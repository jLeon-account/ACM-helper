import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { parseMI, miQuote } from './mi';
import { NativeTerminal } from './terminal';
import type { ProjectConfig, ServerEvent, Snapshot, DebugStatus } from '../shared/types';

export class Debugger extends EventEmitter {
  process?:ChildProcessWithoutNullStreams;
  compiler?:ChildProcessWithoutNullStreams;
  session='';status:DebugStatus='idle';snapshot?:Snapshot;root='';step=0;
  config?:ProjectConfig; toolchain={compiler:process.env.CXX||'g++',debugger:process.env.GDB||'gdb'};
  private sequence=0;private buffer='';private captureBuffer='';private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  private outputTimer?:NodeJS.Timeout;private offsets={stdout:0,stderr:0};private capturing=false;private selectedFrame=0;
  private stopGeneration=0;private breakpointIds:string[]=[];private runMode=false;
  private stopping=false;
  terminal?:NativeTerminal;private finalBreakpoint='';
  private stopQueue=Promise.resolve();
  private decoders={stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};
  send(event:ServerEvent){this.emit('event',event);}
  state(status:DebugStatus,message?:string){this.status=status;this.send({type:'status',status,message,session:this.session});}
  output(channel:'stdout'|'stderr'|'build'|'system',text:string){if(text)this.send({type:'output',channel,text,session:this.session});}
  fail(error:unknown){if(this.stopping)return;const message=error instanceof Error?error.message:String(error);this.output('system',message+'\n');this.send({type:'error',message,session:this.session});this.state('error',message);}
  async command(cmd:string,timeoutMs=20000):Promise<any>{
    if(!this.process)throw new Error('调试器未启动');
    const token=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(token);reject(new Error('GDB 响应超时: '+cmd.slice(0,60)));},timeoutMs);
      this.pending.set(token,{resolve,reject,timer});this.process!.stdin.write(`${token}${cmd}\n`);
    });
  }
  private handleLine(line:string){
    const record=parseMI(line);if(!record)return;
    if(record.kind==='^'&&record.token){const p=this.pending.get(record.token);if(p){clearTimeout(p.timer);this.pending.delete(record.token);record.cls==='error'?p.reject(new Error(record.data.msg||'GDB 错误')):p.resolve(record.data);}}
    if(record.kind==='~'){
      const marker=/CPPIDE_JSON:([A-Za-z0-9+/=]+)/.exec(record.data);
      if(marker)this.captureBuffer=marker[1];
    }
    if(record.kind==='*'&&record.cls==='stopped'){
      if(this.stopping)return;
      const reason=record.data.reason||'step';
      if(reason.startsWith('exited')){void this.readOutput().then(async()=>{if(this.outputTimer){clearInterval(this.outputTimer);this.outputTimer=undefined;}await this.terminal?.stop();this.state('exited',`程序结束 ${record.data['exit-code']??''}`);});}
      else {
        const final=record.data.bkptno===this.finalBreakpoint;const generation=this.stopGeneration;
        this.stopQueue=this.stopQueue.then(async()=>{if(generation!==this.stopGeneration||this.stopping)return;this.selectedFrame=final?2:0;await this.capture(final?'final':reason);if(final&&!this.stopping){this.state('running');await this.command('-exec-continue');}}).catch(e=>this.fail(e));
      }
    }
  }
  async compile(projectPath:string, config:ProjectConfig){
    await this.stop();this.session=crypto.randomUUID();this.step=0;this.snapshot=undefined;this.config=structuredClone(config);this.state('compiling');
    const generation=this.stopGeneration;
    this.root=await fs.mkdtemp(path.join(os.tmpdir(),'cppide-cpp-'));
    await fs.cp(projectPath,this.root,{recursive:true,filter:p=>!path.basename(p).startsWith('.')});
    await fs.copyFile(path.resolve('server/collector.py'),path.join(this.root,'collector.py'));
    await fs.writeFile(path.join(this.root,'input.txt'),config.stdin||'');
    await Promise.all(['stdout','stderr'].map(name=>fs.writeFile(path.join(this.root,`${name}.txt`),'')));
    const executable=path.join(this.root,process.platform==='win32'?'program.exe':'program');
    await fs.copyFile(path.resolve('server/native/runtime.cpp'),path.join(this.root,'cppide-runtime.cpp'));
    const args=['-std=c++17','-g','-O0','-fno-omit-frame-pointer','-fno-inline','-finstrument-functions','-finstrument-functions-exclude-file-list=/include/',config.entry,'cppide-runtime.cpp','-o',executable];
    this.output('build',`C++17 · -g -O0 · ${config.entry}\n`);
    await new Promise<void>((resolve,reject)=>{
      const proc=spawn(this.toolchain.compiler,args,{cwd:this.root,windowsHide:true});this.compiler=proc;
      let settled=false;const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);this.compiler=undefined;error?reject(error):resolve();};
      const timer=setTimeout(()=>{this.kill(proc.pid);finish(new Error('编译超过 30 秒，已停止'));},30000);
      proc.stdout.on('data',d=>this.output('build',d.toString()));proc.stderr.on('data',d=>this.output('build',d.toString()));
      proc.on('error',e=>finish(new Error('无法启动编译器: '+e.message)));proc.on('exit',code=>finish(code===0?undefined:new Error(`编译未通过（退出码 ${code}）`)));
    });
    if(generation!==this.stopGeneration)throw new Error('编译已取消');
    this.output('build','编译成功\n');return executable;
  }
  async start(projectPath:string,config:ProjectConfig,debug=true){
    const executable=await this.compile(projectPath,config);this.runMode=!debug;this.buffer='';this.offsets={stdout:0,stderr:0};this.decoders={stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};
    let consolePid=0;
    if(config.inputMode==='terminal'){
      this.terminal=new NativeTerminal(data=>this.send({type:'terminal',data,session:this.session}));
      this.send({type:'terminal',data:'',reset:true,session:this.session});
      consolePid=await this.terminal.start(this.toolchain.compiler);
    }
    const proc=spawn(this.toolchain.debugger,['--interpreter=mi3','--quiet','--nx'],{cwd:this.root,windowsHide:true,env:{...process.env,...(consolePid?{CPPIDE_CONSOLE_PID:String(consolePid)}:{})}});this.process=proc;
    proc.stdout.on('data',data=>{this.buffer+=data.toString('utf8');let p;while((p=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,p);this.buffer=this.buffer.slice(p+1);this.handleLine(line);}});
    proc.stderr.on('data',d=>this.output('system',d.toString()));
    proc.on('error',e=>this.fail(new Error('无法启动 GDB: '+e.message)));
    proc.on('exit',()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('调试器已退出'));}this.pending.clear();if(this.process===proc){this.process=undefined;if(this.status==='running'||this.status==='paused')this.state('exited','调试器已退出');}});
    await this.command('-gdb-set pagination off');await this.command('-gdb-set confirm off');
    await this.command('-gdb-set print elements 0');await this.command('-gdb-set mi-async on');
    await this.command('-gdb-set charset UTF-8');
    await this.command(`-file-exec-and-symbols ${miQuote(executable.replaceAll('\\','/'))}`);
    await this.command(`-interpreter-exec console ${miQuote('source '+path.join(this.root,'collector.py').replaceAll('\\','/'))}`);
    for(const name of ['__cyg_profile_func_enter','__cyg_profile_func_exit'])await this.command('-interpreter-exec console '+miQuote('skip function '+name));
    this.breakpointIds=[];
    this.finalBreakpoint='';
    if(debug){await this.command('-break-insert -t main');await this.setBreakpoints(config.breakpoints);const final=await this.command('-break-insert cppide_final_checkpoint');this.finalBreakpoint=final.bkpt.number;}
    // Inferior I/O goes to separate files, never into the MI protocol stream.
    if(!consolePid)await this.command(`-exec-arguments < input.txt > stdout.txt 2> stderr.txt`);
    this.outputTimer=setInterval(()=>void this.readOutput(),120);this.state('running');
    await this.command('-exec-run');
  }
  async setBreakpoints(points:Record<string,number[]>){
    if(!this.process)return;
    for(const id of this.breakpointIds)await this.command('-break-delete '+id).catch(()=>{});
    this.breakpointIds=[];
    for(const [file,lines] of Object.entries(points))for(const line of lines){
      if(!Number.isInteger(line)||line<1)continue;
      const result=await this.command('-break-insert '+miQuote(`${file}:${line}`));if(result.bkpt?.number)this.breakpointIds.push(result.bkpt.number);
    }
    if(this.config)this.config.breakpoints=points;
  }
  async capture(reason='refresh',reset=false){
    if(this.capturing)return;this.capturing=true;
    try{
      if(!this.config)throw new Error('缺少项目配置');
      const options={...this.config.observe,frame:this.selectedFrame,root:this.root,reset,final:reason==='final',bindings:this.config.bindings,executedLine:this.snapshot?.location.line??0,watches:[...new Set(this.config.bindings.flatMap(b=>[b.count,b.edgeCount,b.current,b.target,b.root]).filter(Boolean))]};
      this.captureBuffer='';
      await this.command('-interpreter-exec console '+miQuote('cppide-snapshot '+Buffer.from(JSON.stringify(options)).toString('base64')));
      if(!this.captureBuffer)throw new Error('未收到变量快照');
      const parsed=JSON.parse(Buffer.from(this.captureBuffer,'base64').toString('utf8'));
      if(parsed.error)throw new Error(parsed.error);
      if(this.step===0&&reason==='breakpoint-hit'&&parsed.location.function==='main'){
        const source=await fs.readFile(path.resolve(this.root,parsed.location.file),'utf8');const line=source.split('\n')[parsed.location.line-1]??'';
        if(line.includes('{')&&!line.slice(line.indexOf('{')+1).replace(/\/\/.*$/,'').trim()) {await this.command('-exec-next');return;}
      }
      if(reason==='end-stepping-range'&&!parsed.location.file){
        // Stepping off main enters CRT code with no source. Continue to real exit.
        await this.command('-exec-continue');return;
      }
      if(reason==='final')for(const data of Object.values(parsed.bindingData??{}) as any[]){data.current='';data.target='';}
      this.snapshot={...parsed,session:this.session,step:++this.step,reason,timestamp:Date.now()};
      await this.readOutput();this.send({type:'snapshot',snapshot:this.snapshot!});if(reason!=='final')this.state('paused',reason);
    }finally{this.capturing=false;}
  }
  async action(action:string,options:any={}){
    if(action==='stop'){await this.stop();return;}
    if(this.status!=='paused'||this.capturing)throw new Error('请等待程序暂停及变量采集完成');
    if(action==='refresh'||action==='reset'||action==='frame'){
      if(options.config)this.config=options.config;
      if(action==='frame')this.selectedFrame=Math.max(0,Math.min(63,Number(options.level)||0));
      await this.capture(action,action==='reset');return;
    }
    const commands:Record<string,string>={next:'-exec-next',step:'-exec-step',finish:'-exec-finish',continue:'-exec-continue'};
    if(!commands[action])throw new Error('未知调试操作');
    // Execution controls always operate on the newest frame, independent of inspection.
    await this.command('-stack-select-frame 0');this.selectedFrame=0;this.state('running');
    try{await this.command(commands[action]);}catch(e){this.state('paused');throw e;}
  }
  input(text:string){if(!['paused','running'].includes(this.status)||!this.terminal)throw new Error('当前没有可输入的运行终端');this.terminal.input(text);}
  resizeTerminal(cols:number,rows:number){this.terminal?.resize(cols,rows);}
  private async readOutput(){
    if(!this.root)return;
    for(const channel of ['stdout','stderr'] as const){
      try{const buffer=await fs.readFile(path.join(this.root,`${channel}.txt`));if(buffer.length>8*1024*1024){this.output('system','输出超过 8 MiB，已停止程序。\n');await this.stop();return;}
        if(buffer.length>this.offsets[channel]){const fresh=buffer.subarray(this.offsets[channel]);this.offsets[channel]=buffer.length;this.output(channel,this.decoders[channel].write(fresh));}
      }catch{}
    }
  }
  private kill(pid?:number){if(!pid)return;if(process.platform==='win32')spawn('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else try{process.kill(pid,'SIGKILL');}catch{}}
  async stop(){
    this.stopGeneration++;this.stopping=true;if(this.outputTimer){clearInterval(this.outputTimer);this.outputTimer=undefined;}
    const proc=this.process;
    if(proc){
      try{await this.command('-gdb-exit',2000);}catch{}
      if(proc.exitCode===null){proc.stdin.end();proc.kill();}
    }
    this.process=undefined;
    await this.terminal?.stop();this.terminal=undefined;
    if(this.compiler){this.compiler.kill();this.kill(this.compiler.pid);}
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('会话已停止'));}this.pending.clear();this.capturing=false;
    this.state('idle','已停止');this.stopping=false;
  }
}

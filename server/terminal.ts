import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {StringDecoder} from 'node:string_decoder';

export class NativeTerminal {
  process?:ChildProcessWithoutNullStreams;pid=0;history='';private decoder=new StringDecoder('utf8');
  constructor(private onData:(data:string)=>void){}
  async start(compiler:string){
    if(process.platform!=='win32')throw new Error('交互终端目前需要 Windows 10 1809 或更新版本');
    const source=path.resolve('server/native/terminal-host.cpp');const executable=path.resolve('.runtime/terminal-host.exe');
    await fs.mkdir(path.dirname(executable),{recursive:true});
    let build=true;try{build=(await fs.stat(executable)).mtimeMs<(await fs.stat(source)).mtimeMs;}catch{}
    if(build)await new Promise<void>((resolve,reject)=>{
      const p=spawn(compiler,['-std=c++17','-O2',source,'-o',executable],{windowsHide:true});let errors='';
      p.stderr.on('data',b=>errors+=b);p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error('终端组件编译失败: '+errors)));
    });
    const child=spawn(executable,[],{windowsHide:true});this.process=child;
    child.stdout.on('data',b=>{const data=this.decoder.write(b);this.history=(this.history+data).slice(-2*1024*1024);this.onData(data);});
    await new Promise<void>((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(new Error('终端启动超时')),10000);
      child.stderr.on('data',b=>{text+=b;const m=/READY:(\d+)/.exec(text);if(m){this.pid=Number(m[1]);clearTimeout(timer);resolve();}});
      child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);if(!this.pid)reject(new Error(`终端组件退出: ${code}`));});
    });return this.pid;
  }
  private send(type:number,payload:Buffer){if(!this.process||this.process.exitCode!==null)throw new Error('终端尚未启动');const h=Buffer.alloc(5);h[0]=type;h.writeUInt32LE(payload.length,1);this.process.stdin.write(Buffer.concat([h,payload]));}
  input(text:string){if(Buffer.byteLength(text)>65536)throw new Error('单次输入不能超过 64 KiB');this.send(1,Buffer.from(text));}
  resize(cols:number,rows:number){const data=Buffer.alloc(4);data.writeUInt16LE(Math.max(10,Math.min(500,Math.floor(cols)||80)));data.writeUInt16LE(Math.max(2,Math.min(200,Math.floor(rows)||24)),2);this.send(2,data);}
  async stop(){const child=this.process;this.process=undefined;if(!child)return;child.stdin.end();await new Promise<void>(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>{child.kill();resolve();},2000);child.once('exit',()=>{clearTimeout(timer);resolve();});});}
}

import http from 'node:http';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { Debugger } from './debugger';
import { pickFolder, removeFile, revealInExplorer } from './dialog';
import { defaultObserve, type ProjectConfig, type Project } from '../shared/types';

const workspace=path.resolve(process.env.PROJECTS_DIR||'projects');await fs.mkdir(workspace,{recursive:true});
const settingsPath=path.resolve('.runtime/toolchain.json');await fs.mkdir(path.dirname(settingsPath),{recursive:true});
const registryPath=process.env.PROJECTS_DIR?path.join(workspace,'.opened.json'):path.resolve('.runtime/projects.json');const externalProjects=new Map<string,string>();
try{for(const [id,root] of Object.entries(JSON.parse(await fs.readFile(registryPath,'utf8'))))externalProjects.set(id,String(root));}catch{}
const engine=new Debugger();try{engine.toolchain={...engine.toolchain,...JSON.parse(await fs.readFile(settingsPath,'utf8'))};}catch{}
const token=crypto.randomBytes(32).toString('hex');const port=Number(process.env.PORT||4173);let activeProject='';
const allowed=new Set([`http://127.0.0.1:${port}`,`http://localhost:${port}`]);
function local(req:http.IncomingMessage){return [`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host??'')&&(!req.headers.origin||allowed.has(req.headers.origin));}
function projectPath(id:string){if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id))throw new Error('项目标识不合法');return externalProjects.get(id)??path.join(workspace,id);}
function filePath(id:string,name:string){const root=projectPath(id);const p=path.resolve(root,name);const prefix=root.endsWith(path.sep)?root:root+path.sep;if(!p.startsWith(prefix)||! /\.(cpp|cc|cxx|h|hpp|txt)$/i.test(p))throw new Error('仅支持项目内 C++、头文件及文本文件');return p;}
const sourcePattern=/\.(cpp|cc|cxx|h|hpp|txt)$/i;const cppPattern=/\.(cpp|cc|cxx)$/i;
const skippedFolders=new Set(['node_modules','build','dist','out','bin','obj','cmake-build-debug','cmake-build-release']);
const maxFolderDepth=4;const maxListedFiles=500;
async function files(root:string,prefix='',depth=0,found={count:0}):Promise<string[]>{
  if(depth>maxFolderDepth||found.count>=maxListedFiles)return [];
  let list;try{list=await fs.readdir(path.join(root,prefix),{withFileTypes:true});}catch(e){if(!prefix)throw e;return [];}// 子文件夹无权限时跳过，不影响整个项目
  const result:string[]=[];
  for(const item of list.sort((a,b)=>a.name.localeCompare(b.name))){
    if(found.count>=maxListedFiles)break;if(item.name.startsWith('.'))continue;const name=prefix?prefix+'/'+item.name:item.name;
    if(item.isDirectory()){if(!skippedFolders.has(item.name.toLowerCase()))result.push(...await files(root,name,depth+1,found));}
    else if(sourcePattern.test(name)){result.push(name);found.count++;}
  }
  return result;
}
/** 新建 / 重命名的目标必须是文件树能显示的位置，否则文件会“消失”且无法再管理。 */
function assertVisibleName(name:string){
  const parts=name.replaceAll('\\','/').split('/');
  if(parts.length-1>maxFolderDepth)throw new Error(`文件夹层级不能超过 ${maxFolderDepth} 层`);
  for(const part of parts){
    if(!part||part.startsWith('.'))throw new Error('文件名和文件夹名不能为空，也不能以 . 开头');
    if(/[. ]$/.test(part))throw new Error('文件名和文件夹名不能以空格或 . 结尾');
    if(/[<>:"|?*\x00-\x1f]/.test(part))throw new Error('文件名不能包含 < > : " | ? * 等字符');
    if(/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(part))throw new Error(`「${part}」是 Windows 保留名称`);
  }
  if(parts.slice(0,-1).some(part=>skippedFolders.has(part.toLowerCase())))throw new Error('不能放在 build、bin、out 等构建输出文件夹中');
}
/** 返回磁盘上的真实大小写（Windows 不区分大小写，用户输入的大小写可能与实际不同）。 */
async function diskName(id:string,target:string){try{const real=realpathSync.native(target);const root=realpathSync.native(projectPath(id));const name=path.relative(root,real).split(path.sep).join('/');if(name&&!name.startsWith('..'))return name;}catch{}return relativeName(id,target);}
function relativeName(id:string,target:string){return path.relative(projectPath(id),target).split(path.sep).join('/');}
function sourceTemplate(name:string){if(cppPattern.test(name))return '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    \n    return 0;\n}\n';if(/\.(h|hpp)$/i.test(name))return '#pragma once\n\n';return '';}
async function exists(target:string){try{await fs.access(target);return true;}catch{return false;}}
function assertEditable(id:string){if(id===activeProject&&['running','compiling','paused'].includes(engine.status))throw new Error('程序正在运行或调试，请先停止再整理文件');}
async function updateConfig(id:string,change:(config:ProjectConfig)=>ProjectConfig){const root=projectPath(id);const meta=JSON.parse(await fs.readFile(path.join(root,'.cppide.json'),'utf8'));meta.config=change({...meta.config,breakpoints:{...(meta.config.breakpoints??{})}});await fs.writeFile(path.join(root,'.cppide.json'),JSON.stringify(meta,null,2));if(id===activeProject)engine.config=meta.config;}
async function createFile(id:string,name:string){assertVisibleName(name);const target=filePath(id,name);await fs.mkdir(path.dirname(target),{recursive:true});const content=sourceTemplate(target);try{await fs.writeFile(target,content,{flag:'wx'});}catch(e:any){if(e?.code==='EEXIST')throw new Error('同名文件已存在');throw e;}return {project:await readProject(id),file:await diskName(id,target),content};}
async function renameFile(id:string,from:string,to:string){
  assertEditable(id);assertVisibleName(to);const source=filePath(id,from);const target=filePath(id,to);const oldName=await diskName(id,source);let newName=relativeName(id,target);
  if(!(await exists(source)))throw new Error('原文件不存在，可能已被移动或删除');
  if(cppPattern.test(oldName)&&!cppPattern.test(newName)){
    const meta=JSON.parse(await fs.readFile(path.join(projectPath(id),'.cppide.json'),'utf8'));
    if(meta.config?.entry===oldName)throw new Error('它是编译入口，不能改成非 C++ 扩展名；请先把其他 .cpp 设为编译入口');
  }
  if(source!==target){
    if(source.toLowerCase()!==target.toLowerCase()&&await exists(target))throw new Error('同名文件已存在');
    await fs.mkdir(path.dirname(target),{recursive:true});await fs.rename(source,target);newName=await diskName(id,target);
    await updateConfig(id,config=>{const breakpoints=config.breakpoints;if(breakpoints[oldName]){breakpoints[newName]=breakpoints[oldName];delete breakpoints[oldName];}return {...config,breakpoints,entry:config.entry===oldName?newName:config.entry};});
  }
  return {project:await readProject(id),file:newName};
}
async function deleteFile(id:string,name:string){
  assertEditable(id);const target=filePath(id,name);const oldName=relativeName(id,target);const before=await files(projectPath(id));
  if(!before.includes(oldName))throw new Error('文件不存在，可能已被删除');
  const remainingCpp=before.filter(f=>f!==oldName&&cppPattern.test(f));if(cppPattern.test(oldName)&&!remainingCpp.length)throw new Error('项目至少需要保留一个 C++ 源文件');
  await removeFile(target,fs.unlink);
  await updateConfig(id,config=>{const breakpoints=config.breakpoints;delete breakpoints[oldName];return {...config,breakpoints,entry:config.entry===oldName?(remainingCpp.find(f=>f==='main.cpp')??remainingCpp[0]):config.entry};});
  return {project:await readProject(id)};
}
let lastOpenedFolder='';
async function readProject(id:string):Promise<Project>{const root=projectPath(id);const meta=JSON.parse(await fs.readFile(path.join(root,'.cppide.json'),'utf8'));return {id,name:String(meta.name).replace(' · 最短路课堂','').replace('我的算法课堂','未命名项目'),path:root,config:{...meta.config,inputMode:meta.config.inputMode??'terminal'},files:await files(root)};}
async function saveConfig(id:string,config:ProjectConfig){filePath(id,config.entry);if(!cppPattern.test(config.entry))throw new Error('编译入口必须是 .cpp / .cc / .cxx 文件');const proj=await readProject(id);await fs.writeFile(path.join(projectPath(id),'.cppide.json'),JSON.stringify({name:proj.name,config},null,2));}
async function createProject(name:string,example='blank'){
  const id=crypto.randomUUID();const root=projectPath(id);await fs.mkdir(root);
  const examples=['blank','bfs','dijkstra','sort','tree','large','recursion'];if(!examples.includes(example))throw new Error('样例不存在');
  const source=await fs.readFile(path.resolve('example',example,example+'.cpp'),'utf8');await fs.writeFile(path.join(root,'main.cpp'),source);
  let config:ProjectConfig={entry:'main.cpp',stdin:'',inputMode:'terminal',breakpoints:{},bindings:[],observe:defaultObserve()};
  try{config={...config,...JSON.parse(await fs.readFile(path.resolve('example',example,example+'.json'),'utf8'))};}catch{}
  await fs.writeFile(path.join(root,'.cppide.json'),JSON.stringify({name,config},null,2));return readProject(id);
}
async function openProject(directory:string){
  const root=await fs.realpath(path.resolve(directory));if(!(await fs.stat(root)).isDirectory())throw new Error('请选择项目文件夹');
  lastOpenedFolder=root;
  for(const [id,p] of externalProjects)if(p.toLowerCase()===root.toLowerCase())return readProject(id);
  const id=crypto.randomUUID();const list=await files(root);const entry=list.find(f=>f==='main.cpp')??list.find(f=>cppPattern.test(f));if(!entry)throw new Error(`「${path.basename(root)}」中没有 C++ 源文件（.cpp / .cc / .cxx）。想从零开始请使用「新建项目」`);
  try{await fs.access(path.join(root,'.cppide.json'));}catch{
    let config:ProjectConfig={entry,stdin:'',inputMode:'terminal',breakpoints:{},bindings:[],observe:defaultObserve()};
    try{config={...config,...JSON.parse(await fs.readFile(path.join(root,entry.replace(/\.[^.]+$/,'.json')),'utf8')),entry};}catch{}
    await fs.writeFile(path.join(root,'.cppide.json'),JSON.stringify({name:path.basename(root),config},null,2));
  }
  externalProjects.set(id,root);await fs.writeFile(registryPath,JSON.stringify(Object.fromEntries(externalProjects),null,2));return readProject(id);
}
if(!(await fs.readdir(workspace)).some(x=>!x.startsWith('.')))await createProject('未命名项目');
async function body(req:http.IncomingMessage){const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>2*1024*1024)throw new Error('请求超过 2 MiB');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString()||'{}');}
function json(res:http.ServerResponse,value:unknown,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
async function version(binary:string){return new Promise<string>(resolve=>{const p=spawn(binary,['--version'],{windowsHide:true});let text='';const timer=setTimeout(()=>{p.kill();resolve('检查超时');},5000);p.stdout.on('data',b=>text+=b);p.on('error',e=>{clearTimeout(timer);resolve('不可用: '+e.message);});p.on('exit',()=>{clearTimeout(timer);resolve(text.split('\n')[0]);});});}
const dev=process.argv.includes('--dev');
const vite=dev?await (await import('vite')).createServer({server:{middlewareMode:true},appType:'spa'}):undefined;
const server=http.createServer(async(req,res)=>{
  try{
    if(!local(req)){json(res,{error:'只接受本机同源访问'},403);return;}
    const url=new URL(req.url||'/',`http://127.0.0.1:${port}`);
    if(url.pathname==='/api/session'){json(res,{token,status:engine.status,session:engine.session,activeProject,snapshot:engine.snapshot,terminal:engine.terminal?.history??''});return;}
    if(url.pathname.startsWith('/api/')){
      if(req.headers['x-cppide-token']!==token){json(res,{error:'会话令牌无效，请刷新页面'},403);return;}
      const data=req.method==='GET'?{}:await body(req);
      if(url.pathname==='/api/projects'&&req.method==='GET'){const list=[];for(const id of [...await fs.readdir(workspace),...externalProjects.keys()]){try{const p=await readProject(id);list.push(p);}catch{}}json(res,list);return;}
      if(url.pathname==='/api/projects'&&req.method==='POST'){json(res,await createProject(String(data.name||'未命名项目').slice(0,80),data.example||'blank'));return;}
      if(url.pathname==='/api/projects/open'&&req.method==='POST'){json(res,await openProject(String(data.path||'')));return;}
      if(url.pathname==='/api/file'&&req.method==='GET'){json(res,{content:await fs.readFile(filePath(url.searchParams.get('project')||'',url.searchParams.get('file')||''),'utf8')});return;}
      if(url.pathname==='/api/file'&&req.method==='PUT'){const target=filePath(data.project,data.file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,String(data.content));json(res,{ok:true});return;}
      if(url.pathname==='/api/file/create'&&req.method==='POST'){json(res,await createFile(String(data.project),String(data.file||'')));return;}
      if(url.pathname==='/api/file/rename'&&req.method==='POST'){json(res,await renameFile(String(data.project),String(data.from||''),String(data.to||'')));return;}
      if(url.pathname==='/api/file/delete'&&req.method==='POST'){json(res,await deleteFile(String(data.project),String(data.file||'')));return;}
      if(url.pathname==='/api/file/reveal'&&req.method==='POST'){const id=String(data.project);if(data.file)revealInExplorer(filePath(id,String(data.file)),true);else revealInExplorer(projectPath(id),false);json(res,{ok:true});return;}
      if(url.pathname==='/api/dialog/folder'&&req.method==='POST'){let initial=lastOpenedFolder?path.dirname(lastOpenedFolder):path.resolve('example');if(!(await exists(initial)))initial='';json(res,{path:await pickFolder(String(data.title||'选择要打开的项目文件夹'),initial)});return;}
      if(url.pathname==='/api/config'&&req.method==='PUT'){await saveConfig(data.project,data.config);if(data.project===activeProject)engine.config=data.config;json(res,{ok:true});return;}
      if(url.pathname==='/api/tools'&&req.method==='GET'){json(res,{...engine.toolchain,compilerVersion:await version(engine.toolchain.compiler),debuggerVersion:await version(engine.toolchain.debugger)});return;}
      if(url.pathname==='/api/tools'&&req.method==='PUT'){if(engine.status==='running'||engine.status==='compiling')throw new Error('请先停止程序');engine.toolchain={compiler:String(data.compiler),debugger:String(data.debugger)};await fs.writeFile(settingsPath,JSON.stringify(engine.toolchain,null,2));json(res,{ok:true});return;}
      if(url.pathname==='/api/start'&&req.method==='POST'){if(['running','compiling'].includes(engine.status))throw new Error('已有程序正在运行，请先停止');const project=await readProject(data.project);activeProject=project.id;void engine.start(projectPath(project.id),project.config,data.debug!==false).catch(e=>{if(engine.status!=='idle')engine.fail(e);});json(res,{ok:true});return;}
      if(url.pathname==='/api/action'&&req.method==='POST'){await engine.action(data.action,data);json(res,{ok:true});return;}
      if(url.pathname==='/api/terminal'&&req.method==='POST'){if(data.data!==undefined)engine.input(String(data.data));if(data.cols)engine.resizeTerminal(Number(data.cols),Number(data.rows));json(res,{ok:true});return;}
      if(url.pathname==='/api/breakpoints'&&req.method==='PUT'){if(engine.status==='paused')await engine.setBreakpoints(data.breakpoints);json(res,{ok:true});return;}
      json(res,{error:'接口不存在'},404);return;
    }
    if(vite){vite.middlewares(req,res);return;}
    const pathname=decodeURIComponent(url.pathname);const base=path.resolve('dist');const candidate=path.resolve(base,'.'+pathname);
    if(!candidate.startsWith(base+path.sep)&&candidate!==base){res.writeHead(403);res.end();return;}
    let target=candidate;try{if((await fs.stat(target)).isDirectory())target=path.join(target,'index.html');}catch{target=path.join(base,'index.html');}
    const types:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.ttf':'font/ttf'};
    res.writeHead(200,{'Content-Type':types[path.extname(target)]||'application/octet-stream'});res.end(await fs.readFile(target));
  }catch(e){json(res,{error:e instanceof Error?e.message:String(e),code:(e as {code?:unknown})?.code==='unsupported'?'unsupported':undefined},400);}
});
const wss=new WebSocketServer({noServer:true});server.on('upgrade',(req,socket,head)=>{const url=new URL(req.url||'/',`http://127.0.0.1:${port}`);if(url.pathname!=='/events')return;if(!local(req)||url.searchParams.get('token')!==token){socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>{wss.emit('connection',ws,req);ws.send(JSON.stringify({type:'status',status:engine.status,session:engine.session}));if(engine.snapshot)ws.send(JSON.stringify({type:'snapshot',snapshot:engine.snapshot}));});});
engine.on('event',event=>{for(const ws of wss.clients)if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(event));});
server.on('listening',()=>{console.log(`ACM Helper · http://127.0.0.1:${port}`);console.log(`请在浏览器中打开 http://127.0.0.1:${port}`);console.log('使用期间请保持此窗口打开；关闭窗口或按 Ctrl+C 即停止服务。');});
// 端口被占用：如果占用者是之前启动、尚未关闭的 ACM Helper（常见于重新构建后再次双击 start.cmd），自动关闭旧进程并重新启动；否则给出明确提示。
async function existingHelper(){try{const response=await fetch(`http://127.0.0.1:${port}/api/session`,{signal:AbortSignal.timeout(2000)});const value=await response.json();return typeof value?.token==='string'&&'session' in value;}catch{return false;}}
function portOwner(){
  if(process.platform!=='win32')return 0;
  try{const table=execFileSync('netstat',['-ano','-p','TCP'],{encoding:'latin1',windowsHide:true});const match=new RegExp(`^\\s*TCP\\s+127\\.0\\.0\\.1:${port}\\s+0\\.0\\.0\\.0:0\\s+\\S+\\s+(\\d+)\\s*$`,'m').exec(table);return match?Number(match[1]):0;}catch{return 0;}
}
let portRetried=false;
server.on('error',async(error:NodeJS.ErrnoException)=>{
  if(error.code!=='EADDRINUSE'){console.error(error);process.exit(1);}
  if(!portRetried&&await existingHelper()){
    const pid=portOwner();
    if(pid&&pid!==process.pid){
      portRetried=true;console.log(`检测到之前启动的 ACM Helper 仍在运行（进程 ${pid}），正在关闭旧版本并重新启动…`);
      try{execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}catch{}
      await new Promise(resolve=>setTimeout(resolve,1000));server.listen(port,'127.0.0.1');return;
    }
    console.error(`ACM Helper 已经在运行，可直接在浏览器打开 http://127.0.0.1:${port}。如需启动新版本，请先关闭之前的启动窗口。`);process.exit(1);
  }
  console.error(`端口 ${port} 已被其他程序占用。请关闭占用该端口的程序，或在启动前执行 set PORT=4174 改用其他端口。`);process.exit(1);
});
server.listen(port,'127.0.0.1');
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void engine.stop().finally(()=>{server.close();process.exit(0);});});

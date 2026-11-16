import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { Debugger } from './debugger';
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
function filePath(id:string,name:string){const root=projectPath(id);const p=path.resolve(root,name);if(!p.startsWith(root+path.sep)||! /\.(cpp|cc|cxx|h|hpp|txt)$/i.test(p))throw new Error('仅支持项目内 C++、头文件及文本文件');return p;}
async function files(root:string,prefix=''):Promise<string[]>{const list=await fs.readdir(path.join(root,prefix),{withFileTypes:true});let result:string[]=[];for(const item of list){if(item.name.startsWith('.'))continue;const name=prefix?prefix+'/'+item.name:item.name;if(item.isDirectory())result.push(...await files(root,name));else if(/\.(cpp|cc|cxx|h|hpp|txt)$/i.test(name))result.push(name);}return result;}
async function readProject(id:string):Promise<Project>{const root=projectPath(id);const meta=JSON.parse(await fs.readFile(path.join(root,'.cppide.json'),'utf8'));return {id,name:String(meta.name).replace(' · 最短路课堂','').replace('我的算法课堂','未命名项目'),path:root,config:{...meta.config,inputMode:meta.config.inputMode??'terminal'},files:await files(root)};}
async function saveConfig(id:string,config:ProjectConfig){filePath(id,config.entry);const proj=await readProject(id);await fs.writeFile(path.join(projectPath(id),'.cppide.json'),JSON.stringify({name:proj.name,config},null,2));}
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
  for(const [id,p] of externalProjects)if(p.toLowerCase()===root.toLowerCase())return readProject(id);
  const id=crypto.randomUUID();const list=await files(root);const entry=list.find(f=>f==='main.cpp')??list.find(f=>/\.(cpp|cc|cxx)$/i.test(f));if(!entry)throw new Error('项目文件夹中没有 C++ 源文件');
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
  }catch(e){json(res,{error:e instanceof Error?e.message:String(e)},400);}
});
const wss=new WebSocketServer({noServer:true});server.on('upgrade',(req,socket,head)=>{const url=new URL(req.url||'/',`http://127.0.0.1:${port}`);if(url.pathname!=='/events')return;if(!local(req)||url.searchParams.get('token')!==token){socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>{wss.emit('connection',ws,req);ws.send(JSON.stringify({type:'status',status:engine.status,session:engine.session}));if(engine.snapshot)ws.send(JSON.stringify({type:'snapshot',snapshot:engine.snapshot}));});});
engine.on('event',event=>{for(const ws of wss.clients)if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(event));});
server.listen(port,'127.0.0.1',()=>console.log(`C++ 调试工作区 · http://127.0.0.1:${port}`));
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void engine.stop().finally(()=>{server.close();process.exit(0);});});

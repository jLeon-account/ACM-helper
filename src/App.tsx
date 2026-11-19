import {useEffect,useRef,useState,useCallback} from 'react';
import Editor, {type OnMount} from '@monaco-editor/react';
import type {editor as MonacoEditor, Selection} from 'monaco-editor';
import type * as Monaco from 'monaco-editor';
import {Play,Bug,SkipForward,StepForward,ArrowDownToLine,ArrowUpFromLine,Square,Pause,Save,Plus,Settings,FolderOpen,Folder,FileCode2,FileCode,FileText,FilePlus2,ChevronDown,ChevronRight,Terminal,Network,Braces,Layers,Check,AlertCircle,X,Pin,RotateCcw,BookOpen,SlidersHorizontal,Focus,Link2,Sun,Moon,Monitor,Pencil,Trash2,ExternalLink,Flag} from 'lucide-react';
import {defaultBinding,defaultObserve,type Project,type ProjectConfig,type Snapshot,type DebugStatus,type ServerEvent,type Binding,type ObserveOptions} from '../shared/types';
import {VariableCard,VariableTable} from './Variables';
import GraphView from './GraphView';
import TerminalView from './TerminalView';
import SpeedControl from './SpeedControl';
import {useTheme,defineEditorThemes,type ThemePreference} from './theme';

let authToken='';
class ApiError extends Error{constructor(message:string,public code?:string){super(message);}}
async function api(route:string,method='GET',data?:unknown){const response=await fetch('/api/'+route,{method,headers:{'Content-Type':'application/json','X-Cppide-Token':authToken},body:data===undefined?undefined:JSON.stringify(data)});const value=await response.json();if(!response.ok)throw new ApiError(value.error||'请求失败',value.code);return value;}
const statusNames:Record<DebugStatus,string>={idle:'就绪',compiling:'编译中',running:'运行中',paused:'已暂停',exited:'运行结束',error:'发生错误'};
const isWindows=typeof navigator!=='undefined'&&/Windows/i.test(navigator.userAgent);
const message=(e:unknown)=>e instanceof Error?e.message:String(e);
type Output={channel:string;text:string};
type Editing={mode:'create'}|{mode:'rename';file:string};
type ContextMenu={x:number;y:number;file?:string};

function selectedLine(selection: Selection | null) {
  if (!selection) return 1;
  // Monaco includes the newline in an entire-line selection.
  if (selection.positionColumn === 1 && selection.positionLineNumber > selection.selectionStartLineNumber) {
    return selection.positionLineNumber - 1;
  }
  return selection.positionLineNumber;
}

const sourceExtensions=/\.(cpp|cc|cxx|h|hpp|txt)$/i;
/** 规范化用户输入的文件名：去掉首尾空白与开头的 ./，没有扩展名时补上默认扩展名。 */
function normalizeName(raw:string,fallbackExtension='.cpp'){
  let name=raw.trim().replaceAll('\\','/').replace(/^(\.\/|\/)+/,'');
  if(!name)return '';
  if(/[<>:"|?*]/.test(name)||name.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('文件名不能包含 < > : " | ? * 或空的路径段');
  if(name.split('/').some(part=>part.startsWith('.')))throw new Error('文件名和文件夹名不能以 . 开头（这类文件不会显示在文件树中）');
  if(!/\.[^./]+$/.test(name))name+=fallbackExtension;
  if(!sourceExtensions.test(name))throw new Error('仅支持 .cpp、.cc、.cxx、.h、.hpp 或 .txt 文件');
  return name;
}
/** 把调试位置映射为项目中的文件（相对路径），不在项目内时返回空字符串。 */
function projectFileFor(location:{file:string;projectFile?:string}|undefined,files:string[]|undefined){
  if(!location||!files)return '';
  if(location.projectFile&&files.includes(location.projectFile))return location.projectFile;
  const source=location.file.replaceAll('\\','/').replace(/^\.\//,'').toLowerCase();if(!source)return '';
  let best='';for(const f of files){const name=f.toLowerCase();if((source===name||source.endsWith('/'+name))&&f.length>best.length)best=f;}
  return best;
}
function extensionOf(name:string){return /\.[^./]+$/.exec(name)?.[0]??'.cpp';}
function FileIcon({name}:{name:string}){
  if(/\.(h|hpp)$/i.test(name))return <FileCode size={14} className="file-icon header"/>;
  if(/\.txt$/i.test(name))return <FileText size={14} className="file-icon text"/>;
  return <FileCode2 size={14} className="file-icon cpp"/>;
}

/** 文件树中的就地命名输入框：Enter 确认，Esc 取消，失焦时确认。 */
function InlineName({initial,placeholder,onCommit,onCancel}:{initial:string;placeholder:string;onCommit:(value:string)=>Promise<boolean>;onCancel:()=>void}){
  const [value,setValue]=useState(initial);const input=useRef<HTMLInputElement>(null);const settled=useRef(false);
  useEffect(()=>{const el=input.current;if(!el)return;el.focus();const dot=initial.lastIndexOf('.');el.setSelectionRange(0,dot>0?dot:initial.length);},[initial]);
  async function finish(commit:boolean,fromBlur:boolean){
    if(settled.current)return;settled.current=true;
    const text=value.trim();if(!commit||!text||text===initial){onCancel();return;}
    const ok=await onCommit(text);
    if(!ok){if(fromBlur)onCancel();else{settled.current=false;input.current?.focus();}}
  }
  return <div className="file-item editing"><FileIcon name={value||initial||'a.cpp'}/><input ref={input} value={value} placeholder={placeholder} spellCheck={false} aria-label={placeholder}
    onChange={e=>setValue(e.target.value)} onBlur={()=>{if(document.hasFocus())void finish(true,true);}}
    onKeyDown={e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();void finish(true,false);}else if(e.key==='Escape'){e.preventDefault();void finish(false,false);}}}/></div>;
}

export default function App(){
  const {theme,preference,setPreference}=useTheme();
  const [projects,setProjects]=useState<Project[]>([]);const [project,setProject]=useState<Project>();const projectRef=useRef<Project | undefined>(undefined);projectRef.current=project;
  const [file,setFile]=useState('main.cpp');const [buffers,setBuffers]=useState<Record<string,string>>({});const buffersRef=useRef(buffers);buffersRef.current=buffers;const [dirty,setDirty]=useState<Set<string>>(new Set());
  const [status,setStatus]=useState<DebugStatus>('idle');const [snapshot,setSnapshot]=useState<Snapshot>();const [outputs,setOutputs]=useState<Output[]>([]);
  const [tab,setTab]=useState<'visual'|'variables'>('visual');const [consoleTab,setConsoleTab]=useState<'output'|'input'|'build'>('output');
  const [auto,setAuto]=useState(false);const [speed,setSpeed]=useState(()=>Number(localStorage.getItem('cppide-speed'))||2);const [busy,setBusy]=useState(false);const [connected,setConnected]=useState(false);
  const [toast,setToast]=useState('');const [modal,setModal]=useState<'new'|'open'|'delete'|'binding'|'settings'|'help'|null>(null);const [bindingDraft,setBindingDraft]=useState<Binding>();
  const [newName,setNewName]=useState('');const [openPath,setOpenPath]=useState('');const [tools,setTools]=useState<any>({});
  const [menu,setMenu]=useState<'project'|null>(null);const [contextMenu,setContextMenu]=useState<ContextMenu|null>(null);const [editing,setEditing]=useState<Editing|null>(null);const [deleteTarget,setDeleteTarget]=useState('');
  const [terminalText,setTerminalText]=useState('');const [terminalSession,setTerminalSession]=useState('');const inputQueue=useRef(Promise.resolve());
  const [pinText,setPinText]=useState('');const [stackOpen,setStackOpen]=useState(false);const [focus,setFocus]=useState(false);const [selectedBinding,setSelectedBinding]=useState('');
  const [filter,setFilter]=useState('');const [rangeName,setRangeName]=useState('');const [rangeText,setRangeText]=useState('');
  const [layout,setLayout]=useState(()=>{try{return JSON.parse(localStorage.getItem('cppide-layout')||'{"x":0.2,"y":0.55}');}catch{return {x:.2,y:.55};}});
  const stage=useRef<HTMLDivElement>(null);const editor=useRef<MonacoEditor.IStandaloneCodeEditor | undefined>(undefined);const monacoRef=useRef<typeof Monaco | undefined>(undefined);const decoration=useRef<MonacoEditor.IEditorDecorationsCollection | undefined>(undefined);const breakDecoration=useRef<MonacoEditor.IEditorDecorationsCollection | undefined>(undefined);const consoleEnd=useRef<HTMLDivElement>(null);const [editorReady,setEditorReady]=useState(0);
  const breakpointCallback=useRef<(line:number)=>void>(()=>{});const lastSnapshot=useRef<Snapshot | undefined>(undefined);const [executed,setExecuted]=useState<{file:string;line:number}|null>(null);const followedSnapshot=useRef('');const lastStop=useRef<Snapshot['location']|undefined>(undefined);const currentSession=useRef('');
  const notify=useCallback((text:string)=>setToast(text),[]);
  useEffect(()=>{if(!toast)return;const t=setTimeout(()=>setToast(''),6500);return()=>clearTimeout(t);},[toast]);
  const request=useCallback(async<T,>(work:()=>Promise<T>):Promise<T|undefined>=>{setBusy(true);try{return await work();}catch(e){notify(message(e));setAuto(false);}finally{setBusy(false);}},[notify]);

  useEffect(()=>{
    let disposed=false;let socket:WebSocket|undefined;let retry:ReturnType<typeof setTimeout>;
    async function connect(){try{
      const session=await fetch('/api/session').then(r=>r.json());authToken=session.token;if(disposed)return;
      currentSession.current=session.session;setStatus(session.status);if(session.snapshot)setSnapshot(session.snapshot);setTerminalSession(session.session);setTerminalText(session.terminal??'');
      const list:Project[]=await api('projects');setProjects(list);if(!projectRef.current&&list.length){const selected=list.find(p=>p.id===session.activeProject)||list[0];setProject(selected);setFile(selected.config.entry);}
      socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/events?token=${authToken}`);
      socket.onopen=()=>setConnected(true);
      socket.onmessage=event=>{
        const message:ServerEvent=JSON.parse(event.data);
        if(message.type==='status'){
          if(message.session!==currentSession.current){currentSession.current=message.session;lastSnapshot.current=undefined;lastStop.current=undefined;setSnapshot(undefined);setExecuted(null);}
          setStatus(message.status);if(['idle','exited','error'].includes(message.status))setAuto(false);if(message.status==='running')setConsoleTab('output');
        }else if(message.type==='snapshot'){
          const next=message.snapshot;if(next.session!==currentSession.current)return;
          if(lastSnapshot.current&&next.step<lastSnapshot.current.step)return;
          if(!['refresh','reset','frame'].includes(next.reason)){const previous=lastStop.current;setExecuted(previous?{file:projectFileFor(previous,projectRef.current?.files),line:previous.line}:null);lastStop.current=next.location;}
          lastSnapshot.current=next;setSnapshot(next);
        }else if(message.type==='terminal'){if(message.session!==currentSession.current)return;setTerminalSession(message.session);setTerminalText(previous=>message.reset?message.data:(previous+message.data).slice(-2*1024*1024));}
        else if(message.type==='output'){setOutputs(previous=>[...previous,{channel:message.channel,text:message.text}].slice(-1500));}
        else if(message.type==='error'){notify(message.message);setAuto(false);}
      };
      socket.onclose=()=>{setConnected(false);setAuto(false);if(!disposed)retry=setTimeout(connect,1500);};
    }catch(e){if(!disposed){setConnected(false);retry=setTimeout(connect,2000);}}}
    void connect();return()=>{disposed=true;clearTimeout(retry);socket?.close();};
  },[notify]);
  useEffect(()=>{if(!project)return;const id=project.id;let canceled=false;if(buffers[file]===undefined&&project.files.includes(file))void api(`file?project=${id}&file=${encodeURIComponent(file)}`).then(data=>{if(!canceled)setBuffers(old=>({...old,[file]:data.content}));}).catch(e=>notify(e.message));return()=>{canceled=true;};},[project?.id,project?.files,file,buffers,notify]);
  useEffect(()=>{consoleEnd.current?.scrollIntoView({block:'end'});},[outputs,consoleTab]);
  // 自动单步：每一步本身就要花时间（调试器往返、变量采集、界面渲染）。
  // 等待时间扣除这部分耗时，让实际速度贴近设定值；设定速度超过单步极限时，一次请求连续执行多步，只刷新最后一步的画面。
  const autoClock=useRef({issued:0,rtt:0,count:1,step:-1,history:[] as {t:number;n:number}[]});const [actualRate,setActualRate]=useState(0);
  useEffect(()=>{if(!auto){autoClock.current={issued:0,rtt:0,count:1,step:-1,history:[]};setActualRate(0);}},[auto]);
  useEffect(()=>{
    if(!auto||status!=='paused'||busy)return;
    const clock=autoClock.current;const now=performance.now();const step=snapshot?.step??0;
    const interval=1000/Math.max(.1,Math.min(100,speed));
    if(clock.issued&&clock.step!==step){
      clock.step=step;const rtt=now-clock.issued;clock.rtt=rtt;
      clock.history.push({t:now,n:clock.count});clock.history=clock.history.filter(h=>now-h.t<2500);
      if(clock.history.length>1){const span=now-clock.history[0].t;const steps=clock.history.slice(1).reduce((sum,h)=>sum+h.n,0);if(span>0)setActualRate(steps*1000/span);}
      // 自适应每批步数：单步就能跟上时每次只走一步；跟不上时按差距放大批量，但单批耗时控制在约 0.15 秒内，保证画面仍然流畅
      if(rtt<=interval)clock.count=1;
      else if(rtt>180)clock.count=Math.max(1,Math.floor(clock.count*.7));
      else if(rtt<120){const rate=clock.count*1000/rtt;const target=1000/interval;if(rate<target*.95)clock.count=Math.min(50,Math.ceil(clock.count*Math.min(2,target/rate)));}
    }
    const count=clock.count;
    const delay=Math.max(0,interval*count-(clock.issued?now-clock.issued:interval));
    const timer=setTimeout(()=>{clock.issued=performance.now();void request(()=>api('action','POST',{action:'next',count}));},delay);
    return()=>clearTimeout(timer);
  },[auto,status,snapshot?.step,busy,speed,request]);
  useEffect(()=>{if(!editor.current)return;const points=project?.config.breakpoints[file]??[];breakDecoration.current?.clear();breakDecoration.current=editor.current.createDecorationsCollection(points.map(line=>({range:{startLineNumber:line,startColumn:1,endLineNumber:line,endColumn:1},options:{glyphMarginClassName:'breakpoint-dot',glyphMarginHoverMessage:{value:'点击移除断点'}}})));},[project?.config.breakpoints,file,editorReady,buffers[file]]);
  useEffect(()=>{
    if(!editor.current)return;decoration.current?.clear();if(!snapshot||status==='idle')return;
    if(projectFileFor(snapshot.location,project?.files)!==file)return;
    const line=snapshot.location.line;if(line<1)return;
    const markings:MonacoEditor.IModelDeltaDecoration[]=[{range:{startLineNumber:line,startColumn:1,endLineNumber:line,endColumn:1},options:{isWholeLine:true,className:'next-source-line',marginClassName:'execution-arrow'}}];
    if(executed&&executed.file===file&&executed.line>0&&executed.line!==line)markings.push({range:{startLineNumber:executed.line,startColumn:1,endLineNumber:executed.line,endColumn:1},options:{isWholeLine:true,className:'executed-source-line'}});
    decoration.current=editor.current.createDecorationsCollection(markings);editor.current.revealLineInCenterIfOutsideViewport(line);
  },[snapshot,status,file,executed,editorReady,buffers[file],project?.files]);
  // 每个新的调试快照：如果执行位置在项目的另一个文件中（例如 F7 进入头文件里的函数），自动切换过去。
  useEffect(()=>{
    if(!snapshot||!project||status==='idle')return;const key=`${snapshot.session}:${snapshot.step}`;if(followedSnapshot.current===key)return;followedSnapshot.current=key;
    if(snapshot.reason==='refresh'||snapshot.reason==='reset')return;// 只刷新变量时不打断正在查看的其他文件
    const target=projectFileFor(snapshot.location,project.files);if(target&&target!==file)setFile(target);
  },[snapshot,project,status,file]);
  // 点击菜单外部、按 Esc、窗口失焦或改变大小时关闭下拉菜单与右键菜单。
  useEffect(()=>{
    if(!menu&&!contextMenu)return;
    const close=(e:Event)=>{if(e instanceof KeyboardEvent&&e.key!=='Escape')return;if(e.type==='blur'&&e.target!==window)return;if(e.type==='pointerdown'&&(e.target as Element|null)?.closest?.('.menu-root'))return;setMenu(null);setContextMenu(null);};
    const events=['pointerdown','keydown','resize','blur'];for(const name of events)window.addEventListener(name,close,true);
    return()=>{for(const name of events)window.removeEventListener(name,close,true);};
  },[menu,contextMenu]);

  async function save(){if(!project)return;for(const name of dirty)await api('file','PUT',{project:project.id,file:name,content:buffers[name]});await api('config','PUT',{project:project.id,config:project.config});setDirty(new Set());}
  async function changeConfig(config:ProjectConfig,refresh=false){if(!project)return;setProject({...project,config});setProjects(list=>list.map(p=>p.id===project.id?{...p,config}:p));await api('config','PUT',{project:project.id,config});if(refresh&&status==='paused')await api('action','POST',{action:'refresh',config});}
  function observe(options:ObserveOptions){if(project)void request(()=>changeConfig({...project.config,observe:options},true));}
  async function start(debug:boolean){await save();setAuto(false);setOutputs([]);setTerminalText('');setSnapshot(undefined);lastSnapshot.current=undefined;lastStop.current=undefined;setExecuted(null);setConsoleTab('build');await api('start','POST',{project:project?.id,debug});}
  async function acceptProject(p:Project){if(status!=='idle')await api('action','POST',{action:'stop'});setAuto(false);setProjects(await api('projects'));setProject(p);setFile(p.config.entry);setBuffers({});setDirty(new Set());setSnapshot(undefined);lastSnapshot.current=undefined;setOutputs([]);setTerminalText('');setEditing(null);setModal(null);}
  function terminalInput(data:string){inputQueue.current=inputQueue.current.then(()=>api('terminal','POST',{data})).catch(e=>notify(e.message));}
  async function selectProject(id:string){if(project&&dirty.size)await save();if(status!=='idle')await api('action','POST',{action:'stop'});const latest:Project[]=await api('projects');setProjects(latest);const p=latest.find(p=>p.id===id);if(p){setAuto(false);setSnapshot(undefined);lastSnapshot.current=undefined;setBuffers({});setDirty(new Set());setOutputs([]);setProject(p);setFile(p.config.entry);setSelectedBinding('');setEditing(null);}}
  breakpointCallback.current=(line:number)=>{if(!project)return;const list=project.config.breakpoints[file]??[];const points={...project.config.breakpoints,[file]:list.includes(line)?list.filter(n=>n!==line):[...list,line].sort((a,b)=>a-b)};void request(async()=>{await changeConfig({...project.config,breakpoints:points});if(status==='paused')await api('breakpoints','PUT',{breakpoints:points});});};

  /** 服务端返回文件变更后的项目：入口与断点以服务端为准，其余尚未保存的配置保留本地值。 */
  function mergeProject(next:Project){
    const current=projectRef.current;
    const merged:Project=current&&current.id===next.id?{...next,config:{...current.config,entry:next.config.entry,breakpoints:next.config.breakpoints}}:next;
    projectRef.current=merged;setProject(merged);setProjects(list=>list.map(p=>p.id===merged.id?merged:p));return merged;
  }
  function disposeModel(projectId:string,name:string){
    const monaco=monacoRef.current;if(!monaco)return;const model=monaco.editor.getModel(monaco.Uri.parse(`${projectId}/${name}`));
    if(model&&editor.current?.getModel()!==model)model.dispose();
  }
  async function createSource(raw:string){
    if(!project)return false;
    try{
      const name=normalizeName(raw);if(!name)return false;
      const result=await api('file/create','POST',{project:project.id,file:name});mergeProject(result.project);
      setBuffers(b=>({...b,[result.file]:result.content}));setFile(result.file);setEditing(null);return true;
    }catch(e){notify(message(e));return false;}
  }
  async function renameSource(from:string,raw:string){
    if(!project)return false;
    try{
      const to=normalizeName(raw,extensionOf(from));if(!to||to===from){setEditing(null);return true;}
      const result=await api('file/rename','POST',{project:project.id,from,to});const merged=mergeProject(result.project);const next:string=result.file;
      setBuffers(b=>{const n={...b};if(from in n){n[next]=n[from];delete n[from];}return n;});
      setDirty(d=>{const n=new Set(d);if(n.delete(from))n.add(next);return n;});
      if(file===from)setFile(next);setEditing(null);setTimeout(()=>disposeModel(merged.id,from),60);return true;
    }catch(e){notify(message(e));return false;}
  }
  async function deleteSource(name:string){
    if(!project)return;const id=project.id;
    const result=await api('file/delete','POST',{project:id,file:name});const merged=mergeProject(result.project);
    setBuffers(b=>{const n={...b};delete n[name];return n;});setDirty(d=>{const n=new Set(d);n.delete(name);return n;});
    if(file===name)setFile(merged.config.entry);setModal(null);setDeleteTarget('');setTimeout(()=>disposeModel(id,name),60);notify(isWindows?`已删除 ${name}，可在回收站中还原`:`已删除 ${name}`);
  }
  function setEntry(name:string){if(project&&project.config.entry!==name)void request(async()=>{await changeConfig({...project.config,entry:name});notify(`编译入口已切换为 ${name}`);});}
  function beginCreate(){setContextMenu(null);setMenu(null);if(project)setEditing({mode:'create'});}
  const lockedNotice=()=>{const locked=['running','compiling','paused'].includes(status);if(locked)notify('程序正在运行或调试，请先停止（Ctrl+F2）再整理文件');return locked;};
  function beginRename(name:string){setContextMenu(null);if(project&&project.files.includes(name)&&!lockedNotice())setEditing({mode:'rename',file:name});}
  function confirmDelete(name:string){setContextMenu(null);if(project&&project.files.includes(name)&&!lockedNotice()){setDeleteTarget(name);setModal('delete');}}
  function reveal(name?:string){setContextMenu(null);setMenu(null);if(project)void request(()=>api('file/reveal','POST',{project:project.id,file:name}));}
  /** 用 Windows 资源管理器选择文件夹并打开为项目；非 Windows 环境退回手动输入路径。 */
  async function openFolder(){
    setMenu(null);setContextMenu(null);setBusy(true);
    try{
      let picked:{path:string|null};
      try{picked=await api('dialog/folder','POST',{title:'选择要打开的项目文件夹'});}
      catch(e){if(!(e instanceof ApiError&&e.code==='unsupported'))notify(message(e)+'。可以改为手动填写路径。');setModal('open');return;}
      if(!picked.path)return;
      if(dirty.size)await save();const opened:Project=await api('projects/open','POST',{path:picked.path});await acceptProject(opened);notify(`已打开项目「${opened.name}」`);
    }catch(e){notify(message(e));}
    finally{setBusy(false);}
  }
  function openContextMenu(event:React.MouseEvent,name?:string){event.preventDefault();event.stopPropagation();if(!project)return;if(name)setFile(name);setMenu(null);setContextMenu({x:Math.min(event.clientX,window.innerWidth-230),y:Math.min(event.clientY,window.innerHeight-(name?250:120)),file:name});}
  function treeKeys(event:React.KeyboardEvent){
    if(editing||!project)return;
    // 作用于获得焦点的文件项；焦点不在文件项上时作用于当前打开的文件。
    const target=(event.target as HTMLElement).closest<HTMLElement>('[data-file]')?.dataset.file??file;
    if(event.key==='F2'||(event.key==='F6'&&event.shiftKey)){event.preventDefault();beginRename(target);}
    else if(event.key==='Delete'){event.preventDefault();confirmDelete(target);}
    else if(event.key==='Insert'&&event.altKey){event.preventDefault();beginCreate();}
  }

  const mountEditor: OnMount = (instance, monaco) => {
    editor.current = instance;
    monacoRef.current = monaco;
    setEditorReady(value => value + 1);

    instance.onMouseDown(({event, target}) => {
      if (event.leftButton && target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && !target.detail.isAfterLines) {
        breakpointCallback.current(target.position.lineNumber);
      }
    });

    const selectionHighlight = instance.createDecorationsCollection();
    instance.onDidChangeCursorSelection(({selection}) => {
      const line = selectedLine(selection);
      const cursorLine = selection.positionLineNumber;
      selectionHighlight.set(line === cursorLine ? [] : [
        {range: new monaco.Range(line, 1, line, 1), options: {lineNumberClassName: 'selected-line-number'}},
        {range: new monaco.Range(cursorLine, 1, cursorLine, 1), options: {lineNumberClassName: 'selection-boundary-line-number'}},
      ]);
    });

    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      document.querySelector<HTMLButtonElement>('[title="保存文件与配置"]')?.click();
    });
  };

  function resize(axis:'x'|'y',event:React.PointerEvent){event.preventDefault();const rect=stage.current!.getBoundingClientRect();const move=(e:PointerEvent)=>setLayout((prev:any)=>({...prev,[axis]:axis==='x'?Math.max(.14,Math.min(.38,(e.clientX-rect.left)/rect.width)):Math.max(.28,Math.min(.75,(e.clientY-rect.top)/rect.height))}));const end=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);setLayout((l:any)=>{localStorage.setItem('cppide-layout',JSON.stringify(l));return l;});};window.addEventListener('pointermove',move);window.addEventListener('pointerup',end);}
  function addPin(){if(!project)return;if(!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\[\d+(?:\.\.\d+)?\](?:\[\d+\])?$/.test(pinText)){notify('请输入 a[100] 或 a[90..110]');return;}observe({...project.config.observe,pins:[...new Set([...project.config.observe.pins,pinText])]});setPinText('');}
  const config=project?.config;const observation=config?.observe??defaultObserve();
  const binding=config?.bindings.find(b=>b.id===selectedBinding)??config?.bindings[0];
  const variables=snapshot?.variables??[];const visualVariables=variables.filter(v=>!filter||v.name.toLowerCase().includes(filter.toLowerCase()));
  const canStep=status==='paused'&&!busy&&connected;const canStart=!['running','compiling'].includes(status)&&!busy&&connected;
  const scalarVars=visualVariables.filter(v=>v.kind==='scalar');const complexVars=visualVariables.filter(v=>v.kind!=='scalar');
  const fileLocked=['running','compiling','paused'].includes(status);
  useEffect(()=>{
    const key=(e:KeyboardEvent)=>{
      if(modal||e.repeat||e.altKey||e.metaKey)return;
      let work:(()=>Promise<unknown>)|undefined;
      if(e.key==='F8'&&e.ctrlKey){e.preventDefault();e.stopImmediatePropagation();if(editor.current)breakpointCallback.current(selectedLine(editor.current.getSelection()));return;}
      if(e.ctrlKey&&e.key==='F2')work=()=>api('action','POST',{action:'stop'});
      else if(e.ctrlKey&&e.key.toLowerCase()==='s')work=save;
      else if(!e.ctrlKey&&e.key==='F9'&&e.shiftKey){if(canStart)work=()=>start(true);}
      else if(!e.ctrlKey&&e.key==='F10'&&e.shiftKey){if(canStart)work=()=>start(false);}
      else if(!e.ctrlKey&&['F7','F8','F9'].includes(e.key)){e.preventDefault();e.stopImmediatePropagation();if(canStep)work=()=>api('action','POST',{action:e.key==='F7'?'step':e.key==='F8'?(e.shiftKey?'finish':'next'):'continue'});}
      if(work){e.preventDefault();e.stopImmediatePropagation();setAuto(false);void request(work);}
    };window.addEventListener('keydown',key,true);return()=>window.removeEventListener('keydown',key,true);
  });

  const themeOptions:{value:ThemePreference;label:string;note:string}[]=[{value:'dark',label:'深色',note:'类 CLion Dark'},{value:'light',label:'浅色',note:'类 CLion Light'},{value:'system',label:'跟随系统',note:'随 Windows 设置切换'}];
  const projectInitial=(project?.name||'?').trim().slice(0,1).toUpperCase();
  const modalTitle={new:'新建项目',open:'打开项目',delete:'删除文件',binding:'变量与图结构绑定',settings:'设置',help:'快速上手'} as const;

  return <div className="app-shell">
    <header className="app-header">
      <div className="header-left">
        <div className="brand" title="ACM Helper · 让算法执行过程看得见"><span className="brand-mark">A</span><span className="brand-name">ACM Helper</span></div>
        <div className="project-widget menu-root">
          <button className={`project-button ${menu==='project'?'open':''}`} title="切换、新建或打开项目" onClick={()=>{setContextMenu(null);setMenu(menu==='project'?null:'project');}}><span className="project-avatar">{projectInitial}</span><span className="project-name">{project?.name||'正在连接本地服务…'}</span><ChevronDown size={14}/></button>
          {menu==='project'&&<div className="dropdown-menu" role="menu">
            <div className="menu-heading">项目</div>
            <div className="menu-scroll">{projects.map(p=><button role="menuitem" key={p.id} className={p.id===project?.id?'current':''} onClick={()=>{setMenu(null);void request(()=>selectProject(p.id));}}><span className="project-avatar small">{p.name.trim().slice(0,1).toUpperCase()}</span><span className="menu-text">{p.name}<small>{p.path}</small></span>{p.id===project?.id&&<Check size={14}/>}</button>)}</div>
            <hr/>
            <button role="menuitem" onClick={()=>{setMenu(null);setNewName('');setModal('new');}}><Plus size={14}/><span className="menu-text">新建项目…</span></button>
            <button role="menuitem" disabled={busy} onClick={()=>void openFolder()}><FolderOpen size={14}/><span className="menu-text">打开文件夹…</span></button>
            {isWindows&&project&&<button role="menuitem" onClick={()=>reveal()}><ExternalLink size={14}/><span className="menu-text">在资源管理器中显示</span></button>}
          </div>}
        </div>
      </div>
      <div className="header-tools">
        <button title="开始调试 (Shift+F9)" className="primary-action" disabled={!canStart} onClick={()=>void request(()=>start(true))}><Bug size={15}/><span className="label">调试</span></button>
        <button title="运行 (Shift+F10)" className="icon-run" disabled={!canStart} onClick={()=>void request(()=>start(false))}><Play size={15}/><span className="label">运行</span></button>
        <button title="停止程序 (Ctrl+F2)" className="icon-stop" disabled={status==='idle'&&!busy} onClick={()=>{setAuto(false);void request(()=>api('action','POST',{action:'stop'}));}}><Square size={13}/></button>
        <i className="separator"/>
        <button title="下一步 (F8)" className="icon-step" disabled={!canStep} onClick={()=>void request(()=>api('action','POST',{action:'next'}))}><StepForward size={16}/><span className="label">下一步</span></button>
        <button title="进入函数 (F7)" className="icon-step" disabled={!canStep} onClick={()=>void request(()=>api('action','POST',{action:'step'}))}><ArrowDownToLine size={16}/></button>
        <button title="跳出函数 (Shift+F8)" className="icon-step" disabled={!canStep} onClick={()=>void request(()=>api('action','POST',{action:'finish'}))}><ArrowUpFromLine size={16}/></button>
        <button title="继续到下一个断点 (F9)" className="icon-run" disabled={!canStep} onClick={()=>{setAuto(false);void request(()=>api('action','POST',{action:'continue'}));}}><SkipForward size={16}/></button>
        <i className="separator"/>
        <button title="按设定速度自动单步" className={auto?'playing':''} disabled={!auto&&!canStep} onClick={()=>setAuto(!auto)}>{auto?<Pause size={14}/>:<Play size={14}/>}<span className="label">{auto?'暂停播放':'自动单步'}</span></button>
        <SpeedControl value={speed} onChange={setSpeed} actual={auto?actualRate:0}/>
      </div>
      <div className="header-right">
        <div className={`status-chip ${status}`}><span/>{statusNames[status]}</div>
        <button className="icon-button" title={theme==='dark'?'切换到浅色主题':'切换到深色主题'} onClick={()=>setPreference(theme==='dark'?'light':'dark')}>{theme==='dark'?<Sun size={16}/>:<Moon size={16}/>}</button>
        <button className="icon-button" title="快速上手" onClick={()=>setModal('help')}><BookOpen size={16}/></button>
        <button className="icon-button" title="设置" onClick={()=>void request(async()=>{setTools(await api('tools'));setModal('settings');})}><Settings size={16}/></button>
      </div>
    </header>
    <main className="workspace" ref={stage} style={{gridTemplateColumns:`${layout.x*100}% 1fr`,gridTemplateRows:`${layout.y*100}% 1fr`}}>
      <section className="project-pane">
        <div className="pane-title"><span>项目</span><div className="pane-actions"><button title="新建源文件 (Alt+Insert)" disabled={!project} onClick={beginCreate}><FilePlus2 size={15}/></button><button title="打开文件夹…" disabled={busy} onClick={()=>void openFolder()}><FolderOpen size={15}/></button></div></div>
        <div className="file-tree" tabIndex={-1} onKeyDown={treeKeys} onContextMenu={e=>openContextMenu(e)}>
          {project&&<div className="tree-root" title={project.path}><ChevronDown size={13}/><Folder size={15}/><span>{project.name}</span></div>}
          {project?.files.map(name=>editing?.mode==='rename'&&editing.file===name
            ?<InlineName key={name} initial={name} placeholder="新文件名" onCommit={value=>renameSource(name,value)} onCancel={()=>setEditing(null)}/>
            :<button key={name} data-file={name} className={`file-item ${name===file?'active':''}`} title={name} onClick={()=>setFile(name)} onDoubleClick={()=>beginRename(name)} onContextMenu={e=>openContextMenu(e,name)}>
              <FileIcon name={name}/><span className="file-name">{name}</span>{dirty.has(name)&&<i className="dirty-dot" title="未保存"/>}{name===config?.entry&&<small className="entry-badge" title="运行和调试时编译的文件">入口</small>}
              <span className="file-actions"><span role="button" tabIndex={-1} title="重命名 (F2)" onClick={e=>{e.stopPropagation();beginRename(name);}}><Pencil size={12}/></span><span role="button" tabIndex={-1} title="删除 (Delete)" onClick={e=>{e.stopPropagation();confirmDelete(name);}}><Trash2 size={12}/></span></span>
            </button>)}
          {editing?.mode==='create'&&<InlineName initial="" placeholder="文件名，如 solve.cpp" onCommit={createSource} onCancel={()=>setEditing(null)}/>}
          {project&&!editing&&<button className="tree-add" onClick={beginCreate}><Plus size={13}/>新建源文件</button>}
        </div>
        {fileLocked&&<div className="pane-note">运行或调试中，重命名与删除暂不可用</div>}
      </section>
      <section className="editor-pane"><div className="editor-tabs"><div className="file-tab"><FileIcon name={file}/>{file}{dirty.has(file)&&<span className="dirty-dot"/>}</div><div className="editor-tools">{snapshot&&status==='paused'&&!projectFileFor(snapshot.location,project?.files)&&<span className="outside-note" title={snapshot.location.file}>暂停在项目外的代码 · {snapshot.location.function}</span>}<span className="source-legend"><i/>下一执行行</span><span className="source-legend executed"><i/>上次暂停行</span><button title="保存文件与配置" disabled={!project||busy} onClick={()=>void request(async()=>{await save();notify('文件与配置已保存');})}><Save size={14}/><span>保存</span></button></div></div><div className="editor-body"><Editor path={`${project?.id}/${file}`} value={buffers[file]??''} language="cpp" theme={theme==='dark'?'cppide-dark':'cppide-light'} onChange={value=>{const monaco=monacoRef.current;if(monaco&&editor.current?.getOption(monaco.editor.EditorOption.readOnly))return;/* 只读（运行 / 调试中）时的内容变化来自加载文件，不是用户编辑 */const text=value??'';if(buffersRef.current[file]===text)return;setBuffers(b=>({...b,[file]:text}));setDirty(d=>new Set([...d,file]));}} beforeMount={defineEditorThemes} onMount={mountEditor} options={{fontSize:13,fontFamily:"'JetBrains Mono', 'Cascadia Code', Consolas, 'Microsoft YaHei', monospace",lineHeight:22,minimap:{enabled:false},glyphMargin:true,lineNumbersMinChars:3,lineDecorationsWidth:6,showFoldingControls:'mouseover',scrollBeyondLastLine:false,automaticLayout:true,padding:{top:10},renderLineHighlight:'line',tabSize:4,smoothScrolling:true,overviewRulerLanes:0,readOnly:status==='running'||status==='compiling'||status==='paused',bracketPairColorization:{enabled:false},guides:{indentation:true},scrollbar:{verticalScrollbarSize:10,horizontalScrollbarSize:10}}}/></div></section>
      <section className="console-pane"><div className="pane-title"><span>控制台</span><div className="pane-actions"><button title="清空输出" onClick={()=>{setOutputs([]);setTerminalText('');}}><RotateCcw size={13}/></button></div></div>
        <div className="small-tabs"><button className={consoleTab==='output'?'selected':''} onClick={()=>setConsoleTab('output')}><Terminal size={13}/>终端</button><button className={consoleTab==='build'?'selected':''} onClick={()=>setConsoleTab('build')}>编译</button>{config?.inputMode==='preset'&&<button className={consoleTab==='input'?'selected':''} onClick={()=>setConsoleTab('input')}>预置输入</button>}</div>
        <div className="terminal-container" style={{display:consoleTab==='output'&&config?.inputMode!=='preset'?'flex':'none'}}><TerminalView text={terminalText} session={terminalSession} theme={theme} enabled={connected&&['running','paused'].includes(status)} onInput={terminalInput} onResize={(cols,rows)=>{if(authToken)void api('terminal','POST',{cols,rows}).catch(()=>{});}}/><div className="terminal-status">{status==='running'?'运行中 · 点击终端输入':status==='paused'?'已暂停 · 继续执行后读取输入':status==='exited'?'进程已结束':status==='compiling'?'正在编译':'运行后可输入'}</div></div>
        {consoleTab==='input'?<div className="input-panel"><textarea aria-label="预置输入" value={config?.stdin??''} onChange={e=>project&&setProject({...project,config:{...project.config,stdin:e.target.value}})} placeholder="运行前提供的标准输入"/><button onClick={()=>void request(save)}><Save size={12}/>保存输入</button></div>:(consoleTab==='build'||config?.inputMode==='preset')&&<div className="console-output">{outputs.filter(o=>consoleTab==='build'?o.channel==='build':o.channel!=='build').map((o,i)=><pre className={o.channel} key={i} onDoubleClick={()=>{const m=/([^\s:]+\.(?:cpp|cc|cxx|h|hpp)):(\d+):/.exec(o.text);if(m){if(project?.files.includes(m[1]))setFile(m[1]);editor.current?.revealLineInCenter(Number(m[2]));editor.current?.setPosition({lineNumber:Number(m[2]),column:1});}}}>{o.text}</pre>)}<div ref={consoleEnd}/></div>}
      </section>
      <section className="debug-pane"><div className="debug-heading"><div className="debug-tabs"><button className={tab==='visual'?'selected':''} onClick={()=>setTab('visual')}><Network size={14}/>可视化</button><button className={tab==='variables'?'selected':''} onClick={()=>setTab('variables')}><Braces size={14}/>普通变量</button></div><div className="debug-actions"><button title="重置变化标记和观察基线" disabled={!canStep} onClick={()=>void request(()=>api('action','POST',{action:'reset'}))}><RotateCcw size={13}/></button><button title="专注图结构" className={focus?'playing':''} onClick={()=>setFocus(!focus)}><Focus size={15}/></button><button className="binding-button" onClick={()=>{setBindingDraft(binding?structuredClone(binding):defaultBinding());setModal('binding');}}><SlidersHorizontal size={13}/>结构绑定</button></div></div>
        <div className="watchbar"><Pin size={12}/><input aria-label="指定查看变量" placeholder="指定查看：a[100] 或 a[90..110]" value={pinText} onChange={e=>setPinText(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addPin()}/><button title="固定查看" onClick={addPin}><Plus size={14}/></button><label title="折叠相同值区间"><input type="checkbox" checked={observation.fold} onChange={e=>observe({...observation,fold:e.target.checked})}/>折叠</label><label title="规则推断可能误判，可随时关闭"><input type="checkbox" checked={observation.inferInitialization} onChange={e=>observe({...observation,inferInitialization:e.target.checked})}/>初始化推断</label></div>
        {!!observation.pins.length&&<div className="pin-list">{observation.pins.map(pin=><span key={pin}><Pin size={10}/>{pin}<button aria-label={`取消固定 ${pin}`} onClick={()=>observe({...observation,pins:observation.pins.filter(p=>p!==pin)})}><X size={10}/></button></span>)}</div>}
        <div className="debug-content">{tab==='variables'&&<VariableTable variables={variables} step={snapshot?.step??0} observe={observation} onObserve={observe}/>}<div className={`visual-layout ${binding?'with-graph':''} ${focus?'graph-focus':''}`} style={tab==='visual'?undefined:{display:'none'}}>
          {binding&&<div className="graph-column">{config!.bindings.length>1&&<select aria-label="图结构" value={binding.id} onChange={e=>setSelectedBinding(e.target.value)}>{config!.bindings.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select>}<GraphView binding={binding} snapshot={snapshot} theme={theme} onPositions={positions=>{if(project)changeConfig({...project.config,bindings:project.config.bindings.map(b=>b.id===binding.id?{...b,positions}:b)}).catch(e=>notify(message(e)));}}/></div>}
          <div className="variables-column"><div className="variables-caption"><span>变量观察 <small>{variables.length}</small></span><input aria-label="筛选变量" placeholder="筛选变量" value={filter} onChange={e=>setFilter(e.target.value)}/></div>{!snapshot?<div className="visual-empty"><div className="preview-array"><span>3</span><span className="green">1</span><span>4</span><span>1</span><span>5</span></div><h3>开始调试后，变量在这里“动起来”</h3><p>点击行号左侧设置断点，按 Shift+F9 开始调试，再按 F8 一步步执行。</p></div>:<>{snapshot.frames.length>1&&snapshot.frame===0&&snapshot.frames[1]&&<p className="frame-hint">正在 <b>{snapshot.location.function}</b> 中，这里只显示它自己的变量。要看 <b>{snapshot.frames.find(f=>f.level>0&&f.user!==false)?.name??snapshot.frames[1].name}</b> 里的数组等变量，点击下方「调用栈」切换。</p>}<div className="scalar-strip">{scalarVars.map(v=><div className="scalar-chip" key={v.id}><span title={v.type}>{v.name}</span><b key={v.pulse?snapshot.step:'stable'} className={`${v.changed?'changed':''} ${v.pulse?'pulse':''}`}>{v.value}</b></div>)}</div>{complexVars.map(v=><VariableCard key={v.id} v={v} step={snapshot.step} observe={observation} onObserve={observe} infinity={binding?snapshot.bindingData?.[binding.id]?.infinity:undefined}/>)}{!variables.length&&<p className="hint">当前位置没有可读取的用户变量。可切换调用栈，或返回用户代码继续观察。</p>}</>}
            <details className="monitor-settings"><summary>监测范围 <small>最多 8 MiB</small></summary><p>留空表示完整监测；超过预算的数组需指定范围。区间外未完整监测。</p><div><input aria-label="监测数组名称" placeholder="数组名，如 a" value={rangeName} onChange={e=>setRangeName(e.target.value)}/><input aria-label="监测下标区间" placeholder="0..9999" value={rangeText} onChange={e=>setRangeText(e.target.value)}/><button onClick={()=>{const m=/^(\d+)\.\.(\d+)$/.exec(rangeText);if(!rangeName||(!m&&rangeText)){notify('填写数组名及 0..9999 格式的区间');return;}const ranges={...observation.ranges};if(m&&Number(m[1])<=Number(m[2]))ranges[rangeName]=[Number(m[1]),Number(m[2])];else if(!rangeText)delete ranges[rangeName];else{notify('区间起点不能大于终点');return;}observe({...observation,ranges});}}>应用</button></div>{Object.entries(observation.ranges).map(([n,r])=><small key={n}>{n}[{r[0]}..{r[1]}] </small>)}</details>
          </div></div></div>
        <div className="stack-panel"><button className="stack-toggle" onClick={()=>setStackOpen(!stackOpen)}>{stackOpen?<ChevronDown size={12}/>:<ChevronRight size={12}/>}<Layers size={12}/>调用栈 <small>{snapshot?.frames.length??0}</small><span>{snapshot?`${snapshot.location.function} : ${snapshot.location.line}`:''}</span></button>{stackOpen&&<div className="stack-frames">{snapshot?.frames.map(f=><button className={`${snapshot.frame===f.level?'active':''} ${f.user===false?'library':''}`} key={f.id} title={`${f.name}\n${f.file}:${f.line}`} disabled={!canStep} onClick={()=>void request(()=>api('action','POST',{action:'frame',level:f.level}))}><span>#{f.level}</span><b>{f.name}</b><small>{f.file?`${f.file.split('/').pop()}:${f.line}`:'无源码'}</small></button>)}</div>}</div>
      </section>
      <div className="resize-x" style={{left:`${layout.x*100}%`}} onPointerDown={e=>resize('x',e)}/><div className="resize-y" style={{top:`${layout.y*100}%`}} onPointerDown={e=>resize('y',e)}/>
    </main>
    <footer className="statusbar"><span><i className={connected?'online':'offline'}/>{connected?'本地服务已连接':'正在连接本地服务…'}</span><span>{snapshot?`第 ${snapshot.step} 步 · 采集 ${snapshot.elapsedMs} ms · ${(snapshot.monitoredBytes/1024/1024).toFixed(2)} MiB`:'真实 GCC / GDB 执行'}</span><span className="status-right"><span className="legend-chip"><i className="green"/>数值改变</span>{snapshot&&<span>第 {snapshot.location.line} 行</span>}<span>{config?.entry}</span><span>C++17</span><span>UTF-8</span></span></footer>
    {contextMenu&&project&&<div className="context-menu dropdown-menu menu-root" role="menu" style={{left:contextMenu.x,top:contextMenu.y}} onContextMenu={e=>e.preventDefault()}>
      {contextMenu.file?<>
        <div className="menu-heading">{contextMenu.file}</div>
        <button role="menuitem" onClick={beginCreate}><FilePlus2 size={14}/><span className="menu-text">新建源文件</span><kbd>Alt+Insert</kbd></button>
        <button role="menuitem" disabled={fileLocked} onClick={()=>beginRename(contextMenu.file!)}><Pencil size={14}/><span className="menu-text">重命名…</span><kbd>F2</kbd></button>
        {/\.(cpp|cc|cxx)$/i.test(contextMenu.file)&&<button role="menuitem" disabled={contextMenu.file===config?.entry} onClick={()=>{setContextMenu(null);setEntry(contextMenu.file!);}}><Flag size={14}/><span className="menu-text">设为编译入口</span></button>}
        {isWindows&&<button role="menuitem" onClick={()=>reveal(contextMenu.file)}><ExternalLink size={14}/><span className="menu-text">在资源管理器中显示</span></button>}
        <hr/>
        <button role="menuitem" className="danger" disabled={fileLocked} onClick={()=>confirmDelete(contextMenu.file!)}><Trash2 size={14}/><span className="menu-text">删除</span><kbd>Delete</kbd></button>
      </>:<>
        <button role="menuitem" onClick={beginCreate}><FilePlus2 size={14}/><span className="menu-text">新建源文件</span><kbd>Alt+Insert</kbd></button>
        <button role="menuitem" disabled={busy} onClick={()=>void openFolder()}><FolderOpen size={14}/><span className="menu-text">打开文件夹…</span></button>
        {isWindows&&<button role="menuitem" onClick={()=>reveal()}><ExternalLink size={14}/><span className="menu-text">在资源管理器中显示</span></button>}
      </>}
    </div>}
    {toast&&<div role="status" className="toast"><AlertCircle size={16}/>{toast}<button onClick={()=>setToast('')}><X size={14}/></button></div>}
    {modal&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setModal(null);}}><section className={`modal ${modal==='binding'||modal==='settings'?'wide':''} ${modal==='delete'?'compact':''}`} role="dialog" aria-modal="true"><header><h2>{modalTitle[modal]}</h2><button aria-label="关闭对话框" onClick={()=>setModal(null)}><X size={18}/></button></header>
      {modal==='new'&&<><p className="modal-intro">新项目包含一个带 main 函数的 main.cpp，保存在本工具的 projects 文件夹中。</p><label className="field">项目名称<input autoFocus value={newName} placeholder="未命名项目" onChange={e=>setNewName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')(e.currentTarget.closest('section')?.querySelector('footer .primary') as HTMLButtonElement|null)?.click();}}/></label><footer><button onClick={()=>setModal(null)}>取消</button><button className="primary" disabled={busy} onClick={()=>void request(async()=>{await save();await acceptProject(await api('projects','POST',{name:newName||'未命名项目'}));})}>创建项目</button></footer></>}
      {modal==='open'&&<><p className="modal-intro">当前环境无法弹出资源管理器，请填写本机项目文件夹路径，或从下方选择已打开过的项目。</p><label className="field">项目文件夹<input autoFocus value={openPath} placeholder="C:\项目文件夹" onChange={e=>setOpenPath(e.target.value)}/></label><div className="recent-projects">{projects.map(p=><button key={p.id} onClick={()=>void request(async()=>{await selectProject(p.id);setModal(null);})}><FolderOpen size={14}/><span>{p.name}<small>{p.path}</small></span></button>)}</div><footer><button onClick={()=>setModal(null)}>取消</button><button className="primary" disabled={busy||!openPath.trim()} onClick={()=>void request(async()=>{await save();await acceptProject(await api('projects/open','POST',{path:openPath.trim()}));})}>打开项目</button></footer></>}
      {modal==='delete'&&<><p className="modal-intro">确定删除 <b className="mono">{deleteTarget}</b> 吗？{isWindows?'文件会移到回收站，需要时可以从回收站还原（U 盘、网络位置等没有回收站的磁盘除外）。':'删除后无法恢复。'}{dirty.has(deleteTarget)&&' 该文件尚未保存的修改也会被丢弃。'}{deleteTarget===config?.entry&&' 它是当前编译入口，删除后会自动改用项目中的其他 .cpp 文件。'}</p><footer><button autoFocus onClick={()=>setModal(null)}>取消</button><button className="danger" disabled={busy} onClick={()=>void request(()=>deleteSource(deleteTarget))}><Trash2 size={13}/>删除</button></footer></>}
      {modal==='settings'&&<div className="settings">
        <section className="settings-section"><h3>外观</h3><div className="theme-options">{themeOptions.map(option=><button key={option.value} className={`theme-option ${preference===option.value?'selected':''}`} onClick={()=>setPreference(option.value)}>
          <span className={`theme-preview ${option.value}`}><span className="tp-bar"/><span className="tp-side"/><span className="tp-code"><i/><i/><i/><i/></span></span>
          <span className="theme-label">{option.value==='dark'?<Moon size={13}/>:option.value==='light'?<Sun size={13}/>:<Monitor size={13}/>}{option.label}{preference===option.value&&<Check size={13} className="theme-check"/>}</span><small>{option.note}</small></button>)}</div><small className="settings-note">界面、代码编辑器、终端和图视图会同步切换配色，立即生效。</small></section>
        <section className="settings-section"><h3>运行</h3><div className="settings-grid"><label className="field">标准输入<select value={config?.inputMode??"terminal"} onChange={e=>project&&setProject({...project,config:{...project.config,inputMode:e.target.value as "terminal"|"preset"}})}><option value="terminal">交互终端</option><option value="preset">运行前预置输入</option></select></label><label className="field">编译入口<select value={config?.entry} onChange={e=>project&&setProject({...project,config:{...project.config,entry:e.target.value}})}>{project?.files.filter(f=>/\.(cpp|cc|cxx)$/i.test(f)).map(f=><option key={f}>{f}</option>)}</select></label></div></section>
        <section className="settings-section"><h3>工具链</h3><div className="settings-grid"><label className="field">C++ 编译器<input value={tools.compiler??''} onChange={e=>setTools({...tools,compiler:e.target.value})}/><small>{tools.compilerVersion}</small></label><label className="field">GDB 调试器<input value={tools.debugger??''} onChange={e=>setTools({...tools,debugger:e.target.value})}/><small>{tools.debuggerVersion}</small></label></div></section>
        <footer><button onClick={()=>setModal(null)}>关闭</button><button className="primary" onClick={()=>void request(async()=>{await api('tools','PUT',tools);await save();setTools(await api('tools'));notify('设置已保存');})}>保存并检查工具链</button></footer>
      </div>}
      {modal==='binding'&&bindingDraft&&<BindingForm value={bindingDraft} onChange={setBindingDraft} onSave={()=>void request(async()=>{if(!project)return;const list=project.config.bindings.filter(b=>b.id!==bindingDraft.id);await changeConfig({...project.config,bindings:[...list,bindingDraft]},true);setSelectedBinding(bindingDraft.id);setModal(null);})} onNew={()=>setBindingDraft(defaultBinding())} onDelete={()=>void request(async()=>{if(project)await changeConfig({...project.config,bindings:project.config.bindings.filter(b=>b.id!==bindingDraft.id)},true);setModal(null);})}/>}
      {modal==='help'&&<div className="help-content"><div><span>01</span><section><h3>写一段算法，或打开示例</h3><p>点击左上角项目名 →「打开文件夹…」，选择 example 里的任意示例；也可以新建项目自己写。右键文件可新建、重命名、删除或设为编译入口。</p></section></div><div><span>02</span><section><h3>设断点，开始调试</h3><p>点击行号左侧设置断点，按 Shift+F9 开始调试。需要输入时，点击下方终端输入并回车。</p></section></div><div><span>03</span><section><h3>一步一步，看数据怎么变</h3><p>F8 执行一行，F7 进入函数（适合看递归）。蓝色行是下一步要执行的位置，变化的数值原地变绿；「自动单步」可以像动画一样连续播放。</p></section></div><div><span>04</span><section><h3>把数组看成图和树</h3><p>数组、二维数组自动展示；邻接矩阵、边表、父节点数组可以通过「结构绑定」画成图或树，并标出访问状态、当前节点和距离。</p></section></div><p className="help-note">快捷键（与 CLion 一致）：F8 下一步 · F7 进入 · Shift+F8 跳出 · F9 继续 · Shift+F9 调试 · Shift+F10 运行 · Ctrl+F2 停止 · Ctrl+F8 断点 · Ctrl+S 保存 · F2 重命名文件 · Delete 删除文件</p></div>}
    </section></div>}
  </div>;
}

function BindingForm({value:b,onChange,onSave,onDelete,onNew}:{value:Binding;onChange:(b:Binding)=>void;onSave:()=>void;onDelete:()=>void;onNew:()=>void}){
  const field=(key:keyof Binding,label:string,placeholder='',type='text')=><label className="field" key={key}>{label}<input type={type} value={String(b[key])} placeholder={placeholder} onChange={e=>onChange({...b,[key]:type==='number'?Number(e.target.value):e.target.value})}/></label>;
  return <><p className="modal-intro">只描述数据结构与变量角色，同一份配置可以用于不同算法。配置不会修改源代码。</p><div className="binding-types">{([['matrix','邻接矩阵'],['edges','边表数组'],['parent','父节点数组']] as const).map(([kind,label])=><button key={kind} className={b.kind===kind?'selected':''} onClick={()=>onChange({...b,kind})}>{label}</button>)}</div><div className="binding-fields">{field('name','视图名称')}{field('count','节点数量 / 表达式','n')}{b.kind==='edges'?<>{field('from','起点数组','from')}{field('to','终点数组','to')}{field('weight','权重数组（可空）','weight')}{field('edgeCount','边数量 / 表达式','m')}</>:<>{field('source',b.kind==='matrix'?'矩阵变量':'父节点数组',b.kind==='matrix'?'G':'parent')}{field('absent',b.kind==='matrix'?'无边标记 / 表达式':'无父节点标记','INF 或 -1')}</>}<label className="field">节点起始下标<select value={b.base} onChange={e=>onChange({...b,base:Number(e.target.value)})}><option value={0}>0</option><option value={1}>1</option></select></label><label className="field">边的方向<select value={b.directed?'yes':'no'} onChange={e=>onChange({...b,directed:e.target.value==='yes'})}><option value="no">无向</option><option value="yes">有向</option></select></label>{b.kind==='matrix'&&<label className="field">边权显示<select value={b.weight==='none'?'none':'value'} onChange={e=>onChange({...b,weight:e.target.value})}><option value="value">显示矩阵值</option><option value="none">不显示权重</option></select></label>}{field('root','根节点 / 表达式（可空）','0')}{field('labels','节点标签数组（数值，可空）')}{field('status','状态数组（可空）','visited')}{field('distance','节点附加数值数组（可空）','dist')}{field('infinity','显示为 ∞ 的值 / 表达式（可空）','INF')}{field('current','当前节点变量（可空）','u')}{field('target','当前边终点变量（可空）','v')}{field('lineStart','高亮起始行（0 为不限）','','number')}{field('lineEnd','高亮结束行（0 为不限）','','number')}</div><p className="hint">边表的边记录从下标 0 读取，节点编号按上述起始下标解释。无边标记与零权边需明确区分。</p><footer><button className="danger-text" onClick={onDelete}>移除此绑定</button><button onClick={onNew}><Plus size={13}/>新增绑定</button><button className="primary" onClick={onSave}><Link2 size={13}/>保存绑定</button></footer></>;
}

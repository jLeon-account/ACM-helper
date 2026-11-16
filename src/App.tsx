import {useEffect,useRef,useState,useCallback} from 'react';
import Editor, {type OnMount} from '@monaco-editor/react';
import type {editor as MonacoEditor, Selection} from 'monaco-editor';
import {Play,Bug,SkipForward,StepForward,ArrowDownToLine,ArrowUpFromLine,Square,Pause,Save,Plus,Settings2,FolderOpen,FileCode2,ChevronDown,ChevronRight,Terminal,Network,Braces,Layers,Check,AlertCircle,X,Pin,RotateCcw,BookOpen,SlidersHorizontal,Focus,Link2} from 'lucide-react';
import {defaultBinding,defaultObserve,type Project,type ProjectConfig,type Snapshot,type DebugStatus,type ServerEvent,type Binding,type ObserveOptions} from '../shared/types';
import {VariableCard,VariableTable} from './Variables';
import GraphView from './GraphView';
import TerminalView from './TerminalView';
import SpeedControl from './SpeedControl';

let authToken='';
async function api(route:string,method='GET',data?:unknown){const response=await fetch('/api/'+route,{method,headers:{'Content-Type':'application/json','X-Cppide-Token':authToken},body:data===undefined?undefined:JSON.stringify(data)});const value=await response.json();if(!response.ok)throw new Error(value.error||'请求失败');return value;}
const statusNames:Record<DebugStatus,string>={idle:'就绪',compiling:'编译中',running:'运行中',paused:'已暂停',exited:'运行结束',error:'发生错误'};
type Output={channel:string;text:string};

function selectedLine(selection: Selection | null) {
  if (!selection) return 1;
  // Monaco includes the newline in an entire-line selection.
  if (selection.positionColumn === 1 && selection.positionLineNumber > selection.selectionStartLineNumber) {
    return selection.positionLineNumber - 1;
  }
  return selection.positionLineNumber;
}

export default function App(){
  const [projects,setProjects]=useState<Project[]>([]);const [project,setProject]=useState<Project>();const projectRef=useRef<Project | undefined>(undefined);projectRef.current=project;
  const [file,setFile]=useState('main.cpp');const [buffers,setBuffers]=useState<Record<string,string>>({});const [dirty,setDirty]=useState<Set<string>>(new Set());
  const [status,setStatus]=useState<DebugStatus>('idle');const [snapshot,setSnapshot]=useState<Snapshot>();const [outputs,setOutputs]=useState<Output[]>([]);
  const [tab,setTab]=useState<'visual'|'variables'>('visual');const [consoleTab,setConsoleTab]=useState<'output'|'input'|'build'>('output');
  const [auto,setAuto]=useState(false);const [speed,setSpeed]=useState(()=>Number(localStorage.getItem('cppide-speed'))||2);const [busy,setBusy]=useState(false);const [connected,setConnected]=useState(false);
  const [toast,setToast]=useState('');const [modal,setModal]=useState<'new'|'open'|'file'|'binding'|'settings'|'help'|null>(null);const [bindingDraft,setBindingDraft]=useState<Binding>();
  const [newName,setNewName]=useState('');const [openPath,setOpenPath]=useState('');const [newFile,setNewFile]=useState('');const [tools,setTools]=useState<any>({});
  const [terminalText,setTerminalText]=useState('');const [terminalSession,setTerminalSession]=useState('');const inputQueue=useRef(Promise.resolve());
  const [pinText,setPinText]=useState('');const [stackOpen,setStackOpen]=useState(false);const [focus,setFocus]=useState(false);const [selectedBinding,setSelectedBinding]=useState('');
  const [filter,setFilter]=useState('');const [rangeName,setRangeName]=useState('');const [rangeText,setRangeText]=useState('');
  const [layout,setLayout]=useState(()=>{try{return JSON.parse(localStorage.getItem('cppide-layout')||'{"x":0.2,"y":0.55}');}catch{return {x:.2,y:.55};}});
  const stage=useRef<HTMLDivElement>(null);const editor=useRef<MonacoEditor.IStandaloneCodeEditor | undefined>(undefined);const decoration=useRef<MonacoEditor.IEditorDecorationsCollection | undefined>(undefined);const breakDecoration=useRef<MonacoEditor.IEditorDecorationsCollection | undefined>(undefined);const consoleEnd=useRef<HTMLDivElement>(null);const [editorReady,setEditorReady]=useState(0);
  const breakpointCallback=useRef<(line:number)=>void>(()=>{});const lastSnapshot=useRef<Snapshot | undefined>(undefined);const [executedLine,setExecutedLine]=useState(0);const currentSession=useRef('');
  const notify=useCallback((text:string)=>setToast(text),[]);
  useEffect(()=>{if(!toast)return;const t=setTimeout(()=>setToast(''),6500);return()=>clearTimeout(t);},[toast]);
  const request=useCallback(async<T,>(work:()=>Promise<T>):Promise<T|undefined>=>{setBusy(true);try{return await work();}catch(e){notify(e instanceof Error?e.message:String(e));setAuto(false);}finally{setBusy(false);}},[notify]);

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
          if(message.session!==currentSession.current){currentSession.current=message.session;lastSnapshot.current=undefined;setSnapshot(undefined);setExecutedLine(0);}
          setStatus(message.status);if(['idle','exited','error'].includes(message.status))setAuto(false);if(message.status==='running')setConsoleTab('output');
        }else if(message.type==='snapshot'){
          const next=message.snapshot;if(next.session!==currentSession.current)return;
          if(lastSnapshot.current&&next.step<lastSnapshot.current.step)return;
          if(!['refresh','reset','frame'].includes(next.reason))setExecutedLine(lastSnapshot.current?.location.line??0);
          lastSnapshot.current=next;setSnapshot(next);
        }else if(message.type==='terminal'){if(message.session!==currentSession.current)return;setTerminalSession(message.session);setTerminalText(previous=>message.reset?message.data:(previous+message.data).slice(-2*1024*1024));}
        else if(message.type==='output'){setOutputs(previous=>[...previous,{channel:message.channel,text:message.text}].slice(-1500));}
        else if(message.type==='error'){notify(message.message);setAuto(false);}
      };
      socket.onclose=()=>{setConnected(false);setAuto(false);if(!disposed)retry=setTimeout(connect,1500);};
    }catch(e){if(!disposed){setConnected(false);retry=setTimeout(connect,2000);}}}
    void connect();return()=>{disposed=true;clearTimeout(retry);socket?.close();};
  },[notify]);
  useEffect(()=>{if(!project)return;const id=project.id;let canceled=false;if(buffers[file]===undefined)void api(`file?project=${id}&file=${encodeURIComponent(file)}`).then(data=>{if(!canceled)setBuffers(old=>({...old,[file]:data.content}));}).catch(e=>notify(e.message));return()=>{canceled=true;};},[project?.id,file,buffers,notify]);
  useEffect(()=>{consoleEnd.current?.scrollIntoView({block:'end'});},[outputs,consoleTab]);
  useEffect(()=>{if(!auto||status!=='paused'||busy)return;const timer=setTimeout(()=>void request(()=>api('action','POST',{action:'next'})),1000/Math.max(.1,Math.min(100,speed)));return()=>clearTimeout(timer);},[auto,status,snapshot?.step,busy,speed,request]);
  useEffect(()=>{if(!editor.current)return;const points=project?.config.breakpoints[file]??[];breakDecoration.current?.clear();breakDecoration.current=editor.current.createDecorationsCollection(points.map(line=>({range:{startLineNumber:line,startColumn:1,endLineNumber:line,endColumn:1},options:{glyphMarginClassName:'breakpoint-dot',glyphMarginHoverMessage:{value:'点击移除断点'}}})));},[project?.config.breakpoints,file,editorReady,buffers[file]]);
  useEffect(()=>{
    if(!editor.current)return;decoration.current?.clear();if(!snapshot||status==='idle')return;
    const source=snapshot.location.file.replaceAll('\\','/');if(source!==file&&!source.endsWith('/'+file))return;
    const line=snapshot.location.line;if(line<1)return;
    const markings:MonacoEditor.IModelDeltaDecoration[]=[{range:{startLineNumber:line,startColumn:1,endLineNumber:line,endColumn:1},options:{isWholeLine:true,className:'next-source-line',marginClassName:'execution-arrow'}}];
    if(executedLine>0&&executedLine!==line)markings.push({range:{startLineNumber:executedLine,startColumn:1,endLineNumber:executedLine,endColumn:1},options:{isWholeLine:true,className:'executed-source-line'}});
    decoration.current=editor.current.createDecorationsCollection(markings);editor.current.revealLineInCenterIfOutsideViewport(line);
  },[snapshot,status,file,executedLine,editorReady,buffers[file]]);

  async function save(){if(!project)return;for(const name of dirty)await api('file','PUT',{project:project.id,file:name,content:buffers[name]});await api('config','PUT',{project:project.id,config:project.config});setDirty(new Set());}
  async function changeConfig(config:ProjectConfig,refresh=false){if(!project)return;setProject({...project,config});setProjects(list=>list.map(p=>p.id===project.id?{...p,config}:p));await api('config','PUT',{project:project.id,config});if(refresh&&status==='paused')await api('action','POST',{action:'refresh',config});}
  function observe(options:ObserveOptions){if(project)void request(()=>changeConfig({...project.config,observe:options},true));}
  async function start(debug:boolean){await save();setAuto(false);setOutputs([]);setTerminalText('');setSnapshot(undefined);lastSnapshot.current=undefined;setExecutedLine(0);setConsoleTab('build');await api('start','POST',{project:project?.id,debug});}
  async function acceptProject(p:Project){if(status!=='idle')await api('action','POST',{action:'stop'});setAuto(false);setProjects(await api('projects'));setProject(p);setFile(p.config.entry);setBuffers({});setDirty(new Set());setSnapshot(undefined);lastSnapshot.current=undefined;setOutputs([]);setTerminalText('');setModal(null);}
  function terminalInput(data:string){inputQueue.current=inputQueue.current.then(()=>api('terminal','POST',{data})).catch(e=>notify(e.message));}
  async function selectProject(id:string){if(project&&dirty.size)await save();if(status!=='idle')await api('action','POST',{action:'stop'});const latest:Project[]=await api('projects');setProjects(latest);const p=latest.find(p=>p.id===id);if(p){setAuto(false);setSnapshot(undefined);lastSnapshot.current=undefined;setBuffers({});setDirty(new Set());setOutputs([]);setProject(p);setFile(p.config.entry);setSelectedBinding('');}}
  breakpointCallback.current=(line:number)=>{if(!project)return;const list=project.config.breakpoints[file]??[];const points={...project.config.breakpoints,[file]:list.includes(line)?list.filter(n=>n!==line):[...list,line].sort((a,b)=>a-b)};void request(async()=>{await changeConfig({...project.config,breakpoints:points});if(status==='paused')await api('breakpoints','PUT',{breakpoints:points});});};
  const mountEditor: OnMount = (instance, monaco) => {
    editor.current = instance;
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

  return <div className="app-shell">
    <header className="app-header"><div className="header-center"><span className="project-dot"/>{project?.name||'正在连接本地服务'}</div><div className="header-actions"><button onClick={()=>setModal('help')}><BookOpen size={15}/><span>使用指南</span></button><button title="工具链设置" onClick={()=>void request(async()=>{setTools(await api('tools'));setModal('settings');})}><Settings2 size={17}/></button></div></header>
    <nav className="toolbar"><div className="toolbar-left"><button title="开始调试 (Shift+F9)" className="run-button" disabled={!canStart} onClick={()=>void request(()=>start(true))}><Bug size={15}/>开始调试</button><button title="运行 (Shift+F10)" disabled={!canStart} onClick={()=>void request(()=>start(false))}><Play size={14}/>运行</button><i className="separator"/><button title="下一步 (F8)" disabled={!canStep} onClick={()=>void request(()=>api('action','POST',{action:'next'}))}><StepForward size={17}/><span>下一步</span></button><button title="进入函数 (F7)" disabled={!canStep} onClick={()=>void request(()=>api('action','POST',{action:'step'}))}><ArrowDownToLine size={17}/></button><button title="跳出函数 (Shift+F8)" disabled={!canStep} onClick={()=>void request(()=>api('action','POST',{action:'finish'}))}><ArrowUpFromLine size={17}/></button><button title="继续 (F9)" disabled={!canStep} onClick={()=>{setAuto(false);void request(()=>api('action','POST',{action:'continue'}));}}><SkipForward size={17}/></button><button title="停止程序 (Ctrl+F2)" disabled={status==='idle'&&!busy} onClick={()=>{setAuto(false);void request(()=>api('action','POST',{action:'stop'}));}}><Square size={14}/></button><i className="separator"/><button className={auto?'playing':''} disabled={!auto&&!canStep} onClick={()=>setAuto(!auto)}>{auto?<Pause size={14}/>:<Play size={14}/>}<span>{auto?'暂停播放':'自动单步'}</span></button><SpeedControl value={speed} onChange={setSpeed}/></div><div className={`status-chip ${status}`}><span/>{statusNames[status]}</div></nav>
    <main className="workspace" ref={stage} style={{gridTemplateColumns:`${layout.x*100}% 1fr`,gridTemplateRows:`${layout.y*100}% 1fr`}}>
      <section className="project-pane"><div className="pane-title"><span><FolderOpen size={14}/>项目文件</span><div><button title="新建文件" onClick={()=>setModal('file')}><Plus size={15}/></button><button title="打开项目" onClick={()=>setModal('open')}><FolderOpen size={14}/></button></div></div><div className="project-select"><select aria-label="选择项目" value={project?.id??''} onChange={e=>void request(()=>selectProject(e.target.value))}>{projects.map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</select></div><div className="file-tree"><div className="tree-root"><ChevronDown size={13}/><FolderOpen size={15}/><span>{project?.name}</span></div>{project?.files.map(name=><button key={name} className={`file-item ${name===file?'active':''}`} onClick={()=>setFile(name)}><FileCode2 size={14}/><span>{name}</span>{name===config?.entry&&<small>入口</small>}{dirty.has(name)&&<i/>}</button>)}</div><div className="sidebar-bottom"><button className="sample-link" onClick={()=>setModal('new')}><Plus size={14}/>新建项目</button><button className="sample-link" onClick={()=>setModal('open')}><FolderOpen size={14}/>打开项目</button></div></section>
      <section className="editor-pane"><div className="editor-tabs"><div className="file-tab"><FileCode2 size={14}/>{file}{dirty.has(file)&&<span className="dirty-dot"/>}</div><div className="editor-tools"><span className="source-legend"><i/>下一执行行</span><button title="保存文件与配置" disabled={!project||busy} onClick={()=>void request(async()=>{await save();notify('文件与配置已保存');})}><Save size={14}/><span>保存</span></button></div></div><div className="editor-body"><Editor path={`${project?.id}/${file}`} value={buffers[file]??''} language="cpp" theme="cppide-dark" onChange={value=>{setBuffers(b=>({...b,[file]:value??''}));setDirty(d=>new Set([...d,file]));}} beforeMount={monaco=>{monaco.editor.defineTheme('cppide-dark',{base:'vs-dark',inherit:true,rules:[{token:'comment',foreground:'667c80'},{token:'keyword',foreground:'a6c7dc'},{token:'number',foreground:'e9c487'},{token:'string',foreground:'a8ce9f'}],colors:{'editor.background':'#111b22','editor.foreground':'#d4dfdf','editorLineNumber.foreground':'#4c616b','editorLineNumber.activeForeground':'#b0c5c6','editor.selectionBackground':'#2c4652','editor.lineHighlightBackground':'#16232b','editorCursor.foreground':'#9be8ad','editorGutter.background':'#111b22','editorIndentGuide.background1':'#1c2c35'}});}} onMount={mountEditor} options={{fontSize:13,fontFamily:"'Cascadia Code', Consolas, monospace",lineHeight:23,minimap:{enabled:false},glyphMargin:true,lineNumbersMinChars:1,lineDecorationsWidth:0,showFoldingControls:'never',scrollBeyondLastLine:false,automaticLayout:true,padding:{top:15},renderLineHighlight:'line',tabSize:4,smoothScrolling:true,overviewRulerLanes:0,readOnly:status==='running'||status==='compiling'||status==='paused',bracketPairColorization:{enabled:true}}}/></div><div className="editor-footer"><span>{snapshot?`第 ${snapshot.location.line} 行`:''}</span><span>C++17 <span className="footer-divider">|</span> UTF-8</span></div></section>
      <section className="console-pane"><div className="pane-title"><span><Terminal size={14}/>运行控制台</span><button title="清空输出" onClick={()=>{setOutputs([]);setTerminalText('');}}><RotateCcw size={13}/></button></div>
        <div className="small-tabs"><button className={consoleTab==='output'?'selected':''} onClick={()=>setConsoleTab('output')}>终端</button><button className={consoleTab==='build'?'selected':''} onClick={()=>setConsoleTab('build')}>编译</button>{config?.inputMode==='preset'&&<button className={consoleTab==='input'?'selected':''} onClick={()=>setConsoleTab('input')}>预置输入</button>}</div>
        <div className="terminal-container" style={{display:consoleTab==='output'&&config?.inputMode!=='preset'?'flex':'none'}}><TerminalView text={terminalText} session={terminalSession} enabled={connected&&['running','paused'].includes(status)} onInput={terminalInput} onResize={(cols,rows)=>{void api('terminal','POST',{cols,rows}).catch(()=>{});}}/><div className="terminal-status">{status==='running'?'运行中 · 点击终端输入':status==='paused'?'已暂停 · 继续执行后读取输入':status==='exited'?'进程已结束':status==='compiling'?'正在编译':'运行后可输入'}</div></div>
        {consoleTab==='input'?<div className="input-panel"><textarea aria-label="预置输入" value={config?.stdin??''} onChange={e=>project&&setProject({...project,config:{...project.config,stdin:e.target.value}})} placeholder="运行前提供的标准输入"/><button onClick={()=>void request(save)}><Save size={12}/>保存输入</button></div>:(consoleTab==='build'||config?.inputMode==='preset')&&<div className="console-output">{outputs.filter(o=>consoleTab==='build'?o.channel==='build':o.channel!=='build').map((o,i)=><pre className={o.channel} key={i} onDoubleClick={()=>{const m=/([^\s:]+\.(?:cpp|cc|cxx|h|hpp)):(\d+):/.exec(o.text);if(m){if(project?.files.includes(m[1]))setFile(m[1]);editor.current?.revealLineInCenter(Number(m[2]));editor.current?.setPosition({lineNumber:Number(m[2]),column:1});}}}>{o.text}</pre>)}<div ref={consoleEnd}/></div>}
      </section>
      <section className="debug-pane"><div className="debug-heading"><div className="debug-tabs"><button className={tab==='visual'?'selected':''} onClick={()=>setTab('visual')}><Network size={14}/>可视化</button><button className={tab==='variables'?'selected':''} onClick={()=>setTab('variables')}><Braces size={14}/>普通变量</button></div><div className="debug-actions"><button title="重置变化标记和观察基线" disabled={!canStep} onClick={()=>void request(()=>api('action','POST',{action:'reset'}))}><RotateCcw size={13}/></button><button title="专注图结构" className={focus?'playing':''} onClick={()=>setFocus(!focus)}><Focus size={15}/></button><button className="binding-button" onClick={()=>{setBindingDraft(binding?structuredClone(binding):defaultBinding());setModal('binding');}}><SlidersHorizontal size={13}/>结构绑定</button></div></div>
        <div className="watchbar"><Pin size={12}/><input aria-label="指定查看变量" placeholder="指定查看：a[100] 或 a[90..110]" value={pinText} onChange={e=>setPinText(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addPin()}/><button title="固定查看" onClick={addPin}><Plus size={14}/></button><label title="折叠相同值区间"><input type="checkbox" checked={observation.fold} onChange={e=>observe({...observation,fold:e.target.checked})}/>折叠</label><label title="规则推断可能误判，可随时关闭"><input type="checkbox" checked={observation.inferInitialization} onChange={e=>observe({...observation,inferInitialization:e.target.checked})}/>初始化推断</label></div>
        {!!observation.pins.length&&<div className="pin-list">{observation.pins.map(pin=><span key={pin}><Pin size={10}/>{pin}<button aria-label={`取消固定 ${pin}`} onClick={()=>observe({...observation,pins:observation.pins.filter(p=>p!==pin)})}><X size={10}/></button></span>)}</div>}
        <div className="debug-content">{tab==='variables'?<VariableTable variables={variables} step={snapshot?.step??0} observe={observation} onObserve={observe}/>:<div className={`visual-layout ${binding?'with-graph':''} ${focus?'graph-focus':''}`}>
          {binding&&<div className="graph-column">{config!.bindings.length>1&&<select aria-label="图结构" value={binding.id} onChange={e=>setSelectedBinding(e.target.value)}>{config!.bindings.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select>}<GraphView binding={binding} snapshot={snapshot} onPositions={positions=>{if(project)void changeConfig({...project.config,bindings:project.config.bindings.map(b=>b.id===binding.id?{...b,positions}:b)});}}/></div>}
          <div className="variables-column"><div className="variables-caption"><span>变量观察 <small>{variables.length}</small></span><input aria-label="筛选变量" placeholder="筛选变量" value={filter} onChange={e=>setFilter(e.target.value)}/></div>{!snapshot?<div className="visual-empty"><p>开始调试后显示变量</p></div>:<><div className="scalar-strip">{scalarVars.map(v=><div className="scalar-chip" key={v.id}><span title={v.type}>{v.name}</span><b key={v.pulse?snapshot.step:'stable'} className={`${v.changed?'changed':''} ${v.pulse?'pulse':''}`}>{v.value}</b></div>)}</div>{complexVars.map(v=><VariableCard key={v.id} v={v} step={snapshot.step} observe={observation} onObserve={observe} infinity={binding?snapshot.bindingData?.[binding.id]?.infinity:undefined}/>)}{!variables.length&&<p className="hint">当前位置没有可读取的用户变量。可切换调用栈，或返回用户代码继续观察。</p>}</>}
            <details className="monitor-settings"><summary>监测范围 <small>最多 8 MiB</small></summary><p>留空表示完整监测；超过预算的数组需指定范围。区间外未完整监测。</p><div><input aria-label="监测数组名称" placeholder="数组名，如 a" value={rangeName} onChange={e=>setRangeName(e.target.value)}/><input aria-label="监测下标区间" placeholder="0..9999" value={rangeText} onChange={e=>setRangeText(e.target.value)}/><button onClick={()=>{const m=/^(\d+)\.\.(\d+)$/.exec(rangeText);if(!rangeName||(!m&&rangeText)){notify('填写数组名及 0..9999 格式的区间');return;}const ranges={...observation.ranges};if(m&&Number(m[1])<=Number(m[2]))ranges[rangeName]=[Number(m[1]),Number(m[2])];else if(!rangeText)delete ranges[rangeName];else{notify('区间起点不能大于终点');return;}observe({...observation,ranges});}}>应用</button></div>{Object.entries(observation.ranges).map(([n,r])=><small key={n}>{n}[{r[0]}..{r[1]}] </small>)}</details>
          </div></div>}</div>
        <div className="stack-panel"><button className="stack-toggle" onClick={()=>setStackOpen(!stackOpen)}>{stackOpen?<ChevronDown size={12}/>:<ChevronRight size={12}/>}<Layers size={12}/>调用栈 <small>{snapshot?.frames.length??0}</small><span>{snapshot?`${snapshot.location.function} : ${snapshot.location.line}`:''}</span></button>{stackOpen&&<div className="stack-frames">{snapshot?.frames.map(f=><button className={snapshot.frame===f.level?'active':''} key={f.id} disabled={!canStep} onClick={()=>void request(()=>api('action','POST',{action:'frame',level:f.level}))}><span>#{f.level}</span><b>{f.name}</b><small>{f.file}:{f.line}</small></button>)}</div>}</div>
      </section>
      <div className="resize-x" style={{left:`${layout.x*100}%`}} onPointerDown={e=>resize('x',e)}/><div className="resize-y" style={{top:`${layout.y*100}%`}} onPointerDown={e=>resize('y',e)}/>
    </main>
    <footer className="statusbar"><span><i className={connected?'online':'offline'}/>{connected?'本地服务已连接':'正在连接本地服务…'}</span><span>{snapshot?`第 ${snapshot.step} 步 · 采集 ${snapshot.elapsedMs} ms · ${(snapshot.monitoredBytes/1024/1024).toFixed(2)} MiB`:'本地运行 · 真实 C++ 调试'}</span><span>绿色 = 观察到数值变化 <span className="footer-divider">|</span> C++17</span></footer>
    {toast&&<div role="status" className="toast"><AlertCircle size={16}/>{toast}<button onClick={()=>setToast('')}><X size={14}/></button></div>}
    {modal&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setModal(null);}}><section className={`modal ${modal==='binding'?'wide':''}`} role="dialog" aria-modal="true"><header><h2>{modal==='new'?'新建项目':modal==='open'?'打开项目':modal==='binding'?'变量与图结构绑定':modal==='settings'?'本地工具链':modal==='file'?'新建文件':'使用指南'}</h2><button aria-label="关闭对话框" onClick={()=>setModal(null)}><X size={18}/></button></header>
      {modal==='new'&&<><label className="field">项目名称<input value={newName} placeholder="未命名项目" onChange={e=>setNewName(e.target.value)}/></label><footer><button className="primary" disabled={busy} onClick={()=>void request(async()=>{await save();await acceptProject(await api('projects','POST',{name:newName||'未命名项目'}));})}>创建项目</button></footer></>}
      {modal==='open'&&<><label className="field">项目文件夹<input value={openPath} placeholder="C:\项目文件夹" onChange={e=>setOpenPath(e.target.value)}/></label><div className="recent-projects">{projects.map(p=><button key={p.id} onClick={()=>void request(async()=>{await selectProject(p.id);setModal(null);})}><FolderOpen size={14}/><span>{p.name}<small>{p.path}</small></span></button>)}</div><footer><button className="primary" disabled={busy||!openPath.trim()} onClick={()=>void request(async()=>{await save();await acceptProject(await api('projects/open','POST',{path:openPath.trim()}));})}>打开项目</button></footer></>}
      {modal==='file'&&<><p className="modal-intro">文件保存在当前项目中，可创建 .cpp、.h、.hpp 或 .txt 文件。</p><label className="field">文件名<input placeholder="helper.h" value={newFile} onChange={e=>setNewFile(e.target.value)}/></label><footer><button className="primary" disabled={busy} onClick={()=>void request(async()=>{if(!project)return;if(project.files.includes(newFile))throw new Error('文件已存在');await api('file','PUT',{project:project.id,file:newFile,content:''});setProject({...project,files:[...project.files,newFile]});setBuffers({...buffers,[newFile]:''});setFile(newFile);setNewFile('');setModal(null);})}>创建文件</button></footer></>}
      {modal==='settings'&&<><label className="field">语言<select aria-label="语言" value="cpp" disabled><option value="cpp">C++17</option></select></label><label className="field">标准输入<select value={config?.inputMode??"terminal"} onChange={e=>project&&setProject({...project,config:{...project.config,inputMode:e.target.value as "terminal"|"preset"}})}><option value="terminal">交互终端</option><option value="preset">运行前预置输入</option></select></label><label className="field">C++ 编译器<input value={tools.compiler??''} onChange={e=>setTools({...tools,compiler:e.target.value})}/><small>{tools.compilerVersion}</small></label><label className="field">GDB 调试器<input value={tools.debugger??''} onChange={e=>setTools({...tools,debugger:e.target.value})}/><small>{tools.debuggerVersion}</small></label><label className="field">编译入口<select value={config?.entry} onChange={e=>project&&setProject({...project,config:{...project.config,entry:e.target.value}})}>{project?.files.filter(f=>/\.(cpp|cc|cxx)$/.test(f)).map(f=><option key={f}>{f}</option>)}</select></label><footer><button className="primary" onClick={()=>void request(async()=>{await api('tools','PUT',tools);await save();setTools(await api('tools'));notify('工具链设置已保存');})}>保存并检查</button></footer></>}
      {modal==='binding'&&bindingDraft&&<BindingForm value={bindingDraft} onChange={setBindingDraft} onSave={()=>void request(async()=>{if(!project)return;const list=project.config.bindings.filter(b=>b.id!==bindingDraft.id);await changeConfig({...project.config,bindings:[...list,bindingDraft]},true);setSelectedBinding(bindingDraft.id);setModal(null);})} onNew={()=>setBindingDraft(defaultBinding())} onDelete={()=>void request(async()=>{if(project)await changeConfig({...project.config,bindings:project.config.bindings.filter(b=>b.id!==bindingDraft.id)},true);setModal(null);})}/>}
      {modal==='help'&&<div className="help-content"><div><span>01</span><section><h3>写下真实的 C++ 程序</h3><p>新建项目或打开本地项目文件夹。运行后点击终端输入，按回车提交；点击行号左侧设置断点。</p></section></div><div><span>02</span><section><h3>告诉画布，变量代表什么</h3><p>数组自动展示；图与树通过「结构绑定」配置。明确节点数量、方向和无边标记，零权边也能正确显示。</p></section></div><div><span>03</span><section><h3>执行一步，看见一次变化</h3><p>青色行标表示下一执行位置，淡金色表示刚执行的位置。新值原地变绿，边框短暂强调；暂停后绿色保留。</p></section></div><div><span>04</span><section><h3>大数组，也只关注重点</h3><p>同值区间自动折叠。输入 a[100] 或 a[90..110] 固定查看；初始化推断可能误判，可随时关闭。</p></section></div><p className="help-note">逐行快照会合并同一步内部的修改；「继续」不会补录中间动画。正常退出前会更新最终状态。F8 下一步，F7 进入，Shift+F8 跳出，F9 继续，Shift+F9 调试，Shift+F10 运行，Ctrl+F2 停止，Ctrl+F8 切换断点。</p></div>}
    </section></div>}
  </div>;
}

function BindingForm({value:b,onChange,onSave,onDelete,onNew}:{value:Binding;onChange:(b:Binding)=>void;onSave:()=>void;onDelete:()=>void;onNew:()=>void}){
  const field=(key:keyof Binding,label:string,placeholder='',type='text')=><label className="field" key={key}>{label}<input type={type} value={String(b[key])} placeholder={placeholder} onChange={e=>onChange({...b,[key]:type==='number'?Number(e.target.value):e.target.value})}/></label>;
  return <><p className="modal-intro">只描述数据结构与变量角色，同一份配置可以用于不同算法。配置不会修改源代码。</p><div className="binding-types">{([['matrix','邻接矩阵'],['edges','边表数组'],['parent','父节点数组']] as const).map(([kind,label])=><button key={kind} className={b.kind===kind?'selected':''} onClick={()=>onChange({...b,kind})}>{label}</button>)}</div><div className="binding-fields">{field('name','视图名称')}{field('count','节点数量 / 表达式','n')}{b.kind==='edges'?<>{field('from','起点数组','from')}{field('to','终点数组','to')}{field('weight','权重数组（可空）','weight')}{field('edgeCount','边数量 / 表达式','m')}</>:<>{field('source',b.kind==='matrix'?'矩阵变量':'父节点数组',b.kind==='matrix'?'G':'parent')}{field('absent',b.kind==='matrix'?'无边标记 / 表达式':'无父节点标记','INF 或 -1')}</>}<label className="field">节点起始下标<select value={b.base} onChange={e=>onChange({...b,base:Number(e.target.value)})}><option value={0}>0</option><option value={1}>1</option></select></label><label className="field">边的方向<select value={b.directed?'yes':'no'} onChange={e=>onChange({...b,directed:e.target.value==='yes'})}><option value="no">无向</option><option value="yes">有向</option></select></label>{b.kind==='matrix'&&<label className="field">边权显示<select value={b.weight==='none'?'none':'value'} onChange={e=>onChange({...b,weight:e.target.value})}><option value="value">显示矩阵值</option><option value="none">不显示权重</option></select></label>}{field('root','根节点 / 表达式（可空）','0')}{field('labels','节点标签数组（数值，可空）')}{field('status','状态数组（可空）','visited')}{field('distance','节点附加数值数组（可空）','dist')}{field('infinity','显示为 ∞ 的值 / 表达式（可空）','INF')}{field('current','当前节点变量（可空）','u')}{field('target','当前边终点变量（可空）','v')}{field('lineStart','高亮起始行（0 为不限）','','number')}{field('lineEnd','高亮结束行（0 为不限）','','number')}</div><p className="hint">边表的边记录从下标 0 读取，节点编号按上述起始下标解释。无边标记与零权边需明确区分。</p><footer><button className="danger-text" onClick={onDelete}>移除此绑定</button><button onClick={onNew}><Plus size={13}/>新增绑定</button><button className="primary" onClick={onSave}><Link2 size={13}/>保存绑定</button></footer></>;
}

import {useEffect,useRef} from 'react';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {terminalThemes,type ThemeName} from './theme';

export default function TerminalView({text,session,enabled,theme,onInput,onResize}:{text:string;session:string;enabled:boolean;theme:ThemeName;onInput:(text:string)=>void;onResize:(cols:number,rows:number)=>void}){
  const host=useRef<HTMLDivElement>(null);const terminal=useRef<Terminal|undefined>(undefined);const fit=useRef<FitAddon|undefined>(undefined);const previous=useRef('');
  const callbacks=useRef({onInput,onResize});callbacks.current={onInput,onResize};
  useEffect(()=>{
    const term=new Terminal({fontFamily:'"JetBrains Mono", Consolas, "Microsoft YaHei", monospace',fontSize:13,lineHeight:1.25,cursorBlink:true,scrollback:5000,theme:terminalThemes[theme],allowProposedApi:false});
    const addon=new FitAddon();term.loadAddon(addon);term.open(host.current!);terminal.current=term;fit.current=addon;
    const input=term.onData(data=>callbacks.current.onInput(data));const resize=term.onResize(({cols,rows})=>callbacks.current.onResize(cols,rows));
    const observer=new ResizeObserver(()=>{if(host.current?.offsetWidth&&host.current.offsetHeight)addon.fit();});observer.observe(host.current!);
    return()=>{observer.disconnect();input.dispose();resize.dispose();term.dispose();terminal.current=undefined;previous.current='';};
  },[]);
  useEffect(()=>{terminal.current?.reset();previous.current='';if(terminal.current)callbacks.current.onResize(terminal.current.cols,terminal.current.rows);},[session]);
  useEffect(()=>{const term=terminal.current;if(!term)return;if(!text.startsWith(previous.current)){term.reset();previous.current='';}term.write(text.slice(previous.current.length));previous.current=text;},[text,session]);
  useEffect(()=>{if(terminal.current)terminal.current.options.disableStdin=!enabled;},[enabled]);
  useEffect(()=>{if(terminal.current)terminal.current.options.theme=terminalThemes[theme];},[theme]);
  return <div className="terminal-host" aria-label="运行终端" ref={host}/>;
}

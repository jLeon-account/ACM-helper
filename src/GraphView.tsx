import {useEffect,useRef,useState} from 'react';
import cytoscape,{type Core,type ElementDefinition} from 'cytoscape';
import {Maximize,RotateCcw,Network,AlertTriangle} from 'lucide-react';
import type {Binding,Snapshot} from '../shared/types';
import {makeGraph} from '../shared/graph';
import {graphPalettes,type GraphPalette,type ThemeName} from './theme';

function graphStyle(c:GraphPalette,directed:boolean):cytoscape.StylesheetStyle[]{
  return [
    {selector:'node',style:{'background-color':c.node,'border-color':c.nodeBorder,'border-width':2,'color':c.nodeText,'label':'data(display)','font-size':13,'font-family':'"JetBrains Mono", Consolas, monospace','text-valign':'center','text-wrap':'wrap','width':52,'height':52}},
    {selector:'edge',style:{'width':1.6,'line-color':c.edge,'target-arrow-color':c.edge,'target-arrow-shape':directed?'triangle':'none','curve-style':'bezier','label':'','color':c.edgeText,'font-size':12,'text-background-color':c.labelBackground,'text-background-opacity':1,'text-background-padding':'5px','text-rotation':'none'}},
    {selector:'node.visited',style:{'background-color':c.visited,'border-color':c.visitedBorder}},
    {selector:'node.current',style:{'border-color':c.current,'border-width':4}},
    {selector:'edge.current',style:{'line-color':c.current,'target-arrow-color':c.current,'width':3,'color':c.current}},
    {selector:'edge.hovered',style:{'label':'data(label)','line-color':c.hover,'target-arrow-color':c.hover,'width':4,'color':c.hoverText,'z-index':999,'text-border-width':1,'text-border-color':c.hoverBorder,'text-border-opacity':1}},
    {selector:'node.changed',style:{'color':c.changed}},
    {selector:'node.pulse',style:{'border-color':c.changed,'border-width':5}},
  ];
}

export default function GraphView({binding,snapshot,theme,onPositions}:{binding:Binding;snapshot?:Snapshot;theme:ThemeName;onPositions:(p:Binding['positions'])=>void}){
  const themeRef=useRef(theme);themeRef.current=theme;
  const container=useRef<HTMLDivElement>(null);const cy=useRef<Core | undefined>(undefined);const topology=useRef('');const session=useRef('');
  const lastValues=useRef(new Map<string,string>());const changed=useRef(new Set<string>());const positionsCallback=useRef(onPositions);positionsCallback.current=onPositions;
  const [error,setError]=useState('');const [info,setInfo]=useState('等待调试快照');
  useEffect(()=>{
    if(!container.current)return;
    cy.current=cytoscape({container:container.current,elements:[],style:graphStyle(graphPalettes[themeRef.current],binding.directed),minZoom:.25,maxZoom:3,wheelSensitivity:.18});
    // 被隐藏（切到“普通变量”）时尺寸为 0，不做处理；重新显示时只更新尺寸，保留用户的缩放与平移。
    let hidden=false;const resize=new ResizeObserver(()=>{const graph=cy.current;const el=container.current;if(!graph||!el)return;if(!el.offsetWidth||!el.offsetHeight){hidden=true;return;}graph.resize();if(hidden){hidden=false;return;}if(graph.nodes().length)graph.fit(graph.nodes(),16);});resize.observe(container.current);
    cy.current.on('dragfree','node',()=>{const p:Binding['positions']={};cy.current!.nodes().forEach(n=>{p[n.id()]=n.position();});positionsCallback.current(p);});
    cy.current.on('mouseover','edge',event=>{cy.current?.edges().removeClass('hovered');event.target.addClass('hovered');if(container.current)container.current.style.cursor='pointer';});
    cy.current.on('mouseout','edge',event=>{event.target.removeClass('hovered');if(container.current)container.current.style.cursor='default';});
    return()=>{resize.disconnect();cy.current?.destroy();cy.current=undefined;topology.current='';};
  },[binding.id,binding.directed]);
  useEffect(()=>{cy.current?.style(graphStyle(graphPalettes[theme],binding.directed));},[theme,binding.directed]);
  useEffect(()=>{
    const graph=cy.current;const data=snapshot?.bindingData?.[binding.id];if(!graph||!data)return;
    try{
      const model=makeGraph(binding,data,snapshot!.location.line);setError('');setInfo(`${model.nodes.length} 个节点 · ${model.edges.length} 条边 · ${model.forest?'树 / 森林布局':'图布局'}`);
      if(session.current!==snapshot!.session||snapshot!.reason==='reset'){lastValues.current.clear();changed.current.clear();session.current=snapshot!.session;}
      const signature=model.nodes.map(n=>n.id).join(',')+'|'+model.edges.map(e=>`${e.id}:${e.source}:${e.target}`).join(',');
      const elements:ElementDefinition[]=[...model.nodes.map(n=>({data:{...n,display:n.label+(n.distance!==''?'\n'+n.distance:'')},group:'nodes' as const})),...model.edges.map(e=>({data:e,group:'edges' as const}))];
      if(topology.current!==signature){
        const oldPositions:Binding['positions']={};graph.nodes().forEach(n=>{oldPositions[n.id()]=n.position();});
        graph.elements().remove();graph.add(elements);
        const allPlaced=model.nodes.every(n=>binding.positions[n.id]||oldPositions[n.id]);
        if(allPlaced){graph.nodes().forEach(n=>{n.position(binding.positions[n.id()]||oldPositions[n.id()]);});if(!topology.current)graph.fit(graph.nodes(),16);}
        else {graph.layout(model.forest?{name:'breadthfirst',directed:binding.directed,roots:model.roots,spacingFactor:1.15,padding:16,animate:false}:{name:'circle',radius:Math.max(65,model.nodes.length*13),padding:16,animate:false}).run();graph.fit(graph.nodes(),16);}
        topology.current=signature;
      }else graph.batch(()=>{for(const e of elements)graph.getElementById(e.data.id!).data(e.data);});
      const pulsed:string[]=[];
      graph.batch(()=>{
        for(const n of model.nodes){const el=graph.getElementById(n.id);el.toggleClass('visited',n.status);el.toggleClass('current',n.current);const value=n.label+'|'+n.distance;const previous=lastValues.current.get(n.id);if(previous!==undefined&&previous!==value){changed.current.add(n.id);pulsed.push(n.id);el.addClass('pulse');}el.toggleClass('changed',changed.current.has(n.id));lastValues.current.set(n.id,value);}
        for(const e of model.edges)graph.getElementById(e.id).toggleClass('current',e.current);
      });
      const timer=setTimeout(()=>{if(!graph.destroyed())pulsed.forEach(id=>graph.getElementById(id).removeClass('pulse'));},400);return()=>{clearTimeout(timer);if(!graph.destroyed())pulsed.forEach(id=>graph.getElementById(id).removeClass('pulse'));};
    }catch(e){setError(e instanceof Error?e.message:String(e));}
  },[binding,snapshot]);
  return <div className="graph-panel"><div className="graph-caption"><span><Network size={13}/>{binding.name}</span><div><button title="适应画布" onClick={()=>cy.current?.fit(cy.current.nodes(),16)}><Maximize size={14}/></button><button title="重新布局" onClick={()=>{topology.current='';cy.current?.elements().remove();onPositions({});}}><RotateCcw size={14}/></button></div></div>
    <div className="graph-canvas" ref={container}/>{error&&<div className="graph-error"><AlertTriangle size={18}/><b>绑定暂不可用</b><span>{error}</span><small>检查变量名称、作用域和有效范围</small></div>}{!snapshot&&<div className="graph-placeholder"><span>开始调试后显示图结构</span></div>}
    <div className="graph-footer"><span>{info}</span><span className="legend"><i className="teal"/>状态 <i className="yellow"/>当前 <i className="green"/>数值改变</span></div></div>;
}

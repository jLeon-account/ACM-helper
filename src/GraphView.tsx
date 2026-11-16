import {useEffect,useRef,useState} from 'react';
import cytoscape,{type Core,type ElementDefinition} from 'cytoscape';
import {Maximize,RotateCcw,Network,AlertTriangle} from 'lucide-react';
import type {Binding,Snapshot} from '../shared/types';
import {makeGraph} from '../shared/graph';

export default function GraphView({binding,snapshot,onPositions}:{binding:Binding;snapshot?:Snapshot;onPositions:(p:Binding['positions'])=>void}){
  const container=useRef<HTMLDivElement>(null);const cy=useRef<Core | undefined>(undefined);const topology=useRef('');const session=useRef('');
  const lastValues=useRef(new Map<string,string>());const changed=useRef(new Set<string>());const positionsCallback=useRef(onPositions);positionsCallback.current=onPositions;
  const [error,setError]=useState('');const [info,setInfo]=useState('等待调试快照');
  useEffect(()=>{
    if(!container.current)return;
    cy.current=cytoscape({container:container.current,elements:[],style:[
      {selector:'node',style:{'background-color':'#19272e','border-color':'#789091','border-width':2,'color':'#edf2ee','label':'data(display)','font-size':13,'font-family':'Consolas, monospace','text-valign':'center','text-wrap':'wrap','width':52,'height':52}},
      {selector:'edge',style:{'width':1.6,'line-color':'#5f737a','target-arrow-color':'#5f737a','target-arrow-shape':binding.directed?'triangle':'none','curve-style':'bezier','label':'','color':'#b8c8cc','font-size':12,'text-background-color':'#121e25','text-background-opacity':1,'text-background-padding':'5px','text-rotation':'none'}},
      {selector:'node.visited',style:{'background-color':'#1b3d43','border-color':'#59b8b8'}},
      {selector:'node.current',style:{'border-color':'#e6bd70','border-width':4}},
      {selector:'edge.current',style:{'line-color':'#e6bd70','target-arrow-color':'#e6bd70','width':3,'color':'#e6bd70'}},
      {selector:'edge.hovered',style:{'label':'data(label)','line-color':'#b3edf1','target-arrow-color':'#b3edf1','width':4,'color':'#f0ffff','z-index':999,'text-border-width':1,'text-border-color':'#7cb7bf','text-border-opacity':1}},
      {selector:'node.changed',style:{'color':'#91ed9e'}},
      {selector:'node.pulse',style:{'border-color':'#91ed9e','border-width':5}}
    ],minZoom:.25,maxZoom:3,wheelSensitivity:.18});
    const resize=new ResizeObserver(()=>{const graph=cy.current;if(graph){graph.resize();if(graph.nodes().length)graph.fit(graph.nodes(),16);}});resize.observe(container.current);
    cy.current.on('dragfree','node',()=>{const p:Binding['positions']={};cy.current!.nodes().forEach(n=>{p[n.id()]=n.position();});positionsCallback.current(p);});
    cy.current.on('mouseover','edge',event=>{cy.current?.edges().removeClass('hovered');event.target.addClass('hovered');if(container.current)container.current.style.cursor='pointer';});
    cy.current.on('mouseout','edge',event=>{event.target.removeClass('hovered');if(container.current)container.current.style.cursor='default';});
    return()=>{resize.disconnect();cy.current?.destroy();cy.current=undefined;topology.current='';};
  },[binding.id,binding.directed]);
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

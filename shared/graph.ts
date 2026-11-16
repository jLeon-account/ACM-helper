import type { Binding, BindingData } from './types';
export type GraphNode = {id:string; label:string; status:boolean; distance:string; current:boolean};
export type GraphEdge = {id:string;source:string;target:string;label:string;current:boolean};
export function makeGraph(binding:Binding, data:BindingData, line:number) {
  if(data.error)throw new Error(data.error);
  const n=data.count;
  if(!Number.isInteger(n)||n<1||n>200)throw new Error('节点数量必须在 1—200 之间，请选择有效子图');
  const active=(!binding.lineStart||line>=binding.lineStart)&&(!binding.lineEnd||line<=binding.lineEnd);
  const nodes:GraphNode[]=Array.from({length:n},(_,i)=>({id:String(i+binding.base),label:data.labels[i]||String(i+binding.base),status:!!data.status[i]&&!['0','false','False',''].includes(data.status[i]),distance:data.distance[i]===data.infinity&&data.infinity!==''?'∞':data.distance[i]??'',current:active&&String(i+binding.base)===data.current}));
  const ids=new Set(nodes.map(x=>x.id));const edges:GraphEdge[]=[];const keys=new Set<string>();
  const add=(a:string,b:string,w:string,id:string)=>{
    if(!ids.has(a)||!ids.has(b))throw new Error(`边端点 ${a} → ${b} 超出节点范围`);
    const key=binding.directed?`${a}:${b}`:[a,b].sort().join(':');
    if(binding.kind==='matrix'&&!binding.directed&&keys.has(key))return;
    keys.add(key);edges.push({id,source:a,target:b,label:w,current:active&&((a===data.current&&b===data.target)||(!binding.directed&&b===data.current&&a===data.target))});
    if(edges.length>500)throw new Error('超过 500 条边，请缩小子图范围');
  };
  if(binding.kind==='matrix'){
    for(let i=0;i<n;i++)for(let j=0;j<n;j++){
      const v=data.source[i]?.[j];if(v===undefined)throw new Error('矩阵范围或维度不正确');
      if(v!==data.absent)add(String(i+binding.base),String(j+binding.base),binding.weight==='none'?'':v,`m-${i}-${j}`);
    }
  } else if(binding.kind==='edges'){
    for(let i=0;i<data.edgeCount;i++)add(data.from[i],data.to[i],data.weight[i]??'',`e-${i}`);
  } else {
    for(let i=0;i<n;i++){const p=data.source[0]?.[i];if(p!==undefined&&p!==data.absent)add(p,String(i+binding.base),'',`p-${i}`);}
  }
  // Forest detection uses edges rather than appearance; loops/parallel edges are cycles.
  const parent=new Map(nodes.map(x=>[x.id,x.id]));const find=(a:string):string=>{let b=a;while(parent.get(b)!==b)b=parent.get(b)!;return b;};
  let forest=true;const incoming=new Map<string,number>();
  for(const e of edges){const a=find(e.source),b=find(e.target);if(a===b)forest=false;else parent.set(a,b);incoming.set(e.target,(incoming.get(e.target)??0)+1);}
  if(binding.directed&&[...incoming.values()].some(v=>v>1))forest=false;
  const roots:string[]=[];const groups=new Map<string,string[]>();
  for(const node of nodes){const k=find(node.id);groups.set(k,[...(groups.get(k)??[]),node.id]);}
  if(data.root&&!ids.has(data.root))throw new Error('指定根节点超出有效范围');
  for(const group of groups.values())roots.push(group.includes(data.root)?data.root:(binding.directed?group.find(x=>!incoming.get(x)):undefined)??group.sort((a,b)=>Number(a)-Number(b))[0]);
  return {nodes,edges,forest,roots};
}

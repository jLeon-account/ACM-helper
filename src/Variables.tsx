import React,{useState} from 'react';
import { ChevronDown, ChevronRight, Pin, CornerDownRight } from 'lucide-react';
import type { Variable,ObserveOptions,Cell } from '../shared/types';

function Value({cell,step,infinity}:{cell:{value?:string;changed?:boolean;pulse?:boolean};step:number;infinity?:string}){
  return <span key={cell.pulse?step:'stable'} className={`value ${cell.changed?'changed':''} ${cell.pulse?'pulse':''}`}>{cell.value===infinity&&infinity!==''?'∞':cell.value??'—'}</span>;
}
export function VariableCard({v,step,observe,onObserve,infinity=''}:{v:Variable;step:number;observe:ObserveOptions;onObserve:(o:ObserveOptions)=>void;infinity?:string}){
  const [open,setOpen]=useState(true);
  const isArray=v.kind==='array'||v.kind==='matrix';
  const [goto,setGoto]=useState('');
  const pin=(i:number)=>{const expression=v.kind==='matrix'&&v.shape?`${v.expression}[${Math.floor(i/v.shape[1])}][${i%v.shape[1]}]`:`${v.expression}[${i}]`;onObserve({...observe,pins:[...new Set([...observe.pins,expression])]});};
  const page=(n:number)=>onObserve({...observe,pages:{...observe.pages,[v.expression]:Math.max(0,n)}});
  return <section className="variable-card">
    <header><button className="plain" onClick={()=>setOpen(!open)}>{open?<ChevronDown size={13}/>:<ChevronRight size={13}/>}<strong>{v.expression}</strong></button><span className="var-type" title={v.type}>{v.type}</span>{v.length!==undefined&&<span className="count">{v.length.toLocaleString()}</span>}</header>
    {open&&<>
      {v.kind==='unavailable'?<div className="unavailable">{v.warning}</div>:isArray?<>
        {!!v.cells?.length&&v.kind==='matrix'&&v.shape?.length===2&&v.length!>0?<div className="matrix-scroll"><div className="matrix" style={{gridTemplateColumns:`28px repeat(${Math.min(v.shape[1],200)}, minmax(42px,1fr))`}}>
          {v.shape[1]<=200?<><span/>{Array.from({length:v.shape[1]},(_,i)=><span key={'h'+i} className="matrix-index">{i}</span>)}{v.cells.filter(cell=>!v.page||(cell.index>=v.page[0]&&cell.index<=v.page[1])).map(cell=><React.Fragment key={cell.index}>{cell.index%v.shape![1]===0&&<span className="matrix-index">{Math.floor(cell.index/v.shape![1])}</span>}<button className="matrix-cell" title={`${v.expression}[${Math.floor(cell.index/v.shape![1])}][${cell.index%v.shape![1]}] = ${cell.value}`} onClick={()=>pin(cell.index)}><Value cell={cell} step={step} infinity={infinity}/></button></React.Fragment>)}</>:<span className="hint">宽矩阵使用下方线性窗口查看</span>}
        </div></div>:null}
        {(v.kind!=='matrix'||(v.shape?.[1]??0)>200)&&<div className="array-scroll"><div className="array-cells">
          {arrayItems(v).map(item=>item.kind==='cell'?<button key={'c'+item.cell.index} className={`array-cell ${observe.pins.includes(`${v.expression}[${item.cell.index}]`)?'pinned':''}`} onClick={()=>pin(item.cell.index)} title="点击固定查看"><span className="cell-index">{item.cell.index}</span><Value cell={item.cell} step={step} infinity={infinity}/></button>:<button key={'r'+item.start} className="fold-cell" onClick={()=>onObserve({...observe,fold:false,pages:{...observe.pages,[v.expression]:item.start}})} title={`${item.reason}，点击展开窗口`}><span>···</span><small>{item.start}—{item.end}</small><small>{item.reason}</small></button>)}
        </div></div>}
        {v.length!>200&&<div className="array-navigation"><button onClick={()=>page((v.page?.[0]??0)-200)} title="上一窗口">‹</button><span>窗口 {v.page?.[0]??0}—{v.page?.[1]??0}</span><button onClick={()=>page((v.page?.[0]??0)+200)} title="下一窗口">›</button><input aria-label={`定位 ${v.expression} 下标`} placeholder="下标" value={goto} onChange={e=>setGoto(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')page(Number(goto)||0);}}/><button onClick={()=>page(Number(goto)||0)}>定位</button></div>}
        {v.initialization&&<div className="hint amber">{v.initialization}</div>}
        {v.warning&&<div className="hint amber">{v.warning}</div>}
      </>:v.kind==='struct'?<div className="struct-fields">{v.children?.length?v.children.map(child=><VariableCard key={child.id} v={child} step={step} observe={observe} onObserve={onObserve}/>):<button className="text-button" onClick={()=>onObserve({...observe,expanded:[...observe.expanded,v.expression]})}>展开字段</button>}</div>:<div className="scalar-display"><Value cell={v} step={step}/><span>{v.scope}</span></div>}
    </>}
  </section>;
}
function arrayItems(v:Variable):({kind:'cell';cell:Cell}|{kind:'run';start:number;end:number;reason:string})[]{
  const result:({kind:'cell';cell:Cell}|{kind:'run';start:number;end:number;reason:string})[]=(v.cells??[]).map(cell=>({kind:'cell',cell}));
  for(const run of v.runs??[])result.push({kind:'run',start:run.start+1,end:run.end-1,reason:run.reason});
  return result.sort((a,b)=>(a.kind==='cell'?a.cell.index:a.start)-(b.kind==='cell'?b.cell.index:b.start));
}
export function VariableTable({variables,step,observe,onObserve}:{variables:Variable[];step:number;observe:ObserveOptions;onObserve:(o:ObserveOptions)=>void}){
  const [expanded,setExpanded]=useState<Set<string>>(new Set());
  return <div className="variables-table"><div className="table-heading"><span>名称 / 作用域</span><span>值</span><span>类型</span></div>{variables.map(v=><React.Fragment key={v.id}><button className="table-row" onClick={()=>setExpanded(prev=>{const n=new Set(prev);n.has(v.id)?n.delete(v.id):n.add(v.id);return n;})}><span>{expanded.has(v.id)?<ChevronDown size={12}/>:<ChevronRight size={12}/>}<b>{v.name}</b><small>{v.scope}</small></span><span>{v.kind==='scalar'?<Value cell={v} step={step}/>:v.kind==='unavailable'?'不可用':v.length!==undefined?`${v.length} 个元素`:'{ … }'}</span><span title={v.type}>{v.type}</span></button>{expanded.has(v.id)&&<div className="table-detail"><VariableCard v={v} step={step} observe={observe} onObserve={onObserve}/>{v.warning&&<small className="hint">{v.warning}</small>}</div>}</React.Fragment>)}</div>;
}

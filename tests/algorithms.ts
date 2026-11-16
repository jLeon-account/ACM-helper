import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Debugger} from '../server/debugger';
import {defaultObserve,type ProjectConfig,type Snapshot,type Variable} from '../shared/types';
import {makeGraph} from '../shared/graph';

const engine=new Debugger();let stdout='',error='';let maxCaptureMs=0;
engine.on('event',event=>{if(event.type==='error')error=event.message;if(event.type==='output'&&event.channel==='stdout')stdout+=event.text;if(event.type==='snapshot')maxCaptureMs=Math.max(maxCaptureMs,event.snapshot.elapsedMs);});
async function wait(check:()=>boolean,label:string){const start=Date.now();while(!check()){if(error)throw Error(error);if(Date.now()-start>30000)throw Error('Timeout '+label);await new Promise(r=>setTimeout(r,10));}}
async function act(action:string){const step=engine.snapshot?.step??0;await engine.action(action);await wait(()=>engine.status==='exited'||(engine.status==='paused'&&(engine.snapshot?.step??0)>step),action);return engine.snapshot!;}
function variable(snapshot:Snapshot,name:string):Variable{const value=snapshot.variables.find(v=>v.name===name);assert(value,`Missing ${name} at ${snapshot.location.function}:${snapshot.location.line}`);assert.notEqual(value.kind,'unavailable',`${name}: ${value.warning}`);return value;}
function values(snapshot:Snapshot,name:string){return variable(snapshot,name).cells!.map(c=>c.value);}
const normalize=(s:string)=>s.trim().replace(/\s+/g,' ');
type Case={name:string;probe:string;index?:number;before:string;after:string;output:string;arrays:Record<string,string>;scalars?:Record<string,string>};
const cases:Case[]=[
 {name:'binary_search',probe:'left_bound',before:'0',after:'3',output:'4 -1 -1 -1',arrays:{answers:'4 -1 -1 -1'}},
 {name:'quick_sort',probe:'a',index:0,before:'4',after:'1',output:'-2 -2 0 1 4 4 7 9',arrays:{a:'-2 -2 0 1 4 4 7 9'}},
 {name:'knapsack',probe:'dp',index:11,before:'0',after:'3',output:'12',arrays:{},scalars:{}},
 {name:'floyd_warshall',probe:'dist',index:2,before:'10',after:'3',output:'0 0 3 4 INF INF 0 3 4 INF INF 0 0 1 INF INF -1 2 0 INF INF INF INF INF 0',arrays:{dist:'0 0 3 4 1000000 1000000 0 3 4 1000000 1000000 0 0 1 1000000 1000000 -1 2 0 1000000 1000000 1000000 1000000 1000000 0'}},
 {name:'union_find',probe:'parent',index:0,before:'-1',after:'1',output:'4 4 4 4 -1 -1 -1 3',arrays:{parent:'4 4 4 4 -1 -1 -1'},scalars:{components:'3'}},
 {name:'topological_sort',probe:'indegree',index:1,before:'1',after:'0',output:'0 6 1 2 3 5 4',arrays:{order:'0 6 1 2 3 5 4',indegree:'0 0 0 0 0 0 0',visited:'1 1 1 1 1 1 1'}}
];
const results:any[]=[];
async function load(name:string,mutate?:(text:string)=>string){
 stdout='';error='';maxCaptureMs=0;
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cppide-algorithm-'));
 let source=await fs.readFile(`example/${name}/${name}.cpp`,'utf8');if(mutate)source=mutate(source);
 await fs.writeFile(path.join(root,'main.cpp'),source);
 const config:ProjectConfig={entry:'main.cpp',stdin:'',inputMode:'preset',observe:defaultObserve(),breakpoints:{'main.cpp':[source.split('\n').findIndex(s=>s.includes('@probe'))+1]},...JSON.parse(await fs.readFile(`example/${name}/${name}.json`,'utf8'))};
 await engine.start(root,config,true);await wait(()=>engine.status==='paused','main');return config;
}
try{
 for(const test of cases){
  const config=await load(test.name);let snapshot=await act('continue');
  const before=variable(snapshot,test.probe);assert.equal(test.index===undefined?before.value:before.cells?.find(c=>c.index===test.index)?.value,test.before,`${test.name} before`);
  if(test.name==='quick_sort'||test.name==='union_find')assert(snapshot.frames.length>=2,'function frame missing');
  snapshot=await act('next');const changed=variable(snapshot,test.probe);const cell=test.index===undefined?changed:changed.cells!.find(c=>c.index===test.index)!;
  assert.equal(cell.value,test.after,`${test.name} after`);assert.equal(cell.changed,true);assert.equal(cell.pulse,true);
  for(const binding of config.bindings){const graph=makeGraph(binding,snapshot.bindingData![binding.id],snapshot.location.line);assert.equal(graph.nodes.length,Number(test.name==='floyd_warshall'?5:7));if(test.name==='union_find')assert.equal(graph.forest,true);if(test.name==='floyd_warshall'){assert(graph.edges.some(e=>e.label==='0'));assert(graph.edges.some(e=>e.label==='-1'));}}
  await engine.setBreakpoints({});snapshot=await act('continue');assert.equal(engine.status,'exited');assert.equal(snapshot.reason,'final');assert.equal(normalize(stdout),test.output,`${test.name} stdout`);
  for(const [name,expected] of Object.entries(test.arrays))assert.equal(values(snapshot,name).join(' '),expected,`${test.name} ${name}`);
  for(const [name,expected] of Object.entries(test.scalars??{}))assert.equal(variable(snapshot,name).value,expected);
  if(test.name==='knapsack'){const dp=variable(snapshot,'dp');assert.deepEqual(dp.shape,[5,9]);assert.equal(dp.cells?.find(c=>c.index===44)?.value,'12');}
  for(const binding of config.bindings){const graph=makeGraph(binding,snapshot.bindingData![binding.id],snapshot.location.line);assert.equal(graph.nodes.some(n=>n.current),false);if(test.name==='union_find'){assert.equal(graph.forest,true);assert.deepEqual(graph.roots,['4','5','6']);}if(test.name==='floyd_warshall')assert.deepEqual(graph.nodes.map(n=>n.distance),['0','0','3','4','∞']);}
  results.push({name:test.name,passed:true,output:normalize(stdout),maxCaptureMs});console.log(`${test.name}: breakpoint → step changes → final snapshot/output ✓ (${maxCaptureMs} ms max)`);
 }
 await load('topological_sort',source=>source.replace('m = 6','m = 7').replace('from[6] = {0, 0, 1, 2, 3, 2}','from[7] = {0, 0, 1, 2, 3, 2, 5}').replace('to[6] = {1, 2, 3, 3, 4, 5}','to[7] = {1, 2, 3, 3, 4, 5, 2}'));
 await engine.setBreakpoints({});await act('continue');assert.equal(normalize(stdout),'CYCLE 0 6 1');results.push({name:'topological_sort_cycle',passed:true});console.log('topological_sort: cyclic graph terminates and reports CYCLE ✓');
 await load('binary_search');await engine.setBreakpoints({});let steps=0;
 while(engine.status==='paused'&&steps<300){await act('next');steps++;}
 assert.equal(engine.status,'exited');assert.equal(normalize(stdout),'4 -1 -1 -1');results.push({name:'binary_search_all_steps',passed:true,steps});console.log(`binary_search: ${steps} consecutive source steps through exit ✓`);
 await fs.mkdir('.runtime',{recursive:true});await fs.writeFile('.runtime/algorithm-results.json',JSON.stringify({date:'2026-11-13',results},null,2));
}finally{await engine.stop();}

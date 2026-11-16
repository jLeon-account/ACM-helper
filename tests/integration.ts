import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Debugger } from '../server/debugger';
import { defaultObserve, type ProjectConfig, type Snapshot, type Variable } from '../shared/types';
const engine=new Debugger();let lastError='';let stdout='';
engine.on('event',e=>{if(e.type==='error'){lastError=e.message;console.error(e.message);}if(e.type==='output'){if(e.channel==='stdout')stdout+=e.text;if(e.channel==='build'||e.channel==='system')process.stdout.write(e.text);}});
async function wait(predicate:()=>boolean,label:string,timeout=30000){const start=Date.now();while(!predicate()){if(lastError)throw new Error(lastError);if(Date.now()-start>timeout)throw new Error('Timeout: '+label);await new Promise(r=>setTimeout(r,25));}}
async function paused(after=0){await wait(()=>engine.status==='paused'&&(engine.snapshot?.step??0)>after,'paused');return engine.snapshot!;}
function variable(s:Snapshot,name:string):Variable{const v=s.variables.find(v=>v.name===name);assert(v,`missing ${name}; got ${s.variables.map(x=>x.name)}`);return v;}
async function load(example:string,breakAt?:string){
  lastError='';stdout='';const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cppide-test-'));
  const source=await fs.readFile(`example/${example}/${example}.cpp`,'utf8');await fs.writeFile(path.join(dir,'main.cpp'),source);
  const config:ProjectConfig={entry:'main.cpp',stdin:'',breakpoints:{},bindings:[],observe:defaultObserve()};
  try{Object.assign(config,JSON.parse(await fs.readFile(`example/${example}/${example}.json`,'utf8')));}catch{}
  if(breakAt)config.breakpoints={'main.cpp':[source.split('\n').findIndex(x=>x.includes(breakAt))+1]};
  await engine.start(dir,config,true);await paused();return config;
}
async function act(action:string){const step=engine.snapshot?.step??0;await engine.action(action);return paused(step);}
async function custom(source:string,extra:Partial<ProjectConfig>={},headers:Record<string,string>={}){
  lastError='';stdout='';const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cppide-fixture-'));
  await fs.writeFile(path.join(dir,'main.cpp'),source);for(const [name,text] of Object.entries(headers))await fs.writeFile(path.join(dir,name),text);
  const config:ProjectConfig={entry:'main.cpp',stdin:'',breakpoints:{},bindings:[],observe:defaultObserve(),...extra};
  await engine.start(dir,config,true);return paused();
}
try{
  console.log('Dijkstra: compile / globals / matrix / real stepping');
  await load('dijkstra','dist[v] = dist[u]');
  assert.equal(variable(engine.snapshot!,'G').kind,'matrix');
  let s=await act('continue');assert.equal(variable(s,'dist').cells?.find(x=>x.index===1)?.value,'1000000000');
  s=await act('next');const cell=variable(s,'dist').cells?.find(x=>x.index===1);assert.equal(cell?.value,'5');assert.equal(cell?.changed,true);assert.equal(cell?.pulse,true);
  assert.equal(s.bindingData?.['dijkstra-graph']?.count,6);
  console.log('Dijkstra: INF → 5, changed=true, pulse=true ✓');
  await engine.setBreakpoints({});await engine.action('continue');await wait(()=>engine.status==='exited','exit');assert.match(stdout,/dist\[1\] = 5/);
  assert.equal(engine.snapshot?.reason,'final');assert.equal(variable(engine.snapshot!,'dist').cells?.find(x=>x.index===5)?.value,'45');
  assert.equal(engine.snapshot?.bindingData?.['dijkstra-graph'].distance[5],'45');
  console.log('Large array: hidden modifications / restored values / budget');
  await load('large','a[100] = 5');s=await act('continue');
  assert.equal(variable(s,'a').length,1000000);assert.equal(variable(s,'a').monitored?.[1],999999);
  s=await act('next');assert.equal(variable(s,'a').cells?.find(x=>x.index===100)?.value,'5');
  s=await act('next');assert.equal(variable(s,'a').cells?.find(x=>x.index===500000)?.value,'42');
  s=await act('next');s=await act('next');assert.equal(variable(s,'a').cells?.find(x=>x.index===100)?.changed,true);
  console.log(`Large array: ${s.monitoredBytes} bytes, ${s.elapsedMs} ms ✓`);
  console.log('vector / stdio');await load('sort');assert.equal(variable(engine.snapshot!,'a').kind,'array',JSON.stringify(variable(engine.snapshot!,'a')));
  await engine.action('continue');await wait(()=>engine.status==='exited','sort exit');assert.match(stdout,/1 2 3 4 6 7 8 9/);
  await load('recursion');await engine.action('continue');await wait(()=>engine.status==='exited','stdin exit');assert.match(stdout,/120/);
  await custom('#include <vector>\nstd::vector<int> a={1};\nint main(){\n a[0]=2;\n a.push_back(3);\n return 0;\n}\n');
  s=await act('next');assert.equal(variable(s,'a').cells?.[0].changed,true);
  s=await act('next');assert.equal(variable(s,'a').length,2);assert.equal(variable(s,'a').cells?.[0].changed,true);assert.equal(variable(s,'a').cells?.[1].pulse,true);
  console.log('Budget / explicit ranges / struct / 64-bit / project header');
  const source='#include "helper.h"\nint a[3000000];\nlong long big=9007199254740993LL;\nstruct Point { int x; double y; };\nPoint p={3,2.5};\nint main(){\n  a[100]=7;\n  a[100]=9;\n  return helper(p.x);\n}\n';
  s=await custom(source,{}, {'helper.h':'inline int helper(int x) { return x-3; }'});
  assert.match(variable(s,'a').warning??'',/8 MiB/);assert.equal(variable(s,'big').value,'9007199254740993');assert.equal(variable(s,'p').children?.find(c=>c.name==='x')?.value,'3');
  engine.config!.observe.ranges={a:[90,110]};engine.config!.observe.pins=['a[100]'];await engine.capture('refresh');
  s=await act('next');assert.equal(variable(s,'a').cells?.find(c=>c.index===100)?.value,'7');assert.deepEqual(variable(s,'a').monitored,[90,110]);
  await engine.action('reset');assert.equal(variable(engine.snapshot!,'a').cells?.find(c=>c.index===100)?.changed,false);
  s=await act('next');assert.equal(variable(s,'a').cells?.find(c=>c.index===100)?.pulse,true);
  console.log('Auto stepping through program exit');
  await custom('int main(){\n int x=0;\n x=1;\n return 0;\n}\n');
  for(let i=0;i<12&&engine.status==='paused';i++){
    const old=engine.snapshot!.step;await engine.action('next');await wait(()=>engine.status==='exited'||(engine.status==='paused'&&engine.snapshot!.step>old),'step or exit');
  }
  assert.equal(engine.status,'exited');
  console.log('Recursion frame identities / switching / signal / stop');
  await load('tree','depth[node] = d');s=await act('continue');const first=s.frames[0].id;s=await act('continue');assert.notEqual(s.frames[0].id,first);assert(s.frames.length>=3);
  await engine.action('frame',{level:1});assert.equal(engine.snapshot!.frame,1);assert.equal(variable(engine.snapshot!,'node').value,'0');
  await custom('int main(){\n volatile int* p=nullptr;\n *p=1;\n return 0;\n}\n');await engine.action('continue');await paused(engine.snapshot!.step);assert.equal(engine.snapshot!.reason,'signal-received');
  await engine.stop();assert.equal(engine.status,'idle');
  await custom('int main(){\n volatile int x=0;\n while(true){++x;}\n}\n');await engine.action('continue');await engine.stop();assert.equal(engine.status,'idle');
  console.log('BFS real graph / initialization inference / unsafe expressions');
  await load('bfs','visited[v] = true');s=await act('continue');s=await act('next');assert.equal(variable(s,'visited').cells?.find(c=>c.index===1)?.value,'true');assert.equal(s.bindingData?.['bfs-graph'].status[1],'true');
  await custom('#include <algorithm>\nint a[300];\nint main(){\n std::fill(a+30,a+70,5);\n for(int i=100;i<120;++i){\n  a[i]=2;\n }\n return 0;\n}\n');
  s=await act('next');assert(variable(s,'a').runs?.some(r=>r.start===30&&r.reason==='疑似初始化'));
  for(let i=0;i<80;i++){if(engine.snapshot!.location.line===8)break;s=await act('next');}
  assert(variable(engine.snapshot!,'a').runs?.some(r=>r.start===100&&r.reason==='疑似初始化'));
  await custom('#include <vector>\nint main(){\n std::vector<int> a={1,2,3};\n a[0]=9;\n return 0;\n}\n');
  await engine.action('continue');await wait(()=>engine.status==='exited','local vector final');assert.equal(variable(engine.snapshot!,'a').kind,'unavailable');assert.match(variable(engine.snapshot!,'a').warning??'',/析构/);
  console.log('Compile error propagates');
  await engine.stop();const bad=await fs.mkdtemp(path.join(os.tmpdir(),'cppide-bad-'));await fs.writeFile(path.join(bad,'main.cpp'),'int main( {');
  await assert.rejects(()=>engine.start(bad,{entry:'main.cpp',stdin:'',bindings:[],breakpoints:{},observe:defaultObserve()}),/编译未通过/);
  console.log('Integration passed ✓');
}finally{await engine.stop();}

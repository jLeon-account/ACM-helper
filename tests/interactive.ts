import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Debugger} from '../server/debugger';
import {defaultObserve,type ProjectConfig} from '../shared/types';
const engine=new Debugger();let output='';let error='';
engine.on('event',e=>{if(e.type==='terminal')output+=e.data;if(e.type==='error')error=e.message;});
async function wait(check:()=>boolean,name:string){const begin=Date.now();while(!check()){if(error)throw Error(error);if(Date.now()-begin>15000)throw Error(name+' timeout, '+JSON.stringify(output));await new Promise(r=>setTimeout(r,20));}}
const folder=await fs.mkdtemp(path.join(os.tmpdir(),'cppide-interactive-'));
const config:ProjectConfig={entry:'main.cpp',stdin:'',inputMode:'terminal',observe:defaultObserve(),bindings:[],breakpoints:{}};
try{
  await fs.writeFile(path.join(folder,'main.cpp'),'#include <iostream>\nint main(){\n int a[2]={1,2};\n int x;\n std::cout<<"number: ";\n std::cin>>x;\n a[1]=x*2;\n std::cout<<"answer="<<a[1]<<std::endl;\n return a[0]=7;\n}\n');
  await engine.start(folder,config,true);await wait(()=>engine.status==='paused','main pause');await engine.action('continue');await wait(()=>output.includes('number:'),'prompt');engine.resizeTerminal(60,20);engine.input('9\r');await wait(()=>engine.status==='exited','exit');
  await wait(()=>output.includes('answer=18'),'output');assert.equal(engine.snapshot?.reason,'final');const a=engine.snapshot?.variables.find(v=>v.name==='a');assert.equal(a?.cells?.find(c=>c.index===0)?.value,'7');assert.equal(a?.cells?.find(c=>c.index===1)?.value,'18');
  console.log('GDB + ConPTY: interactive prompt, input, final local array including return-expression change ✓');
  output='';await fs.writeFile(path.join(folder,'main.cpp'),'#include <iostream>\nint main(){std::ios::sync_with_stdio(false);std::cin.tie(nullptr);int x;while(std::cin>>x)std::cout<<"value="<<x<<std::endl;}');
  await engine.start(folder,config,false);engine.input('21\r');await wait(()=>output.includes('value=21'),'unsynchronized flushed output');engine.input('32\r');await wait(()=>output.includes('value=32'),'second line');await engine.stop();assert.equal(engine.status,'idle');
  console.log('Unsynchronized iostream: repeated input/output; stop while waiting for input ✓');
}finally{await engine.stop();}

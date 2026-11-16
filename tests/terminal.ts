import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {NativeTerminal} from '../server/terminal';
let output='';const terminal=new NativeTerminal(text=>{output+=text;});
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cppide-console-'));
const source=path.join(dir,'main.cpp');const binary=path.join(dir,'program.exe');
await fs.writeFile(source,'#include <iostream>\nint main(){int x;std::cout<<"number: ";std::cin>>x;std::cout<<"answer="<<x*2<<std::endl;std::cin>>x;std::cout<<"second="<<x*3<<std::endl;}');
async function wait(match:RegExp){const begin=Date.now();while(!match.test(output)){if(Date.now()-begin>10000)throw new Error('Missing '+match+' output='+JSON.stringify(output));await new Promise(r=>setTimeout(r,20));}}
try{
 await new Promise<void>((resolve,reject)=>{const p=spawn('g++',['-std=c++17',source,path.resolve('server/native/runtime.cpp'),'-o',binary],{windowsHide:true});p.stderr.pipe(process.stderr);p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error('compile')));});
 const pid=await terminal.start('g++');const p=spawn(binary,[],{windowsHide:true,env:{...process.env,CPPIDE_CONSOLE_PID:String(pid)}});p.stderr.on('data',b=>process.stderr.write(b));
 await wait(/number:/);terminal.input('7\r');await wait(/answer=14/);terminal.resize(60,20);terminal.input('9\r');await wait(/second=27/);assert.match(output,/7/);console.log('ConPTY: real prompt, line input, echo, output, resize ✓');
}finally{await terminal.stop();}

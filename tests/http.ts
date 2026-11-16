import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
const projects=await fs.mkdtemp(path.join(os.tmpdir(),'cppide-api-'));
const port=4187;const base=`http://127.0.0.1:${port}`;
const proc=spawn(process.execPath,['--import','tsx','server/index.ts'],{cwd:process.cwd(),windowsHide:true,env:{...process.env,PORT:String(port),PROJECTS_DIR:projects}});
let logs='';proc.stdout.on('data',b=>logs+=b);proc.stderr.on('data',b=>logs+=b);
try{
  const start=Date.now();while(!logs.includes(base)){if(Date.now()-start>15000)throw new Error('Server not ready: '+logs);await new Promise(r=>setTimeout(r,100));}
  const home=await fetch(base);assert.equal(home.status,200);assert.match(await home.text(),/C\+\+ 调试工作区/);
  assert.equal((await fetch(base+'/api/projects')).status,403);
  assert.equal((await fetch(base+'/api/session',{headers:{Origin:'https://example.com'}})).status,403);
  const session=await fetch(base+'/api/session').then(r=>r.json());const headers={'Content-Type':'application/json','X-Cppide-Token':session.token};
  const list=await fetch(base+'/api/projects',{headers}).then(r=>r.json());assert.equal(list.length,1);
  const create=await fetch(base+'/api/projects',{method:'POST',headers,body:JSON.stringify({name:'API test',example:'bfs'})}).then(r=>r.json());assert.equal(create.config.bindings[0].kind,'matrix');
  const bad=await fetch(base+'/api/file',{method:'PUT',headers,body:JSON.stringify({project:create.id,file:'../escape.cpp',content:'x'})});assert.equal(bad.status,400);
  const saved=await fetch(base+'/api/file',{method:'PUT',headers,body:JSON.stringify({project:create.id,file:'helper.h',content:'inline int add(int a,int b){return a+b;}'})});assert.equal(saved.status,200);
  const opened=await fetch(base+`/api/file?project=${create.id}&file=helper.h`,{headers}).then(r=>r.json());assert.match(opened.content,/return a\+b/);
  const external=await fs.mkdtemp(path.join(os.tmpdir(),'cppide-open-'));await fs.writeFile(path.join(external,'main.cpp'),'int main(){return 0;}');
  const openedProject=await fetch(base+'/api/projects/open',{method:'POST',headers,body:JSON.stringify({path:external})}).then(r=>r.json());assert.equal(openedProject.path,external);assert.equal(openedProject.config.inputMode,'terminal');
  console.log('HTTP: page, token, origin, project creation, traversal rejection, header save/open ✓');
}finally{
  proc.kill();await new Promise<void>(resolve=>{if(proc.exitCode!==null)resolve();else{proc.once('exit',()=>resolve());setTimeout(resolve,3000);}});
}

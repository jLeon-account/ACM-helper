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
  const home=await fetch(base);assert.equal(home.status,200);assert.match(await home.text(),/ACM Helper/);
  assert.equal((await fetch(base+'/api/projects')).status,403);
  assert.equal((await fetch(base+'/api/session',{headers:{Origin:'https://example.com'}})).status,403);
  const session=await fetch(base+'/api/session').then(r=>r.json());const headers={'Content-Type':'application/json','X-Cppide-Token':session.token};
  const list=await fetch(base+'/api/projects',{headers}).then(r=>r.json());assert.equal(list.length,1);
  const create=await fetch(base+'/api/projects',{method:'POST',headers,body:JSON.stringify({name:'API test',example:'bfs'})}).then(r=>r.json());assert.equal(create.config.bindings[0].kind,'matrix');
  const bad=await fetch(base+'/api/file',{method:'PUT',headers,body:JSON.stringify({project:create.id,file:'../escape.cpp',content:'x'})});assert.equal(bad.status,400);
  const saved=await fetch(base+'/api/file',{method:'PUT',headers,body:JSON.stringify({project:create.id,file:'helper.h',content:'inline int add(int a,int b){return a+b;}'})});assert.equal(saved.status,200);
  const opened=await fetch(base+`/api/file?project=${create.id}&file=helper.h`,{headers}).then(r=>r.json());assert.match(opened.content,/return a\+b/);
  const post=(route:string,body:unknown)=>fetch(base+'/api/'+route,{method:'POST',headers,body:JSON.stringify(body)});
  const created=await post('file/create',{project:create.id,file:'solve.cpp'});assert.equal(created.status,200);const createdBody=await created.json();
  assert.equal(createdBody.file,'solve.cpp');assert.match(createdBody.content,/int main/);assert.ok(createdBody.project.files.includes('solve.cpp'));
  assert.equal((await post('file/create',{project:create.id,file:'solve.cpp'})).status,400);
  assert.equal((await post('file/create',{project:create.id,file:'../outside.cpp'})).status,400);
  await fetch(base+'/api/config',{method:'PUT',headers,body:JSON.stringify({project:create.id,config:{...create.config,breakpoints:{'main.cpp':[3]}}})});
  const renamed=await post('file/rename',{project:create.id,from:'main.cpp',to:'first.cpp'}).then(r=>r.json());
  assert.equal(renamed.file,'first.cpp');assert.equal(renamed.project.config.entry,'first.cpp');assert.deepEqual(renamed.project.config.breakpoints,{'first.cpp':[3]});assert.ok(!renamed.project.files.includes('main.cpp'));
  assert.equal((await post('file/rename',{project:create.id,from:'first.cpp',to:'solve.cpp'})).status,400);
  assert.equal((await post('file/rename',{project:create.id,from:'first.cpp',to:'first.exe'})).status,400);
  const removed=await post('file/delete',{project:create.id,file:'solve.cpp'}).then(r=>r.json());assert.ok(!removed.project.files.includes('solve.cpp'));
  const lastCpp=await post('file/delete',{project:create.id,file:'first.cpp'});assert.equal(lastCpp.status,400);assert.match((await lastCpp.json()).error,/至少需要保留/);
  assert.equal((await post('file/rename',{project:create.id,from:'first.cpp',to:'first.h'})).status,400);
  for(const hidden of ['.secret.cpp','build/a.cpp','a/b/c/d/e/f.cpp','dir /a.cpp','con.cpp'])assert.equal((await post('file/create',{project:create.id,file:hidden})).status,400,hidden);
  const nested=await post('file/create',{project:create.id,file:'sub/part.cpp'}).then(r=>r.json());assert.equal(nested.file,'sub/part.cpp');assert.ok(nested.project.files.includes('sub/part.cpp'));
  const movedNested=await post('file/rename',{project:create.id,from:'sub/part.cpp',to:'sub/piece.cpp'}).then(r=>r.json());assert.ok(movedNested.project.files.includes('sub/piece.cpp'));
  assert.equal((await fetch(base+'/api/config',{method:'PUT',headers,body:JSON.stringify({project:create.id,config:{...renamed.project.config,entry:'helper.h'}})})).status,400);
  if(process.platform!=='win32'){const dialog=await post('dialog/folder',{}).then(r=>r.json());assert.equal(dialog.code,'unsupported');}
  const external=await fs.mkdtemp(path.join(os.tmpdir(),'cppide-open-'));await fs.writeFile(path.join(external,'main.cpp'),'int main(){return 0;}');
  const openedProject=await fetch(base+'/api/projects/open',{method:'POST',headers,body:JSON.stringify({path:external})}).then(r=>r.json());assert.equal(openedProject.path,external);assert.equal(openedProject.config.inputMode,'terminal');
  console.log('HTTP: page, token, origin, project creation, traversal rejection, header save/open, file create/rename/delete ✓');
}finally{
  proc.kill();await new Promise<void>(resolve=>{if(proc.exitCode!==null)resolve();else{proc.once('exit',()=>resolve());setTimeout(resolve,3000);}});
}

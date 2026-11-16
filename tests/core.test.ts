import test from 'node:test';import assert from 'node:assert/strict';
import {parseMI} from '../server/mi';import {makeGraph} from '../shared/graph';import {defaultBinding,type BindingData} from '../shared/types';
test('MI parses nested results, lists, escaped output and tokens',()=>{
  const r=parseMI('17^done,stack=[frame={level="0",func="main",line="12"},frame={level="1",func="f"}]');
  assert.equal(r?.token,17);assert.equal(r?.data.stack[1].frame.func,'f');assert.equal(parseMI('~"hello\\n\\"world\\""')?.data,'hello\n"world"');
});
const data=(source:string[][]):BindingData=>({count:source.length,edgeCount:0,source,from:[],to:[],weight:[],labels:[],status:[],distance:[],current:'0',target:'1',root:'',absent:'-1',infinity:''});
test('zero-weight edges survive and undirected matrix edges deduplicate',()=>{
  const binding={...defaultBinding(),absent:'-1'};const g=makeGraph(binding,data([['-1','0'],['0','-1']]),2);
  assert.equal(g.edges.length,1);assert.equal(g.edges[0].label,'0');assert.equal(g.forest,true);
});
test('cycles and self loops do not receive a tree layout',()=>{
  const b=defaultBinding();assert.equal(makeGraph(b,data([['1']]),1).forest,false);
  assert.equal(makeGraph(b,data([['-1','1','1'],['1','-1','1'],['1','1','-1']]),1).forest,false);
});
test('current-edge highlighting obeys source line range',()=>{
  const b={...defaultBinding(),lineStart:10,lineEnd:20};const d=data([['-1','1'],['1','-1']]);
  assert.equal(makeGraph(b,d,5).edges[0].current,false);assert.equal(makeGraph(b,d,15).edges[0].current,true);
});
test('invalid parent edge fails instead of inventing a node',()=>{
  const b={...defaultBinding(),kind:'parent' as const};const d={...data([['-1','99']]),count:2};assert.throws(()=>makeGraph(b,d,1),/超出/);
});

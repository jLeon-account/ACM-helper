export type Cell = { index: number; value: string; changed: boolean; pulse: boolean };
export type Variable = {
  id: string; name: string; expression: string; type: string; scope: string;
  kind: 'scalar' | 'array' | 'matrix' | 'struct' | 'unavailable';
  value?: string; changed?: boolean; pulse?: boolean; children?: Variable[];
  length?: number; shape?: number[]; cells?: Cell[]; runs?: FoldRun[];
  monitored?: [number, number]; page?: [number, number]; address?: string;
  warning?: string; initialization?: string;
};
export type FoldRun = { start: number; end: number; value: string; reason: string };
export type Frame = { level: number; name: string; file: string; line: number; id: string };
export type Snapshot = {
  session: string; step: number; reason: string; frames: Frame[]; frame: number;
  location: {file: string; line: number; function: string}; variables: Variable[];
  watches: Record<string, string>; warnings: string[]; elapsedMs: number;
  monitoredBytes: number; timestamp: number;
  bindingData?: Record<string, BindingData>;
};
export type BindingData = {count:number; edgeCount:number; source:string[][]; from:string[];to:string[];weight:string[];labels:string[];status:string[];distance:string[];current:string;target:string;root:string;absent:string;infinity:string;error?:string};
export type Binding = {
  id: string; name: string; kind: 'matrix' | 'edges' | 'parent';
  source: string; from: string; to: string; weight: string;
  count: string; edgeCount: string; base: number; directed: boolean;
  absent: string; root: string; labels: string; status: string; distance: string;
  current: string; target: string; lineStart: number; lineEnd: number;
  infinity: string; positions: Record<string, {x: number; y: number}>;
};
export type ObserveOptions = {
  pins: string[]; pages: Record<string, number>; ranges: Record<string, [number,number]>;
  expanded: string[]; inferInitialization: boolean; fold: boolean;
};
export type ProjectConfig = { entry: string; stdin: string; inputMode?:'terminal'|'preset'; breakpoints: Record<string,number[]>; bindings: Binding[]; observe: ObserveOptions };
export type Project = { id: string; name: string; path?:string; files: string[]; config: ProjectConfig };
export type DebugStatus = 'idle' | 'compiling' | 'running' | 'paused' | 'exited' | 'error';
export type ServerEvent =
 | {type:'status'; status:DebugStatus; message?:string; session:string}
 | {type:'snapshot'; snapshot:Snapshot}
 | {type:'output'; channel:'stdout'|'stderr'|'build'|'system'; text:string; session:string}
 | {type:'terminal'; data:string; session:string; reset?:boolean}
 | {type:'error'; message:string; session:string};
export const defaultObserve = ():ObserveOptions => ({ pins:[], pages:{}, ranges:{}, expanded:[], inferInitialization:true, fold:true });
export const defaultBinding = ():Binding => ({id:crypto.randomUUID(),name:'图结构',kind:'matrix',source:'G',from:'from',to:'to',weight:'weight',count:'n',edgeCount:'m',base:0,directed:false,absent:'0',root:'',labels:'',status:'visited',distance:'',current:'u',target:'v',lineStart:0,lineEnd:0,infinity:'',positions:{}});

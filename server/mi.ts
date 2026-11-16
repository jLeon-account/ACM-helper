// GDB/MI grammar: quoted C strings, tuples, lists and repeated result keys.
export function parseMI(line: string): { token?:number; kind:string; cls:string; data:any } | null {
  const match = /^(\d*)([\^*+=~@&])(.*)$/.exec(line.trim());
  if (!match) return null;
  let i = 0; const s = match[3];
  function quoted():string {
    i++; let out='';
    while(i<s.length) { const c=s[i++]; if(c==='"') break;
      if(c!=='\\') {out+=c;continue;}
      const e=s[i++]; const map:Record<string,string>={n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v','\\':'\\','"':'"'};
      if(/[0-7]/.test(e)) {let oct=e;for(let n=0;n<2&&/[0-7]/.test(s[i]??'x');n++)oct+=s[i++];out+=String.fromCharCode(parseInt(oct,8));}
      else out+=map[e]??e;
    } return out;
  }
  function key():string {const start=i;while(i<s.length&& !'=,]}'.includes(s[i]))i++;return s.slice(start,i);}
  function value():any {
    if(s[i]==='"')return quoted();
    if(s[i]==='{'){i++;const o=results('}');i++;return o;}
    if(s[i]==='['){i++;const a:any[]=[];while(i<s.length&&s[i]!==']'){
      if(s[i]==='"'||s[i]==='{'||s[i]==='[')a.push(value());
      else {const k=key();if(s[i]==='='){i++;a.push({[k]:value()});}else a.push(k);}
      if(s[i]===',')i++;else break;
    }i++;return a;}
    return key();
  }
  function results(end=''):any {const o:any={};while(i<s.length&&s[i]!==end){const k=key();if(s[i]!=='=')break;i++;o[k]=value();if(s[i]===',')i++;else break;}return o;}
  if('~@&'.includes(match[2]))return {kind:match[2],cls:'',data:quoted()};
  const comma=s.indexOf(','); const cls=comma<0?s:s.slice(0,comma);i=comma<0?s.length:comma+1;
  return {token:match[1]?Number(match[1]):undefined,kind:match[2],cls,data:results()};
}
export const miQuote = (value:string) => JSON.stringify(value);

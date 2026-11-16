import {ChevronDown,ChevronUp} from 'lucide-react';

export default function SpeedControl({value,onChange}:{value:number;onChange:(value:number)=>void}){
  function commit(next:number){
    const bounded=Math.max(.1,Math.min(100,next||2));
    onChange(bounded);localStorage.setItem('cppide-speed',String(bounded));
  }
  return <div className="speed-control"><div className="speed-input">
    <input aria-label="播放速度" type="number" min="0.1" max="100" step="0.1" value={value}
      onChange={e=>{const next=Number(e.target.value);onChange(next);if(next>=.1&&next<=100)localStorage.setItem('cppide-speed',String(next));}}
      onBlur={()=>commit(value)}/>
    <div className="speed-arrows">
      <button type="button" aria-label="提高播放速度" title="提高 0.1 步 / 秒" disabled={value>=100} onClick={()=>commit(Math.round((value+.1)*10)/10)}><ChevronUp size={10}/></button>
      <button type="button" aria-label="降低播放速度" title="降低 0.1 步 / 秒" disabled={value<=.1} onClick={()=>commit(Math.round((value-.1)*10)/10)}><ChevronDown size={10}/></button>
    </div>
  </div><span>步 / 秒</span></div>;
}

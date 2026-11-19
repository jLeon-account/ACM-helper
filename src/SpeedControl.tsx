import {ChevronDown,ChevronUp} from 'lucide-react';

export default function SpeedControl({value,onChange,actual=0}:{value:number;onChange:(value:number)=>void;actual?:number}){
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
  </div><span>步 / 秒</span>{actual>0&&<small className="speed-actual" title="自动播放时实际达到的速度；单步本身需要时间，速度很高时会一次执行多步、只刷新最后一步的画面">实际 {actual<10?actual.toFixed(1):Math.round(actual)}</small>}</div>;
}

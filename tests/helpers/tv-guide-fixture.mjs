import {TVGuideClient} from '../../web/tv/tanstack-query.js';
export const NOW=Date.parse('2026-10-14T12:00:00Z');
export const flush=()=>new Promise(resolve=>setImmediate(resolve));
export const program=(title,from=-60000,to=60000)=>({title,description:`Sinopse de ${title}`,start:new Date(NOW+from).toISOString(),end:new Date(NOW+to).toISOString(),startLabel:'09:00',endLabel:'09:02'});
export const channel=(title='Agora')=>({status:'ready',window:{previous:null,current:program(title),next:program('Próximo',60000,120000)},progressPercent:37,elapsedSeconds:22,remainingSeconds:38});
export const projection=(channels={'10':channel()},extra={})=>({schemaVersion:1,serverTime:new Date(NOW).toISOString(),nextRefreshAt:new Date(NOW+60000).toISOString(),revision:'revision-a',channels,...extra});
export function clock(){
 let time=NOW,next=0;const timers=new Map();
 return {now:()=>time,schedule:(callback,delay)=>{const id=++next;timers.set(id,{at:time+delay,callback});return id;},cancel:id=>timers.delete(id),timers,
  async advance(duration){const end=time+duration;for(;;){const due=[...timers].filter(([,task])=>task.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;time=due[1].at;timers.delete(due[0]);due[1].callback();await flush();}time=end;await flush();},get size(){return timers.size;}};
}
export function fixture(t,{request=async()=>projection(),scope={account:'account-a',epoch:1},...options}={}){
 const time=clock(),calls=[];let currentScope=scope;
 const guide=new TVGuideClient({...time,getScope:()=>currentScope,document:{hidden:false},loadQueryCore:async()=>{throw new Error('SDK unavailable in fixture');},request:(url,opts)=>{calls.push({url,...opts});return request(url,opts);},...options});
 t.after(()=>guide.dispose());
 return {guide,time,calls,setScope(value){currentScope=value;},async ready(){await flush();await flush();}};
}

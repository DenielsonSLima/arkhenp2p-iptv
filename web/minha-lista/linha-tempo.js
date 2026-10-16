import {parseProgramTime,programWindow} from '../tv/canais/programacao.js';

export const HALF_HOUR=30*60*1000,HOUR=2*HALF_HOUR;
const key=program=>JSON.stringify([program.title,parseProgramTime(program.start),parseProgramTime(program.end)]);

/** Geometry shares one absolute time scale across channels. Programme
 * selection and display labels still come from the server projection. */
export function timelinePrograms(data){
  const window=programWindow(data),seen=new Set(),result=[];
  const selected=new Map([['previous','Anterior'],['current','Agora'],['next','A seguir'],['afterNext','Depois']]
    .filter(([name])=>window[name]).map(([name,label])=>[key(window[name]),{name,label}]));
  for(const program of [...Object.values(window),...(Array.isArray(data?.schedule)?data.schedule:[])]){
    if(!program?.title)continue;
    const start=parseProgramTime(program.start),end=parseProgramTime(program.end),id=key(program);
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||seen.has(id))continue;
    seen.add(id);const state=selected.get(id)||{name:'later',label:'Depois'};
    result.push({...program,key:id,startMs:start,endMs:end,...state});
  }
  return result.sort((a,b)=>a.startMs-b.startMs||a.endMs-b.endMs).slice(0,132);
}

export function timelineRange(stamp,channels=[]){
  if(!Number.isFinite(stamp))return null;
  let earliest=stamp,last=stamp;
  for(const data of channels){
    const current=programWindow(data).current,currentStart=parseProgramTime(current?.start);
    if(Number.isFinite(currentStart)&&currentStart<=stamp)earliest=Math.min(earliest,currentStart);
    for(const program of timelinePrograms(data))if(program.endMs>stamp&&program.startMs<stamp+24*HOUR)last=Math.max(last,Math.min(stamp+24*HOUR,program.endMs));
  }
  // Keep the start of current shows when nearby. Very long broadcasts may
  // be clipped, but their real start label and full title remain available.
  const start=Math.floor(Math.max(stamp-90*60*1000,earliest)/HALF_HOUR)*HALF_HOUR;
  const end=Math.max(start+HALF_HOUR,Math.ceil(last/HALF_HOUR)*HALF_HOUR);
  return {start,end,duration:end-start,hours:(end-start)/HOUR};
}

export function timelinePosition(stamp,range){return (stamp-range.start)/range.duration*100;}

export function timelineSlot(program,range){
  const start=Math.max(program.startMs,range.start),end=Math.min(program.endMs,range.end);
  if(end<=start)return null;
  return {left:timelinePosition(start,range),width:(end-start)/range.duration*100,compact:end-start<10*60*1000};
}

export function timelineFormatter(timeZone,{seconds=false}={}){
  const options={timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23',...(seconds?{second:'2-digit'}:{})};
  try{return new Intl.DateTimeFormat('pt-BR',options);}
  catch{return new Intl.DateTimeFormat('pt-BR',{...options,timeZone:'America/Maceio'});}
}

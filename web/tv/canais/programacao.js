const bounded=(value,min,max,fallback)=>Number.isFinite(Number(value))?Math.min(max,Math.max(min,Number(value))):fallback;
const clock=value=>/^\d{2}:\d{2}$/.test(String(value??''))?String(value):'';
const text=value=>String(value??'').trim();
const isChannelID=value=>/^\d{1,12}$/.test(String(value??''));
const MAX_SCHEDULE_PROGRAMS=128;
const absoluteTime=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:?\d{2})$/.test(value)?Date.parse(value):NaN;

function program(value){
  if(!value||typeof value!=='object'||!text(value.title))return null;
  return {title:text(value.title),description:text(value.description),start:value.start,end:value.end,
    startLabel:clock(value.startLabel),endLabel:clock(value.endLabel)};
}

function normalizeWindow(value){
  return {previous:program(value?.previous),current:program(value?.current),next:program(value?.next),afterNext:program(value?.afterNext)};
}

function schedulePrograms(values){
  const entries=[],seen=new Set();
  for(const value of values.slice(0,MAX_SCHEDULE_PROGRAMS*2)){
    const entry=program(value),start=absoluteTime(entry?.start),end=absoluteTime(entry?.end);
    if(!entry||!Number.isFinite(start)||!Number.isFinite(end)||end<=start)continue;
    const key=JSON.stringify([entry.title,start,end]);if(seen.has(key))continue;
    seen.add(key);entries.push({...entry,start:new Date(start).toISOString(),end:new Date(end).toISOString()});
  }
  return entries.sort((a,b)=>Date.parse(a.start)-Date.parse(b.start)||Date.parse(a.end)-Date.parse(b.end)||a.title.localeCompare(b.title)).slice(0,MAX_SCHEDULE_PROGRAMS);
}

/** Accept the database projection, never derive its current programme, clock
 * labels or progress from the browser's clock/time zone. */
export function normalizeGuideChannel(value){
  if(!value||typeof value!=='object'||!value.window||typeof value.window!=='object')return null;
  const window=normalizeWindow(value.window);
  const legacy=['previous','current','next'].map(key=>window[key]).filter(Boolean);
  const source=Array.isArray(value.schedule)&&value.schedule.length?value.schedule:Array.isArray(value.list)?value.list:legacy;
  const schedule=schedulePrograms([window.current,window.next,window.afterNext,...source].filter(Boolean));
  return {...value,window,list:legacy,schedule,
    progressPercent:bounded(value.progressPercent,0,100,0),
    elapsedSeconds:bounded(value.elapsedSeconds,0,Number.MAX_SAFE_INTEGER,0),
    remainingSeconds:bounded(value.remainingSeconds,0,Number.MAX_SAFE_INTEGER,0)};
}

export function validateGuideProjection(value){
  if(value?.schemaVersion!==1||!value.channels||typeof value.channels!=='object'||Array.isArray(value.channels)||
    !Number.isFinite(Date.parse(value.serverTime))||!Number.isFinite(Date.parse(value.nextRefreshAt))||
    Object.keys(value.channels).length>2000)throw new Error('TV_GUIDE_RESPONSE_INVALID');
  const channels={};
  for(const [id,entry] of Object.entries(value.channels)){
    const channel=normalizeGuideChannel(entry);
    if(!isChannelID(id)||!channel)throw new Error('TV_GUIDE_RESPONSE_INVALID');
    channels[id]=channel;
  }
  return {...value,channels};
}

// Kept for metadata consumers; programme selection and display clocks are
// supplied by the server projection, never inferred from the local clock.
export function parseProgramTime(value){
  if(value===null||value===undefined||value==='')return NaN;
  if(typeof value==='number'||/^\d+(?:\.\d+)?$/.test(String(value))){
    const number=Number(value);return number>0?(number<1e12?number*1000:number):NaN;
  }
  return Date.parse(String(value).replace(/^(\d{4}-\d{2}-\d{2}) /,'$1T'));
}

export function programWindow(data){
  return normalizeWindow(data?.window);
}

// Legacy import compatibility only. Lists without a server window do not
// manufacture a current programme or keep a disappeared event alive.
export function retainCurrentProgramList(_previous,incoming){return Array.isArray(incoming)?incoming:[];}

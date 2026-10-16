import {projectTvGuide} from './grade-legada.mjs';

const HASH=/^[a-f0-9]{64}$/i,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,ID=/^\d{1,12}$/;
const ZONES=new Set(['America/Maceio','America/Sao_Paulo','UTC']);
const MAX_CHANNELS=10000,MAX_VISIBLE=2000,MAX_PROGRAMS=250000,BATCH=80,DEADLINE_MS=8000,RETRY_MS=30000;
const object=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const text=(value,max)=>typeof value==='string'?value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/(?:https?:)?\/\/[^\s<>"']+/gi,'').trim().slice(0,max):'';
const failure=()=>{throw new Error('TV_PUBLISHED_SCHEDULE_INVALID');};
function timestamp(value){
  if(typeof value!=='string')return null;
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/.exec(value);
  if(!match)return null;
  const [year,month,day,hour,minute,second]=match.slice(1).map(Number),calendar=new Date(Date.UTC(year,month-1,day));
  if(year<1000||month<1||month>12||calendar.getUTCFullYear()!==year||calendar.getUTCMonth()!==month-1||calendar.getUTCDate()!==day||hour>23||minute>59||second>59)return null;
  const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:null;
}
const eventKey=value=>JSON.stringify([value?.title,timestamp(value?.start),timestamp(value?.end)]);
const headerKey=header=>JSON.stringify([header.revision,timestamp(header.snapshot_fetched_at),timestamp(header.snapshot_expires_at),header.channel_count,header.program_count,header.horizon_end===null?null:timestamp(header.horizon_end),header.is_legacy]);
const matchesGuide=(header,guide)=>header.revision===guide.revision&&timestamp(header.snapshot_fetched_at)===timestamp(guide.snapshotFetchedAt)&&timestamp(header.snapshot_expires_at)===timestamp(guide.snapshotExpiresAt);

/** Add metadata from the same atomically published EPG revision. The RPC's
 * channel IDs remain the authorization whitelist; this cache contains no
 * credentials, account preferences, catalogue identities or private sources. */
export class TvGuidePublishedSchedule{
  constructor({now=Date.now,maxEntries=4}={}){this.now=now;this.maxEntries=Math.max(1,Math.min(4,Math.trunc(maxEntries)||4));this.entries=new Map();this.closed=false;}
  async capture({providerKey,scopeHash,guide,ids,read,current,signal}){
    const valid=()=>!this.closed&&!signal.aborted&&current();
    const rows=async(table,parameters)=>{
      if(!valid())failure();
      const value=await read(table,new URLSearchParams({provider_key:'eq.'+providerKey,scope_hash:'eq.'+scopeHash,...parameters}),{signal,timeoutMs:4000});
      if(!valid()||!Array.isArray(value))failure();return value;
    };
    const readHeader=async()=>{
      const values=await rows('epg_cache_versions',{select:'revision,snapshot_fetched_at,snapshot_expires_at,channel_count,program_count,horizon_end,is_legacy',limit:'1'}),header=values[0];
      if(values.length!==1||!UUID.test(header?.revision||'')||header.is_legacy!==false||timestamp(header.snapshot_fetched_at)===null||timestamp(header.snapshot_expires_at)===null||
        !Number.isSafeInteger(header.channel_count)||header.channel_count<1||header.channel_count>MAX_CHANNELS||!Number.isSafeInteger(header.program_count)||header.program_count<1||header.program_count>MAX_PROGRAMS||
        header.horizon_end!==null&&timestamp(header.horizon_end)===null||!matchesGuide(header,guide))failure();
      return header;
    };
    const before=await readHeader(),programs=new Map();let count=0;
    // The transport limiter bounds concurrent batches. Each response is below
    // PostgREST's normal row cap and a request never targets a channel by name.
    for(let offset=0;offset<ids.length;offset+=BATCH*2){
      const batches=[ids.slice(offset,offset+BATCH),ids.slice(offset+BATCH,offset+BATCH*2)].filter(batch=>batch.length);
      const responses=await Promise.all(batches.map(batch=>rows('provider_epg_cache',{select:'channel_id,payload,expires_at',channel_id:'in.('+batch.join(',')+')',order:'channel_id.asc',limit:String(batch.length)})));
      for(let index=0;index<responses.length;index++){
        const requested=new Set(batches[index]),seen=new Set(),values=responses[index];if(values.length>requested.size)failure();
        for(const row of values){
          const id=String(row?.channel_id??'');
          if(!ID.test(id)||!requested.has(id)||seen.has(id)||!object(row.payload)||!Array.isArray(row.payload.list)||timestamp(row.expires_at)!==timestamp(before.snapshot_expires_at))failure();
          seen.add(id);const list=[],events=new Set();count+=row.payload.list.length;if(count>before.program_count||count>MAX_PROGRAMS)failure();
          for(const value of row.payload.list){
            const title=text(value?.title,1000),start=timestamp(value?.start),end=timestamp(value?.end);if(!title||start===null||end===null||end<=start)failure();
            const event={title,description:text(value.description,5000),start:new Date(start).toISOString(),end:new Date(end).toISOString(),startMs:start,endMs:end},key=eventKey(event);
            if(!events.has(key)){events.add(key);list.push(event);}
          }
          list.sort((a,b)=>a.startMs-b.startMs||a.endMs-b.endMs||(a.title<b.title?-1:a.title>b.title?1:0));programs.set(id,list);
        }
        for(const id of requested)if(!seen.has(id))programs.set(id,[]);
      }
    }
    const after=await readHeader();if(headerKey(before)!==headerKey(after)||!valid())failure();
    return {header:before,programs};
  }
  async enrich({guide,providerKey,scopeHash,read,current=()=>true}={}){
    if(this.closed||!current()||!HASH.test(providerKey||'')||!HASH.test(scopeHash||'')||!UUID.test(guide?.revision||'')||guide.legacySnapshot!==false||!object(guide.channels)||!ZONES.has(guide.timeZone)||timestamp(guide.asOf)===null||timestamp(guide.snapshotFetchedAt)===null||timestamp(guide.snapshotExpiresAt)===null||typeof read!=='function')return null;
    const ids=Object.keys(guide.channels);if(!ids.length||ids.length>MAX_VISIBLE||ids.some(id=>!ID.test(id)||!object(guide.channels[id])||!object(guide.channels[id].window)))return null;
    const cacheKey=JSON.stringify([providerKey,scopeHash,guide.revision,timestamp(guide.snapshotFetchedAt)]);let entry=this.entries.get(cacheKey);
    if(!entry){
      while(this.entries.size>=this.maxEntries){const old=[...this.entries].find(([,value])=>!value.pending);if(!old)return null;this.entries.delete(old[0]);}
      entry={header:null,programs:new Map(),loaded:new Set(),pending:null,controller:null,retryAt:0};this.entries.set(cacheKey,entry);
    }else{this.entries.delete(cacheKey);this.entries.set(cacheKey,entry);}
    // A later adult-enabled or broader RPC can fill missing IDs without
    // treating the first caller's catalogue/PIN selection as a complete cache.
    for(let attempt=0;attempt<2;attempt++){
      const missing=ids.filter(id=>!entry.loaded.has(id));if(!missing.length)break;if(entry.retryAt>this.now())return null;
      if(!entry.pending){
        const controller=new AbortController();entry.controller=controller;let timer;
        const deadline=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(null);},DEADLINE_MS);});
        entry.pending=Promise.race([this.capture({providerKey,scopeHash,guide,ids:missing,read,current,signal:controller.signal}),deadline]).then(data=>{
          if(!data||this.closed||!current())throw new Error('TV_PUBLISHED_SCHEDULE_CANCELLED');
          if(entry.header&&headerKey(entry.header)!==headerKey(data.header))failure();
          entry.header=data.header;for(const [id,list]of data.programs){entry.programs.set(id,list);entry.loaded.add(id);}entry.retryAt=0;
        }).catch(()=>{entry.retryAt=this.now()+RETRY_MS;}).finally(()=>{controller.abort();clearTimeout(timer);entry.pending=null;entry.controller=null;});
      }
      await entry.pending;if(this.closed||!current())return null;
    }
    if(!entry.header||!matchesGuide(entry.header,guide)||ids.some(id=>!entry.loaded.has(id))||this.closed||!current())return null;
    const eligible=new Map(ids.map(id=>[id,false])),raw={eligible,programs:entry.programs,revision:guide.revision,fetched:timestamp(entry.header.snapshot_fetched_at),expires:timestamp(entry.header.snapshot_expires_at),horizon:timestamp(entry.header.horizon_end)};
    const projected=projectTvGuide(raw,true,guide.timeZone,timestamp(guide.asOf),{source:'published-snapshot',legacySnapshot:false,partial:false,stale:guide.stale===true});
    const channels={},asOf=timestamp(guide.asOf),format=new Intl.DateTimeFormat('pt-BR',{timeZone:guide.timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
    for(const id of ids){
      const original=guide.channels[id],expanded=projected.channels[id],programs=entry.programs.get(id)||[],known=new Set(programs.map(eventKey));
      // Existing programme anchors must be found in that same raw revision.
      // A missing row is useful only when the RPC also had no programme data.
      for(const name of ['previous','current','next'])if(original?.window?.[name]&&!known.has(eventKey(original.window[name])))return null;
      let afterNext=null;
      if(original?.window?.next){
        const anchor=eventKey(original.window.next),index=programs.findIndex(program=>eventKey(program)===anchor);
        const following=programs.slice(index+1).find(program=>program.startMs>asOf&&eventKey(program)!==anchor);
        if(following)afterNext={title:following.title,description:following.description,start:following.start,end:following.end,startLabel:format.format(following.startMs),endLabel:format.format(following.endMs)};
      }
      channels[id]={...original,schedule:expanded.schedule,window:{...original.window,afterNext}};
    }
    return !this.closed&&current()?{...guide,channels}:null;
  }
  close(){this.closed=true;for(const entry of this.entries.values())entry.controller?.abort();this.entries.clear();}
}

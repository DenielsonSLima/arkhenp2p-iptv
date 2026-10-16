import {createHash} from 'node:crypto';
import {isAdultItem} from '../../web/parental-classification.js';

const HASH=/^[a-f0-9]{64}$/i,ID=/^[0-9]{1,12}$/;
const ZONES=new Set(['America/Maceio','America/Sao_Paulo','UTC']);
const SIX_HOURS=21600000,SCHEDULE_HORIZON_MS=86400000,MAX_CHANNELS=2000,MAX_PROGRAMS=250000,MAX_SCHEDULE_PROGRAMS=128;
const object=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const text=(value,max)=>typeof value==='string'?value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/(?:https?:)?\/\/[^\s<>"']+/gi,'').trim().slice(0,max):'';
function timestamp(value){
  if(typeof value!=='string')return null;
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/.exec(value);
  if(!match)return null;
  const [year,month,day,hour,minute,second]=match.slice(1).map(Number),calendar=new Date(Date.UTC(year,month-1,day));
  if(year<1000||month<1||month>12||day<1||calendar.getUTCFullYear()!==year||calendar.getUTCMonth()!==month-1||calendar.getUTCDate()!==day||hour>23||minute>59||second>59)return null;
  const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:null;
}
const time=value=>{const parsed=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(parsed)?parsed:null;};
const earlier=(a,b)=>a===null?b:b===null?a:Math.min(a,b);

/** Only already-published, sanitized metadata is read. Missing rows cannot be
 * interpreted as a complete guide, and no provider/engine fallback lives here. */
function capture(catalogRows,first,second){
  if(!Array.isArray(catalogRows)||catalogRows.length!==1||!Array.isArray(first)||!Array.isArray(second)||first.length>1000||second.length>1000||first.length<1000&&second.length)return null;
  const catalog=catalogRows[0],payload=catalog?.payload;
  if(catalog?.is_complete!==true||!object(payload)||!Array.isArray(payload.items)||!payload.items.length||payload.items.length>MAX_CHANNELS||!Array.isArray(payload.categories))return null;
  if(payload.categories.some(category=>!object(category)||category.id==null||typeof category.name!=='string'))return null;
  const eligible=new Map();
  for(const item of payload.items){
    const id=String(item?.id??'');
    if(!object(item)||item.kind!=='live'||!ID.test(id)||!text(item.name,1000))return null;
    eligible.set(id,Boolean(eligible.get(id)||isAdultItem(item,payload.categories)));
  }
  const rows=new Map();
  for(const row of [...first,...second]){
    const id=String(row?.channel_id??'');
    if(!ID.test(id)||!object(row?.payload)||!Array.isArray(row.payload.list))return null;
    const updated=time(row.updated_at),expires=time(row.expires_at);
    if(updated===null||expires===null)return null;
    const old=rows.get(id);if(!old||updated>old.updated)rows.set(id,{payload:row.payload,updated,expires});
  }
  let fetched=time(catalog.updated_at),expires=time(catalog.expires_at),horizon=null,total=0;
  if(fetched===null||expires===null)return null;
  const programs=new Map(),digest=createHash('sha256');digest.update(String(catalog.snapshot_id||''));
  for(const id of [...eligible.keys()].sort()){
    const row=rows.get(id)||{payload:{list:[]},updated:fetched,expires},seen=new Set(),list=[];
    if(row.payload.list.length>MAX_PROGRAMS||total+row.payload.list.length>MAX_PROGRAMS)return null;
    total+=row.payload.list.length;fetched=Math.min(fetched,row.updated);expires=Math.min(expires,row.expires);
    for(const value of row.payload.list){
      const title=text(value?.title,1000),start=timestamp(value?.start),end=timestamp(value?.end);
      if(!title||start===null||end===null||end<=start)return null;
      const description=text(value.description,5000),key=JSON.stringify([title,start,end]);if(seen.has(key))continue;
      seen.add(key);horizon=horizon===null?end:Math.max(horizon,end);
      list.push({title,description,start:new Date(start).toISOString(),end:new Date(end).toISOString(),startMs:start,endMs:end});
    }
    list.sort((a,b)=>a.startMs-b.startMs||a.endMs-b.endMs||(a.title<b.title?-1:a.title>b.title?1:0));
    programs.set(id,list);digest.update(JSON.stringify([id,eligible.get(id),row.updated,row.expires,list]));
  }
  return {eligible,programs,revision:'legacy-cache:'+digest.digest('hex'),fetched,expires,horizon};
}

export function projectTvGuide(raw,includeAdult,timeZone,stamp,{source='legacy-cache',legacySnapshot=true,partial=true,stale=true}={}){
  const format=new Intl.DateTimeFormat('pt-BR',{timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const display=program=>program?{title:program.title,description:program.description,start:program.start,end:program.end,startLabel:format.format(program.startMs),endLabel:format.format(program.endMs)}:null;
  const channels={};let refreshAt=Math.floor(stamp/60000)*60000+60000;
  for(const [id,adult]of raw.eligible){
    if(adult&&!includeAdult)continue;
    let previous=null,current=null,next=null,afterNext=null;
    const programs=raw.programs.get(id)||[];
    for(const program of programs){
      if(program.endMs<=stamp&&(!previous||program.endMs>previous.endMs||program.endMs===previous.endMs&&program.startMs>previous.startMs))previous=program;
      if(program.startMs<=stamp&&program.endMs>stamp&&(!current||program.startMs>current.startMs))current=program;
      if(program.startMs>stamp){if(!next)next=program;else if(!afterNext&&(program.startMs!==next.startMs||program.endMs!==next.endMs||program.title!==next.title))afterNext=program;}
    }
    const nextChange=earlier(current?.endMs??null,next?.startMs??null),window={previous:display(previous),current:display(current),next:display(next),afterNext:display(afterNext)};
    // The selected current programme is retained even when it began before
    // this horizon. Other metadata is bounded to 24 hours and 128 events;
    // no programme is stretched to fill a gap in the provider's schedule.
    const schedule=[],seen=new Set();
    for(const program of [current,...programs]){
      if(!program||!Number.isFinite(program.startMs)||!Number.isFinite(program.endMs)||program.endMs<=program.startMs||program.endMs<=stamp||program.startMs>=stamp+SCHEDULE_HORIZON_MS)continue;
      const key=JSON.stringify([program.title,program.startMs,program.endMs]);if(seen.has(key))continue;
      seen.add(key);schedule.push(display(program));if(schedule.length>=MAX_SCHEDULE_PROGRAMS)break;
    }
    schedule.sort((a,b)=>Date.parse(a.start)-Date.parse(b.start)||Date.parse(a.end)-Date.parse(b.end)||a.title.localeCompare(b.title));
    if(nextChange!==null&&nextChange>stamp)refreshAt=Math.min(refreshAt,nextChange);
    channels[id]={status:current||next?'ready':'unavailable',list:[window.previous,window.current,window.next].filter(Boolean),window,schedule,
      progressPercent:current?Math.round(Math.max(0,Math.min(100,(stamp-current.startMs)/(current.endMs-current.startMs)*100))*100)/100:null,
      elapsedSeconds:current?Math.floor((stamp-current.startMs)/1000):null,remainingSeconds:current?Math.ceil((current.endMs-stamp)/1000):null,
      nextChangeAt:nextChange===null?null:new Date(nextChange).toISOString()};
  }
  return {schemaVersion:1,revision:raw.revision,projectionVersion:raw.revision+':'+stamp,asOf:new Date(stamp).toISOString(),serverTime:new Date(stamp).toISOString(),timeZone,
    nextRefreshAt:new Date(refreshAt).toISOString(),sourceNextRefreshAt:legacySnapshot?null:new Date(raw.expires).toISOString(),snapshotFetchedAt:new Date(raw.fetched).toISOString(),snapshotExpiresAt:new Date(legacySnapshot?Math.min(raw.expires,stamp):raw.expires).toISOString(),
    horizonEnd:raw.horizon===null?null:new Date(raw.horizon).toISOString(),source,legacySnapshot,partial,stale,channels};
}

/** Temporary server projection while the Edge RPC is unavailable. Raw reads
 * coalesce globally by partition, never by card/user, for at most six hours. */
export class TvGuideCompat{
  constructor({now=Date.now,maxPartitions=8,cacheMs=SIX_HOURS}={}){
    this.now=now;this.maxPartitions=Number.isFinite(maxPartitions)?Math.max(1,Math.min(8,Math.trunc(maxPartitions))):8;this.cacheMs=Number.isFinite(cacheMs)?Math.max(1000,Math.min(SIX_HOURS,cacheMs)):SIX_HOURS;this.entries=new Map();this.closed=false;
  }
  async get({providerKey,scopeHash,includeAdult=false,timeZone='America/Maceio',read,current=()=>true,now=this.now}={}){
    const clock=typeof now==='function'?now:()=>Number(now),isCurrent=()=>{try{return !this.closed&&Boolean(current());}catch{return false;}};
    if(!HASH.test(providerKey||'')||!HASH.test(scopeHash||'')||typeof includeAdult!=='boolean'||!ZONES.has(timeZone)||typeof read!=='function'||!isCurrent()||!Number.isFinite(clock()))return null;
    const key=JSON.stringify([providerKey,scopeHash]);let entry=this.entries.get(key);
    if(!entry){
      if(this.entries.size>=this.maxPartitions){const oldest=[...this.entries].find(([,value])=>!value.pending);if(!oldest)return null;this.entries.delete(oldest[0]);}
      entry={raw:null,pending:null,expiresAt:0,retryAt:0,projections:new Map()};this.entries.set(key,entry);
    }else{this.entries.delete(key);this.entries.set(key,entry);}
    if(entry.expiresAt<=clock()){
      if(!entry.pending&&entry.retryAt>clock())return null;
      if(!entry.pending){
        const query=(select,extra={})=>new URLSearchParams({select,provider_key:'eq.'+providerKey,scope_hash:'eq.'+scopeHash,...extra});
        entry.pending=Promise.all([
          Promise.resolve().then(()=>read('provider_catalog_cache',query('payload,is_complete,snapshot_id,updated_at,expires_at',{media_type:'eq.live',limit:'1'}))),
          Promise.resolve().then(()=>read('provider_epg_cache',query('channel_id,payload,updated_at,expires_at',{order:'channel_id.asc',limit:'1000',offset:'0'}))),
          Promise.resolve().then(()=>read('provider_epg_cache',query('channel_id,payload,updated_at,expires_at',{order:'channel_id.asc',limit:'1000',offset:'1000'}))),
        ]).then(values=>{
          const raw=capture(...values);
          if(raw&&!this.closed){entry.raw=raw;entry.expiresAt=clock()+this.cacheMs;entry.retryAt=0;entry.projections.clear();}
          else entry.retryAt=clock()+5000;
        }).catch(()=>{entry.retryAt=clock()+5000;}).finally(()=>{entry.pending=null;});
      }
      await entry.pending;
    }
    if(!isCurrent()||!entry.raw||entry.expiresAt<=clock())return null;
    const projectionKey=JSON.stringify([includeAdult,timeZone]),stamp=clock();let data=entry.projections.get(projectionKey);
    if(!data||Date.parse(data.nextRefreshAt)<=stamp){data=projectTvGuide(entry.raw,includeAdult,timeZone,stamp);entry.projections.set(projectionKey,data);}
    if(!isCurrent())return null;
    return {...data,serverTime:new Date(clock()).toISOString(),channels:{...data.channels}};
  }
  close(){this.closed=true;this.entries.clear();}
}

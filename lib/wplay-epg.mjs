import {decodeText,ProviderError} from './provider.mjs';

export const WPLAY_EPG_MAX_BYTES=16*1024*1024;
export const WPLAY_EPG_CACHE_MS=5*60*1000;
export const WPLAY_EPG_FAILURE_BACKOFF_MS=30000;
const CACHE_KEY='epg:wplay:global';
const positiveID=value=>/^\d{1,12}$/.test(String(value??''))&&Number(value)>0?String(Number(value)):null;
const currentGuide=(rows,now)=>Array.isArray(rows)&&rows.some(row=>{const start=epgTimestamp(row?.start),end=epgTimestamp(row?.end);return start!==null&&end!==null&&start<=now&&end>now;});
const upcomingGuide=(rows,now)=>Array.isArray(rows)&&rows.some(row=>{const start=epgTimestamp(row?.start),end=epgTimestamp(row?.end);return start!==null&&end!==null&&end>start&&end>now;});
export const wplayEPGChannelID=(channel,itemID)=>positiveID(channel?.epgSameAs)||positiveID(channel?.chid)||positiveID(itemID);

function retainCurrentGuides(incoming,previous,now){
  let retained=false;
  for(const [id,rows] of previous instanceof Map?previous:[])if(currentGuide(rows,now)&&!upcomingGuide(incoming.get(id),now)){incoming.set(id,rows);retained=true;}
  return retained;
}

// APK td.i.j parses ISO timestamps as absolute UTC milliseconds. Require an
// explicit zone and reject invalid calendar dates instead of shifting a guide.
export function epgTimestamp(value) {
  if(typeof value!=='string')return null;
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):?(\d{2}))$/.exec(value);
  if(!match)return null;
  const [year,month,day,hour,minute,second]=match.slice(1,7).map(Number);
  const millisecond=Number((match[7]||'').padEnd(3,'0').slice(0,3));
  if(year<1000||month<1||month>12||day<1||day>31||hour>23||minute>59||second>59)return null;
  const wall=Date.UTC(year,month-1,day,hour,minute,second,millisecond),calendar=new Date(wall);
  if(calendar.getUTCFullYear()!==year||calendar.getUTCMonth()!==month-1||calendar.getUTCDate()!==day)return null;
  const zoneHours=Number(match[10]||0),zoneMinutes=Number(match[11]||0);
  if(zoneHours>23||zoneMinutes>59)return null;
  const offset=(zoneHours*60+zoneMinutes)*60000*(match[9]==='-'?-1:1);
  return wall-offset;
}

export function parseWplayEPG(payload) {
  if(!Array.isArray(payload))throw new ProviderError('O serviço WPlay retornou uma programação inválida.','WPLAY_INVALID_EPG');
  const guides=new Map(),coverage={channelRecords:payload.length,invalidChannels:0,programRecords:0,invalidPrograms:0};
  for(const channel of payload) {
    const id=positiveID(channel?.id);
    if(!id||!Array.isArray(channel.epg)){coverage.invalidChannels++;continue;}
    let guide=guides.get(id);
    if(!guide){guide={rows:[],seen:new Set()};guides.set(id,guide);}
    for(const program of channel.epg) {
      coverage.programRecords++;
      if(!program||typeof program!=='object'||typeof program.name!=='string'){coverage.invalidPrograms++;continue;}
      const title=decodeText(program.name).trim().slice(0,1000),start=epgTimestamp(program.time),end=epgTimestamp(program.endTime);
      if(!title||start===null||end===null||end<=start){coverage.invalidPrograms++;continue;}
      const key=JSON.stringify([start,end,title]);if(guide.seen.has(key))continue;
      guide.seen.add(key);
      // playbackUrl is deliberately excluded: this API serves programming only.
      guide.rows.push({title,description:'',start:new Date(start).toISOString(),end:new Date(end).toISOString()});
    }
  }
  return {guides:new Map([...guides].map(([id,guide])=>[id,guide.rows.sort((a,b)=>a.start.localeCompare(b.start))])),coverage};
}

export function normalizeWplayEPG(payload){return parseWplayEPG(payload).guides;}

/** One authorized whole-file metadata GET. No connect/authenticate or channel
 * request is performed here; callers supply an already validated client. */
export async function wplayEPGSnapshot(client,{signal,cacheMs=WPLAY_EPG_CACHE_MS,now=Date.now,force=false}={}) {
  if(!client.authInfo?.service?.epg_url)throw new ProviderError('O serviço não disponibilizou a programação.','WPLAY_EPG_UNAVAILABLE',503);
  const url=client.serviceURL('epg_url');
  // Spark.K downloads one complete epg_url with the usual token and Android UA.
  // All channel cards in this browser session share this promise and index.
  // The complete schedule is ~4 MB. Keep it for five minutes while the UI can
  // recalculate the current program locally; failed requests have a short
  // backoff too, so several cards cannot create a retry storm.
  let entry=client.cache.get(CACHE_KEY);
  if(!entry||entry.url!==url||!entry.promise||typeof entry.promise.then!=='function'||!(entry.expiresAt>now())||force===true&&Number.isFinite(entry.expiresAt)){
    const previous=entry?.url===url?entry.guides:null;
    entry={time:now(),url,expiresAt:Infinity,fetchedAt:null};
    entry.promise=Promise.resolve().then(async()=>{
      const parsed=parseWplayEPG(await client.requestJSON(url,{maxBytes:WPLAY_EPG_MAX_BYTES,timeout:8000,signal}));entry.coverage=parsed.coverage;return parsed.guides;
    }).then(guides=>{
      const retained=retainCurrentGuides(guides,previous,now());entry.guides=guides;entry.fetchedAt=now();entry.retained=retained;
      const partial=entry.coverage.invalidChannels>0||entry.coverage.invalidPrograms>0;
      entry.expiresAt=now()+(retained||partial?WPLAY_EPG_FAILURE_BACKOFF_MS:Math.max(1000,Math.min(21600000,cacheMs)));return guides;
    },error=>{
      entry.error=error;entry.expiresAt=now()+WPLAY_EPG_FAILURE_BACKOFF_MS;entry.fetchedAt=null;entry.retained=true;
      const guides=new Map();
      if(!retainCurrentGuides(guides,previous,now()))throw error;
      entry.guides=guides;return guides;
    });
    client.cache.set(CACHE_KEY,entry);
  }
  const guides=await entry.promise;
  return {guides,coverage:entry.coverage||null,fetchedAt:entry.fetchedAt,expiresAt:entry.expiresAt,stale:entry.retained===true||Boolean(entry.error),error:entry.error||null};
}

export async function wplayEPG(client,channel,itemID) {
  if(!client.authInfo?.service?.epg_url)return {list:[]};
  const id=wplayEPGChannelID(channel,itemID);if(!id)return {list:[]};
  const snapshot=await wplayEPGSnapshot(client),guides=snapshot.guides;
  const rows=guides.get(id)||[];
  if(snapshot.error&&!currentGuide(rows,Date.now()))throw snapshot.error;
  return {list:rows};
}

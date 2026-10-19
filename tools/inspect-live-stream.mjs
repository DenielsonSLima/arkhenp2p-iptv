// Bounded diagnostic against an explicitly selected ARKHEN origin.
// Credentials, cookies, provider payloads and media URLs never leave memory.
import {readWplayCredentials,safeCode} from './wplay-tool-input.mjs';
import {tvPlaylistTransportMetadata} from '../lib/tv/transport-observer.mjs';

const base=process.argv.find(x=>x.startsWith('--base='))?.slice(7);
const channel=process.argv.find(x=>x.startsWith('--channel='))?.slice(10);
let credentials=null,cookie='';
const attempt='trace-'+crypto.randomUUID(),started=performance.now();
const emit=value=>console.log(JSON.stringify({at:new Date().toISOString(),elapsedMs:Math.round(performance.now()-started),...value}));
async function request(route,options={},deadline=Infinity){
  if(!route.startsWith('/api/'))throw new Error('INVALID_ROUTE');
  const remaining=deadline-performance.now();
  if(remaining<=0)throw Object.assign(new Error(),{code:'DIAGNOSTIC_DEADLINE'});
  return fetch(base+route,{...options,headers:{Cookie:cookie,...options.headers},redirect:'error',signal:AbortSignal.timeout(Math.min(45000,Math.ceil(remaining)))});
}
async function limitedBody(response,limit){
  const reader=response.body?.getReader();if(!reader)return Buffer.alloc(0);
  const chunks=[];let bytes=0,complete=false;
  try{
    for(;;){const {done,value}=await reader.read();if(done){complete=true;break;}
      bytes+=value.byteLength;if(bytes>limit)throw Object.assign(new Error(),{code:'DIAGNOSTIC_BODY_BUDGET'});
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks,bytes);
  }finally{if(!complete)await reader.cancel().catch(()=>{});reader.releaseLock();}
}
const limitedJSON=async(response,limit)=>JSON.parse((await limitedBody(response,limit)).toString());
function safeServerTiming(value){
  const allowed=new Set(['prepare','upstream','segmentcache','provider','sources',
    'runtime_acquire','runtime_wait','runtime_read','runtime_restore','runtime_serialize','runtime_codec','runtime_commit','runtime_validate']);
  const fragments=[];
  for(const fragment of String(value||'').split(',').slice(0,32)){
    const match=/^\s*([a-z_]+);dur=(\d+(?:\.\d+)?)(?:;count=(\d+))?\s*$/.exec(fragment);
    if(!match||!allowed.has(match[1])||!Number.isFinite(Number(match[2]))||Number(match[2])>86400000||Number(match[3]||0)>100000)continue;
    fragments.push(`${match[1]};dur=${Number(match[2])}${match[3]===undefined?'':';count='+Number(match[3])}`);
  }
  return fragments.join(', ');
}
async function summary(response,phase,began){
  const timing=safeServerTiming(response.headers.get('server-timing'));
  const value={phase,status:response.status,ms:Math.round(performance.now()-began),
    ...(timing?{serverTiming:timing}:{})};
  if(!response.ok){const error=await limitedJSON(response,64*1024).catch(()=>({}));value.code=/^[A-Z0-9_]{1,80}$/.test(error.code||'')?error.code:'REQUEST_FAILED';process.exitCode=1;}
  emit(value);return response.ok;
}
try{
  if(!['http://127.0.0.1:4173','https://arkhenp2p-iptv.vercel.app'].includes(base)||!/^\d{1,12}$/.test(channel||''))throw Object.assign(new Error(),{code:'EXPLICIT_TARGET_REQUIRED'});
  credentials=await readWplayCredentials();
  let began=performance.now();
  const login=await request('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...credentials,provider:'wplay'})});
  credentials.username='';credentials.password='';cookie=login.headers.get('set-cookie')?.split(';')[0]||'';
  if(!await summary(login,'login',began))throw new Error('LOGIN_FAILED');await login.body?.cancel();
  began=performance.now();const sources=await request(`/api/live/sources?id=${channel}`);
  if(!await summary(sources,'sources',began))throw new Error('SOURCES_FAILED');
  const list=await limitedJSON(sources,1024*1024);
  // Only the selected channel's explicit initial source; no quality/channel fallback.
  const source=list.initialSourceId||list.selectedSourceId||list.sources?.find(x=>x.initial)?.id;
  emit({phase:'inventory',sourceCount:Array.isArray(list.sources)?list.sources.length:null,explicitSource:typeof source==='string'});
  if(!/^[nwo]_[a-f0-9]{28}$/.test(source||'')||!list.sources?.some(item=>item.id===source&&item.available===true))throw Object.assign(new Error(),{code:'LIVE_SOURCE_UNAVAILABLE'});
  const route=`/api/play/live/${channel}/index.m3u8?attempt=${attempt}&sourceId=${source}`;
  const end=performance.now()+35000;let polls=0,segmentRead=false;
  while(performance.now()<end&&polls++<12){
    began=performance.now();const response=await request(route,{},end);
    if(!await summary(response,'manifest',began))break;
    const text=(await limitedBody(response,4*1024*1024)).toString();emit({phase:'playlist',...tvPlaylistTransportMetadata(text),ms:Math.round(performance.now()-began)});
    const segments=[];let segmentDuration=false;
    for(const raw of text.split(/\r?\n/)){
      const line=raw.trim();
      if(line.startsWith('#EXTINF:'))segmentDuration=true;
      else if(line&&!line.startsWith('#')){if(segmentDuration&&/^\/api\/asset\/[A-Za-z0-9_-]{32}$/.test(line))segments.push(line);segmentDuration=false;}
    }
    if(!segmentRead&&segments.length){
      began=performance.now();const segment=await request(segments.at(-1),{},end);
      if(await summary(segment,'segment-headers',began)){
        const data=await limitedBody(segment,8*1024*1024);emit({phase:'segment-body',bytes:data.length,mpegts:data[0]===0x47&&data[188]===0x47,ms:Math.round(performance.now()-began)});
      }
      segmentRead=true;
    }
    if(performance.now()<end)await new Promise(resolve=>setTimeout(resolve,Math.min(2000,end-performance.now())));
  }
}catch(error){emit({phase:'failed',code:safeCode(error)});process.exitCode=1;}
finally{
  if(credentials){credentials.username='';credentials.password='';}
  if(cookie)for(const [phase,route]of [['stop','/api/stop?attempt='+encodeURIComponent(attempt)],['logout','/api/logout']]){
    const began=performance.now();
    try{const response=await request(route,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      if(!await summary(response,phase,began))process.exitCode=1;else await response.body?.cancel();
    }catch(error){emit({phase,code:safeCode(error),ms:Math.round(performance.now()-began)});process.exitCode=1;}
  }
  cookie='';
}

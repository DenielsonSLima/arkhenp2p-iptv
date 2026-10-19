// Direct, bounded comparison of the existing WPLAY transport. No application
// proxy, manifest rewriting, runtime store or private output is involved.
import {createHash,randomUUID} from 'node:crypto';
import {readWplayCredentials,safeCode} from './wplay-tool-input.mjs';
import {OrquestradorConexaoWplay} from '../lib/wplay/orquestrador.mjs';
import {readBody,requestUpstream} from '../lib/upstream.mjs';
import {tvPlaylistTransportMetadata} from '../lib/tv/transport-observer.mjs';

const channel=process.argv.find(value=>value.startsWith('--channel='))?.slice(10);
const resolvedMode=process.argv.includes('--resolved');
const consumeMode=process.argv.includes('--consume'),compareOverlap=process.argv.includes('--compare-overlap');
const officialQuery=process.argv.includes('--official-query'),browserHeaders=process.argv.includes('--browser-headers');
const validArguments=process.argv.slice(2).every(value=>/^--channel=\d{1,12}$/.test(value)||['--resolved','--consume','--compare-overlap','--official-query','--browser-headers'].includes(value));
const WPLAY_ORIGIN='https://player.wplayott.com';
const CHROME_UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const rawQuery=value=>new URL(value).search.slice(1);
const withoutSessionQuery=value=>rawQuery(value).split('&').filter(pair=>!['sid','gen'].includes(pair.split('=',1)[0])).join('&');
const began=performance.now();
const emit=value=>process.stdout.write(JSON.stringify({elapsedMs:Math.round(performance.now()-began),...value})+'\n');
const milliseconds=started=>Math.round(performance.now()-started);
const httpStatus=error=>Number.isInteger(error?.status)&&error.status>=100&&error.status<=599?error.status:null;
const cacheClass=value=>{
  if(typeof value!=='string'||!value)return 'absent';
  const names=['no-store','no-cache','private','public','s-maxage','max-age'];
  return names.filter(name=>new RegExp('(?:^|,)\\s*'+name+'(?:\\s*=|\\s*(?:,|$))','i').test(value)).join('+')||'other';
};
const safeHeaders=headers=>({
  ageSeconds:/^\d+$/.test(String(headers?.age||''))&&Number.isSafeInteger(Number(headers.age))?Number(headers.age):null,
  cacheControlClass:cacheClass(headers?.['cache-control']),
  serverTimingMs:[...String(headers?.['server-timing']||'').matchAll(/(?:^|[;,])\s*dur\s*=\s*(\d+(?:\.\d+)?)/gi)]
    .map(match=>Number(match[1])).filter(value=>Number.isFinite(value)&&value>=0&&value<=86400000).slice(0,16)
});
const mediaSegments=(text,base)=>{
  const segments=[];let duration=null,sequence=0,discontinuity=0;
  for(const raw of text.split(/\r?\n/)){
    const line=raw.trim();
    if(line.startsWith('#EXT-X-MEDIA-SEQUENCE:')){const value=Number(line.slice(22));sequence=Number.isSafeInteger(value)&&value>=0?value:null;}
    else if(line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')){const value=Number(line.slice(30));discontinuity=Number.isSafeInteger(value)&&value>=0?value:null;}
    else if(line==='#EXT-X-DISCONTINUITY')discontinuity=discontinuity===null?null:discontinuity+1;
    else if(line.startsWith('#EXTINF:')){const value=Number(line.slice(8).split(',')[0]);duration=value>0&&Number.isFinite(value)?value:null;}
    else if(line&&!line.startsWith('#')){
      if(duration!==null&&sequence!==null&&discontinuity!==null){
        const url=new URL(line,base).href;
        segments.push({url,key:JSON.stringify([base,sequence,discontinuity])});sequence++;
      }
      duration=null;
    }
  }
  return segments;
};

// The shared stdin helper's prompt and provider diagnostics must not introduce
// payloads or channel labels into this tool's strict numeric/code-only output.
const originalLog=console.log,originalWarn=console.warn;
console.log=()=>{};console.warn=()=>{};
let credentials=null,client=null;
try{
  if(!validArguments||!/^\d{1,12}$/.test(channel||''))throw Object.assign(new Error(),{code:'EXPLICIT_CHANNEL_REQUIRED'});
  credentials=await readWplayCredentials();
  const connection=new OrquestradorConexaoWplay();
  const resolved=connection.resolveConnection({...credentials,provider:'wplay'},null);
  client=await connection.createClient(resolved);client.libraryProvider=resolved.provider;
  let started=performance.now();await client.connect();emit({phase:'connect',status:200,ms:milliseconds(started)});
  started=performance.now();
  const inventory=await client.liveSources(channel);
  const selected=inventory.sources?.find(source=>source.available&&source.id===inventory.selectedSourceId);
  if(!selected)throw Object.assign(new Error(),{code:'LIVE_SOURCE_UNAVAILABLE',status:503});
  emit({phase:'sources',status:200,ms:milliseconds(started)});
  started=performance.now();
  const entry=await client.playbackURL('live',channel,null,{attempt:'direct-'+randomUUID(),sourceId:selected.id});
  client.beginPlayback('live:'+channel);emit({phase:'prepare',status:200,ms:milliseconds(started)});
  const sdkEntry=new URL(entry).href,saved=client.exportRuntimeState().playbackRuntime?.web?.client?.ott;
  let originalEntry=null;
  if(saved?.liveSource&&typeof saved.liveSource.url==='string'&&typeof saved.liveScreenSID==='string'&&Number.isSafeInteger(saved.liveSource.generation)){
    // Deliberately mirror the observed official literal concatenation. Do not
    // use searchParams here: it reserializes preexisting signed query bytes.
    originalEntry=saved.liveSource.url+'&sid='+encodeURIComponent(saved.liveScreenSID)+'&gen='+saved.liveSource.generation;
    emit({phase:'query-contract',originalQueryPreserved:rawQuery(saved.liveSource.url)===withoutSessionQuery(sdkEntry),queryChanged:rawQuery(originalEntry)!==rawQuery(sdkEntry)});
  }
  if(officialQuery&&!originalEntry)throw Object.assign(new Error(),{code:'WEB_SOURCE_CONTRACT_REQUIRED'});
  const entryURL=officialQuery?client.mediaURL(originalEntry):sdkEntry,deadline=performance.now()+35000;
  const mediaRequest=(value,options)=>{
    if(!browserHeaders)return client.upstreamRequest(value,options);
    // Authentication is still derived for this exact authorized destination;
    // requestUpstream also strips it on cross-origin redirects. Only the
    // explicitly requested browser's non-authentication headers are overlaid.
    const headers={...client.upstreamHeaders(value),'User-Agent':CHROME_UA,Accept:'*/*',Referer:WPLAY_ORIGIN+'/watch',Origin:WPLAY_ORIGIN};
    return requestUpstream(value,{...options,headers,allowPrivate:client.allowPrivate===true});
  };
  let source=entryURL,segmentRead=false,polls=0,segmentRequests=0,transferredBytes=0,comparison=null,comparisonAttempted=false;
  const seen=new Set();
  const readSegment=async(segment,{quiet=false}={})=>{
    if(segmentRequests>=40||transferredBytes>=50*1024*1024||performance.now()>=deadline)return null;
    segmentRequests++;const started=performance.now();let media;
    try{
      const budget=Math.max(1,Math.ceil(deadline-performance.now())),mediaSource=client.mediaURL(segment.url);
      media=await mediaRequest(mediaSource,{method:'GET',headers:client.upstreamHeaders(mediaSource),timeout:Math.min(15000,budget),signal:AbortSignal.timeout(budget)});
      if(!quiet)emit({phase:'segment-headers',status:media.status,ms:milliseconds(started),...safeHeaders(media.headers)});
      if(![200,206].includes(media.status)){media.body.destroy();return {ok:false,status:media.status,bytes:0,code:'SEGMENT_HTTP'};}
      const digest=compareOverlap?createHash('sha256'):null;let bytes=0,prefix=Buffer.alloc(0);
      for await(const chunk of media.body){
        bytes+=chunk.length;transferredBytes+=chunk.length;
        if(bytes>8*1024*1024||transferredBytes>50*1024*1024)throw Object.assign(new Error(),{code:'SEGMENT_BYTE_BUDGET'});
        digest?.update(chunk);
        if(prefix.length<376)prefix=Buffer.concat([prefix,chunk.subarray(0,376-prefix.length)]);
      }
      const result={ok:true,status:media.status,bytes,mpegts:prefix.length>=376&&prefix[0]===0x47&&prefix[188]===0x47,digest:digest?.digest()};
      if(!quiet)emit({phase:'segment-body',status:result.status,bytes,mpegts:result.mpegts,ms:milliseconds(started)});
      if(compareOverlap&&!comparison)comparison={key:segment.key,url:segment.url,digest:result.digest,bytes};
      return result;
    }catch(error){media?.body.destroy();if(!quiet)throw error;return {ok:false,status:httpStatus(error),bytes:0,code:safeCode(error)};}
  };
  while(performance.now()<deadline&&polls++<12){
    started=performance.now();
    const remaining=Math.max(1,Math.ceil(deadline-performance.now()));
    const response=await mediaRequest(source,{method:'GET',headers:client.upstreamHeaders(source),timeout:Math.min(10000,remaining),signal:AbortSignal.timeout(remaining)});
    emit({phase:'manifest-headers',status:response.status,ms:milliseconds(started),entryEqualsFinal:entryURL===new URL(response.url).href,...safeHeaders(response.headers)});
    if(response.status!==200){response.body.destroy();break;}
    const text=(await readBody(response,4*1024*1024)).toString();
    emit({phase:'playlist',status:response.status,ms:milliseconds(started),...tvPlaylistTransportMetadata(text)});
    if(resolvedMode)source=new URL(response.url).href;
    const segments=mediaSegments(text,response.url);
    if(consumeMode){
      started=performance.now();const requestsBefore=segmentRequests,bytesBefore=transferredBytes;
      const pending=segments.filter(segment=>!seen.has(segment.key));let index=0,successful=0,failed=0,mpegtsCount=0;const codes=new Set();
      const consume=async()=>{while(index<pending.length){const segment=pending[index++];seen.add(segment.key);const result=await readSegment(segment,{quiet:true});if(!result)break;if(result.ok){successful++;if(result.mpegts)mpegtsCount++;}else{failed++;codes.add(result.code);}}};
      await Promise.all([consume(),consume()]);
      emit({phase:'consume',requests:segmentRequests-requestsBefore,successful,failed,mpegtsCount,bytes:transferredBytes-bytesBefore,ms:milliseconds(started),codes:[...codes].slice(0,8)});
    }else if(!segmentRead&&segments.length){
      segmentRead=true;await readSegment(segments.at(-1));
    }
    if(compareOverlap&&comparison&&!comparisonAttempted){
      const overlap=segments.find(segment=>segment.key===comparison.key&&segment.url!==comparison.url);
      if(overlap){
        comparisonAttempted=true;started=performance.now();const result=await readSegment(overlap,{quiet:true});
        if(result?.ok)emit({phase:'overlap-comparison',equal:comparison.digest.equals(result.digest),previousBytes:comparison.bytes,currentBytes:result.bytes,ms:milliseconds(started)});
        else emit({phase:'overlap-comparison',code:result?.code||'SEGMENT_REQUEST_BUDGET',status:result?.status??null,ms:milliseconds(started)});
      }
    }
    if(polls<12&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,Math.min(2000,Math.max(0,deadline-performance.now()))));
  }
}catch(error){emit({phase:'failed',code:safeCode(error),status:httpStatus(error)});process.exitCode=1;}
finally{
  if(credentials){credentials.username='';credentials.password='';}
  if(client){const started=performance.now();try{await client.logout();emit({phase:'logout',status:200,ms:milliseconds(started)});}catch(error){emit({phase:'logout',code:safeCode(error),status:httpStatus(error),ms:milliseconds(started)});process.exitCode=1;}}
  console.log=originalLog;console.warn=originalWarn;
}

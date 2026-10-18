import {createHash} from 'node:crypto';

const WINDOW_MS=10000,BUDGET_MS=300000,MAX_EVENTS=36,MAX_IDENTITY_SEGMENTS=128;
const playlistIdentities=new WeakMap();
// Diagnostic names only. Membership does not authorize dropping a parameter.
export const TV_AUTH_QUERY_FLAGS=Object.freeze({token:1,auth:2,signature:4,sig:8,sign:16,expires:32,expiry:64,exp:128,
  auth_key:256,access_token:512,auth_token:1024,hdnts:2048,hdnea:4096,hmac:8192,wmsauthsign:16384,wssecret:32768,
  wsmd5:65536,wstime:131072,policy:262144,key:524288,hash:1048576,e:2097152,expire:4194304,authkey:8388608});
const authQueryFlagValues=Object.values(TV_AUTH_QUERY_FLAGS);
const phases=new Set(['prepare','manifest','segment','asset','cache']);
const number=(value,max=86400000)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=max?Math.round(value*1000)/1000:null;
const object=value=>value!==null&&(typeof value==='object'||typeof value==='function');
const integer=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const tagInteger=value=>/^\d+$/.test(value)?integer(Number(value)):null;
const tagNumber=value=>/^\d+(?:\.\d+)?$/.test(value)?number(Number(value),86400):null;
const emptyWindow=()=>({samples:0,manifestSamples:0,segmentSamples:0,cacheHits:0,failures:0,segmentBytes:0,mediaSeconds:0,segmentDurationMs:0,headersMsMax:null,firstBodyMsMax:null,manifestBootstrapCount:0,manifestResolvedCount:0,sequenceAdvanceTotal:0,sequenceRegressions:0,
  sameSequenceSamples:0,rawUriChanges:0,resolvedUriChanges:0,proxyUriChanges:0,durationChanges:0,rewriteOnlyUriChanges:0,mediaBaseChanges:0,
  rawPathChanges:0,resolvedPathChanges:0,queryChanges:0,originChanges:0,filenameChanges:0,queryOnlyUriChanges:0,
  changedAuthQueryFlags:0,queryKnownAuthOnly:null,unknownChangedQuery:false,queryRepresentationChanges:0});

/** Numeric HLS window metadata only. No URI, attribute text, title, key or
 * provider payload is retained. windowSeconds counts complete EXTINF segments. */
export function tvPlaylistTransportMetadata(text){
  const result={mediaPlaylist:false,mediaSequence:null,discontinuitySequence:null,segmentCount:0,windowSeconds:0,
    targetDuration:null,endList:false,llHls:false,hasVariables:false,hasByteRange:false};
  let duration=null,discontinuityPresent=false;
  for(const raw of typeof text==='string'?text.split(/\r?\n/):[]){
    const line=raw.trim();
    if(line.startsWith('#EXT-X-MEDIA-SEQUENCE:')){result.mediaPlaylist=true;result.mediaSequence=tagInteger(line.slice(22));}
    else if(line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')){discontinuityPresent=true;result.discontinuitySequence=tagInteger(line.slice(30));}
    else if(line.startsWith('#EXT-X-TARGETDURATION:'))result.targetDuration=tagNumber(line.slice(22));
    else if(line.startsWith('#EXTINF:')){result.mediaPlaylist=true;duration=tagNumber(line.slice(8).split(',')[0]);}
    else if(line==='#EXT-X-ENDLIST')result.endList=true;
    if(/^#EXT-X-(?:PART(?:-INF)?:|PRELOAD-HINT:|SERVER-CONTROL:|SKIP:|RENDITION-REPORT:)/.test(line))result.llHls=true;
    if(line.startsWith('#EXT-X-PART:'))result.mediaPlaylist=true;
    if(line.startsWith('#EXT-X-DEFINE:')||line.includes('{$'))result.hasVariables=true;
    if(line.startsWith('#EXT-X-')&&/\bBYTERANGE(?::|=|-)/.test(line))result.hasByteRange=true;
    if(line&&!line.startsWith('#')){
      if(duration!==null){result.segmentCount++;result.windowSeconds+=duration;}duration=null;
    }
  }
  if(result.mediaPlaylist&&!discontinuityPresent)result.discontinuitySequence=0;
  result.windowSeconds=number(result.windowSeconds,604800);return result;
}

const digest=value=>createHash('sha256').update(value).digest('base64url');
function queryIdentity(url){
  const known=new Map(),unknown=createHash('sha256');
  for(const [name,value]of url.searchParams){
    const normalized=name.toLowerCase(),flag=Object.hasOwn(TV_AUTH_QUERY_FLAGS,normalized)?TV_AUTH_QUERY_FLAGS[normalized]:null,pair=JSON.stringify([name,value]);
    if(flag){if(!known.has(flag))known.set(flag,createHash('sha256'));known.get(flag).update(pair);}
    else unknown.update(pair);
  }
  for(const [flag,hash]of known)known.set(flag,hash.digest('base64url'));
  return{known,unknown:unknown.digest('base64url')};
}
function segmentIdentities(text,base,{resolve=true}={}){
  const result=new Map();let sequence=null,discontinuity=0,duration=null;
  for(const raw of typeof text==='string'?text.split(/\r?\n/):[]){
    const line=raw.trim();
    if(line.startsWith('#EXT-X-MEDIA-SEQUENCE:'))sequence=tagInteger(line.slice(22));
    else if(line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:'))discontinuity=tagInteger(line.slice(30));
    else if(line==='#EXT-X-DISCONTINUITY')discontinuity=discontinuity===null?null:integer(discontinuity+1);
    else if(line.startsWith('#EXTINF:')){const value=tagNumber(line.slice(8).split(',')[0]);duration=value>0?value:null;}
    if(!line||line.startsWith('#'))continue;
    if(duration!==null&&sequence!==null&&discontinuity!==null){
      const segment={raw:digest(line),duration};
      if(resolve){
        const rawPath=line.split(/[?#]/,1)[0].replace(/^(?:[a-z][a-z\d+.-]*:)?\/\/[^/]*/i,'');
        Object.assign(segment,{rawPath:digest(rawPath),resolved:null,resolvedPath:null,query:null,origin:null,filename:null,queryIdentity:null});
        try{
          const url=new URL(line,base);segment.resolved=digest(url.href);segment.resolvedPath=digest(url.pathname);
          segment.query=digest(url.search);segment.origin=digest(url.origin);segment.filename=digest(url.pathname.slice(url.pathname.lastIndexOf('/')+1));
          segment.queryIdentity=queryIdentity(url);
        }catch{/* Invalid references stay unknown. */}
      }
      result.set(`${sequence}:${discontinuity}`,segment);
      if(result.size>MAX_IDENTITY_SEGMENTS)result.delete(result.keys().next().value);
    }
    if(duration!==null&&sequence!==null)sequence=integer(sequence+1);
    duration=null;
  }
  return result;
}

/** Opaque, playback-private comparison input. Even accidental serialization
 * reveals no URI or digest; only the observer can access the bounded snapshot. */
export function tvPlaylistUriIdentity(original,rewritten,base){
  const token=Object.freeze({}),segments=segmentIdentities(original,base),proxy=segmentIdentities(rewritten,base,{resolve:false});
  for(const [key,segment]of segments){segment.proxy=proxy.get(key)?.raw??null;}
  playlistIdentities.set(token,{base:typeof base==='string'?digest(base):null,segments});return token;
}

function uriMeasurement(current,previous){
  const result={sameSequenceSamples:0,rawUriStable:null,resolvedUriStable:null,proxyUriStable:null,durationStable:null,
    rawUriChanges:0,resolvedUriChanges:0,proxyUriChanges:0,durationChanges:0,rewriteOnlyUriChanges:0,mediaBaseChanged:null,
    rawPathChanges:0,resolvedPathChanges:0,queryChanges:0,originChanges:0,filenameChanges:0,queryOnlyUriChanges:0,
    changedAuthQueryFlags:0,queryKnownAuthOnly:null,unknownChangedQuery:null,queryRepresentationChanges:0};
  if(!current||!previous)return result;
  if(current.base!==null&&previous.base!==null)result.mediaBaseChanged=current.base!==previous.base;
  let resolvedSamples=0,proxySamples=0;
  for(const [key,segment]of current.segments){
    const prior=previous.segments.get(key);if(!prior)continue;
    result.sameSequenceSamples++;
    if(segment.raw!==prior.raw)result.rawUriChanges++;
    if(segment.rawPath!==prior.rawPath)result.rawPathChanges++;
    if(segment.duration!==prior.duration)result.durationChanges++;
    if(segment.resolved!==null&&prior.resolved!==null){
      resolvedSamples++;if(segment.resolved!==prior.resolved)result.resolvedUriChanges++;
      for(const [part,field]of [['resolvedPath','resolvedPathChanges'],['query','queryChanges'],['origin','originChanges'],['filename','filenameChanges']])if(segment[part]!==prior[part])result[field]++;
      if(segment.query!==prior.query&&segment.resolvedPath===prior.resolvedPath&&segment.origin===prior.origin)result.queryOnlyUriChanges++;
      if(segment.query!==prior.query){
        let flags=0;for(const flag of authQueryFlagValues)if(segment.queryIdentity.known.get(flag)!==prior.queryIdentity.known.get(flag))flags|=flag;
        const unknown=segment.queryIdentity.unknown!==prior.queryIdentity.unknown;
        result.changedAuthQueryFlags|=flags;result.unknownChangedQuery=result.unknownChangedQuery===true||unknown;
        if(!flags&&!unknown)result.queryRepresentationChanges++;
      }
    }
    if(segment.proxy!==null&&prior.proxy!==null){
      proxySamples++;if(segment.proxy!==prior.proxy){result.proxyUriChanges++;if(segment.resolved!==null&&segment.resolved===prior.resolved)result.rewriteOnlyUriChanges++;}
    }
  }
  if(result.sameSequenceSamples){result.rawUriStable=result.rawUriChanges===0;result.durationStable=result.durationChanges===0;}
  if(resolvedSamples){result.resolvedUriStable=result.resolvedUriChanges===0;result.unknownChangedQuery??=false;}
  if(result.queryChanges)result.queryKnownAuthOnly=result.changedAuthQueryFlags!==0&&!result.unknownChangedQuery&&result.queryRepresentationChanges===0;
  if(proxySamples)result.proxyUriStable=result.proxyUriChanges===0;
  return result;
}

function playlistMeasurement(sample,stream){
  const value={mediaPlaylist:sample.mediaPlaylist===true,mediaSequence:integer(sample.mediaSequence),discontinuitySequence:integer(sample.discontinuitySequence),
    segmentCount:integer(sample.segmentCount),windowSeconds:number(sample.windowSeconds,604800),targetDuration:number(sample.targetDuration,86400),
    endList:sample.endList===true,llHls:sample.llHls===true,hasVariables:sample.hasVariables===true,hasByteRange:sample.hasByteRange===true,
    entryPlaylist:sample.entryPlaylist===true,bootstrap:sample.bootstrap===true,resolvedURL:sample.resolvedURL===true,
    ageSeconds:integer(sample.ageSeconds),sequenceAdvance:null,tailSequenceAdvance:null,...uriMeasurement(null,null)};
  // This bounded, playback-private key is never copied to a measurement/log.
  if(value.mediaPlaylist&&value.mediaSequence!==null){
    const key=typeof sample.playlistKey==='string'&&sample.playlistKey.length<=8192?sample.playlistKey:'entry';
    const previous=stream.playlists.get(key),tail=value.segmentCount>0?integer(value.mediaSequence+value.segmentCount-1):null;
    const uriIdentity=object(sample.uriIdentity)?playlistIdentities.get(sample.uriIdentity):null;
    Object.assign(value,uriMeasurement(uriIdentity,previous?.uriIdentity));
    if(previous){
      const delta=value.mediaSequence-previous.sequence;value.sequenceAdvance=Number.isSafeInteger(delta)?delta:null;
      if(tail!==null&&previous.tail!==null){const difference=tail-previous.tail;value.tailSequenceAdvance=Number.isSafeInteger(difference)?difference:null;}
    }
    stream.playlists.delete(key);stream.playlists.set(key,{sequence:value.mediaSequence,tail,uriIdentity});
    if(stream.playlists.size>16)stream.playlists.delete(stream.playlists.keys().next().value);
  }
  return value;
}

/** Observes existing player requests. No I/O, timers, provider probes or
 * identifiers leave this callback. Delivery includes downstream backpressure. */
export function createTvTransportObserver({emit,now=Date.now}={}){
  if(typeof emit!=='function')return()=>{};
  const clients=new WeakMap();let sequence=0;
  return(client,identity,sample)=>{
    if(!object(client)||!object(identity)||!phases.has(sample?.phase))return;
    const time=now();if(!Number.isFinite(time))return;
    let state=clients.get(client);
    if(!state){state={budgetAt:time,emitted:0,retired:new WeakSet(),stream:null};clients.set(client,state);}
    if(time<state.budgetAt||time-state.budgetAt>=BUDGET_MS){state.budgetAt=time;state.emitted=0;}
    if(state.retired.has(identity))return;
    if(state.stream?.identity!==identity){
      if(state.stream)state.retired.add(state.stream.identity);
      state.stream={identity,observation:++sequence,seen:new Set(),mediaSeen:false,playlists:new Map(),windowAt:time,window:emptyWindow()};
    }
    const stream=state.stream;
    const measurement={phase:sample.phase,durationMs:number(sample.durationMs),headersMs:number(sample.headersMs),
      firstBodyMs:number(sample.firstBodyMs),rewriteMs:number(sample.rewriteMs),bytes:number(sample.bytes,Number.MAX_SAFE_INTEGER),
      mediaSeconds:number(sample.mediaSeconds,86400),ok:sample.ok===true,
      status:Number.isInteger(sample.status)&&sample.status>=100&&sample.status<=599?sample.status:null};
    const window=stream.window;window.samples++;let firstMedia=false;
    if(measurement.phase==='manifest'){
      const playlist=playlistMeasurement(sample,stream);Object.assign(measurement,playlist);window.manifestSamples++;
      firstMedia=playlist.mediaPlaylist&&!stream.mediaSeen;if(playlist.mediaPlaylist)stream.mediaSeen=true;
      if(playlist.mediaPlaylist||!window.playlist)window.playlist=Object.freeze({...playlist});
      if(playlist.bootstrap)window.manifestBootstrapCount++;if(playlist.resolvedURL)window.manifestResolvedCount++;
      if(playlist.sequenceAdvance!==null){window.sequenceAdvanceTotal+=playlist.sequenceAdvance;if(playlist.sequenceAdvance<0)window.sequenceRegressions++;}
      for(const field of ['sameSequenceSamples','rawUriChanges','resolvedUriChanges','proxyUriChanges','durationChanges','rewriteOnlyUriChanges',
        'rawPathChanges','resolvedPathChanges','queryChanges','originChanges','filenameChanges','queryOnlyUriChanges'])window[field]+=playlist[field];
      if(playlist.mediaBaseChanged)window.mediaBaseChanges++;
      window.changedAuthQueryFlags|=playlist.changedAuthQueryFlags;window.unknownChangedQuery||=playlist.unknownChangedQuery===true;
      window.queryRepresentationChanges+=playlist.queryRepresentationChanges;
      if(playlist.queryKnownAuthOnly!==null)window.queryKnownAuthOnly=(window.queryKnownAuthOnly??true)&&playlist.queryKnownAuthOnly;
    }
    if(measurement.phase==='cache')window.cacheHits++;
    if(!measurement.ok)window.failures++;
    if(measurement.phase==='segment'){
      window.segmentSamples++;
      if(measurement.ok){
        window.segmentBytes+=measurement.bytes||0;
        if(measurement.mediaSeconds>0){window.mediaSeconds+=measurement.mediaSeconds;window.segmentDurationMs+=measurement.durationMs||0;}
      }
    }
    for(const field of ['headersMs','firstBodyMs'])if(measurement[field]!==null)window[field+'Max']=Math.max(window[field+'Max']||0,measurement[field]);
    const output=payload=>{
      if(state.emitted>=MAX_EVENTS)return;
      state.emitted++;
      try{emit(Object.freeze({schema:1,observation:stream.observation,...payload}));}catch{/* Diagnostics cannot interrupt playback. */}
    };
    if(!stream.seen.has(measurement.phase)||firstMedia){
      stream.seen.add(measurement.phase);output(measurement);
    }
    if(time-stream.windowAt>=WINDOW_MS){
      output({phase:'window',windowMs:time-stream.windowAt,...window});
      stream.windowAt=time;stream.window=emptyWindow();
    }
  };
}

import {createWplayGateway} from './wplay-gateway.mjs';
export const PROJECT_URL='https://wnicimkmzswksaqdtgdv.supabase.co';
const MAX_BYTES=32*1024*1024,MAX_AGE_MS=120000;
const HASH=/^[a-f0-9]{64}$/i,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const EMAIL=/^([a-f0-9]{64})@accounts\.arkhen\.invalid$/,EDITION=/^skipdb-[a-f0-9]{24}$/;
const object=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const text=(value,max=20000)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const finite=(value,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
const iso=value=>typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value));
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value);
const worker=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const slug=value=>typeof value==='string'&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)&&value.length<=160;
const optional=check=>value=>value===undefined||check(value);
const nullable=check=>value=>value===null||check(value);
const keys=(value,allowed)=>object(value)&&Object.keys(value).every(key=>allowed.includes(key));
const shape=(value,rules)=>keys(value,Object.keys(rules))&&Object.entries(rules).every(([key,check])=>check(value[key]));
const list=(value,check,max=100000)=>Array.isArray(value)&&value.length<=max&&value.every(check);
const hex=bytes=>Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
const encoder=new TextEncoder();
const failure=(status,code)=>Object.assign(new Error(code),{status,code});
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});

// Fixed shared metadata vocabulary: provider URLs, playback sources and secret
// fields cannot be published through the administrative capability.
const metadataKeys=new Set(('categories items id name kind categoryId categoryIds poster backdrop year rating added plot genre group groupNames container durationSeconds duration imdbId tmdbId adult isAdult is_adult list title description start end available date timeZone games message league homeTeam awayTeam logo status score channels').split(' '));
function metadata(value,depth=0){
  if(depth>10)return false;
  if(value===null||typeof value==='boolean')return true;
  if(typeof value==='number')return Number.isFinite(value);
  if(typeof value==='string')return text(value)&&!/https?:\/\//i.test(value);
  if(Array.isArray(value))return value.length<=100000&&value.every(entry=>metadata(entry,depth+1));
  return object(value)&&Object.entries(value).every(([key,entry])=>metadataKeys.has(key)&&metadata(entry,depth+1));
}
const refreshPayload=value=>keys(value,['media_type','channel_ids','date','timeZone','time_zone','lang'])&&
  (value.media_type===undefined||['live','movies','series'].includes(value.media_type))&&
  (value.channel_ids===undefined||list(value.channel_ids,id,20000))&&
  (value.date===undefined||/^\d{4}-\d{2}-\d{2}$/.test(value.date))&&
  [value.timeZone,value.time_zone].every(item=>item===undefined||typeof item==='string'&&/^[A-Za-z_/-]{1,80}$/.test(item))&&
  (value.lang===undefined||typeof value.lang==='string'&&/^[a-z-]{2,12}$/i.test(value.lang));

function rpcRules(now){
  const partition={p_provider_key:value=>HASH.test(value||''),p_scope_hash:value=>HASH.test(value||'')};
  const lease={...partition,p_job_id:value=>UUID.test(value||''),p_worker:worker};
  return {
    arkhen_identity_lookup:{p_library_hash:value=>HASH.test(value||'')},
    arkhen_identity_bind:{p_library_hash:value=>HASH.test(value||''),p_user_id:value=>UUID.test(value||''),p_provider:value=>['wplay','wplay-ott'].includes(value),...partition},
    arkhen_validate_account:{p_user_id:value=>UUID.test(value||''),p_status:value=>['active','disabled','expired'].includes(value),p_expires_at:nullable(iso),p_validated_at:value=>iso(value)&&Date.parse(value)<=now+60000&&Date.parse(value)>=now-86400000,...partition},
    arkhen_enqueue_source_jobs:partition,
    arkhen_kick_cloud_collector:{},
    arkhen_request_cache_refresh:{...partition,p_job_type:value=>['catalog','epg','games'].includes(value),p_payload:refreshPayload},
    arkhen_claim_cache_jobs:{p_worker:worker,p_limit:optional(value=>integer(value,1,10)),p_lease_seconds:optional(value=>integer(value,30,900))},
    arkhen_renew_cache_job:{p_job_id:value=>UUID.test(value||''),p_worker:worker,p_lease_seconds:optional(value=>integer(value,30,900))},
    arkhen_finish_cache_job:{p_job_id:value=>UUID.test(value||''),p_worker:worker,p_success:value=>typeof value==='boolean',p_error_code:optional(nullable(value=>typeof value==='string'&&/^[A-Za-z0-9_.-]{1,80}$/.test(value)))},
    arkhen_publish_catalog:{...lease,p_media_type:value=>['live','movies','series'].includes(value),p_payload:value=>keys(value,['categories','items'])&&Array.isArray(value.categories)&&Array.isArray(value.items)&&metadata(value),p_complete:value=>value===true,p_snapshot_id:value=>UUID.test(value||''),p_expires_at:iso},
    arkhen_publish_epg:{...lease,p_channel_id:id,p_payload:value=>keys(value,['list'])&&Array.isArray(value.list)&&metadata(value),p_expires_at:iso},
    arkhen_publish_epg_batch:{...lease,p_channels:value=>list(value,row=>shape(row,{channel_id:id,payload:data=>keys(data,['list'])&&Array.isArray(data.list)&&metadata(data)}),20000),p_expires_at:iso},
    arkhen_publish_games:{...lease,p_game_date:value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value),p_time_zone:value=>typeof value==='string'&&/^[A-Za-z_/-]{1,80}$/.test(value),p_payload:value=>object(value)&&Array.isArray(value.games)&&metadata(value),p_expires_at:iso},
  };
}

const profileColumns=['id','provider','provider_key','scope_hash','library_hash','status','access_expires_at','last_validated_at'];
const markerColumns=['series_slug','season','episode','edition_id','tmdb_id','imdb_id','duration_seconds','tolerance_seconds','verification','markers','provenance','data_version','is_active'];
const selectColumns=(value,allowed)=>typeof value==='string'&&value.length>0&&value.split(',').every(column=>allowed.includes(column));
function parameters(url,allowed){
  const result={};for(const [key,value]of url.searchParams){if(!allowed.includes(key)||Object.hasOwn(result,key))throw failure(400,'GATEWAY_OPERATION_REJECTED');result[key]=value;}return result;
}
const inList=(value,check,max=100)=>typeof value==='string'&&value.startsWith('in.(')&&value.endsWith(')')&&list(value.slice(4,-1).split(','),check,max);
function markerRow(row){
  if(!shape(row,{series_slug:slug,season:value=>integer(value,0,1000),episode:value=>integer(value,1,10000),edition_id:value=>EDITION.test(value||''),
    tmdb_id:value=>integer(value,1,100000000),imdb_id:value=>typeof value==='string'&&/^tt\d{1,12}$/.test(value),duration_seconds:value=>finite(value,0.001,86400),
    tolerance_seconds:value=>value===2,verification:value=>value==='community-reference',markers:object,provenance:object,data_version:value=>typeof value==='string'&&/^skipdb\.[0-9TZ]{14,32}$/.test(value),is_active:value=>typeof value==='boolean'}))return false;
  if(!keys(row.markers,['openingStart','openingEnd','creditsStart'])||!Object.values(row.markers).every(value=>finite(value,0,row.duration_seconds)))return false;
  if((row.markers.openingStart===undefined)!==(row.markers.openingEnd===undefined)||row.markers.openingEnd!==undefined&&row.markers.openingEnd<=row.markers.openingStart)return false;
  const provenance=row.provenance;
  if(!shape(provenance,{source:value=>value==='skipdb',license:value=>value==='ODbL 1.0 + Service Provider Reciprocity',licenseUrl:value=>value==='https://skipdb.tv/license',dumpUrl:value=>value==='https://skipdb.tv/api/dump',dumpGeneratedAt:iso,retrievedAt:iso,
    sources:value=>list(value,source=>shape(source,{title:title=>title==='SkipDB',url:sourceURL=>{
      try{const url=new URL(sourceURL),query=parameters(url,['imdb_id','season','episode','duration','adjust']);return url.origin==='https://skipdb.tv'&&url.pathname==='/api/segments'&&!url.username&&!url.password&&!url.hash&&query.imdb_id===row.imdb_id&&query.season===String(row.season)&&query.episode===String(row.episode)&&Number(query.duration)===row.duration_seconds&&query.adjust==='none';}catch{return false;}
    },retrievedAt:iso}),10),
    verification:value=>shape(value,{status:status=>status==='community-reference',notes:notes=>list(notes,note=>text(note,1000),20),blockEarlyNext:optional(block=>typeof block==='boolean'),openingCandidates:optional(candidates=>list(candidates,candidate=>shape(candidate,{openingStart:value=>finite(value,0,86400),openingEnd:value=>finite(value,0,86400),durationSeconds:value=>finite(value,0.001,86400)&&Math.abs(value-row.duration_seconds)<=4})&&candidate.openingEnd>candidate.openingStart&&candidate.openingEnd<=candidate.durationSeconds,1000))}),
    evidence:value=>list(value,entry=>shape(entry,{id:value=>integer(value,1,Number.MAX_SAFE_INTEGER),imdb_id:value=>value===row.imdb_id,media_type:value=>value==='series',season:value=>value===row.season,episode:value=>value===row.episode,segment_type:value=>['intro','outro','recap','preview'].includes(value),start_ms:value=>finite(value,0,86400000),end_ms:value=>finite(value,0,86400000),duration_ms:nullable(value=>finite(value,0.001,86400000)),score:value=>typeof value==='number'&&Number.isFinite(value),updated_at:optional(iso)}),10000)}))return false;
  return true;
}

function operation(envelope,now){
  if(!shape(envelope,{path:value=>typeof value==='string'&&value.length<=20000,method:value=>['GET','POST','PATCH'].includes(value),body:optional(()=>true)}))throw failure(400,'GATEWAY_OPERATION_REJECTED');
  const {path,method}=envelope;
  // Reject normalization tricks before URL parsing. The only upstream is fixed.
  if(!/^\/(?:auth\/v1|rest\/v1)\/[A-Za-z0-9_/?=&.,%+>*-]+$/.test(path)||path.includes('..')||path.includes('#')||path.includes('\\'))throw failure(400,'GATEWAY_OPERATION_REJECTED');
  const url=new URL(path,PROJECT_URL);if(url.origin!==PROJECT_URL)throw failure(400,'GATEWAY_OPERATION_REJECTED');
  const result={path:url.pathname+url.search,method,body:envelope.body,headers:{},timeoutMs:15000};
  const rpc=/^\/rest\/v1\/rpc\/(arkhen_[a-z_]+)$/.exec(url.pathname);
  if(rpc){
    const rules=rpcRules(now)[rpc[1]];
    if(method!=='POST'||url.search||!rules||!shape(envelope.body,rules))throw failure(400,'GATEWAY_OPERATION_REJECTED');
    if(/^arkhen_publish_/.test(rpc[1]))result.timeoutMs=65000;
    return result;
  }
  if(url.pathname==='/auth/v1/admin/users'&&method==='POST'&&!url.search){
    const body=envelope.body,hash=EMAIL.exec(body?.email||'')?.[1];
    if(!hash||!shape(body,{email:value=>value===body.email,password:value=>text(value,256)&&value.length>=32,email_confirm:value=>value===true,
      app_metadata:value=>shape(value,{arkhen_provider:provider=>['wplay','wplay-ott'].includes(provider),arkhen_library_hash:value=>value===hash})}))throw failure(400,'GATEWAY_OPERATION_REJECTED');
    result.authEmail=body.email;result.body={email:body.email,email_confirm:true,app_metadata:{...body.app_metadata}};result.createPassword=true;return result;
  }
  if(url.pathname==='/auth/v1/admin/generate_link'&&method==='POST'&&!url.search){
    if(!shape(envelope.body,{type:value=>value==='magiclink',email:value=>typeof value==='string'&&EMAIL.test(value)}))throw failure(400,'GATEWAY_OPERATION_REJECTED');
    result.authEmail=envelope.body.email;result.generateLink=true;return result;
  }
  if(url.pathname==='/rest/v1/profiles'&&method==='GET'&&envelope.body===undefined){
    const query=parameters(url,['select','status','id','limit']);
    if(!selectColumns(query.select,profileColumns)||query.status!=='eq.active'||!/^[12]$/.test(query.limit||'2')||query.id!==undefined&&!/^eq\.[a-f0-9-]{36}$/i.test(query.id))throw failure(400,'GATEWAY_OPERATION_REJECTED');
    if(query.id!==undefined&&!UUID.test(query.id.slice(3)))throw failure(400,'GATEWAY_OPERATION_REJECTED');
    if(query.limit===undefined)url.searchParams.set('limit','2');result.path=url.pathname+url.search;result.columns=query.select.split(',');return result;
  }
  if(url.pathname==='/rest/v1/episode_skip_markers'){
    if(method==='POST'){
      const query=parameters(url,['on_conflict']);
      if(query.on_conflict!=='series_slug,season,episode,edition_id'||!list(envelope.body,markerRow,200)||envelope.body.length===0)throw failure(400,'GATEWAY_OPERATION_REJECTED');
      result.headers.Prefer='resolution=ignore-duplicates,return=minimal';return result;
    }
    if(method==='PATCH'){
      const query=parameters(url,['edition_id','provenance->>source','verification']);
      if(!inList(query.edition_id,value=>EDITION.test(value))||query['provenance->>source']!=='eq.skipdb'||query.verification!=='neq.verified'||!shape(envelope.body,{is_active:value=>typeof value==='boolean'}))throw failure(400,'GATEWAY_OPERATION_REJECTED');
      result.headers.Prefer='return=minimal';return result;
    }
    if(method==='GET'&&envelope.body===undefined){
      const query=parameters(url,['select','edition_id','provenance->>source','series_slug','order','limit','offset']);
      if(!selectColumns(query.select,markerColumns)||query.edition_id!=='like.skipdb-*'||query['provenance->>source']!=='eq.skipdb'||!inList(query.series_slug,slug,1000)||query.order!=='series_slug,season,episode,edition_id'||!/^\d{1,4}$/.test(query.limit||'')||!integer(Number(query.limit),1,1000)||!/^\d{1,5}$/.test(query.offset||'')||!integer(Number(query.offset),0,49999))throw failure(400,'GATEWAY_OPERATION_REJECTED');
      result.columns=query.select.split(',');return result;
    }
  }
  throw failure(400,'GATEWAY_OPERATION_REJECTED');
}

async function boundedBytes(message,limit){
  const length=message.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)>limit))throw failure(413,'GATEWAY_BODY_TOO_LARGE');
  if(!message.body)return new Uint8Array();
  const reader=message.body.getReader(),chunks=[];let bytes=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>limit){await reader.cancel();throw failure(413,'GATEWAY_BODY_TOO_LARGE');}chunks.push(value);}}
  finally{reader.releaseLock();}
  const result=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}return result;
}

function adminKey(environment){
  let key;try{key=JSON.parse(environment('SUPABASE_SECRET_KEYS')||'null')?.default;}catch{/* Legacy projects may only expose their JWT service key. */}
  if(typeof key==='string'&&/^sb_secret_[A-Za-z0-9_-]{16,}$/.test(key))return key;
  const legacy=environment('SUPABASE_SERVICE_ROLE_KEY');
  if(typeof legacy==='string'&&legacy.split('.').length===3&&!/\s/.test(legacy)){
    try{const payload=legacy.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');if(JSON.parse(atob(payload)).role==='service_role')return legacy;}catch{/* Configuration errors must not expose keys. */}
  }
  throw failure(503,'GATEWAY_NOT_CONFIGURED');
}

/** This HMAC belongs to one trusted backend, never to distributed/browser
 * clients. Provider validation remains that backend's responsibility.
 * Nonces are retained per isolate, not globally across Edge workers. HTTPS,
 * the short timestamp window and idempotent writes bound cross-isolate replay. */
export function createBackendGateway({environment=()=>undefined,fetch:fetcher=(...args)=>globalThis.fetch(...args),now=()=>Date.now(),crypto:cryptography=globalThis.crypto,maxBytes=MAX_BYTES,maxNonces=10000}={}){
  const seen=new Map(),wplay=createWplayGateway({environment,fetch:fetcher,now});
  return async request=>{
    try{
      if(request.headers.has('origin'))throw failure(403,'GATEWAY_BROWSER_FORBIDDEN');
      if(request.method!=='POST')throw failure(405,'GATEWAY_METHOD_REJECTED');
      if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')||''))throw failure(415,'GATEWAY_JSON_REQUIRED');
      const secret=environment('ARKHEN_BACKEND_SECRET');
      if(typeof secret!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(secret))throw failure(503,'GATEWAY_NOT_CONFIGURED');
      const timestamp=request.headers.get('x-arkhen-timestamp')||'',nonce=request.headers.get('x-arkhen-nonce')||'',signature=request.headers.get('x-arkhen-signature')||'';
      if(!/^\d{13}$/.test(timestamp)||Math.abs(now()-Number(timestamp))>MAX_AGE_MS||!/^[a-f0-9]{32}$/.test(nonce)||!/^[a-f0-9]{64}$/.test(signature))throw failure(401,'GATEWAY_SIGNATURE_INVALID');
      const bytes=await boundedBytes(request,maxBytes),prefix=encoder.encode(`${timestamp}.${nonce}.`),signed=new Uint8Array(prefix.byteLength+bytes.byteLength);signed.set(prefix);signed.set(bytes,prefix.byteLength);
      const key=await cryptography.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
      const signatureBytes=Uint8Array.from(signature.match(/../g),value=>Number.parseInt(value,16));
      if(!await cryptography.subtle.verify('HMAC',key,signatureBytes,signed)||Math.abs(now()-Number(timestamp))>MAX_AGE_MS)throw failure(401,'GATEWAY_SIGNATURE_INVALID');
      for(const [old,expires]of seen)if(expires<now())seen.delete(old);
      if(seen.has(nonce))throw failure(409,'GATEWAY_REPLAY_REJECTED');
      if(seen.size>=maxNonces)throw failure(429,'GATEWAY_CAPACITY_REACHED');
      seen.set(nonce,Number(timestamp)+MAX_AGE_MS);
      let envelope;try{envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw failure(400,'GATEWAY_JSON_INVALID');}
      if(['/providers/wplay/auth','/providers/wplay/artwork'].includes(envelope?.path))return json(await wplay(envelope,adminKey(environment)));
      const selected=operation(envelope,now()),serviceKey=adminKey(environment);
      if(selected.createPassword)selected.body.password=hex(cryptography.getRandomValues(new Uint8Array(48)));
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),selected.timeoutMs);timer?.unref?.();
      let response,data;
      try{response=await fetcher(PROJECT_URL+selected.path,{method:selected.method,redirect:'error',signal:controller.signal,
        headers:{'Content-Type':'application/json',...selected.headers,apikey:serviceKey,...(serviceKey.split('.').length===3?{Authorization:'Bearer '+serviceKey}:{})},
        ...(selected.body===undefined?{}:{body:JSON.stringify(selected.body)})});
        const raw=new TextDecoder('utf-8',{fatal:true}).decode(await boundedBytes(response,maxBytes));
        if(raw.includes(serviceKey)||raw.includes(secret))throw new Error('sensitive response');data=raw?JSON.parse(raw):null;
      }
      catch{throw failure(502,controller.signal.aborted?'GATEWAY_UPSTREAM_TIMEOUT':response?'GATEWAY_RESPONSE_INVALID':'GATEWAY_UPSTREAM_UNAVAILABLE');}
      finally{clearTimeout(timer);}
      if(!response.ok){const safe={};for(const field of ['code','error_code'])if(typeof data?.[field]==='string'&&/^[A-Za-z0-9_]{1,80}$/.test(data[field]))safe[field]=data[field];return json(Object.keys(safe).length?safe:{code:'GATEWAY_UPSTREAM_REJECTED'},response.status>=400&&response.status<=599?response.status:502);}
      if(selected.authEmail){
        const user=data?.user??data,hash=EMAIL.exec(selected.authEmail)[1];
        if(!UUID.test(user?.id||'')||user.email!==selected.authEmail||user.app_metadata?.arkhen_library_hash!==hash||!['wplay','wplay-ott'].includes(user.app_metadata?.arkhen_provider))throw failure(502,'GATEWAY_IDENTITY_MISMATCH');
        const safeUser={id:user.id,email:user.email,app_metadata:{arkhen_library_hash:hash,arkhen_provider:user.app_metadata.arkhen_provider}};
        if(selected.generateLink){const token=data.hashed_token??data.properties?.hashed_token;if(typeof token!=='string'||!/^[A-Za-z0-9._~-]{16,8192}$/.test(token))throw failure(502,'GATEWAY_RESPONSE_INVALID');return json({user:safeUser,hashed_token:token});}
        return json(safeUser);
      }
      if(selected.columns){if(!Array.isArray(data))throw failure(502,'GATEWAY_RESPONSE_INVALID');data=data.map(row=>Object.fromEntries(selected.columns.filter(column=>Object.hasOwn(row,column)).map(column=>[column,row[column]])));}
      return json(data);
    }catch(error){return json({code:/^GATEWAY_[A-Z_]{1,80}$/.test(error?.code||'')?error.code:'GATEWAY_REQUEST_FAILED'},integer(error?.status,400,599)?error.status:500);}
  };
}

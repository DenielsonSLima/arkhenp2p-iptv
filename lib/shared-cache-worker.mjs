import {randomUUID,createHash} from 'node:crypto';
import {cloudSourceScope} from './supabase-cloud.mjs';
import {epgTimestamp,wplayEPGChannelID,wplayEPGSnapshot} from './wplay/ao-vivo/grade.mjs';
import {readWplayLiveCatalog} from './wplay/ao-vivo/catalogo-autorizado.mjs';

const HASH=/^[a-f0-9]{64}$/i,ID=/^[A-Za-z0-9_-]{1,160}$/;
const safeID=value=>ID.test(String(value??''))?String(value):'';
const text=(value,limit=1000)=>typeof value==='string'||typeof value==='number'?String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/https?:\/\/[^\s<>"']+/gi,'').slice(0,limit):'';
const list=value=>Array.isArray(value)?value:[];
const iso=value=>{const time=epgTimestamp(value);return time===null?null:new Date(time).toISOString();};
const failure=code=>Object.assign(new Error('A atualização compartilhada não foi concluída.'),{code});
const safeError=error=>typeof error?.code==='string'&&/^[A-Z_]{1,80}$/.test(error.code)?error.code:'CACHE_REFRESH_FAILED';
const localImage=value=>typeof value==='string' && (/^\/assets\/[A-Za-z0-9_./-]+$/.test(value)&&!value.includes('..') || /^\/api\/shared-image(?:\/[a-f0-9]{64}|\?ref=[a-f0-9]{64})$/.test(value) || /^\/api\/sports-image\/[a-f0-9]{64}$/.test(value))?value:'';
const image=(value,mapImage)=>{try{return localImage(mapImage?mapImage(value):value);}catch{return '';}};

/** Explicit whitelist: no provider URLs, credentials, source lists or per-login image refs. */
export function sanitizeSharedCatalog(data,{type,mapImage}={}){
  if(!['live','movies','series'].includes(type)||!Array.isArray(data?.categories)||!Array.isArray(data?.items))throw failure('CACHE_CATALOG_INVALID');
  const kind=type==='movies'?'movie':type,categories=[],items=[],seenCategories=new Set(),seenItems=new Set();
  for(const raw of data.categories){const id=safeID(raw?.id),name=text(raw?.name);if(!id||!name||seenCategories.has(id))continue;seenCategories.add(id);categories.push({id,name,...(raw.adult===true||raw.isAdult===true||raw.is_adult===true?{isAdult:true}:{})});}
  for(const raw of data.items){
    const id=safeID(raw?.id),name=text(raw?.name);if(!id||!name||raw.kind!==kind||seenItems.has(id))continue;seenItems.add(id);
    const categoryIds=[...new Set([raw.categoryId,...list(raw.categoryIds)].map(safeID).filter(Boolean))];
    const item={id,name,kind,categoryId:categoryIds[0]||'',categoryIds,
      poster:image(raw.poster,mapImage),backdrop:image(raw.backdrop,mapImage),
      year:text(raw.year,20),rating:Number.isFinite(Number(raw.rating))?Math.max(0,Math.min(10,Number(raw.rating))):0,
      added:text(raw.added,80),plot:text(raw.plot,20000),genre:text(raw.genre,10000),
      group:text(raw.group,1000),groupNames:list(raw.groupNames).map(value=>text(value,300)).filter(Boolean).slice(0,200),
      container:/^[a-z0-9]{1,12}$/i.test(raw.container||'')?raw.container:'mp4'};
    const imdbId=raw.imdbId??raw.imdb_id,tmdbId=raw.tmdbId??raw.tmdb_id;
    if(typeof imdbId==='string'&&/^tt\d{6,10}$/.test(imdbId))item.imdbId=imdbId;
    if((typeof tmdbId==='number'||typeof tmdbId==='string'&&/^\d+$/.test(tmdbId))&&Number.isSafeInteger(Number(tmdbId))&&Number(tmdbId)>0)item.tmdbId=Number(tmdbId);
    if(raw.adult===true||raw.isAdult===true||raw.is_adult===true)item.isAdult=true;
    if(Number.isFinite(raw.durationSeconds)&&raw.durationSeconds>0&&raw.durationSeconds<=86400)item.durationSeconds=raw.durationSeconds;
    if(typeof raw.duration==='string')item.duration=text(raw.duration,80);
    items.push(item);
  }
  return {categories,items};
}

export function sanitizeSharedEPG(data){
  if(!Array.isArray(data?.list))throw failure('CACHE_EPG_INVALID');
  const programs=[],seen=new Set();
  for(const row of data.list){
    const title=text(row?.title),start=iso(row?.start),end=iso(row?.end);if(!title||!start||!end||end<=start)continue;
    const key=JSON.stringify([title,start,end]);if(seen.has(key))continue;seen.add(key);
    programs.push({title,description:text(row.description,20000),start,end});
  }
  return {list:programs.sort((a,b)=>a.start.localeCompare(b.start))};
}

export function sanitizeSharedGames(data,{mapImage}={}){
  if(typeof data?.available!=='boolean'||!Array.isArray(data.games)||typeof data.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(data.date))throw failure('CACHE_GAMES_INVALID');
  const team=value=>{if(!value||typeof value!=='object')return null;const id=safeID(value.id),name=text(value.name);return id||name?{id,name,logo:image(value.logo,mapImage)}:null;};
  const games=[],seen=new Set();
  for(const raw of data.games){const id=safeID(raw?.id);if(!id||seen.has(id))continue;seen.add(id);
    games.push({id,title:text(raw.title),league:team(raw.league),start:iso(raw.start),status:text(raw.status,80),homeTeam:team(raw.homeTeam),awayTeam:team(raw.awayTeam),score:text(raw.score,80),
      channels:list(raw.channels).map(value=>({id:safeID(value?.id),name:text(value?.name)})).filter(value=>value.id)});
  }
  return {available:data.available,date:data.date,timeZone:text(data.timeZone,80),games,...(data.available?{}:{message:'O serviço não disponibilizou a agenda de jogos para esta conta.'})};
}

/** Traverse metadata pages without ever publishing a partially loaded catalog. */
export async function completeSharedCatalog(client,type,{assertActive=()=>{},maxPages=100000,invalidate=true,onSnapshot=()=>{}}={}){
  if(type==='live'?client.authInfo?.service?.enabledLive===false:client.authInfo?.service?.enabledVoD===false)throw failure('CACHE_SOURCE_CAPABILITY_UNAVAILABLE');
  assertActive();if(invalidate)client.invalidateCatalog?.(type);let data=await client.catalog(type),pages=0;assertActive();onSnapshot(data);
  while(data?.pagination?.mode==='category'){
    const states=data.pagination.byCategory;
    if(!states||typeof states!=='object'||Array.isArray(states)||!Array.isArray(data.categories)||data.categories.some(category=>!Object.hasOwn(states,String(category?.id))))throw failure('CACHE_PAGINATION_INVALID');
    if(Object.values(states).some(state=>!state||typeof state.hasMore!=='boolean'))throw failure('CACHE_PAGINATION_INVALID');
    const pending=Object.entries(states).find(([,state])=>state.hasMore);
    if(!pending)break;if(++pages>maxPages)throw failure('CACHE_PAGINATION_LIMIT');
    const [category,state]=pending,page=Number(state.nextPage);
    if(!Number.isSafeInteger(page)||page<1||typeof client.catalogPage!=='function')throw failure('CACHE_PAGINATION_INVALID');
    assertActive();const next=await client.catalogPage(type,category,page);assertActive();
    const position=next?.pagination?.byCategory?.[category];
    if(!next||next.pagination?.mode!=='category'||!position||position.hasMore&&Number(position.nextPage)<=page)throw failure('CACHE_PAGINATION_STALLED');
    data=next;onSnapshot(data);
  }
  if(data?.pagination && data.pagination.mode!=='category')throw failure('CACHE_PAGINATION_UNSUPPORTED');
  return data;
}

export class SharedCacheWorker {
  constructor({cloud,chooseSource,mapImage,now=()=>Date.now(),workerId='arkhen-'+randomUUID(),pollMs=10000,leaseSeconds=300,heartbeatMs=60000,
    schedule=(callback,delay)=>globalThis.setTimeout(callback,delay),cancel=timer=>globalThis.clearTimeout(timer),onStatus=()=>{}}={}){
    Object.assign(this,{cloud,chooseSource,mapImage,now,workerId,pollMs,leaseSeconds,heartbeatMs,schedule,cancel,onStatus});
    this.sources=new Map();this.timer=null;this.inflight=null;this.generation=0;this.running=false;this.heartbeat=null;
  }
  registerSource(value){
    if(value?.client?.cloudCollection)throw failure('CACHE_SOURCE_MANAGED_IN_CLOUD');
    if(!value?.client?.session?.connected || !value.session?.connected)throw failure('CACHE_SOURCE_UNVALIDATED');
    const provider=value.provider||value.session.account?.provider,scope=cloudSourceScope(provider,value.client.config?.server);
    const source={...value,provider,providerKey:value.providerKey??scope.providerKey,scopeHash:value.scopeHash??scope.scopeHash,disabledUntil:0};
    if(!HASH.test(source.providerKey)||!HASH.test(source.scopeHash))throw failure('CACHE_SOURCE_INVALID');
    this.sources.set(source.client,source);return {providerKey:source.providerKey,scopeHash:source.scopeHash};
  }
  unregisterSource(client){this.sources.delete(client);}
  sourceActive(source){
    const account=source?.client?.session?.account,validated=Number(source?.client?.authenticatedAt),expiry=account?.expiresAt;
    return Boolean(!source?.client?.cloudCollection&&this.sources.get(source?.client)===source&&source?.client?.session?.connected&&source.session?.connected&&Number.isFinite(validated)&&validated>0&&validated<=this.now()+60000&&this.now()-validated<=86400000&&
      String(account?.status||'').toLowerCase()==='active'&&(!expiry||Number.isFinite(Date.parse(expiry))&&Date.parse(expiry)>this.now())&&(!source.disabledUntil||source.disabledUntil<=this.now()));
  }
  start(){if(this.running)return;this.running=true;this.generation++;this.#schedule(0);}
  stop(){this.running=false;this.generation++;if(this.timer!==null)this.cancel(this.timer);this.timer=null;if(this.heartbeat!==null)this.cancel(this.heartbeat);this.heartbeat=null;}
  #schedule(delay=this.pollMs){if(!this.running||this.timer!==null)return;this.timer=this.schedule(()=>{this.timer=null;void this.tick().finally(()=>this.#schedule());},delay);this.timer?.unref?.();}
  status(state,job,errorCode){try{this.onStatus({state,jobType:job?.job_type||null,errorCode:errorCode||null,updatedAt:this.now()});}catch{/* Status consumers cannot fail a refresh. */}}
  async tick(){
    if(this.inflight)return this.inflight;
    const pending=this.#tick().catch(error=>{this.status('error',null,safeError(error));return {idle:false,errorCode:safeError(error)};});this.inflight=pending;try{return await pending;}finally{if(this.inflight===pending)this.inflight=null;}
  }
  async #tick(){
    const generation=this.generation;
    await this.cloud.ready;if(!this.cloud.enabled)return {idle:true,reason:'cloud-not-configured'};
    if(![...this.sources.values()].some(source=>this.sourceActive(source))&&!this.chooseSource)return {idle:true,reason:'no-active-source'};
    let jobs;try{jobs=await this.cloud.rpc('arkhen_claim_cache_jobs',{p_worker:this.workerId,p_limit:1,p_lease_seconds:this.leaseSeconds});}
    catch(error){this.status('error',null,safeError(error));return {idle:false,errorCode:safeError(error)};}
    const job=Array.isArray(jobs)?jobs[0]:null;if(!job)return {idle:true,reason:'no-jobs'};
    const context={job,generation,lease:true};let source=null;
    const assertActive=()=>{if(context.generation!==this.generation||!context.lease)throw failure('CACHE_LEASE_LOST');if(source&&!this.sourceActive(source))throw failure('CACHE_SOURCE_UNAVAILABLE');};
    const renew=async()=>{
      try{const valid=await this.cloud.rpc('arkhen_renew_cache_job',{p_job_id:job.id,p_worker:this.workerId,p_lease_seconds:this.leaseSeconds});if(valid!==true)context.lease=false;}
      catch{context.lease=false;}
      if(context.lease&&context.generation===this.generation){this.heartbeat=this.schedule(()=>{this.heartbeat=null;void renew();},this.heartbeatMs);this.heartbeat?.unref?.();}
    };
    let succeeded=false,errorCode=null;
    try{
      const candidates=[...this.sources.values()].filter(value=>value.providerKey===job.provider_key&&value.scopeHash===job.scope_hash&&this.sourceActive(value));
      source=this.chooseSource?await this.chooseSource(job,candidates):candidates[0];
      if(!source||source.providerKey!==job.provider_key||source.scopeHash!==job.scope_hash||!this.sourceActive(source))throw failure('CACHE_SOURCE_UNAVAILABLE');
      assertActive();this.status('refreshing',job);await renew();assertActive();
      const common={p_provider_key:job.provider_key,p_scope_hash:job.scope_hash,p_job_id:job.id,p_worker:this.workerId};
      const mapper=value=>this.mapImage?.(value,{client:source.client,providerKey:source.providerKey,scopeHash:source.scopeHash})??value;
      if(job.job_type==='catalog'){
        const requested=job.payload?.media_type,types=requested?[requested]:['live','movies','series'];
        if(types.some(type=>!['live','movies','series'].includes(type)))throw failure('CACHE_JOB_INVALID');
        for(const type of types){
          const data=await completeSharedCatalog(source.client,type,{assertActive}),snapshot=sanitizeSharedCatalog(data,{type,mapImage:mapper});assertActive();
          await this.cloud.rpc('arkhen_publish_catalog',{...common,p_media_type:type,p_payload:snapshot,p_complete:true,p_snapshot_id:randomUUID(),p_expires_at:new Date(this.now()+86400000).toISOString()});assertActive();
        }
      }else if(job.job_type==='epg'){
        const lease={p_job_id:job.id,p_worker:this.workerId};
        let candidate=await this.cloud.rpc('arkhen_epg_snapshot_state',lease);assertActive();
        if(candidate?.state==='missing'){
          const nativeEPG=Boolean(source.client.authInfo?.service?.epg_url);
          const catalog=nativeEPG?await readWplayLiveCatalog(source.client,{fresh:true,now:this.now,current:()=>{assertActive();return true;}}):await completeSharedCatalog(source.client,'live',{assertActive});assertActive();
          // A global job captures the complete channel set. A viewer's partial
          // channel_ids request must never replace the published global guide.
          const ids=[...new Set(list(catalog?.items).map(item=>String(item.id)).filter(id=>/^[0-9]{1,12}$/.test(id)))];
          const channels=[];let cursor=0,fetchedAt=this.now();
          if(nativeEPG){
            // Publication requires a capture at most 15 minutes old. The live
            // reader snapshot cannot be staged with a fabricated new timestamp.
            // This lease takes one fresh file with the EXISTING provider token.
            const capture=await wplayEPGSnapshot(source.client,{now:this.now,force:true});assertActive();
            if(capture.error||capture.stale||!capture.coverage||capture.coverage.invalidChannels||capture.coverage.invalidPrograms||!Number.isFinite(capture.fetchedAt)||capture.fetchedAt<this.now()-900000)throw failure('CACHE_EPG_SOURCE_UNAVAILABLE');
            fetchedAt=capture.fetchedAt;
            for(const channel_id of ids){
              const epgId=wplayEPGChannelID(source.client.rawItems.get('live:'+channel_id),channel_id);
              if(!capture.guides.has(epgId))throw failure('CACHE_EPG_COVERAGE_INCOMPLETE');
              channels.push({channel_id,payload:sanitizeSharedEPG({list:capture.guides.get(epgId)})});
            }
          }else await Promise.all([0,1].map(async()=>{for(;;){assertActive();const index=cursor++;if(index>=ids.length)return;const channel_id=ids[index],data=await source.client.epg(channel_id);assertActive();channels.push({channel_id,payload:sanitizeSharedEPG(data)});}}));
          channels.sort((a,b)=>a.channel_id.localeCompare(b.channel_id));
          assertActive();candidate=await this.cloud.rpc('arkhen_epg_snapshot_stage',{...lease,p_channels:channels,p_content_hash:createHash('sha256').update(JSON.stringify(channels)).digest('hex'),p_fetched_at:new Date(fetchedAt).toISOString()});assertActive();
        }
        if(candidate?.state==='sealed'){candidate=await this.cloud.rpc('arkhen_epg_snapshot_publish',lease);assertActive();}
        if(!['published','superseded'].includes(candidate?.state))throw failure('CACHE_EPG_PUBLICATION_INCOMPLETE');
      }else if(job.job_type==='games'){
        if(typeof source.client.games!=='function')throw failure('CACHE_GAMES_UNAVAILABLE');
        const options={date:job.payload?.date,timeZone:job.payload?.timeZone||job.payload?.time_zone||'America/Maceio',lang:job.payload?.lang||'pt'};
        const data=sanitizeSharedGames(await source.client.games(options),{mapImage:mapper});assertActive();
        await this.cloud.rpc('arkhen_publish_games',{...common,p_game_date:data.date,p_time_zone:data.timeZone,p_payload:data,p_expires_at:new Date(this.now()+60000).toISOString()});assertActive();
      }else throw failure('CACHE_JOB_INVALID');
      succeeded=true;this.status('ready',job);
    }catch(error){errorCode=safeError(error);this.status('error',job,errorCode);if(source&&(error?.status===401||error?.status===403||['ACCOUNT_INACTIVE','ACCOUNT_EXPIRED','CACHE_SOURCE_UNAVAILABLE'].includes(errorCode)))source.disabledUntil=this.now()+60000;}
    finally{
      context.lease=false;if(this.heartbeat!==null)this.cancel(this.heartbeat);this.heartbeat=null;
      try{await this.cloud.rpc('arkhen_finish_cache_job',{p_job_id:job.id,p_worker:this.workerId,p_success:succeeded,p_error_code:errorCode});}catch{/* A lost lease cannot release another worker's job. */}
    }
    return {idle:false,jobType:job.job_type,succeeded,...(errorCode?{errorCode}:{})};
  }
}

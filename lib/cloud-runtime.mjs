import {createHash} from 'node:crypto';
import {SharedCacheWorker,completeSharedCatalog} from './shared-cache-worker.mjs';
import {catalogReadLimiter,readCatalogSnapshot} from './catalog-snapshot-reader.mjs';
import {catalogSearchRequest,shortCatalogSearch} from './catalog-search-request.mjs';
import {ConectorSupabaseFilmes} from './filmes/conector-supabase.mjs';
import {PRIVATE_PROJECTION_TIMEOUT_MS} from './private-projection-budget.mjs';
import {ConectorTvSupabase} from './tv/conector-supabase.mjs';

const HASH=/^[a-f0-9]{64}$/i,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const code=error=>typeof error?.code==='string'&&/^[A-Z_]{1,80}$/.test(error.code)?error.code:'CLOUD_UNAVAILABLE';
const hash=value=>createHash('sha256').update(value).digest('hex');
const authQuery=/^(?:t|token|access_token|refresh_token|auth|authorization|password|passwd|username|user|key|api_key|apikey|secret|signature|sig|expires|expiry|session|jwt)$/i;

/** Server lifecycle adapter; createApp never reads live cloud configuration. */
export class CloudRuntime {
  constructor({cloud=null,worker,mapImage,now=()=>Date.now(),maxReadEntries=256,maxFallbackEntries=32}={}){
    this.cloud=cloud;this.now=now;this.images=new Map();this.reads=new Map();this.fallbacks=new Map();this.imageWarmups=new Map();this.imageWaiters=new Map();this.imageRequests=new Map();this.closed=false;
    this.maxReadEntries=Math.max(1,Math.min(512,maxReadEntries));this.maxFallbackEntries=Math.max(1,Math.min(64,maxFallbackEntries));
    this.tv=new ConectorTvSupabase({cloud,now,maxReadEntries:this.maxReadEntries,isEnabled:()=>this.enabled,isClosed:()=>this.closed,onStatus:status=>{this.epgStatus=status;}});
    this.filmes=new ConectorSupabaseFilmes({runtime:this});
    this.worker=worker??(cloud?new SharedCacheWorker({cloud,mapImage:(value,context)=>this.registerImage(value,context)}):null);
    this.ready=Promise.resolve(cloud?.ready).then(()=>Boolean(cloud?.enabled)).catch(error=>{this.configurationError=code(error);return false;});
  }
  get enabled(){return Boolean(this.cloud?.enabled&&!this.configurationError);}
  publicConfig(){return this.enabled?this.cloud.publicConfig():null;}
  fields(state){return {cloud:state.cloud||null,cloudStatus:state.cloudStatus||{state:this.enabled?'pending':'disabled',...(!this.enabled&&this.cloud?{code:this.configurationError||'CLOUD_NOT_CONFIGURED'}:{})}};}
  async refreshConfiguration(){
    await this.ready;
    if(this.enabled)return true;
    try{
      await this.cloud?.refreshConfiguration?.();
      if(this.cloud?.enabled){this.configurationError=null;return true;}
    }catch(error){this.configurationError=code(error);}
    return false;
  }
  async attach(state,session,client,generation=state.authGeneration){
    const startedEpoch=state.cloudEpoch||0,sameSession=()=>!this.closed&&state.client===client&&state.authGeneration===generation;
    if(!sameSession())return null;
    await this.refreshConfiguration();
    if(!sameSession()||(state.cloudEpoch||0)!==startedEpoch)return null;
    if(!this.enabled){state.cloudStatus={state:'disabled',code:this.configurationError||'CLOUD_NOT_CONFIGURED'};return null;}
    if(!['wplay','wplay-ott'].includes(client?.libraryProvider)){state.cloudStatus={state:'disabled',code:'CLOUD_PROVIDER_UNSUPPORTED'};return null;}
    const account=session?.account,validatedAt=Number(client.authenticatedAt),expiry=account?.expiresAt,status=String(account?.status||'').toLowerCase();
    const expired=Boolean(expiry&&(!Number.isFinite(Date.parse(expiry))||Date.parse(expiry)<=this.now()));
    if(!session?.connected||!client.session?.connected||!HASH.test(account?.libraryId||'')||status!=='active'||expired||!Number.isFinite(validatedAt)||validatedAt<=0||validatedAt>this.now()+60000||this.now()-validatedAt>86400000){
      const previous=state.cloud,pending=state.cloudPending;
      const denial=status&&status!=='active'||expired?{client,generation,libraryId:account?.libraryId||pending?.libraryId||previous?.libraryId,
        status:expired?'expired':'disabled',expiresAt:expiry&&Number.isFinite(Date.parse(expiry))?new Date(expiry).toISOString():null,validatedAt:this.now()}:null;
      if(denial){state.cloudDenial=denial;if(pending?.client===client)pending.denial=denial;}
      this.detach(state,client);state.cloudStatus={state:'unavailable',code:'CLOUD_PROVIDER_VALIDATION_REQUIRED'};
      // An explicit provider denial/expiry also closes RLS access for existing
      // JWTs. Local proof becoming old alone must not disable other devices.
      if(denial)await this.#applyCloudDenial(denial,previous);
      return null;
    }
    const denial=state.cloudDenial;
    if(denial?.client===client&&denial.generation===generation&&(!denial.libraryId||denial.libraryId===account.libraryId)){
      if(validatedAt<=denial.validatedAt){state.cloudStatus={state:'unavailable',code:'CLOUD_PROVIDER_VALIDATION_REQUIRED'};return null;}
      state.cloudDenial=null;
    }
    const validationKey=JSON.stringify([account.libraryId,expiry||null,validatedAt]);
    if(client.cloudCollection){this.worker?.unregisterSource(client);if(this.worker?.sources?.size===0)this.worker.stop();}
    if(state.cloudClient===client&&state.cloud&&state.cloud.libraryId!==account.libraryId)this.detach(state,client);
    // An account mismatch intentionally detaches first; this operation then
    // captures the new epoch rather than inheriting the cancelled one.
    const epoch=state.cloudEpoch||0,current=()=>sameSession()&&(state.cloudEpoch||0)===epoch;
    if(state.cloudClient===client && state.cloud && state.cloudExpiresAt>this.now()+60000){
      if(state.cloudValidationKey!==validationKey){
        try{await this.cloud.rpc('arkhen_validate_account',{p_user_id:state.cloud.userId,p_status:'active',p_expires_at:expiry||null,
          p_validated_at:new Date(validatedAt).toISOString(),p_provider_key:state.cloud.providerKey,p_scope_hash:state.cloud.scopeHash});}
        catch{if(current()){this.detach(state,client);state.cloudStatus={state:'unavailable',code:'CLOUD_REQUEST_FAILED'};}return null;}
        if(!current())return null;state.cloudValidationKey=validationKey;
      }
      return state.cloud;
    }
    if(state.cloudPending?.client===client&&state.cloudPending.epoch===epoch)return state.cloudPending.promise;
    const attachment={client,epoch,generation,libraryId:account.libraryId,validatedAt,denial:null,promise:null};
    state.cloudStatus={state:'pending'};
    const pending=(async()=>{
      try{
        const result=await this.cloud.bootstrap({session,client,provider:client.libraryProvider});
        if(!current()){
          void this.cloud.revoke(result.session?.access_token).catch(()=>{});
          // An initial bootstrap may learn the user ID only after a denial.
          // SQL ignores this older proof once the newer denial is persisted.
          if(attachment.denial)await this.#applyCloudDenial(attachment.denial,result);
          return null;
        }
        state.cloud={...result,provider:client.libraryProvider,libraryId:session.account.libraryId};state.cloudClient=client;
        state.cloudExpiresAt=Number(result.session?.expires_at)>0?result.session.expires_at*1000:this.now()+(Number(result.session?.expires_in)||3600)*1000;
        state.cloudStatus={state:'ready'};state.cloudValidationKey=validationKey;
        const source={session,client,provider:client.libraryProvider,providerKey:result.providerKey,scopeHash:result.scopeHash};
        if(!client.cloudCollection){this.worker?.registerSource(source);this.worker?.start();void this.worker?.tick().catch(()=>{});}
        else void this.cloud.kickCollector?.().catch(()=>{});
        return state.cloud;
      }catch(error){if(current()){state.cloud=null;state.cloudClient=null;state.cloudStatus={state:'unavailable',code:code(error),...(/^[a-z0-9_]{1,100}$/.test(error?.cloudStage||'')?{stage:error.cloudStage}:{}),...(Number.isInteger(error?.remoteStatus)?{remoteStatus:error.remoteStatus}:{})};}return null;}
    })();
    attachment.promise=pending;state.cloudPending=attachment;try{return await pending;}finally{if(state.cloudPending?.promise===pending)state.cloudPending=null;}
  }
  async #applyCloudDenial(denial,identity){
    if(!UUID.test(identity?.userId||'')||!HASH.test(identity?.providerKey||'')||!HASH.test(identity?.scopeHash||''))return;
    try{await this.cloud.rpc('arkhen_validate_account',{
      p_user_id:identity.userId,p_status:denial.status,p_expires_at:denial.expiresAt,
      p_validated_at:new Date(denial.validatedAt).toISOString(),p_provider_key:identity.providerKey,p_scope_hash:identity.scopeHash,
    });}catch{/* Local access and the late Auth session remain revoked. */}
  }
  /** Recover only the authenticated browser's rejected bootstrap. A failed UI
   * render must never turn this into a logout of another valid Auth session. */
  recoverSession(state,session,client,generation=state.authGeneration){
    if(this.closed||state.client!==client||state.authGeneration!==generation)return Promise.resolve(null);
    const account=session?.account,validatedAt=Number(client?.authenticatedAt),expiry=account?.expiresAt;
    if(!session?.connected||!client?.session?.connected||!HASH.test(account?.libraryId||'')||String(account?.status||'').toLowerCase()!=='active'||expiry&&(!Number.isFinite(Date.parse(expiry))||Date.parse(expiry)<=this.now())||!Number.isFinite(validatedAt)||validatedAt<=0||validatedAt>this.now()+60000||this.now()-validatedAt>86400000)return this.attach(state,session,client,generation);
    const cached=state.cloudRecovery;
    if(cached?.client===client&&cached.libraryId===account.libraryId&&cached.generation===generation&&(cached.pending||cached.expiresAt>this.now()))return cached.promise;
    const recovery={client,libraryId:account.libraryId,generation,pending:true,expiresAt:this.now()+30000,promise:null};state.cloudRecovery=recovery;
    state.cloudExpiresAt=0;
    recovery.promise=this.attach(state,session,client,generation).finally(()=>{recovery.pending=false;});return recovery.promise;
  }
  detach(state,client=state.client){
    state.cloudEpoch=(state.cloudEpoch||0)+1;
    this.worker?.unregisterSource(client);const token=state.cloud?.session?.access_token;
    state.cloud=null;state.cloudClient=null;state.cloudExpiresAt=0;state.cloudValidationKey=null;state.cloudPending=null;state.cloudRecovery=null;state.cloudStatus={state:'disabled'};
    if(token&&this.cloud)void this.cloud.revoke(token).catch(()=>{});
  }
  #imageKey(source,providerKey,scopeHash){
    const url=new URL(source);url.username='';url.password='';url.hash='';
    for(const key of [...url.searchParams.keys()])if(authQuery.test(key))url.searchParams.delete(key);
    url.searchParams.sort();return hash(JSON.stringify([providerKey,scopeHash,url.href]));
  }
  registerImage(value,{client,providerKey,scopeHash}={}){
    if(typeof value!=='string')return '';
    if(value.startsWith('/assets/')&&!value.includes('..')&&!/[?#]/.test(value))return value;
    if(/^\/api\/shared-image\/[a-f0-9]{64}$/.test(value))return value;
    if(/^\/api\/sports-image\/[a-f0-9]{64}$/.test(value))return value;
    if(!HASH.test(providerKey||'')||!HASH.test(scopeHash||''))return '';
    let source;try{const url=new URL(value,'http://localhost');if(url.pathname!=='/api/image')return '';source=client?.images?.get(url.searchParams.get('ref'));if(!source)return '';}catch{return '';}
    try{
      const ref=this.#imageKey(source,providerKey,scopeHash);this.images.set(ref,{source,headers:client.upstreamHeaders?.(source),providerKey,scopeHash});
      for(const resolve of this.imageWaiters.get(ref)||[])resolve();this.imageWaiters.delete(ref);
      while(this.images.size>50000)this.images.delete(this.images.keys().next().value);
      return '/api/shared-image/'+ref;
    }catch{return '';}
  }
  imageSource(state,ref){
    if(!HASH.test(ref||'')||!state.cloud)return null;
    const {providerKey,scopeHash}=state.cloud;
    let value=this.images.get(ref);
    if(!value){for(const [sessionRef]of state.client?.images||[]){this.registerImage('/api/image?ref='+encodeURIComponent(sessionRef),{client:state.client,providerKey,scopeHash});if(this.images.has(ref))break;}value=this.images.get(ref);}
    return value?.providerKey===providerKey&&value.scopeHash===scopeHash?value:null;
  }
  #imageContext(state){
    const account=state.cloud,client=state.client,generation=state.authGeneration,epoch=state.cloudEpoch||0;
    if(!account||!client||!HASH.test(account.providerKey||'')||!HASH.test(account.scopeHash||''))return null;
    const {provider,providerKey,scopeHash,userId,libraryId}=account;
    const current=()=>!this.closed&&state.client===client&&state.authGeneration===generation&&(state.cloudEpoch||0)===epoch&&client.session?.connected&&
      state.cloud?.provider===provider&&state.cloud?.providerKey===providerKey&&state.cloud?.scopeHash===scopeHash&&state.cloud?.userId===userId&&state.cloud?.libraryId===libraryId;
    return {client,providerKey,scopeHash,current};
  }
  #prune(map,limit){for(const [key,value]of map)if(value.expiresAt<=this.now())map.delete(key);while(map.size>limit)map.delete(map.keys().next().value);}
  #cachedRead(key){this.#prune(this.reads,this.maxReadEntries);return this.reads.get(key);}
  warmImages(source){
    if(!source?.client||typeof source.client.catalog!=='function')return Promise.resolve();
    const key=source.providerKey+':'+source.scopeHash,old=this.imageWarmups.get(key);
    const active=()=>!this.closed&&source.client.session?.connected&&(!this.worker?.sources||this.worker.sources.has(source.client));
    if(old&&!old.failed&&(old.done||old.active()))return old.promise;
    if(old?.failed&&old.client===source.client&&this.now()-old.started<30000)return old.promise;
    const entry={client:source.client,active,started:this.now(),done:false,failed:false,promise:null};
    const snapshot=data=>{for(const item of data?.items||[])for(const field of ['poster','posterOriginal','backdrop'])this.registerImage(item[field],source);};
    const assertActive=()=>{if(!active())throw new Error('Image source is no longer registered.');};
    entry.promise=Promise.all(['live','movies','series'].map(type=>completeSharedCatalog(source.client,type,{invalidate:false,assertActive,onSnapshot:snapshot}))).then(()=>{entry.done=true;},()=>{entry.failed=true;});
    this.imageWarmups.set(key,entry);return entry.promise;
  }
  async ensureImageSource(state,ref,{waitMs=20000}={}){
    const context=this.#imageContext(state);if(!context?.current()||!HASH.test(ref||''))return null;
    const immediate=this.imageSource(state,ref);if(immediate)return context.current()?immediate:null;
    const {providerKey,scopeHash,client,current}=context;
    const key=providerKey+':'+scopeHash+':'+ref;
    if(!this.imageRequests.has(key)){
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.min(waitMs,5000));timer.unref?.();
      const pending=(async()=>{
        try{
          const row=await this.#artworkReference(state,ref,{timeoutMs:Math.min(waitMs,5000)});
          if(!current()||controller.signal.aborted||!row||!['live','movies','series'].includes(row.media_type)||!/^[A-Za-z0-9_-]{1,160}$/.test(row.media_id||'')||typeof client?.artworkMetadata!=='function')return;
          const details=await client.artworkMetadata(row.media_type==='movies'?'movie':row.media_type,row.media_id,{signal:controller.signal});
          if(!current()||controller.signal.aborted)return;
          for(const field of ['poster','backdrop','posterOriginal'])this.registerImage(details?.[field],{client,providerKey,scopeHash});
        }catch{/* Missing artwork never triggers a full provider catalog download. */}
        finally{clearTimeout(timer);}
      })();
      this.imageRequests.set(key,pending);void pending.finally(()=>{if(this.imageRequests.get(key)===pending)this.imageRequests.delete(key);});
    }
    const warm=this.imageRequests.get(key),manual=this.imageWarmups.get(providerKey+':'+scopeHash)?.promise;
    let resolveWait,timer;const wait=new Promise(resolve=>{resolveWait=resolve;timer=setTimeout(resolve,waitMs);timer.unref?.();});
    if(!this.imageWaiters.has(ref))this.imageWaiters.set(ref,new Set());this.imageWaiters.get(ref).add(resolveWait);
    try{await Promise.race([manual?Promise.all([warm,manual]):warm,wait]);return current()?this.imageSource(state,ref):null;}
    finally{clearTimeout(timer);this.imageWaiters.get(ref)?.delete(resolveWait);if(!this.imageWaiters.get(ref)?.size)this.imageWaiters.delete(ref);}
  }
  async cloudArtwork(state,ref,{source,timeoutMs=source?20000:1500}={}){
    const context=this.#imageContext(state);
    if(!context?.current()||!HASH.test(ref||'')||typeof this.cloud?.artwork!=='function')return null;
    const {providerKey,scopeHash,current}=context,key=JSON.stringify(['cloud-artwork',providerKey,scopeHash,ref]),cached=this.#cachedRead(key);
    const budget=Number.isFinite(timeoutMs)&&timeoutMs>0?Math.min(20000,timeoutMs):source?20000:1500;
    let entry=cached?.expiresAt>this.now()&&(!source||cached.writing)?cached:null;
    if(!entry){
      entry={expiresAt:Infinity,promise:null,writing:Boolean(source)};
      const finish=value=>{
        entry.expiresAt=this.now()+(value?60000:5000);
        if(!current()){if(this.reads.get(key)===entry)this.reads.delete(key);return null;}
        return value;
      };
      let request;
      try{request=this.cloud.artwork({providerKey,scopeHash,ref,...(source?{source}:{})},{timeoutMs:budget});}
      catch{request=Promise.resolve(null);}
      entry.promise=Promise.resolve(request).then(finish,()=>finish(null)).finally(()=>{entry.writing=false;});
      this.reads.set(key,entry);this.#prune(this.reads,this.maxReadEntries);
    }
    // A read joining a background upload keeps its own short budget instead of
    // making the browser wait for the uploader's longer transport deadline.
    let timer;
    try{
      const value=await Promise.race([entry.promise,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),budget);timer.unref?.();})]);
      return current()?value:null;
    }finally{clearTimeout(timer);}
  }
  async isSportsLogoReference(state,ref){
    if(!state.cloud||!this.enabled||!HASH.test(ref||''))return false;
    const {providerKey,scopeHash}=state.cloud,key=JSON.stringify(['sports-logo-refs',providerKey,scopeHash]),cached=this.#cachedRead(key);
    let pending=cached?.expiresAt>this.now()?cached.promise:null;
    if(!pending){
      const params=new URLSearchParams({select:'payload',provider_key:'eq.'+providerKey,scope_hash:'eq.'+scopeHash,order:'updated_at.desc',limit:'8'});
      pending=this.#userRequest(state,'/rest/v1/provider_games_cache?'+params).then(rows=>{
        const refs=new Set();for(const row of Array.isArray(rows)?rows:[])for(const game of Array.isArray(row?.payload?.games)?row.payload.games:[])for(const field of ['league','homeTeam','awayTeam']){
          const match=/^\/api\/(?:sports|shared)-image\/([a-f0-9]{64})$/.exec(game?.[field]?.logo||'');if(match)refs.add(match[1]);
        }return refs;
      }).catch(()=>new Set());
      this.reads.set(key,{expiresAt:this.now()+45000,promise:pending});this.#prune(this.reads,this.maxReadEntries);
    }
    return (await pending).has(ref);
  }
  async #userRequest(state,path,options={}){
    if(!state.cloud||!this.enabled)return null;
    try{return await this.cloud.request(path,{...options,publicKey:true,accessToken:state.cloud.session.access_token});}
    catch(error){
      if(error?.remoteStatus!==401)throw error;
      const previous=state.cloud,client=state.client;if(!client)return null;
      state.cloudExpiresAt=0;
      const session={...await client.connect(),account:{...client.session.account,libraryId:previous.libraryId}};
      if(!await this.attach(state,session,client))return null;
      return this.cloud.request(path,{...options,publicKey:true,accessToken:state.cloud.session.access_token});
    }
  }
  async markerSyncStatus(state){
    if(!state.cloud||!this.enabled||typeof state.cloud.session?.access_token!=='string'||!state.cloud.session.access_token)return null;
    const {providerKey,scopeHash}=state.cloud;
    if(!HASH.test(providerKey||'')||!HASH.test(scopeHash||''))return null;
    const result=await this.#userRequest(state,'/rest/v1/rpc/arkhen_marker_sync_status',{
      method:'POST',body:{p_provider_key:providerKey,p_scope_hash:scopeHash},timeoutMs:15000,
    });
    return result?.schemaVersion===1&&Array.isArray(result.providers)&&Array.isArray(result.recent)?result:null;
  }
  async searchCatalog(state,request,{signal}={}){
    const input=catalogSearchRequest(request);
    if(Array.from(input.query).length<3)return shortCatalogSearch(input.query);
    if(!this.enabled||!state.cloud?.session?.access_token)return null;
    const {providerKey,scopeHash}=state.cloud;
    if(!HASH.test(providerKey||'')||!HASH.test(scopeHash||''))return null;
    // Searching must not join a blocking Auth/bootstrap recovery. A rejected
    // indexed read can use the active session's already loaded snapshots.
    const account=state.cloud;
    const result=await this.cloud.request('/rest/v1/rpc/arkhen_global_search',{
      method:'POST',body:{p_provider_key:providerKey,p_scope_hash:scopeHash,p_query:input.query,p_media_type:input.type,
        p_offset:input.offset,p_limit:input.limit,p_hidden_categories:input.hidden,p_hidden_items:input.hiddenItems,p_include_adult:state.parental?.unlocked===true},
      publicKey:true,accessToken:account.session.access_token,timeoutMs:3000,...(signal?{signal}:{}),
    });
    return result?.schemaVersion===1&&result.query===input.query&&Array.isArray(result.items)&&result.counts&&Number.isSafeInteger(result.total)&&result.total>=0?result:null;
  }
  async catalogReadModel(state,type,{signal}={}){
    if(!['live','movies','series'].includes(type)||!this.enabled||!state.cloud?.session?.access_token)return null;
    const account=state.cloud,{providerKey,scopeHash}=account;
    if(!HASH.test(providerKey||'')||!HASH.test(scopeHash||''))return null;
    const result=await this.cloud.request('/rest/v1/rpc/arkhen_catalog_read_model',{
      method:'POST',body:{p_provider_key:providerKey,p_scope_hash:scopeHash,p_media_type:type,p_include_adult:state.parental?.unlocked===true},
      publicKey:true,accessToken:account.session.access_token,timeoutMs:3000,...(signal?{signal}:{}),
    });
    if(state.cloud!==account||signal?.aborted)return null;
    return result?.schemaVersion===1?result:null;
  }
  async homeLibrary(state,request={}, {signal}={}){
    const input=catalogSearchRequest({query:'home',hidden:request.hidden,hiddenItems:request.hiddenItems});
    const started=this.now();
    const report=(phase,code,error)=>{
      const safe=value=>typeof value==='string'&&/^[A-Za-z0-9_]{1,80}$/.test(value)?value:undefined;
      const diagnostic={phase,code,elapsedMs:Math.max(0,this.now()-started),...(safe(error?.code)?{transportCode:safe(error.code)}:{}),...(safe(error?.remoteCode)?{remoteCode:safe(error.remoteCode)}:{}),...(Number.isInteger(error?.remoteStatus)?{remoteStatus:error.remoteStatus}:{})};
      this.homeStatus=diagnostic;
      const key=JSON.stringify([phase,code,diagnostic.transportCode,diagnostic.remoteCode,diagnostic.remoteStatus]);
      if(this.homeLogKey!==key||this.now()-(this.homeLogAt||0)>=30000){this.homeLogKey=key;this.homeLogAt=this.now();console.warn('[home-library]',JSON.stringify(diagnostic));}
    };
    if(!this.enabled||!state.cloud?.session?.access_token){report('precondition',this.enabled?'CLOUD_SESSION_MISSING':'CLOUD_DISABLED');return null;}
    const account=state.cloud,{providerKey,scopeHash}=account;
    if(!HASH.test(providerKey||'')||!HASH.test(scopeHash||'')){report('precondition','PARTITION_INVALID');return null;}
    let result;
    try{result=await this.cloud.request('/rest/v1/rpc/arkhen_home_library',{
      method:'POST',body:{p_provider_key:providerKey,p_scope_hash:scopeHash,p_include_adult:state.parental?.unlocked===true,p_hidden_categories:input.hidden,p_hidden_items:input.hiddenItems},
      publicKey:true,accessToken:account.session.access_token,timeoutMs:PRIVATE_PROJECTION_TIMEOUT_MS,...(signal?{signal}:{}),
    });}catch(error){if(!signal?.aborted)report('rpc','RPC_REQUEST_FAILED',error);throw error;}
    if(state.cloud!==account||signal?.aborted)return null;
    const valid=result?.schemaVersion===1&&result.counts&&result.history&&Array.isArray(result.favoriteChannels)&&Array.isArray(result.recommendations?.items);
    if(!valid)report('rpc',result===null?'RPC_RETURNED_NULL':'RPC_DTO_INVALID');
    return valid?result:null;
  }
  movieRecommendations(state,request={},options={}){return this.filmes.recommendations(state,request,options);}
  async catalogPage(state,type,{category=null,page=1,cursor=-1,snapshotId=null,includeAdult=false,fresh=false,limit=120}={}){
    if(!state.cloud||!this.enabled||!['live','movies','series'].includes(type))return null;
    if(category==='__all')category=null;
    if(category!==null&&!/^[A-Za-z0-9_-]{1,160}$/.test(category)||!Number.isSafeInteger(page)||page<1||page>100000||!Number.isSafeInteger(cursor)||cursor< -1||cursor>1000000000||snapshotId!==null&&!UUID.test(snapshotId)||!Number.isSafeInteger(limit)||limit<1||limit>240)return null;
    const {providerKey,scopeHash}=state.cloud;
    const args={p_provider_key:providerKey,p_scope_hash:scopeHash,p_media_type:type,p_category:category,p_page:page,p_after:cursor,p_limit:limit,p_snapshot:snapshotId,p_include_adult:includeAdult===true};
    const key=JSON.stringify(['catalog-page',args]),cached=this.#cachedRead(key);
    if(!fresh&&cached?.expiresAt>this.now())return cached.promise;
    const pending=this.#userRequest(state,'/rest/v1/rpc/arkhen_catalog_page',{method:'POST',body:args}).then(result=>{
      if(!Array.isArray(result?.items)||!Array.isArray(result?.categories)||result?.pagination?.source!=='supabase')return null;
      if(Date.parse(result.pagination.expiresAt)<=this.now())void this.refresh(state,'catalog',{media_type:type});
      return result;
    }).catch(()=>null);
    this.reads.set(key,{expiresAt:this.now()+5000,promise:pending});this.#prune(this.reads,this.maxReadEntries);
    return pending;
  }
  async parentalCatalogItem(state,kind,id){
    const type=kind==='movie'?'movies':kind;
    if(!state.cloud||!this.enabled||!['live','movies','series'].includes(type)||!/^[A-Za-z0-9_-]{1,160}$/.test(String(id)))return null;
    const {providerKey,scopeHash}=state.cloud,key=JSON.stringify(['catalog-item',providerKey,scopeHash,type,String(id)]),cached=this.#cachedRead(key);
    if(cached?.expiresAt>this.now())return cached.promise;
    const params=new URLSearchParams({select:'metadata,is_adult',provider_key:'eq.'+providerKey,scope_hash:'eq.'+scopeHash,media_type:'eq.'+type,media_id:'eq.'+id,is_active:'eq.true',limit:'1'});
    const pending=this.#userRequest(state,'/rest/v1/catalog_media?'+params).then(rows=>{
      const row=Array.isArray(rows)?rows[0]:null;
      return row&&row.metadata&&typeof row.metadata==='object'?{categories:[],items:[{...row.metadata,isAdult:row.is_adult===true}]}:null;
    }).catch(()=>null);
    this.reads.set(key,{expiresAt:this.now()+5000,promise:pending});this.#prune(this.reads,this.maxReadEntries);
    return pending;
  }
  async #artworkReference(state,ref,{timeoutMs=5000}={}){
    if(!state.cloud||!this.enabled||!HASH.test(ref||''))return null;
    const {providerKey,scopeHash}=state.cloud,key=JSON.stringify(['artwork-ref',providerKey,scopeHash,ref]),cached=this.#cachedRead(key);
    if(cached?.expiresAt>this.now())return cached.promise;
    const params=new URLSearchParams({select:'media_type,media_id,field',provider_key:'eq.'+providerKey,scope_hash:'eq.'+scopeHash,ref:'eq.'+ref,limit:'1'});
    const pending=this.#userRequest(state,'/rest/v1/catalog_artwork_refs?'+params,{timeoutMs}).then(rows=>Array.isArray(rows)?rows[0]||null:null).catch(()=>null);
    this.reads.set(key,{expiresAt:this.now()+5000,promise:pending});this.#prune(this.reads,this.maxReadEntries);return pending;
  }
  async parentalArtworkItem(state,ref){
    const row=await this.#artworkReference(state,ref);if(!row||!['live','movies','series'].includes(row.media_type))return null;
    const kind=row.media_type==='movies'?'movie':row.media_type,catalog=await this.parentalCatalogItem(state,kind,row.media_id);
    return catalog?{kind,id:row.media_id,catalog}:null;
  }
  async #read(state,table,filters,{complete=false,fresh=false}={}){
    if(!state.cloud||!this.enabled)return null;
    if(complete)return this.#readCompleteCatalog(state,filters.media_type?.slice(3),{fresh});
    const {providerKey,scopeHash}=state.cloud;
    if(!HASH.test(providerKey||'')||!HASH.test(scopeHash||''))return null;
    const key=JSON.stringify([table,providerKey,scopeHash,filters]),cached=this.#cachedRead(key);
    if(!fresh&&cached?.expiresAt>this.now())return cached.promise;
    const parameters=new URLSearchParams({select:'payload,expires_at',provider_key:'eq.'+providerKey,scope_hash:'eq.'+scopeHash,...filters,limit:'1'});
    const pending=(async()=>{
      try{
        let rows;
        try{rows=await this.cloud.request('/rest/v1/'+table+'?'+parameters,{publicKey:true,accessToken:state.cloud.session.access_token});}
        catch(error){
          if(error?.remoteStatus!==401)throw error;
          state.cloudExpiresAt=0;
          const client=state.client,session={...await client.connect(),account:{...client.session.account,libraryId:state.cloud.libraryId}};
          if(!await this.attach(state,session,client))return null;
          rows=await this.cloud.request('/rest/v1/'+table+'?'+parameters,{publicKey:true,accessToken:state.cloud.session.access_token});
        }
        const row=Array.isArray(rows)?rows[0]:null;
        if(!row||!row.payload||typeof row.payload!=='object')return null;
        if(!Number.isFinite(Date.parse(row.expires_at))||Date.parse(row.expires_at)<=this.now())return null;
        return row.payload;
      }catch{return null;}
    })();
    this.reads.set(key,{expiresAt:this.now()+5000,promise:pending});this.#prune(this.reads,this.maxReadEntries);
    return pending;
  }
  async #readCompleteCatalog(state,type,{fresh=false,recoverFlight=true}={}){
    const account=state.cloud,{providerKey,scopeHash}=account,generation=state.authGeneration;
    const current=()=>!this.closed&&state.authGeneration===generation&&state.cloud?.providerKey===providerKey&&state.cloud?.scopeHash===scopeHash&&state.cloud?.userId===account.userId&&state.cloud?.libraryId===account.libraryId;
    if(!HASH.test(providerKey||'')||!HASH.test(scopeHash||'')||!['live','movies','series'].includes(type)||!account.session?.access_token)return null;
    const key=JSON.stringify(['complete-catalog',providerKey,scopeHash,type]),previous=this.reads.get(key);
    if(previous?.inFlight||!fresh&&previous?.expiresAt>this.now()){
      const sharedFlight=previous.inFlight;
      const value=await previous.promise;if(!current())return null;
      // Another viewer can leave while owning the shared in-flight transport.
      // A still-authorized waiter gets one independent attempt, never a loop.
      if(!value&&sharedFlight&&recoverFlight)return this.#readCompleteCatalog(state,type,{fresh:true,recoverFlight:false});
      return value;
    }
    const entry={inFlight:true,expiresAt:Infinity,promise:null,data:null};
    this.catalogSnapshotLimiter||=catalogReadLimiter(2);
    entry.promise=(async()=>{
      try{
        const data=await readCatalogSnapshot({providerKey,scopeHash,type,current,limitRead:this.catalogSnapshotLimiter,read:path=>this.#userRequest(state,path)});
        if(!current())throw new Error('Catalog reader account changed');
        if(!data)throw new Error('Incomplete catalog snapshot');
        entry.data=data;
        if(Date.parse(data.pagination.expiresAt)<=this.now())void this.refresh(state,'catalog',{media_type:type});
        return data;
      }catch{
        if(this.reads.get(key)===entry){if(previous?.data)this.reads.set(key,previous);else this.reads.delete(key);}
        return null;
      }finally{entry.inFlight=false;entry.expiresAt=this.now()+5000;}
    })();
    this.reads.set(key,entry);this.#prune(this.reads,this.maxReadEntries);return entry.promise;
  }
  catalog(state,type,{fresh=false}={}){return this.#read(state,'provider_catalog_cache',{media_type:'eq.'+type},{complete:true,fresh});}
  epg(state,id){
    return this.tv.epg(state,id);
  }
  tvGuide(state,{ids=null,includeAdult=false,timeZone='America/Maceio',fresh=false}={}){
    return this.tv.guide(state,{ids,includeAdult,timeZone,fresh});
  }
  games(state,options){return this.#read(state,'provider_games_cache',{game_date:'eq.'+options.date,time_zone:'eq.'+options.timeZone});}
  async fallback(state,kind,identity,load){
    if(kind==='catalog'&&identity[0]!=='live'&&state.client?.cloudCollection)return {categories:[],items:[],catalogComplete:false,preparing:true,pagination:{mode:'category',source:'preparing',byCategory:{}}};
    if(!state.cloud)return load(state.client);
    this.#prune(this.fallbacks,this.maxFallbackEntries);
    const {providerKey,scopeHash}=state.cloud,key=JSON.stringify([providerKey,scopeHash,kind,identity]),cached=this.fallbacks.get(key);
    if(cached?.expiresAt>this.now())return cached.promise;
    const candidates=[...this.worker?.sources?.values?.()||[]];
    const source=candidates.find(value=>value.providerKey===providerKey&&value.scopeHash===scopeHash&&this.worker.sourceActive(value));
    const client=source?.client||state.client;
    const pending=Promise.resolve().then(()=>load(client)).then(data=>{
      const art=value=>this.registerImage(value,{client,providerKey,scopeHash});
      if(kind==='catalog'&&Array.isArray(data?.items))return {...data,items:data.items.map(item=>({...item,poster:art(item.poster),backdrop:art(item.backdrop),...(item.posterOriginal?{posterOriginal:art(item.posterOriginal)}:{})}))};
      if(kind==='games'&&Array.isArray(data?.games))return {...data,games:data.games.map(game=>({...game,...Object.fromEntries(['league','homeTeam','awayTeam'].filter(field=>game[field]).map(field=>[field,{...game[field],logo:art(game[field].logo)}]))}))};
      return data;
    }).catch(error=>{if(this.fallbacks.get(key)?.promise===pending)this.fallbacks.delete(key);throw error;}).finally(()=>{
      // Native category pages are cumulative snapshots. Keeping a remapped copy
      // for every resolved page retains the whole catalog quadratically.
      if(kind==='catalog'&&this.fallbacks.get(key)?.promise===pending)this.fallbacks.delete(key);
    });
    this.fallbacks.set(key,{expiresAt:this.now()+(kind==='catalog'?60000:30000),promise:pending});this.#prune(this.fallbacks,this.maxFallbackEntries);
    return pending;
  }
  async refresh(state,jobType,payload={}){
    if(!state.cloud||!this.enabled)return;
    const {providerKey,scopeHash}=state.cloud;
    try{await this.cloud.rpc('arkhen_request_cache_refresh',{p_provider_key:providerKey,p_scope_hash:scopeHash,p_job_type:jobType,p_payload:payload});}
    catch{try{await this.cloud.rpc('arkhen_enqueue_source_jobs',{p_provider_key:providerKey,p_scope_hash:scopeHash});}catch{}}
    if(jobType==='epg'){
      // Scheduling a live refresh must not evict a current guide or unrelated
      // catalog reads, nor discard another viewer's in-flight provider request.
      this.tv.invalidate(providerKey,scopeHash);
    }else{this.reads.clear();this.fallbacks.clear();}
    if(state.client?.cloudCollection)void this.cloud.kickCollector?.().catch(()=>{});else void this.worker?.tick().catch(()=>{});
  }
  close(){this.closed=true;this.worker?.stop();this.tv.close();this.filmes.close();for(const resolvers of this.imageWaiters.values())for(const resolve of resolvers)resolve();this.imageWaiters.clear();this.imageWarmups.clear();this.imageRequests.clear();this.images.clear();this.reads.clear();this.fallbacks.clear();}
}

import {createHash} from 'node:crypto';
import {SharedCacheWorker,completeSharedCatalog} from './shared-cache-worker.mjs';

const HASH=/^[a-f0-9]{64}$/i;
const code=error=>typeof error?.code==='string'&&/^[A-Z_]{1,80}$/.test(error.code)?error.code:'CLOUD_UNAVAILABLE';
const hash=value=>createHash('sha256').update(value).digest('hex');
const authQuery=/^(?:t|token|access_token|refresh_token|auth|authorization|password|passwd|username|user|key|api_key|apikey|secret|signature|sig|expires|expiry|session|jwt)$/i;

/** Server lifecycle adapter; createApp never reads live cloud configuration. */
export class CloudRuntime {
  constructor({cloud=null,worker,mapImage,now=()=>Date.now()}={}){
    this.cloud=cloud;this.now=now;this.images=new Map();this.reads=new Map();this.fallbacks=new Map();this.imageWarmups=new Map();this.imageWaiters=new Map();this.closed=false;
    this.worker=worker??(cloud?new SharedCacheWorker({cloud,mapImage:(value,context)=>this.registerImage(value,context)}):null);
    this.ready=Promise.resolve(cloud?.ready).then(()=>Boolean(cloud?.enabled)).catch(error=>{this.configurationError=code(error);return false;});
  }
  get enabled(){return Boolean(this.cloud?.enabled&&!this.configurationError);}
  publicConfig(){return this.enabled?this.cloud.publicConfig():null;}
  fields(state){return {cloud:state.cloud||null,cloudStatus:state.cloudStatus||{state:this.enabled?'pending':'disabled',...(this.configurationError?{code:this.configurationError}:{})}};}
  async attach(state,session,client,generation=state.authGeneration){
    await this.ready;
    if(!this.enabled){state.cloudStatus={state:'disabled',...(this.configurationError?{code:this.configurationError}:{})};return null;}
    if(!['wplay','wplay-ott'].includes(client?.libraryProvider)){state.cloudStatus={state:'disabled',code:'CLOUD_PROVIDER_UNSUPPORTED'};return null;}
    const current=()=>!this.closed&&state.client===client&&state.authGeneration===generation;
    if(!current())return null;
    const account=session?.account,validatedAt=Number(client.authenticatedAt),expiry=account?.expiresAt,status=String(account?.status||'').toLowerCase();
    const expired=Boolean(expiry&&(!Number.isFinite(Date.parse(expiry))||Date.parse(expiry)<=this.now()));
    if(!session?.connected||!client.session?.connected||!HASH.test(account?.libraryId||'')||status!=='active'||expired||!Number.isFinite(validatedAt)||validatedAt<=0||validatedAt>this.now()+60000||this.now()-validatedAt>86400000){
      const previous=state.cloud;this.detach(state,client);state.cloudStatus={state:'unavailable',code:'CLOUD_PROVIDER_VALIDATION_REQUIRED'};
      // An explicit provider denial/expiry also closes RLS access for existing
      // JWTs. Local proof becoming old alone must not disable other devices.
      if(previous?.userId&&(status&&status!=='active'||expired))try{await this.cloud.rpc('arkhen_validate_account',{
        p_user_id:previous.userId,p_status:expired?'expired':'disabled',p_expires_at:expiry&&Number.isFinite(Date.parse(expiry))?new Date(expiry).toISOString():null,
        p_validated_at:new Date(this.now()).toISOString(),p_provider_key:previous.providerKey,p_scope_hash:previous.scopeHash,
      });}catch{/* The local source and session have already been revoked. */}
      return null;
    }
    const validationKey=JSON.stringify([account.libraryId,expiry||null,validatedAt]);
    if(state.cloudClient===client&&state.cloud&&state.cloud.libraryId!==account.libraryId)this.detach(state,client);
    if(state.cloudClient===client && state.cloud && state.cloudExpiresAt>this.now()+60000){
      if(state.cloudValidationKey!==validationKey){
        try{await this.cloud.rpc('arkhen_validate_account',{p_user_id:state.cloud.userId,p_status:'active',p_expires_at:expiry||null,
          p_validated_at:new Date(validatedAt).toISOString(),p_provider_key:state.cloud.providerKey,p_scope_hash:state.cloud.scopeHash});}
        catch{if(current()){this.detach(state,client);state.cloudStatus={state:'unavailable',code:'CLOUD_REQUEST_FAILED'};}return null;}
        if(!current())return null;state.cloudValidationKey=validationKey;
      }
      return state.cloud;
    }
    if(state.cloudPending?.client===client)return state.cloudPending.promise;
    const pending=(async()=>{
      try{
        const result=await this.cloud.bootstrap({session,client,provider:client.libraryProvider});
        if(!current()){void this.cloud.revoke(result.session?.access_token).catch(()=>{});return null;}
        state.cloud={...result,provider:client.libraryProvider,libraryId:session.account.libraryId};state.cloudClient=client;
        state.cloudExpiresAt=Number(result.session?.expires_at)>0?result.session.expires_at*1000:this.now()+(Number(result.session?.expires_in)||3600)*1000;
        state.cloudStatus={state:'ready'};state.cloudValidationKey=validationKey;
        const source={session,client,provider:client.libraryProvider,providerKey:result.providerKey,scopeHash:result.scopeHash};
        this.worker?.registerSource(source);void this.warmImages(source);
        this.worker?.start();void this.worker?.tick().catch(()=>{});
        return state.cloud;
      }catch(error){if(current()){state.cloud=null;state.cloudClient=null;state.cloudStatus={state:'unavailable',code:code(error)};}return null;}
    })();
    state.cloudPending={client,promise:pending};try{return await pending;}finally{if(state.cloudPending?.promise===pending)state.cloudPending=null;}
  }
  detach(state,client=state.client){
    this.worker?.unregisterSource(client);const token=state.cloud?.session?.access_token;
    state.cloud=null;state.cloudClient=null;state.cloudExpiresAt=0;state.cloudValidationKey=null;state.cloudPending=null;state.cloudStatus={state:'disabled'};
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
    const immediate=this.imageSource(state,ref);if(immediate||!HASH.test(ref||'')||!state.cloud)return immediate;
    const {providerKey,scopeHash}=state.cloud,candidates=[...this.worker?.sources?.values?.()||[]];
    const source=candidates.find(value=>value.providerKey===providerKey&&value.scopeHash===scopeHash&&this.worker.sourceActive(value));
    const warm=source?this.warmImages(source):this.imageWarmups.get(providerKey+':'+scopeHash)?.promise;
    if(!warm)return null;
    let resolveWait,timer;const wait=new Promise(resolve=>{resolveWait=resolve;timer=setTimeout(resolve,waitMs);timer.unref?.();});
    if(!this.imageWaiters.has(ref))this.imageWaiters.set(ref,new Set());this.imageWaiters.get(ref).add(resolveWait);
    try{await Promise.race([warm,wait]);return this.imageSource(state,ref);}
    finally{clearTimeout(timer);this.imageWaiters.get(ref)?.delete(resolveWait);if(!this.imageWaiters.get(ref)?.size)this.imageWaiters.delete(ref);}
  }
  async #read(state,table,filters,{complete=false,fresh=false}={}){
    if(!state.cloud||!this.enabled)return null;
    const {providerKey,scopeHash}=state.cloud;
    if(!HASH.test(providerKey||'')||!HASH.test(scopeHash||''))return null;
    const key=JSON.stringify([table,providerKey,scopeHash,filters]),cached=this.reads.get(key);
    if(!fresh&&cached?.expiresAt>this.now())return cached.promise;
    const parameters=new URLSearchParams({select:'payload,expires_at'+(complete?',is_complete':''),provider_key:'eq.'+providerKey,scope_hash:'eq.'+scopeHash,...filters,limit:'1'});
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
        if(!row||complete&&row.is_complete!==true||!row.payload||typeof row.payload!=='object')return null;
        if(!Number.isFinite(Date.parse(row.expires_at))||Date.parse(row.expires_at)<=this.now()){
          if(!complete)return null;
          void this.refresh(state,'catalog',{media_type:filters.media_type?.slice(3)});
        }
        return row.payload;
      }catch{return null;}
    })();
    this.reads.set(key,{expiresAt:this.now()+5000,promise:pending});while(this.reads.size>10000)this.reads.delete(this.reads.keys().next().value);
    return pending;
  }
  catalog(state,type,{fresh=false}={}){return this.#read(state,'provider_catalog_cache',{media_type:'eq.'+type},{complete:true,fresh});}
  epg(state,id){return this.#read(state,'provider_epg_cache',{channel_id:'eq.'+id});}
  games(state,options){return this.#read(state,'provider_games_cache',{game_date:'eq.'+options.date,time_zone:'eq.'+options.timeZone});}
  async fallback(state,kind,identity,load){
    if(!state.cloud)return load(state.client);
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
    }).catch(error=>{if(this.fallbacks.get(key)?.promise===pending)this.fallbacks.delete(key);throw error;});
    this.fallbacks.set(key,{expiresAt:this.now()+(kind==='catalog'?60000:30000),promise:pending});while(this.fallbacks.size>10000)this.fallbacks.delete(this.fallbacks.keys().next().value);
    return pending;
  }
  async refresh(state,jobType,payload={}){
    if(!state.cloud||!this.enabled)return;
    try{await this.cloud.rpc('arkhen_request_cache_refresh',{p_provider_key:state.cloud.providerKey,p_scope_hash:state.cloud.scopeHash,p_job_type:jobType,p_payload:payload});}
    catch{try{await this.cloud.rpc('arkhen_enqueue_source_jobs',{p_provider_key:state.cloud.providerKey,p_scope_hash:state.cloud.scopeHash});}catch{}}
    this.reads.clear();this.fallbacks.clear();void this.worker?.tick().catch(()=>{});
  }
  close(){this.closed=true;this.worker?.stop();for(const resolvers of this.imageWaiters.values())for(const resolve of resolvers)resolve();this.imageWaiters.clear();this.imageWarmups.clear();this.images.clear();this.reads.clear();this.fallbacks.clear();}
}

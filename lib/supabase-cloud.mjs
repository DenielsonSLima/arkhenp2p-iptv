import {readFile} from 'node:fs/promises';
import {runtimeSessionContext} from './runtime-session-context.mjs';
import {resolve} from 'node:path';
import {createHash,createHmac,randomBytes} from 'node:crypto';

export const ARKHEN_SUPABASE_PROJECT = 'wnicimkmzswksaqdtgdv';
const HASH=/^[a-f0-9]{64}$/i,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const sha=value=>createHash('sha256').update(value).digest('hex');
const message='Não foi possível conectar sua biblioteca na nuvem. Tente novamente.';
export class SupabaseCloudError extends Error {
  constructor(code='CLOUD_UNAVAILABLE',status=502){super(message);this.name='SupabaseCloudError';this.code=code;this.status=status;}
}
const jwtRole=key=>{try{return JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString()).role;}catch{return null;}};
const validKey=(key,role)=>typeof key==='string' && key.length>=20 && key.length<=8192 && !/[\s\r\n]/.test(key) &&
  (key.startsWith(role==='anon'?'sb_publishable_':'sb_secret_') || key.split('.').length===3 && jwtRole(key)===role);
// Gateway provider errors can include an upstream denial hidden behind 502.
// Only the separate cloud transport may authorize a direct provider attempt.
const providerAuthenticationTransportFailure=error=>{
  if(error?.name==='AbortError'||[401,403].includes(error?.remoteStatus))return false;
  if(['CLOUD_TIMEOUT','CLOUD_UNAVAILABLE'].includes(error?.code))return true;
  return error?.remoteStatus>=500&&error.remoteStatus<=599&&
    !/^GATEWAY_PROVIDER_/.test(error.remoteCode||'')&&
    !['GATEWAY_NOT_CONFIGURED','GATEWAY_RESPONSE_INVALID','GATEWAY_IDENTITY_MISMATCH'].includes(error.remoteCode);
};

export function normalizeCloudConfig(value,{expectedProjectRef=ARKHEN_SUPABASE_PROJECT}={}){
  if(!value || typeof value!=='object' || Array.isArray(value))throw new SupabaseCloudError('CLOUD_CONFIG_INVALID');
  let url;try{url=new URL(value.url);}catch{throw new SupabaseCloudError('CLOUD_CONFIG_INVALID');}
  if(url.origin!==`https://${expectedProjectRef}.supabase.co` || !['','/'].includes(url.pathname) || url.search || url.hash || url.username || url.password)
    throw new SupabaseCloudError('CLOUD_PROJECT_MISMATCH');
  const publishableKey=value.publishableKey??value.anonKey,secretKey=value.secretKey??value.serviceRoleKey;
  if(!validKey(publishableKey,'anon'))throw new SupabaseCloudError('CLOUD_CONFIG_INVALID');
  if(value.gateway!==undefined){
    const gateway=value.gateway,gatewayURL=url.origin+'/functions/v1/arkhen-backend';
    if(!gateway||typeof gateway!=='object'||Array.isArray(gateway)||
      typeof gateway.secret!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(gateway.secret)||secretKey!==undefined||
      gateway.url!==undefined&&gateway.url!==gatewayURL)throw new SupabaseCloudError('CLOUD_CONFIG_INVALID');
    return {url:url.origin,publishableKey,gateway:{url:gatewayURL,secret:gateway.secret}};
  }
  if(!validKey(secretKey,'service_role'))throw new SupabaseCloudError('CLOUD_CONFIG_INVALID');
  return {url:url.origin,publishableKey,secretKey};
}

/** Global metadata scope is explicitly shared by provider origin, not by user.
 * Playback still uses the individual provider client to authorize every source.
 */
export function cloudSourceScope(provider,server){
  if(!['wplay','wplay-ott'].includes(provider))throw new SupabaseCloudError('CLOUD_PROVIDER_UNSUPPORTED',400);
  let url;try{url=new URL(server);}catch{throw new SupabaseCloudError('CLOUD_PROVIDER_INVALID',400);}
  if(!['https:','http:'].includes(url.protocol))throw new SupabaseCloudError('CLOUD_PROVIDER_INVALID',400);
  const providerKey=sha(JSON.stringify(['arkhen-provider-v1',provider,url.origin.toLowerCase()]));
  return {providerKey,scopeHash:sha('arkhen-shared-v1:'+providerKey)};
}

/** Minimal server-only REST adapter. Keys never enter error messages or URLs. */
export class SupabaseCloud {
  #config=null;
  #configurationSource;
  #configurationCheckedAt;
  #providerAuthenticationUnavailableUntil=0;
  #sourceJobEnqueues=new Map();
  constructor({config,configPath=resolve('.local/supabase.json'),fetch:fetcher=(...args)=>globalThis.fetch(...args),expectedProjectRef=ARKHEN_SUPABASE_PROJECT,now=()=>Date.now(),timeoutMs=15000,publicationTimeoutMs=65000,configurationRetryMs=5000,providerAuthenticationTimeoutMs=3000,providerAuthenticationRetryMs=30000}={}){
    this.fetch=fetcher;this.now=now;this.timeoutMs=timeoutMs;this.publicationTimeoutMs=publicationTimeoutMs;this.enabled=false;this.bootstraps=new Map();
    this.providerAuthenticationTimeoutMs=providerAuthenticationTimeoutMs;this.providerAuthenticationRetryMs=providerAuthenticationRetryMs;
    this.#configurationSource={config,configPath,expectedProjectRef};this.configurationRetryMs=configurationRetryMs;this.#configurationCheckedAt=this.now();
    this.ready=this.#readConfiguration();
  }
  async #readConfiguration(){
    const {config,configPath,expectedProjectRef}=this.#configurationSource;let value=config;
    if(value===undefined)try{const raw=await readFile(configPath,'utf8');if(raw.length>32768)throw new SupabaseCloudError('CLOUD_CONFIG_INVALID');value=JSON.parse(raw);}
    catch(error){if(error?.code==='ENOENT')return false;throw error instanceof SupabaseCloudError?error:new SupabaseCloudError('CLOUD_CONFIG_INVALID');}
    if(value===null || value?.enabled===false)return false;
    this.#config=normalizeCloudConfig(value,{expectedProjectRef});this.enabled=true;return true;
  }
  /** A newly provisioned server-only file can activate existing WPLAY sessions.
   * Healthy configuration stays fixed for the lifetime of the process. */
  async refreshConfiguration({force=false}={}){
    if(this.enabled||this.#configurationSource.config!==undefined)return this.ready;
    try{await this.ready;}catch{/* A repaired file is checked below. */}
    if(this.enabled)return true;
    if(!force&&this.now()-this.#configurationCheckedAt<this.configurationRetryMs)return this.ready;
    this.#configurationCheckedAt=this.now();this.ready=this.#readConfiguration();return this.ready;
  }
  publicConfig(){return this.#config?{url:this.#config.url,publishableKey:this.#config.publishableKey}:null;}
  get providerAuthenticationEnabled(){return Boolean(this.enabled&&this.#config?.gateway);}
  async authenticateWplay({server,scopeServer,form,userAgent,signal}={}){
    await this.ready;if(!this.providerAuthenticationEnabled)throw new SupabaseCloudError('CLOUD_PROVIDER_AUTH_UNAVAILABLE',503);
    if(signal?.aborted)throw new DOMException('Consulta cancelada.','AbortError');
    if(this.#providerAuthenticationUnavailableUntil>this.now())throw Object.assign(new SupabaseCloudError('CLOUD_PROVIDER_AUTH_UNAVAILABLE',503),{providerAuthFallback:true});
    try{
      const result=await this.request('/providers/wplay/auth',{method:'POST',body:{server,...(scopeServer===undefined?{}:{scopeServer}),form,userAgent},timeoutMs:this.providerAuthenticationTimeoutMs,signal});
      if(!result?.payload||typeof result.payload!=='object'||Array.isArray(result.payload)||typeof result.cloudCollector!=='boolean')throw new SupabaseCloudError('CLOUD_PROVIDER_AUTH_INVALID');
      this.#providerAuthenticationUnavailableUntil=0;return result;
    }catch(error){
      if(providerAuthenticationTransportFailure(error)){
        this.#providerAuthenticationUnavailableUntil=this.now()+this.providerAuthenticationRetryMs;
        error.providerAuthFallback=true;
      }
      throw error;
    }
  }
  async artwork({providerKey,scopeHash,ref,source}={}, {timeoutMs=20000}={}){
    if(!this.providerAuthenticationEnabled||![providerKey,scopeHash,ref].every(value=>HASH.test(value||'')))return null;
    if(source!==undefined&&(!source||typeof source!=='object'||Array.isArray(source)||Object.keys(source).length!==2||typeof source.url!=='string'||source.url.length>8192||typeof source.userAgent!=='string'||source.userAgent.length>1000||/[\r\n\0]/.test(source.url+source.userAgent)))throw new SupabaseCloudError('CLOUD_ARTWORK_SOURCE_INVALID');
    const budget=Number.isFinite(timeoutMs)&&timeoutMs>0?Math.min(20000,timeoutMs):20000;
    const result=await this.request('/providers/wplay/artwork',{method:'POST',body:{providerKey,scopeHash,ref,...(source===undefined?{}:{source})},timeoutMs:budget});
    let url;try{url=new URL(result?.url);}catch{return null;}
    return url.origin===this.#config.url&&url.pathname===`/storage/v1/object/public/arkhen-catalog-artwork/${providerKey}/${scopeHash}/${ref}`&&!url.search&&!url.hash?url.href:null;
  }
  kickCollector(){return this.rpc('arkhen_kick_cloud_collector',{});}
  async runtimeSessionKey(){
    await this.ready;if(!this.enabled)throw new SupabaseCloudError('CLOUD_NOT_CONFIGURED',503);
    const secret=this.#config.gateway?.secret||this.#config.secretKey;
    if(!secret)throw new SupabaseCloudError('CLOUD_NOT_CONFIGURED',503);
    return createHmac('sha256',secret).update('arkhen-private-runtime-key-v1').digest();
  }
  async runtimeSessionRPC(operation,args){
    if(!['acquire','renew','commit','media','read'].includes(operation))throw new SupabaseCloudError('CLOUD_RPC_INVALID');
    return this.request('/rest/v1/rpc/arkhen_runtime_session_'+operation,{method:'POST',body:args,runtimeStore:true,timeoutMs:operation==='media'?1500:7000});
  }
  async request(path,{method='GET',body,publicKey=false,accessToken,headers={},timeoutMs=this.timeoutMs,signal,runtimeStore=false}={}){
    const lease=runtimeStore?null:runtimeSessionContext();
    if(lease){lease.assert();signal=signal?AbortSignal.any([signal,lease.signal]):lease.signal;}
    await this.ready;if(!this.enabled)throw new SupabaseCloudError('CLOUD_NOT_CONFIGURED',503);
    if(signal?.aborted)throw new DOMException('Consulta cancelada.','AbortError');
    if(typeof path!=='string' || !(/^\/(?:auth\/v1|rest\/v1)\//.test(path)||this.#config.gateway&&['/providers/wplay/auth','/providers/wplay/artwork'].includes(path)) || path.includes('..') || /[\r\n]/.test(path))throw new SupabaseCloudError('CLOUD_PATH_INVALID');
    const gateway=this.#config.gateway&&!publicKey&&!accessToken?this.#config.gateway:null;
    const key=publicKey||this.#config.gateway?this.#config.publishableKey:this.#config.secretKey;
    const auth=accessToken || (key.split('.').length===3?key:null);
    const started=performance.now(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);timer.unref?.();
    const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});
    try{
      let destination=this.#config.url+path,requestMethod=method,requestBody=body===undefined?undefined:JSON.stringify(body);
      let requestHeaders={...headers,apikey:key,...(auth?{Authorization:'Bearer '+auth}:{}),'Content-Type':'application/json'};
      if(gateway){
        destination=runtimeStore?this.#config.url+'/functions/v1/arkhen-session':gateway.url;requestMethod='POST';requestBody=runtimeStore?JSON.stringify({rpc:path.split('/').at(-1),args:body}):JSON.stringify({path,method,...(body===undefined?{}:{body})});
        const timestamp=String(this.now()),nonce=randomBytes(16).toString('hex');
        const signature=createHmac('sha256',gateway.secret).update(`${timestamp}.${nonce}.${requestBody}`).digest('hex');
        requestHeaders={'Content-Type':'application/json','x-arkhen-timestamp':timestamp,'x-arkhen-nonce':nonce,'x-arkhen-signature':signature};
      }
      const response=await this.fetch(destination,{method:requestMethod,redirect:'error',signal:controller.signal,headers:requestHeaders,
        ...(requestBody===undefined?{}:{body:requestBody})});
      const raw=await response.text();let data=null,invalidJSON=false;try{if(raw)data=JSON.parse(raw);}catch{invalidJSON=true;}
      if(!response.ok){const error=new SupabaseCloudError(invalidJSON?'CLOUD_RESPONSE_INVALID':data?.code==='57014'?'CLOUD_DATABASE_TIMEOUT':'CLOUD_REQUEST_FAILED',502);error.remoteStatus=response.status;
        if(typeof data?.code==='string'&&/^[A-Z0-9][A-Z0-9_]{0,79}$/.test(data.code))error.remoteCode=data.code;
        const authCode=data?.code??data?.error_code;if(typeof authCode==='string'&&/^[a-z_]{1,60}$/.test(authCode))error.authCode=authCode;
        throw error;}
      if(invalidJSON)throw new SupabaseCloudError('CLOUD_RESPONSE_INVALID');
      return data;
    }catch(error){if(signal?.aborted)throw new DOMException('Consulta cancelada.','AbortError');const failure=error instanceof SupabaseCloudError?error:new SupabaseCloudError(controller.signal.aborted?'CLOUD_TIMEOUT':'CLOUD_UNAVAILABLE');const stage=path.match(/^\/rest\/v1\/rpc\/(arkhen_[a-z_]{1,80})$/)?.[1]||({'/auth/v1/admin/users':'auth_create_user','/auth/v1/admin/generate_link':'auth_generate_link','/auth/v1/verify':'auth_verify','/auth/v1/health':'auth_health'}[path])||(/^\/rest\/v1\/catalog_artwork_refs\?/.test(path)?'artwork_reference':/^\/rest\/v1\/catalog_media\?/.test(path)?'artwork_classification':null);if(stage)failure.cloudStage=stage;failure.elapsedMs=Math.max(0,Math.round(performance.now()-started));throw failure;}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
  }
  async rpc(name,args={}){
    if(typeof name!=='string'||!/^arkhen_[a-z_]{1,80}$/.test(name))throw new SupabaseCloudError('CLOUD_RPC_INVALID');
    const budget=name==='arkhen_identity_bind'?{timeoutMs:Math.min(this.timeoutMs,5000)}:
      /^arkhen_publish_(?:catalog|epg|epg_batch)$/.test(name)?{timeoutMs:this.publicationTimeoutMs}:{};
    return this.request('/rest/v1/rpc/'+name,{method:'POST',body:args,...budget});
  }
  async bootstrap(value={}){
    await this.ready;if(!this.enabled)throw new SupabaseCloudError('CLOUD_NOT_CONFIGURED',503);
    const {session,client,provider}=value,libraryHash=session?.account?.libraryId;
    if(!session?.connected || !client?.session?.connected || !HASH.test(libraryHash||'') || !['wplay','wplay-ott'].includes(provider))
      throw new SupabaseCloudError('CLOUD_PROVIDER_VALIDATION_REQUIRED',401);
    const validatedAt=Number(client.authenticatedAt),expiresAt=session.account.expiresAt;
    if(!Number.isFinite(validatedAt)||validatedAt<=0||validatedAt>this.now()+60000||this.now()-validatedAt>86400000 ||
      String(session.account.status||'').toLowerCase()!=='active' || expiresAt && (!Number.isFinite(Date.parse(expiresAt))||Date.parse(expiresAt)<=this.now()))
      throw new SupabaseCloudError('CLOUD_PROVIDER_VALIDATION_REQUIRED',401);
    // Serialize identity creation and one-use magic links, but issue a distinct
    // Auth session for each browser. Sharing the pending result would make a
    // local logout revoke another device's refresh session.
    const previous=this.bootstraps.get(libraryHash);
    const pending=Promise.resolve(previous).catch(()=>{}).then(()=>this.#bootstrap({...value,libraryHash,validatedAt,expiresAt:expiresAt||null}));this.bootstraps.set(libraryHash,pending);
    try{return await pending;}finally{if(this.bootstraps.get(libraryHash)===pending)this.bootstraps.delete(libraryHash);}
  }
  async #bootstrap({session,client,provider,libraryHash,validatedAt,expiresAt,providerKey,scopeHash}){
    const scope=cloudSourceScope(provider,client.config?.server);
    providerKey=providerKey??scope.providerKey;scopeHash=scopeHash??scope.scopeHash;
    if(!HASH.test(providerKey)||!HASH.test(scopeHash))throw new SupabaseCloudError('CLOUD_SCOPE_INVALID');
    const email=libraryHash.toLowerCase()+'@accounts.arkhen.invalid';
    const rows=await this.rpc('arkhen_identity_lookup',{p_library_hash:libraryHash.toLowerCase()});
    let userId=Array.isArray(rows)?rows[0]?.user_id:rows?.user_id;
    if(userId && !UUID.test(userId))throw new SupabaseCloudError('CLOUD_IDENTITY_INVALID');
    if(!userId){
      try{
        const created=await this.request('/auth/v1/admin/users',{method:'POST',body:{email,password:randomBytes(48).toString('base64url'),email_confirm:true,
          app_metadata:{arkhen_provider:provider,arkhen_library_hash:libraryHash.toLowerCase()}}});
        userId=(created?.user??created)?.id;if(!UUID.test(userId||''))throw new SupabaseCloudError('CLOUD_IDENTITY_INVALID');
      }catch(error){if(!['email_exists','user_already_exists'].includes(error.authCode))throw error;}
    }
    // Admin generate_link creates the OTP but does not send an email. The
    // synthetic address has no mailbox and no provider password is reused.
    const link=await this.request('/auth/v1/admin/generate_link',{method:'POST',body:{type:'magiclink',email}});
    const linkedUser=link?.user??link,linkedId=linkedUser?.id;
    if(!UUID.test(linkedId||'') || userId && linkedId!==userId || linkedUser.email!==email ||
      linkedUser.app_metadata?.arkhen_library_hash!==libraryHash.toLowerCase())throw new SupabaseCloudError('CLOUD_IDENTITY_INVALID');
    userId=linkedId;
    await this.rpc('arkhen_identity_bind',{p_library_hash:libraryHash.toLowerCase(),p_user_id:userId,p_provider:provider,p_provider_key:providerKey,p_scope_hash:scopeHash});
    await this.rpc('arkhen_validate_account',{p_user_id:userId,p_status:'active',p_expires_at:expiresAt,p_validated_at:new Date(validatedAt).toISOString(),p_provider_key:providerKey,p_scope_hash:scopeHash});
    const hash=link.hashed_token??link.properties?.hashed_token;
    if(typeof hash!=='string'||hash.length<16||hash.length>8192)throw new SupabaseCloudError('CLOUD_IDENTITY_INVALID');
    const issued=await this.request('/auth/v1/verify',{method:'POST',publicKey:true,body:{token_hash:hash,type:'email'}});
    if(issued?.user?.id!==userId || typeof issued.access_token!=='string' || typeof issued.refresh_token!=='string' || !issued.access_token || !issued.refresh_token)
      throw new SupabaseCloudError('CLOUD_SESSION_INVALID');
    const cloudSession={access_token:issued.access_token,refresh_token:issued.refresh_token,token_type:'bearer',
      ...(Number.isFinite(issued.expires_in)?{expires_in:issued.expires_in}:{}),
      ...(Number.isFinite(issued.expires_at)?{expires_at:issued.expires_at}:{}),user:{id:userId}};
    this.#enqueueSourceJobs(providerKey,scopeHash);
    return {...this.publicConfig(),session:cloudSession,userId,providerKey,scopeHash};
  }
  #enqueueSourceJobs(providerKey,scopeHash){
    const stamp=this.now(),key=JSON.stringify([providerKey,scopeHash]);
    if((this.#sourceJobEnqueues.get(key)||0)>stamp)return;
    for(const [scope,until]of this.#sourceJobEnqueues)if(until<=stamp)this.#sourceJobEnqueues.delete(scope);
    this.#sourceJobEnqueues.set(key,stamp+15000);
    // Metadata collection is not an authorization dependency of favorites.
    // A failed/slow enqueue cannot discard the session already issued above.
    void Promise.resolve().then(()=>this.request('/rest/v1/rpc/arkhen_enqueue_source_jobs',{
      method:'POST',body:{p_provider_key:providerKey,p_scope_hash:scopeHash},timeoutMs:1500,
    })).catch(()=>{/* No provider/SQL response is reflected into library errors or logs. */});
  }
  async revoke(accessToken){
    if(typeof accessToken!=='string'||!accessToken)return false;
    await this.request('/auth/v1/logout?scope=local',{method:'POST',accessToken});return true;
  }
}

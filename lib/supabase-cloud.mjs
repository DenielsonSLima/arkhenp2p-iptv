import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';

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

export function normalizeCloudConfig(value,{expectedProjectRef=ARKHEN_SUPABASE_PROJECT}={}){
  if(!value || typeof value!=='object' || Array.isArray(value))throw new SupabaseCloudError('CLOUD_CONFIG_INVALID');
  let url;try{url=new URL(value.url);}catch{throw new SupabaseCloudError('CLOUD_CONFIG_INVALID');}
  if(url.origin!==`https://${expectedProjectRef}.supabase.co` || !['','/'].includes(url.pathname) || url.search || url.hash || url.username || url.password)
    throw new SupabaseCloudError('CLOUD_PROJECT_MISMATCH');
  const publishableKey=value.publishableKey??value.anonKey,secretKey=value.secretKey??value.serviceRoleKey;
  if(!validKey(publishableKey,'anon') || !validKey(secretKey,'service_role'))throw new SupabaseCloudError('CLOUD_CONFIG_INVALID');
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
  constructor({config,configPath=resolve('.local/supabase.json'),fetch:fetcher=(...args)=>globalThis.fetch(...args),expectedProjectRef=ARKHEN_SUPABASE_PROJECT,now=()=>Date.now(),timeoutMs=15000,publicationTimeoutMs=65000}={}){
    this.fetch=fetcher;this.now=now;this.timeoutMs=timeoutMs;this.publicationTimeoutMs=publicationTimeoutMs;this.enabled=false;this.bootstraps=new Map();
    this.ready=(async()=>{
      let value=config;
      if(value===undefined)try{const raw=await readFile(configPath,'utf8');if(raw.length>32768)throw new SupabaseCloudError('CLOUD_CONFIG_INVALID');value=JSON.parse(raw);}
      catch(error){if(error?.code==='ENOENT')return false;throw error instanceof SupabaseCloudError?error:new SupabaseCloudError('CLOUD_CONFIG_INVALID');}
      if(value===null || value?.enabled===false)return false;
      this.#config=normalizeCloudConfig(value,{expectedProjectRef});this.enabled=true;return true;
    })();
  }
  publicConfig(){return this.#config?{url:this.#config.url,publishableKey:this.#config.publishableKey}:null;}
  async request(path,{method='GET',body,publicKey=false,accessToken,headers={},timeoutMs=this.timeoutMs}={}){
    await this.ready;if(!this.enabled)throw new SupabaseCloudError('CLOUD_NOT_CONFIGURED',503);
    if(typeof path!=='string' || !/^\/(?:auth\/v1|rest\/v1)\//.test(path) || path.includes('..') || /[\r\n]/.test(path))throw new SupabaseCloudError('CLOUD_PATH_INVALID');
    const key=publicKey?this.#config.publishableKey:this.#config.secretKey;
    const auth=accessToken || (key.split('.').length===3?key:null);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);timer.unref?.();
    try{
      const response=await this.fetch(this.#config.url+path,{method,redirect:'error',signal:controller.signal,
        headers:{...headers,apikey:key,...(auth?{Authorization:'Bearer '+auth}:{}),'Content-Type':'application/json'},
        ...(body===undefined?{}:{body:JSON.stringify(body)})});
      const raw=await response.text();let data=null;try{if(raw)data=JSON.parse(raw);}catch{throw new SupabaseCloudError('CLOUD_RESPONSE_INVALID');}
      if(!response.ok){const error=new SupabaseCloudError(data?.code==='57014'?'CLOUD_DATABASE_TIMEOUT':'CLOUD_REQUEST_FAILED',502);error.remoteStatus=response.status;
        const authCode=data?.code??data?.error_code;if(typeof authCode==='string'&&/^[a-z_]{1,60}$/.test(authCode))error.authCode=authCode;
        throw error;}
      return data;
    }catch(error){throw error instanceof SupabaseCloudError?error:new SupabaseCloudError(controller.signal.aborted?'CLOUD_TIMEOUT':'CLOUD_UNAVAILABLE');}
    finally{clearTimeout(timer);}
  }
  async rpc(name,args={}){
    if(typeof name!=='string'||!/^arkhen_[a-z_]{1,80}$/.test(name))throw new SupabaseCloudError('CLOUD_RPC_INVALID');
    return this.request('/rest/v1/rpc/'+name,{method:'POST',body:args,...(/^arkhen_publish_(?:catalog|epg|epg_batch)$/.test(name)?{timeoutMs:this.publicationTimeoutMs}:{})});
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
    await this.rpc('arkhen_enqueue_source_jobs',{p_provider_key:providerKey,p_scope_hash:scopeHash});
    const hash=link.hashed_token??link.properties?.hashed_token;
    if(typeof hash!=='string'||hash.length<16||hash.length>8192)throw new SupabaseCloudError('CLOUD_IDENTITY_INVALID');
    const issued=await this.request('/auth/v1/verify',{method:'POST',publicKey:true,body:{token_hash:hash,type:'email'}});
    if(issued?.user?.id!==userId || typeof issued.access_token!=='string' || typeof issued.refresh_token!=='string' || !issued.access_token || !issued.refresh_token)
      throw new SupabaseCloudError('CLOUD_SESSION_INVALID');
    const cloudSession={access_token:issued.access_token,refresh_token:issued.refresh_token,token_type:'bearer',
      ...(Number.isFinite(issued.expires_in)?{expires_in:issued.expires_in}:{}),
      ...(Number.isFinite(issued.expires_at)?{expires_at:issued.expires_at}:{}),user:{id:userId}};
    return {...this.publicConfig(),session:cloudSession,userId,providerKey,scopeHash};
  }
  async revoke(accessToken){
    if(typeof accessToken!=='string'||!accessToken)return false;
    await this.request('/auth/v1/logout?scope=local',{method:'POST',accessToken});return true;
  }
}

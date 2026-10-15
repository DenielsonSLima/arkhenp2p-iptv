import {sealSource,openSource,publicProviderURL,assertPublicProviderDestination} from '../_shared/provider-sources.mjs';
import {sharedImageReference} from '../arkhen-catalog-sync/wplay-http.mjs';

const URL_ROOT='https://wnicimkmzswksaqdtgdv.supabase.co';
const AUTH_HOSTS=new Set(['https://auth1.wareztv.io/api/v2/auth','https://auth1.authwplays.one/api/v2/auth']);
const SERVICE_URLS=['ch_url','vod_url','vod_tag_url','vod_search_url','epg_url','football_url'];
const FORM_KEYS=['from','username','password','deviceID','packageName','appName','appVersion','buildBrand','buildProduct','buildBoard','buildABI','operateMode','buildDisplay','buildModel','sysVersion'];
const hash=/^[a-f0-9]{64}$/;
const encoder=new TextEncoder();
const failure=(status,code)=>Object.assign(new Error(code),{status,code:'GATEWAY_'+code});
const object=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const exact=(value,names)=>object(value)&&Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');
async function bounded(response,maximum){
  if(Number(response.headers.get('content-length'))>maximum)throw failure(502,'PROVIDER_RESPONSE_TOO_LARGE');
  const reader=response.body?.getReader();if(!reader)return new Uint8Array();const chunks=[];let length=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>maximum)throw failure(502,'PROVIDER_RESPONSE_TOO_LARGE');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const output=new Uint8Array(length);let offset=0;for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.length;}return output;
}
function expiry(value){
  if(typeof value==='number'||typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value)){const number=Number(value);return number>0?number>=1e12?number:number*1000:null;}
  const time=Date.parse(value);return Number.isFinite(time)?time:null;
}
function tokenExpiry(value){
  try{
    if(typeof value!=='string'||value.split('.').length!==3)return null;
    const payload=JSON.parse(atob(value.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
    return typeof payload.exp==='number'&&Number.isFinite(payload.exp)?payload.exp*1000:null;
  }catch{return null;}
}
function imageType(bytes){
  if(bytes.length<12)return null;
  if(bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'image/jpeg';
  if([137,80,78,71,13,10,26,10].every((byte,index)=>bytes[index]===byte))return 'image/png';
  const prefix=new TextDecoder().decode(bytes.subarray(0,64));
  if(/^GIF8[79]a/.test(prefix))return 'image/gif';
  if(prefix.startsWith('RIFF')&&prefix.slice(8,12)==='WEBP')return 'image/webp';
  if(prefix.slice(4,8)==='ftyp'&&/avif|avis/.test(prefix.slice(8)))return 'image/avif';
  return null;
}

/** Runs only after the outer server HMAC has been verified. No browser accepts
 * this capability. Provider passwords exist only for the outbound POST. */
export function createWplayGateway({environment,fetch:request=globalThis.fetch,now=Date.now,resolveDns=globalThis.Deno?.resolveDns}={}){
  const adminHeaders=key=>({'Content-Type':'application/json',apikey:key,...(key.split('.').length===3?{Authorization:'Bearer '+key}:{})});
  async function rpc(key,name,body){
    const response=await request(URL_ROOT+'/rest/v1/rpc/'+name,{method:'POST',redirect:'error',headers:adminHeaders(key),body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    if(!response.ok){await response.body?.cancel();throw failure(502,'PROVIDER_DATABASE_UNAVAILABLE');}
    return response.status===204?null:response.json();
  }
  async function authenticate(body,key){
    if(!(exact(body,['server','form','userAgent'])||exact(body,['server','form','userAgent','scopeServer']))||!AUTH_HOSTS.has(body.server)||body.scopeServer!==undefined&&!AUTH_HOSTS.has(body.scopeServer)||typeof body.form!=='string'||body.form.length>16000||typeof body.userAgent!=='string'||body.userAgent.length>1000||/[\r\n\0]/.test(body.userAgent)||!body.userAgent.startsWith('Apache-HttpClient/Null (WPlay 11.9.0d; Android '))throw failure(400,'PROVIDER_OPERATION_REJECTED');
    const form=new URLSearchParams(body.form),seen=new Set();
    for(const [name,value]of form){if(!FORM_KEYS.includes(name)||seen.has(name)||value.length>300||/[\0\r\n]/.test(value))throw failure(400,'PROVIDER_OPERATION_REJECTED');seen.add(name);}
    if(seen.size!==FORM_KEYS.length||form.get('from')!=='ap'||form.get('packageName')!=='io.wareztv.android.one'||form.get('appName')!=='WPlay'||form.get('appVersion')!=='1190'||!form.get('username')||!form.get('password'))throw failure(400,'PROVIDER_OPERATION_REJECTED');
    let response,payload;
    try{
      response=await request(body.server,{method:'POST',redirect:'error',headers:{'User-Agent':body.userAgent,'Content-Type':'application/x-www-form-urlencoded'},body:body.form,signal:AbortSignal.timeout(12000)});
      if(!response.ok)throw new Error();payload=JSON.parse(new TextDecoder().decode(await bounded(response,1048576)));
    }catch{throw failure(502,'PROVIDER_AUTH_UNAVAILABLE');}
    if(!object(payload)||!['number','string'].includes(typeof payload.code)||String(payload.code).trim()===''||!Number.isInteger(Number(payload.code)))throw failure(502,'PROVIDER_RESPONSE_INVALID');
    let cloudCollector=false;
    if(Number(payload.code)===0&&object(payload.service)&&environment('ARKHEN_SOURCE_ENCRYPTION_KEY')){
      try{
        const service={};for(const field of SERVICE_URLS)if(payload.service[field])service[field]=publicProviderURL(payload.service[field]).href;
        for(const field of ['enabledLive','enabledVoD'])if(typeof payload.service[field]==='boolean')service[field]=payload.service[field];
        if(typeof payload.service.token==='string'&&payload.service.token.length<=8192)service.token=payload.service.token;
        if(!service.ch_url&&!service.vod_tag_url&&!service.vod_url)throw new Error();
        const scopeOrigin=new URL(body.scopeServer??body.server).origin;
        const providerKey=await digest(JSON.stringify(['arkhen-provider-v1','wplay',scopeOrigin.toLowerCase()])),scopeHash=await digest('arkhen-shared-v1:'+providerKey);
        const sourceId=await digest(JSON.stringify(['wplay',scopeOrigin,form.get('username').trim()]));
        const expiresAt=new Date(Math.min(now()+7200000,expiry(payload.user?.end_time??payload.user?.EndTime)??Infinity,tokenExpiry(service.token)??Infinity)).toISOString();if(Date.parse(expiresAt)<=now())throw new Error();
        const source={provider:'wplay',service,userAgent:body.userAgent,validatedAt:new Date(now()).toISOString(),expiresAt};
        const cipher=await sealSource({source,providerKey,scopeHash,sourceId,key:environment('ARKHEN_SOURCE_ENCRYPTION_KEY')});
        await rpc(key,'arkhen_source_put',{p_provider_key:providerKey,p_scope_hash:scopeHash,p_source_id:sourceId,p_cipher:cipher,p_expires_at:expiresAt});cloudCollector=true;
      }catch{/* Successful authentication survives a temporarily unavailable shared collector. */}
    }
    return {payload,cloudCollector};
  }
  async function artwork(body,key){
    if(!(exact(body,['providerKey','scopeHash','ref'])||exact(body,['providerKey','scopeHash','ref','source']))||![body.providerKey,body.scopeHash,body.ref].every(value=>hash.test(value||'')))throw failure(400,'PROVIDER_OPERATION_REJECTED');
    if(body.source!==undefined){
      const source=body.source;
      if(!exact(source,['url','userAgent'])||typeof source.url!=='string'||source.url.length>8192||typeof source.userAgent!=='string'||source.userAgent.length>1000||/[\r\n\0]/.test(source.url+source.userAgent))throw failure(400,'PROVIDER_OPERATION_REJECTED');
      publicProviderURL(source.url);
      if(await sharedImageReference(source.url,{providerKey:body.providerKey,scopeHash:body.scopeHash})!=='/api/shared-image/'+body.ref)throw failure(400,'PROVIDER_OPERATION_REJECTED');
    }
    const {providerKey,scopeHash,ref}=body,path='arkhen-catalog-artwork/'+providerKey+'/'+scopeHash+'/'+ref,url=URL_ROOT+'/storage/v1/object/public/'+path;
    const cached=await request(url,{method:'HEAD',redirect:'error',signal:AbortSignal.timeout(5000)});await cached.body?.cancel();
    const modified=Date.parse(cached.headers.get('last-modified'));
    if(cached.ok&&Number.isFinite(modified)&&now()-modified<86400000)return {url};
    let row;
    if(body.source!==undefined){
      const cipher=await sealSource({source:body.source,providerKey,scopeHash,sourceId:ref,key:environment('ARKHEN_SOURCE_ENCRYPTION_KEY')});
      const expiresAt=new Date(now()+7200000).toISOString();
      await rpc(key,'arkhen_artwork_put_batch',{p_rows:[{provider_key:providerKey,scope_hash:scopeHash,ref,cipher,expires_at:expiresAt}]});
      row={provider_key:providerKey,scope_hash:scopeHash,ref,cipher,expires_at:expiresAt};
    }else row=await rpc(key,'arkhen_artwork_get',{p_provider_key:providerKey,p_scope_hash:scopeHash,p_ref:ref});
    if(!row)return {url:cached.ok?url:null};
    const source=await openSource(row,environment('ARKHEN_SOURCE_ENCRYPTION_KEY'));let target=publicProviderURL(source.url),response;
    if(typeof source.userAgent!=='string'||/[\r\n\0]/.test(source.userAgent))throw failure(502,'PROVIDER_IMAGE_INVALID');
    for(let count=0;count<4;count++){
      await assertPublicProviderDestination(target.href,{resolveDns});
      response=await request(target.href,{headers:{'User-Agent':source.userAgent},redirect:'manual',signal:AbortSignal.timeout(10000)});
      if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('location');await response.body?.cancel();if(!location)throw failure(502,'PROVIDER_IMAGE_UNAVAILABLE');target=publicProviderURL(new URL(location,target).href);continue;}break;
    }
    if(!response?.ok){await response?.body?.cancel();throw failure(502,'PROVIDER_IMAGE_UNAVAILABLE');}
    const bytes=await bounded(response,8388608),type=imageType(bytes);if(!type)throw failure(502,'PROVIDER_IMAGE_INVALID');
    const saved=await request(URL_ROOT+'/storage/v1/object/'+path,{method:'POST',headers:{...adminHeaders(key),'Content-Type':type,'x-upsert':'true','Cache-Control':'max-age=86400'},body:bytes,redirect:'error',signal:AbortSignal.timeout(10000)});
    await saved.body?.cancel();if(!saved.ok)throw failure(502,'PROVIDER_IMAGE_STORAGE_UNAVAILABLE');return {url};
  }
  return async(envelope,key)=>{
    if(!['/providers/wplay/auth','/providers/wplay/artwork'].includes(envelope?.path))return null;
    if(!exact(envelope,['path','method','body'])||envelope.method!=='POST')throw failure(400,'PROVIDER_OPERATION_REJECTED');
    return envelope.path.endsWith('/auth')?authenticate(envelope.body,key):artwork(envelope.body,key);
  };
}

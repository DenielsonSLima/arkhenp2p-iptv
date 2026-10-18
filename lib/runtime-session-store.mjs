import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {gzip,gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {withRuntimeSession} from './runtime-session-context.mjs';

const compress=promisify(gzip),decompress=promisify(gunzip);
const MAX_PLAIN=64*1024*1024,MAX_CIPHER=3*1024*1024;
const mediaEpoch=state=>{
  const client=state?.client,playback=client?.playback;
  if(!playback||playback.controller.signal.aborted||state.loggedOut)return null;
  return createHash('sha256').update(JSON.stringify([state.authGeneration,client.playbackGeneration,playback.key,state.playbackIntent?.attempt||'',state.parental?.unlocked===true])).digest('hex');
};
const diagnostics=new Map();
const report=(code,details={})=>{
  const key=JSON.stringify([code,details.stage,details.remoteCode,details.remoteStatus]),now=Date.now();
  if(now-(diagnostics.get(key)||0)<30000)return;
  diagnostics.set(key,now);while(diagnostics.size>32)diagnostics.delete(diagnostics.keys().next().value);
  console.warn('[runtime-session]',JSON.stringify({code,...details}));
};
const failure=(code='RUNTIME_SESSION_UNAVAILABLE',details={})=>{report(code,details);return Object.assign(new Error('O serviço de acesso está temporariamente indisponível. Tente novamente em instantes.'),{status:503,code});};
const transportFailure=(error,stage)=>failure('RUNTIME_SESSION_UNAVAILABLE',{stage,
  ...(/^[A-Za-z0-9_]{1,80}$/.test(error?.code||'')?{transportCode:error.code}:{}),
  ...(/^[A-Za-z0-9_]{1,80}$/.test(error?.remoteCode||'')?{remoteCode:error.remoteCode}:{}),
  ...(Number.isInteger(error?.remoteStatus)?{remoteStatus:error.remoteStatus}:{})});
function encode(value,seen=new Set()){
  if(value===undefined)return null;
  if(value===null||typeof value!=='object'){
    if(!['string','number','boolean'].includes(typeof value)&&value!==null)throw failure('RUNTIME_SESSION_FORMAT');
    return value;
  }
  if(seen.has(value))throw failure('RUNTIME_SESSION_FORMAT');seen.add(value);
  try{
    if(value instanceof Map)return {$runtime:'map',value:[...value].map(([key,item])=>[encode(key,seen),encode(item,seen)])};
    if(value instanceof Set)return {$runtime:'set',value:[...value].map(item=>encode(item,seen))};
    if(value instanceof URL)return {$runtime:'url',value:value.href};
    if(value instanceof AbortController)return {$runtime:'controller',value:value.signal.aborted};
    if(Array.isArray(value))return value.map(item=>encode(item,seen));
    if(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)throw failure('RUNTIME_SESSION_FORMAT');
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,encode(item,seen)]));
  }finally{seen.delete(value);}
}
function decode(value){
  if(value===null||typeof value!=='object')return value;
  if(Array.isArray(value))return value.map(decode);
  if(Object.keys(value).length===2&&typeof value.$runtime==='string'){
    if(value.$runtime==='map')return new Map(value.value.map(([key,item])=>[decode(key),decode(item)]));
    if(value.$runtime==='set')return new Set(value.value.map(decode));
    if(value.$runtime==='url')return new URL(value.value);
    if(value.$runtime==='controller'){const controller=new AbortController();if(value.value)controller.abort();return controller;}
  }
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,decode(item)]));
}

/** A browser owns one opaque cookie. Server-only encrypted checkpoints and a
 * fenced lease preserve provider/session objects across Vercel instances. */
export class RuntimeSessionStore{
  constructor({cloud,now=Date.now}={}){this.cloud=cloud;this.now=now;this.readers=new Map();}
  async seal(value,sessionHash){
    const json=JSON.stringify(encode(value));
    if(Buffer.byteLength(json)>MAX_PLAIN)throw failure('RUNTIME_SESSION_TOO_LARGE');
    const compressed=await compress(json,{level:6});
    const iv=randomBytes(12),key=await this.cloud.runtimeSessionKey();
    const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('arkhen-runtime-v1:'+sessionHash));
    const ciphertext=Buffer.concat([cipher.update(compressed),cipher.final()]);
    const sealed=['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),ciphertext.toString('base64url')].join('.');
    if(sealed.length>MAX_CIPHER)throw failure('RUNTIME_SESSION_TOO_LARGE');
    return sealed;
  }
  async openCipher(value,sessionHash){
    try{
      if(typeof value!=='string'||value.length>MAX_CIPHER)throw new Error();
      const parts=value.split('.');if(parts.length!==4||parts[0]!=='v1')throw new Error();
      const iv=Buffer.from(parts[1],'base64url'),tag=Buffer.from(parts[2],'base64url');if(iv.length!==12||tag.length!==16)throw new Error();
      const decipher=createDecipheriv('aes-256-gcm',await this.cloud.runtimeSessionKey(),iv);
      decipher.setAAD(Buffer.from('arkhen-runtime-v1:'+sessionHash));decipher.setAuthTag(tag);
      const plain=await decompress(Buffer.concat([decipher.update(Buffer.from(parts[3],'base64url')),decipher.final()]),{maxOutputLength:MAX_PLAIN});
      return decode(JSON.parse(plain.toString()));
    }catch{throw failure('RUNTIME_SESSION_INVALID');}
  }
  async run(req,res,{create=false,createState,capture,restore,drain=async()=>{}},operation){
    let cookie=req.headers.cookie?.match(/(?:^|;\s*)ORBIT_SID=([A-Za-z0-9_-]{32})(?:;|$)/)?.[1];
    const hadCookie=Boolean(cookie);
    if(!cookie){cookie=randomBytes(24).toString('base64url');res.setHeader('Set-Cookie',`ORBIT_SID=${cookie}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`);}
    const sessionHash=createHash('sha256').update(cookie).digest('hex'),owner=randomUUID();
    let row=null;
    if(create||hadCookie){
      const deadline=this.now()+12000;
      do{
        try{row=await this.cloud.runtimeSessionRPC('acquire',{p_session_hash:sessionHash,p_owner:owner,p_create:create});}
        catch(error){throw transportFailure(error,'acquire');}
        if(!row?.busy)break;
        if(this.now()>=deadline)throw failure('RUNTIME_SESSION_BUSY');
        await new Promise(resolve=>setTimeout(resolve,250+Math.floor(Math.random()*100)));
      }while(true);
    }
    const leased=Boolean(row&&!row.missing&&!row.busy),controller=new AbortController();
    let released=!leased,leaseUntil=leased?Date.parse(row.leaseUntil):Infinity,revision=Number(row?.revision||0),fence=Number(row?.fence||0),timer=null,renewing=null,committing=false,lastDigest=null;
    let state,reader=null,guardTimer=null;
    const stopGuard=()=>{clearTimeout(guardTimer);guardTimer=null;if(reader){const readers=this.readers.get(sessionHash);readers?.delete(reader);if(!readers?.size)this.readers.delete(sessionHash);reader=null;}};
    const revokeReaders=epoch=>{for(const active of this.readers.get(sessionHash)||[])if(active.epoch!==epoch)active.controller.abort(failure('RUNTIME_SESSION_MEDIA_REVOKED'));};
    const startGuard=()=>{
      const epoch=mediaEpoch(state);if(!epoch)return;
      reader={epoch,controller};let readers=this.readers.get(sessionHash);if(!readers){readers=new Set();this.readers.set(sessionHash,readers);}readers.add(reader);
      const guard=async()=>{
        if(!reader||controller.signal.aborted)return;
        try{const value=await this.cloud.runtimeSessionRPC('media',{p_session_hash:sessionHash,p_media_epoch:epoch});if(!value?.ok)throw failure();}
        catch{controller.abort(failure('RUNTIME_SESSION_MEDIA_REVOKED'));return;}
        if(reader&&!controller.signal.aborted){guardTimer=setTimeout(guard,2500);guardTimer.unref?.();}
      };
      guardTimer=setTimeout(guard,2500);guardTimer.unref?.();
    };
    const assert=()=>{if(controller.signal.aborted||leased&&(released||this.now()>=leaseUntil))throw failure('RUNTIME_SESSION_LEASE_LOST');};
    const args=()=>({p_session_hash:sessionHash,p_owner:owner,p_fence:fence});
    const stopTimer=()=>{clearInterval(timer);timer=null;};
    const renew=async()=>{
      if(released||committing||renewing)return renewing;
      renewing=(async()=>{
        try{assert();const value=await this.cloud.runtimeSessionRPC('renew',args());if(!value?.ok)throw failure();leaseUntil=Date.parse(value.leaseUntil);}
        catch{if(!released)controller.abort(failure('RUNTIME_SESSION_LEASE_LOST'));stopTimer();}
        finally{renewing=null;}
      })();return renewing;
    };
    const checkpoint=async(release=false)=>{
      if(!leased||released)return;
      assert();
      await drain(state);assert();
      const snapshot=capture(state),digest=createHash('sha256').update(JSON.stringify(encode(snapshot))).digest('hex');
      const ciphertext=digest===lastDigest?null:await this.seal(snapshot,sessionHash);assert();
      // A renewal racing a released lease must not abort a valid media stream.
      committing=true;if(release)stopTimer();
      try{
        if(renewing)await renewing;assert();
        let value;try{value=await this.cloud.runtimeSessionRPC('commit',{...args(),p_revision:revision,p_cipher:ciphertext,p_release:release,p_media_epoch:mediaEpoch(state)});}catch(error){throw transportFailure(error,'commit');}
        if(!value?.ok){controller.abort(failure('RUNTIME_SESSION_LEASE_LOST'));throw failure('RUNTIME_SESSION_LEASE_LOST');}
        revision=Number(value.revision);lastDigest=digest;revokeReaders(mediaEpoch(state));
        if(release){released=true;stopTimer();}else leaseUntil=this.now()+80000;
      }finally{committing=false;}
    };
    // JSON/images are held until their mutable authorization state is durable.
    // Media paths explicitly release before writing headers or streaming bytes.
    const writeHead=res.writeHead,write=res.write,end=res.end,baselineHeaders={...res.getHeaders()},baselineStatus=res.statusCode;
    let chunks=[],ended=false,endCallback=null,restored=false;
    const restoreResponse=()=>{if(restored)return;restored=true;res.writeHead=writeHead;res.write=write;res.end=end;};
    res.writeHead=function(status,statusText,headers){this.statusCode=status;const values=typeof statusText==='object'?statusText:headers;for(const[key,value]of Object.entries(values||{}))this.setHeader(key,value);return this;};
    res.write=function(chunk,encoding,callback){if(chunk!==undefined)chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk,typeof encoding==='string'?encoding:undefined));if(typeof callback==='function')callback();return true;};
    res.end=function(chunk,encoding,callback){if(ended)chunks=[];if(chunk!==undefined)chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk,typeof encoding==='string'?encoding:undefined));ended=true;endCallback=typeof callback==='function'?callback:typeof encoding==='function'?encoding:null;return this;};
    const context={signal:controller.signal,assert,checkpoint:()=>checkpoint(false),beforeStreaming:async()=>{await checkpoint(true);startGuard();restoreResponse();}};
    try{
      if(leased){
        if(!Number.isFinite(leaseUntil)||!Number.isSafeInteger(revision)||!Number.isSafeInteger(fence))throw failure('RUNTIME_SESSION_INVALID');
        timer=setInterval(()=>{void renew();},15000);timer.unref?.();
      }
      const snapshot=row?.cipher?await this.openCipher(row.cipher,sessionHash):null;
      state=snapshot?await restore(snapshot):createState();
      if(snapshot)lastDigest=createHash('sha256').update(JSON.stringify(encode(snapshot))).digest('hex');
      await withRuntimeSession(context,()=>operation(state));
      await checkpoint(true);restoreResponse();
      if(ended&&!res.destroyed)end.call(res,chunks.length?Buffer.concat(chunks):undefined,endCallback||undefined);
    }catch(error){
      // Persist side-effect descriptors after a provider error, if we still own
      // the lease. A lost lease can never overwrite a later login or logout.
      try{if(state&&leased&&!released&&!controller.signal.aborted)await checkpoint(true);}catch{}
      restoreResponse();
      if(!res.headersSent){for(const name of res.getHeaderNames())res.removeHeader(name);for(const[name,value]of Object.entries(baselineHeaders))res.setHeader(name,value);res.statusCode=baselineStatus;}
      if(!error?.status)report('RUNTIME_SESSION_UNAVAILABLE',{stage:'restore_or_operation'});
      throw error?.status?error:failure();
    }finally{
      stopTimer();stopGuard();restoreResponse();
      if(leased&&!released){
        try{await this.cloud.runtimeSessionRPC('commit',{...args(),p_revision:revision,p_cipher:null,p_release:true,p_media_epoch:mediaEpoch(state)});}catch{}
      }
    }
  }
}

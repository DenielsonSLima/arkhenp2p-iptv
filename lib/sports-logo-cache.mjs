import {createHash,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,unlink,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {requestUpstream,validUpstreamURL,readBody} from './upstream.mjs';

const REF=/^[a-f0-9]{64}$/;
const sha=value=>createHash('sha256').update(value).digest('hex');
const credentialQuery=/^(?:t|token|access_token|refresh_token|auth|authorization|password|passwd|username|user|key|api_key|apikey|secret|signature|sig|expires|expiry|session|jwt)$/i;
export const SPORTS_LOGO_MAX_BYTES=512*1024;

/** Recognize raster bytes instead of trusting the extension or remote MIME. */
export function sportsLogoContentType(bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length<12)return null;
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)))return 'image/gif';
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
  if(bytes.toString('ascii',4,8)==='ftyp'&&['avif','avis'].includes(bytes.toString('ascii',8,12)))return 'image/avif';
  return null;
}

function sourceIdentity(value,scope,allowPrivate){
  const url=validUpstreamURL(value,allowPrivate),canonical=new URL(url);
  for(const key of [...canonical.searchParams.keys()])if(credentialQuery.test(key))canonical.searchParams.delete(key);
  canonical.hash='';canonical.searchParams.sort();
  let origin='';try{origin=new URL(scope).origin.toLowerCase();}catch{}
  return {ref:sha(JSON.stringify(['arkhen-sports-logo-v1',origin,canonical.href])),url:url.href};
}

/** Shared, bounded download queue. Persisted metadata contains hashes only;
 * provider addresses, headers and credentials stay in this process's memory.
 */
export class SportsLogoCache {
  constructor({directory=resolve('.local/sports-logos'),request=requestUpstream,now=Date.now,concurrency=4,maxPending=512,maxBytes=SPORTS_LOGO_MAX_BYTES,timeoutMs=8000,refreshMs=7*86400000}={}){
    Object.assign(this,{directory,request,now,concurrency,maxPending,maxBytes,timeoutMs,refreshMs});
    this.pending=new Map();this.queueEntries=[];this.active=0;this.failedUntil=new Map();
  }
  queue(value,{scope='',allowPrivate=false,headers={}}={}){
    if(typeof value!=='string'||!value||value.length>8192)return '';
    let source;try{source=sourceIdentity(value,scope,allowPrivate);}catch{return '';}
    const route='/api/sports-image/'+source.ref;
    if(this.pending.has(source.ref)||this.failedUntil.get(source.ref)>this.now())return route;
    if(this.pending.size>=this.maxPending)return '';
    let finish;const promise=new Promise(resolve=>{finish=resolve;});
    this.pending.set(source.ref,promise);this.queueEntries.push({...source,allowPrivate,headers,finish});this.#pump();return route;
  }
  #pump(){
    while(this.active<this.concurrency&&this.queueEntries.length){
      const entry=this.queueEntries.shift();this.active++;
      void this.#download(entry).catch(()=>{this.failedUntil.set(entry.ref,this.now()+300000);while(this.failedUntil.size>2000)this.failedUntil.delete(this.failedUntil.keys().next().value);}).finally(()=>{
        this.active--;this.pending.delete(entry.ref);entry.finish();this.#pump();
      });
    }
  }
  async #download(entry){
    const existing=await this.#stored(entry.ref);if(existing&&this.now()-existing.storedAt<this.refreshMs)return;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeoutMs);timer.unref?.();
    let response;
    try{
      response=await this.request(entry.url,{allowPrivate:entry.allowPrivate,headers:entry.headers,timeout:this.timeoutMs,signal:controller.signal});
      const declared=String(response.headers?.['content-type']||'').split(';')[0].trim().toLowerCase().replace('image/jpg','image/jpeg');
      const length=Number(response.headers?.['content-length']);
      if(response.status!==200||!/^image\/(png|jpeg|gif|webp|avif)$/.test(declared)||Number.isFinite(length)&&length>this.maxBytes)throw new Error('Invalid sports logo.');
      const bytes=await readBody(response,this.maxBytes),contentType=sportsLogoContentType(bytes);
      if(!contentType||contentType!==declared)throw new Error('Invalid sports logo.');
      const contentHash=sha(bytes),metadata={version:1,contentHash,contentType,storedAt:this.now()};
      await mkdir(join(this.directory,'content'),{recursive:true,mode:0o700});
      await this.#atomic(join(this.directory,'content',contentHash),bytes);
      await this.#atomic(join(this.directory,entry.ref+'.json'),JSON.stringify(metadata));this.failedUntil.delete(entry.ref);
    }finally{clearTimeout(timer);response?.body?.destroy?.();}
  }
  async #atomic(path,value){
    const temporary=path+'.'+randomBytes(8).toString('hex')+'.tmp';
    try{await writeFile(temporary,value,{mode:0o600,flag:'wx'});await rename(temporary,path);}
    finally{await unlink(temporary).catch(()=>{});}
  }
  async #stored(ref){
    if(!REF.test(ref||''))return null;
    try{
      const path=join(this.directory,ref+'.json');if((await stat(path)).size>1024)return null;
      const metadata=JSON.parse(await readFile(path,'utf8'));if(metadata.version!==1||!REF.test(metadata.contentHash||'')||!Number.isFinite(metadata.storedAt))return null;
      const content=join(this.directory,'content',metadata.contentHash);if((await stat(content)).size>this.maxBytes)return null;
      const bytes=await readFile(content),contentType=sportsLogoContentType(bytes);
      return contentType&&contentType===metadata.contentType&&sha(bytes)===metadata.contentHash?{bytes,contentType,storedAt:metadata.storedAt}:null;
    }catch{return null;}
  }
  async read(ref,{waitMs=20000}={}){
    const stored=await this.#stored(ref);if(stored)return {bytes:stored.bytes,contentType:stored.contentType};
    const pending=this.pending.get(ref);if(!pending)return null;
    let timer;try{await Promise.race([pending,new Promise(resolve=>{timer=setTimeout(resolve,waitMs);timer.unref?.();})]);}
    finally{clearTimeout(timer);}
    const downloaded=await this.#stored(ref);return downloaded?{bytes:downloaded.bytes,contentType:downloaded.contentType}:null;
  }
  async idle(){while(this.pending.size)await Promise.all([...this.pending.values()]);}
}

export const sportsLogoCache=new SportsLogoCache();
export const readSportsLogo=(ref,options)=>sportsLogoCache.read(ref,options);

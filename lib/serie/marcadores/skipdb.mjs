import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {SKIPDB_DUMP_URL,SKIPDB_CACHE_MS,SKIPDB_MAX_BYTES,validDate,failure} from './contrato.mjs';
import {validateSkipDBDump} from './normalizacao.mjs';
import {atomicJSON} from './arquivos.mjs';
const publicHosts=new Set(['skipdb.tv','api.skipdb.tv','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com']);

async function boundedFetch(fetcher,signal){
  let url=SKIPDB_DUMP_URL;
  for(let redirects=0;redirects<6;redirects++){
    const target=new URL(url);if(target.protocol!=='https:'||target.username||target.password||!publicHosts.has(target.hostname))throw failure('SKIPDB_REDIRECT_REJECTED');
    const response=await fetcher(url,{redirect:'manual',signal,headers:{Accept:'application/json'}});
    if([301,302,303,307,308].includes(response.status)){
      const location=response.headers.get('location');await response.body?.cancel?.();if(!location)throw failure('SKIPDB_REDIRECT_INVALID');url=new URL(location,url).href;continue;
    }
    if(!response.ok)throw failure('SKIPDB_HTTP_'+response.status);
    if(Number(response.headers.get('content-length'))>SKIPDB_MAX_BYTES)throw failure('SKIPDB_DUMP_TOO_LARGE');
    const chunks=[];let bytes=0;
    if(response.body?.getReader){const reader=response.body.getReader();try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>SKIPDB_MAX_BYTES){await reader.cancel();throw failure('SKIPDB_DUMP_TOO_LARGE');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}}
    else{const text=await response.text();bytes=Buffer.byteLength(text);if(bytes>SKIPDB_MAX_BYTES)throw failure('SKIPDB_DUMP_TOO_LARGE');chunks.push(Buffer.from(text));}
    let dump;try{dump=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw failure('SKIPDB_DUMP_INVALID');}
    return {dump:validateSkipDBDump(dump),bytes};
  }
  throw failure('SKIPDB_REDIRECT_LIMIT');
}

export async function loadSkipDBDump({fetch:fetcher=globalThis.fetch,force=false,cacheDir=resolve('.local/skipdb'),now=Date.now,signal}={}){
  const cached=join(cacheDir,'dump.json');
  if(!force)try{const entry=JSON.parse(await readFile(cached,'utf8'));if(validDate(entry.retrievedAt)&&now()-Date.parse(entry.retrievedAt)>=0&&now()-Date.parse(entry.retrievedAt)<SKIPDB_CACHE_MS)return {...entry,dump:validateSkipDBDump(entry.dump),cacheHit:true};}catch{/* Fetch a complete new snapshot instead of trusting broken cache. */}
  const controller=new AbortController(),abort=()=>controller.abort(),timeout=setTimeout(abort,60000);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  try{const value=await boundedFetch(fetcher,controller.signal),entry={...value,retrievedAt:new Date(now()).toISOString()};if(controller.signal.aborted)throw failure('SKIPDB_SYNC_ABORTED');await atomicJSON(cached,entry,{privateFile:true});return {...entry,cacheHit:false};}
  catch(error){throw error?.code?error:failure(controller.signal.aborted?'SKIPDB_SYNC_ABORTED':'SKIPDB_FETCH_FAILED');}
  finally{clearTimeout(timeout);signal?.removeEventListener('abort',abort);}
}


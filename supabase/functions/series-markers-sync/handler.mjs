import {MarkerStore} from './store.mjs';
import {runMarkerPipeline} from './pipeline.mjs';

const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
async function equalSecret(first,second){
  if(typeof first!=='string'||typeof second!=='string'||second.length<32||first.length>512)return false;
  const encode=new TextEncoder(),digests=await Promise.all([first,second].map(value=>crypto.subtle.digest('SHA-256',encode.encode(value))));
  const a=new Uint8Array(digests[0]),b=new Uint8Array(digests[1]);let difference=0;for(let index=0;index<a.length;index++)difference|=a[index]^b[index];return difference===0;
}
export function createMarkerSyncHandler({environment=name=>globalThis.Deno?.env?.get(name),fetch:request=globalThis.fetch,pipeline=runMarkerPipeline,store:givenStore,waitUntil=globalThis.EdgeRuntime?.waitUntil?.bind(globalThis.EdgeRuntime),sleep=delay=>new Promise(resolve=>setTimeout(resolve,delay))}={}){
  return async requestMessage=>{
    if(requestMessage.method!=='POST')return json({error:'METHOD_NOT_ALLOWED'},405);
    if(!await equalSecret(requestMessage.headers.get('x-arkhen-marker-secret'),environment('ARKHEN_MARKER_SYNC_SECRET')))return json({error:'MARKER_SYNC_UNAUTHORIZED'},401);
    let modernKey;try{modernKey=JSON.parse(environment('SUPABASE_SECRET_KEYS')||'{}').default;}catch{}
    const url=environment('SUPABASE_URL'),key=typeof modernKey==='string'&&modernKey.startsWith('sb_secret_')?modernKey:environment('SUPABASE_SERVICE_ROLE_KEY');if(!givenStore&&(!url||!key))return json({error:'MARKER_SYNC_CONFIGURATION_REQUIRED'},503);
    try{
      // Body options cannot change remote hosts, credentials, limits or tables.
      const body=await requestMessage.text();if(body.length>1024)return json({error:'BODY_TOO_LARGE'},413);
      if(body.trim()&&body.trim()!=='{}')return json({error:'INVALID_OPTIONS'},400);
      const store=givenStore||new MarkerStore({url,key,fetch:request});
      const result=await pipeline({store,fetch:request,skipdbKey:environment('SKIPDB_API_KEY')||'',introdbKey:environment('INTRODB_API_KEY')||''});
      const sourceProgress=!result.dumpComplete&&(result.published>0||result.rawCopied||result.rawStaged>0);
      const lookupProgress=result.identities>0||result.unresolved>0||result.inventories>0||result.episodesChecked>0;
      // Keep routine work on the cron cadence rather than creating a chain of
      // 11-second invocations whenever a large source or lookup queue exists.
      if(environment('ARKHEN_SYNC_CONTINUATIONS_ENABLED')==='true'&&result.state==='ready'&&waitUntil&&(sourceProgress||lookupProgress)){
        waitUntil((async()=>{await sleep(11000);try{const response=await request(url.replace(/\/$/,'')+'/functions/v1/series-markers-sync',{method:'POST',headers:{'Content-Type':'application/json','x-arkhen-marker-secret':environment('ARKHEN_MARKER_SYNC_SECRET')},body:'{}',signal:AbortSignal.timeout(55000)});await response.body?.cancel?.();}catch{}})());
      }
      return json(result,result.state==='failed'?503:200);
    }catch{return json({error:'MARKER_SYNC_FAILED'},503);}
  };
}

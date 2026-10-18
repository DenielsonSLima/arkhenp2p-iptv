import {CollectorStore} from './store.mjs';
import {runCloudCollector} from './collector.mjs';
const ROOT='https://wnicimkmzswksaqdtgdv.supabase.co';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
async function equal(first,expected){
  if(typeof first!=='string'||typeof expected!=='string'||expected.length<32||expected.length>512||first.length>512)return false;
  const encoder=new TextEncoder(),hashes=await Promise.all([first,expected].map(value=>crypto.subtle.digest('SHA-256',encoder.encode(value))));
  const [a,b]=hashes.map(value=>new Uint8Array(value));let difference=0;for(let index=0;index<a.length;index++)difference|=a[index]^b[index];return difference===0;
}
function adminKey(environment){try{const keys=JSON.parse(environment('SUPABASE_SECRET_KEYS')||'null');if(typeof keys?.default==='string'&&keys.default)return keys.default;}catch{/* Legacy projects expose a built-in JWT instead. */}return environment('SUPABASE_SERVICE_ROLE_KEY');}
export function createCollectorHandler({environment=name=>globalThis.Deno?.env?.get(name),fetch:request=globalThis.fetch,store:givenStore,pipeline=runCloudCollector,waitUntil,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  return async message=>{
    if(message.headers.has('origin'))return json({error:'COLLECTOR_BROWSER_DENIED'},403);
    if(message.method!=='POST')return json({error:'METHOD_NOT_ALLOWED'},405);
    if(!await equal(message.headers.get('x-arkhen-collector-secret'),environment('ARKHEN_COLLECTOR_SECRET')))return json({error:'COLLECTOR_UNAUTHORIZED'},401);
    const key=adminKey(environment),encryptionKey=environment('ARKHEN_SOURCE_ENCRYPTION_KEY');
    if(!encryptionKey||!givenStore&&(!key||environment('SUPABASE_URL')!==ROOT))return json({error:'COLLECTOR_CONFIGURATION_REQUIRED'},503);
    try{
      let raw='',size=0;const reader=message.body?.getReader(),decoder=new TextDecoder();
      if(reader)try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>1024)return json({error:'BODY_TOO_LARGE'},413);raw+=decoder.decode(part.value,{stream:true});}raw+=decoder.decode();}finally{await reader.cancel().catch(()=>{});}
      if(raw.trim()&&raw.trim()!=='{}')return json({error:'INVALID_OPTIONS'},400);
      const continuation=waitUntil||(globalThis.EdgeRuntime?.waitUntil?promise=>globalThis.EdgeRuntime.waitUntil(promise):null);
      const store=givenStore||new CollectorStore({key,fetch:request}),pending=Promise.resolve().then(()=>pipeline({store,fetch:request,encryptionKey}));
      // pg_net can close its HTTP request while a bounded SQL publication is
      // still finishing. Keep the pipeline alive long enough to release its lease.
      if(continuation)continuation(pending.catch(()=>{}));
      const result=await pending;
      // Cron owns the normal cadence. Fast backfill is an explicit operational
      // choice, and a completed job must never start another worker by itself.
      if(environment('ARKHEN_SYNC_CONTINUATIONS_ENABLED')==='true'&&result.state==='checkpointed'&&continuation)continuation((async()=>{await delay(11000);try{await store.rpc('arkhen_kick_cloud_collector',{});}catch{/* Cron retries a missed continuation. */}})());
      return json(result,result.state==='failed'?503:200);
    }catch{return json({error:'COLLECTOR_FAILED'},503);}
  };
}

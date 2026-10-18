import {catalogSearchRequest} from '../../catalog-search-request.mjs';
import {PRIVATE_PROJECTION_TIMEOUT_MS} from '../../private-projection-budget.mjs';

const HASH=/^[a-f0-9]{64}$/i;
const safe=value=>typeof value==='string'&&/^[A-Za-z0-9_]{1,80}$/.test(value)?value:undefined;

/** Private Home VOD/history projection. Home TV and movie-detail suggestions
 * own different connectors/RPCs; they cannot reset or cancel this reader. */
export class ConectorBibliotecaInicioSupabase{
  constructor({runtime,onStatus=()=>{}}={}){this.runtime=runtime;this.onStatus=onStatus;this.closed=false;this.diagnostics=new WeakMap();this.pending=new Set();this.inflight=new WeakMap();}
  report(state,phase,code,started,error){
    const now=this.runtime.now(),diagnostic={phase,code,elapsedMs:Math.max(0,now-started),
      ...(safe(error?.code)?{transportCode:safe(error.code)}:{}),
      ...(safe(error?.remoteCode)?{remoteCode:safe(error.remoteCode)}:{}),
      ...(Number.isInteger(error?.remoteStatus)?{remoteStatus:error.remoteStatus}:{})};
    this.onStatus(diagnostic);
    const key=JSON.stringify({...diagnostic,elapsedMs:undefined}),previous=this.diagnostics.get(state);
    if(previous?.key===key&&now-previous.at<30000)return;
    this.diagnostics.set(state,{key,at:now});console.warn('[home-library]',JSON.stringify(diagnostic));
  }
  consume(record,signal){
    return new Promise((resolve,reject)=>{
      record.readers++;let done=false;
      const finish=(callback,value)=>{
        if(done)return;done=true;signal?.removeEventListener('abort',cancel);record.readers--;
        if(record.readers===0&&!record.settled)record.controller.abort();
        callback(value);
      };
      const cancel=()=>finish(reject,new DOMException('A consulta do início foi cancelada.','AbortError'));
      signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted){cancel();return;}
      record.promise.then(value=>finish(resolve,value),error=>finish(reject,error));
    });
  }
  async read(state,request={}, {signal}={}){
    const parsed=catalogSearchRequest({query:'home',hidden:request.hidden,hiddenItems:request.hiddenItems}),runtime=this.runtime,started=runtime.now();
    const vod=value=>Object.fromEntries(Object.entries(value).filter(([type])=>type==='movies'||type==='series'));
    const input={hidden:vod(parsed.hidden),hiddenItems:vod(parsed.hiddenItems)};
    if(signal?.aborted)return null;
    if(this.closed||runtime.closed){this.report(state,'precondition','RUNTIME_CLOSED',started);return null;}
    if(!runtime.enabled||!state.cloud?.session?.access_token){this.report(state,'precondition',runtime.enabled?'CLOUD_SESSION_MISSING':'CLOUD_DISABLED',started);return null;}
    const account=state.cloud,{providerKey,scopeHash}=account,client=state.client,generation=state.authGeneration,pin=state.parental?.unlocked===true;
    if(!HASH.test(providerKey||'')||!HASH.test(scopeHash||'')){this.report(state,'precondition','PARTITION_INVALID',started);return null;}
    const key=JSON.stringify([providerKey,scopeHash,pin,input]);
    let entries=this.inflight.get(state);if(!entries){entries=new Map();this.inflight.set(state,entries);}
    let record=entries.get(key);
    if(!record||record.account!==account||record.client!==client||record.generation!==generation||record.pin!==pin||record.controller.signal.aborted){
      record={account,client,generation,pin,controller:new AbortController(),readers:0,settled:false};
      const pending=record;
      pending.promise=Promise.resolve().then(()=>{
        if(pending.controller.signal.aborted)return null;
        return runtime.cloud.request('/rest/v1/rpc/arkhen_home_vod',{
          method:'POST',body:{p_provider_key:providerKey,p_scope_hash:scopeHash,p_include_adult:pin,p_hidden_categories:input.hidden,p_hidden_items:input.hiddenItems},
          publicKey:true,accessToken:account.session.access_token,timeoutMs:PRIVATE_PROJECTION_TIMEOUT_MS,signal:pending.controller.signal,
        });
      }).catch(error=>{
        if(!pending.controller.signal.aborted)this.report(state,'rpc','RPC_REQUEST_FAILED',started,error);
        throw error;
      }).finally(()=>{
        pending.settled=true;this.pending.delete(pending);
        if(entries.get(key)===pending)entries.delete(key);
      });
      entries.set(key,pending);this.pending.add(pending);
    }
    const result=await this.consume(record,signal);
    if(this.closed||runtime.closed||signal?.aborted||state.cloud!==account||state.client!==client||state.authGeneration!==generation||(state.parental?.unlocked===true)!==pin)return null;
    const valid=result?.schemaVersion===1&&result.counts?.live===0&&result.history&&Array.isArray(result.history.live)&&result.history.live.length===0&&Array.isArray(result.favoriteChannels)&&result.favoriteChannels.length===0&&Array.isArray(result.recommendations?.items);
    if(!valid)this.report(state,'rpc',result===null?'RPC_RETURNED_NULL':'RPC_DTO_INVALID',started);
    return valid?result:null;
  }
  close(){this.closed=true;for(const record of this.pending)record.controller.abort();this.pending.clear();this.inflight=new WeakMap();}
}

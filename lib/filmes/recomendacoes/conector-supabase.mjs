import {movieRecommendationsRequest} from './request.mjs';
import {PRIVATE_PROJECTION_TIMEOUT_MS} from '../../private-projection-budget.mjs';

const HASH=/^[a-f0-9]{64}$/i;
const diagnosticCode=value=>typeof value==='string'&&/^[A-Za-z0-9_]{1,80}$/.test(value)?value:undefined;

/** Private movie suggestions only. No Home, TV, catalog collection or playback
 * operation shares these in-flight requests or their cancellation ownership. */
export class ConectorRecomendacoesFilmesSupabase{
  constructor({runtime}={}){this.runtime=runtime;this.closed=false;this.diagnostics=new WeakMap();this.inflight=new WeakMap();this.pending=new Set();}
  report(state,phase,code,started,error){
    const entry={phase,code,elapsedMs:Math.max(0,Math.round(performance.now()-started)),
      ...(diagnosticCode(error?.code)?{transportCode:diagnosticCode(error.code)}:{}),
      ...(diagnosticCode(error?.remoteCode)?{remoteCode:diagnosticCode(error.remoteCode)}:{}),
      ...(diagnosticCode(error?.authCode)?{authCode:diagnosticCode(error.authCode)}:{}),
      ...(Number.isInteger(error?.remoteStatus)?{remoteStatus:error.remoteStatus}:{})};
    // No source ID, partition, account, JWT, request payload or database error
    // text enters diagnostics. Repeated polling failures are bounded per state.
    const key=JSON.stringify({...entry,elapsedMs:undefined}),previous=this.diagnostics.get(state),now=Date.now();
    if(previous?.key===key&&now-previous.at<30000)return;
    this.diagnostics.set(state,{key,at:now});console.warn('[movie-recommendations]',entry);
  }
  consume(record,signal){
    // Preview, playback end and an explicit retry may overlap. They share only
    // an unfinished RPC; no private DTO is cached after it settles. Cancelling
    // one view must not cancel another reader of the same authorized query.
    return new Promise((resolve,reject)=>{
      record.readers++;let done=false;
      const finish=(callback,value)=>{
        if(done)return;done=true;signal?.removeEventListener('abort',cancel);record.readers--;
        if(record.readers===0&&!record.settled)record.controller.abort();
        callback(value);
      };
      const cancel=()=>finish(reject,new DOMException('A consulta de recomendações foi cancelada.','AbortError'));
      signal?.addEventListener('abort',cancel,{once:true});
      if(signal?.aborted){cancel();return;}
      record.promise.then(result=>finish(resolve,result),error=>finish(reject,error));
    });
  }
  async recommendations(state,request={}, {signal}={}){
    const input=movieRecommendationsRequest(request),runtime=this.runtime,started=performance.now();
    if(signal?.aborted)return null;
    if(this.closed||runtime.closed){this.report(state,'precondition','RUNTIME_CLOSED',started);return null;}
    if(!runtime.enabled){this.report(state,'precondition','CLOUD_DISABLED',started);return null;}
    if(!state.cloud?.session?.access_token){this.report(state,'precondition','CLOUD_SESSION_MISSING',started);return null;}
    const account=state.cloud,{providerKey,scopeHash}=account,client=state.client,generation=state.authGeneration,unlocked=state.parental?.unlocked===true;
    if(!HASH.test(providerKey||'')||!HASH.test(scopeHash||'')){this.report(state,'precondition','PARTITION_INVALID',started);return null;}
    const key=JSON.stringify([providerKey,scopeHash,input]);
    let entries=this.inflight.get(state);if(!entries){entries=new Map();this.inflight.set(state,entries);}
    let record=entries.get(key);
    if(!record||record.account!==account||record.client!==client||record.generation!==generation||record.unlocked!==unlocked||record.controller.signal.aborted){
      record={account,client,generation,unlocked,controller:new AbortController(),readers:0,settled:false,failed:false,promise:null};
      const request=record;
      request.promise=Promise.resolve().then(()=>{
        if(request.controller.signal.aborted)return null;
        return runtime.cloud.request('/rest/v1/rpc/arkhen_movie_recommendations',{
          method:'POST',body:{p_provider_key:providerKey,p_scope_hash:scopeHash,p_source_id:input.id,p_limit:input.limit,p_hidden_categories:input.hidden,p_hidden_items:input.hiddenItems},
          publicKey:true,accessToken:account.session.access_token,timeoutMs:PRIVATE_PROJECTION_TIMEOUT_MS,signal:request.controller.signal,
        });
      }).catch(error=>{
        request.failed=true;
        if(!request.controller.signal.aborted&&!this.closed&&!runtime.closed)this.report(state,'rpc','RPC_REQUEST_FAILED',started,error);
        return null;
      }).finally(()=>{
        request.settled=true;this.pending.delete(request);
        if(entries.get(key)===request)entries.delete(key);
      });
      entries.set(key,request);this.pending.add(request);
    }
    const result=await this.consume(record,signal);
    if(this.closed||runtime.closed||state.cloud!==account||state.client!==client||state.authGeneration!==generation||(state.parental?.unlocked===true)!==unlocked||signal?.aborted)return null;
    if(record.failed)return null;
    if(result===null){this.report(state,'rpc','RPC_RETURNED_NULL',started);return null;}
    const valid=result?.schemaVersion===1&&result.rankingVersion===2&&result.identityVersion===2&&result.source==='rpc'&&result.sourceId===input.id&&Array.isArray(result.items)&&result.items.length<=input.limit&&result.items.every(item=>item?.kind==='movie'&&typeof item.id==='string'&&item.id!==input.id&&item.isAdult===false);
    if(!valid){this.report(state,'dto','RPC_DTO_INVALID',started);return null;}
    return result;
  }
  close(){this.closed=true;for(const record of this.pending)record.controller.abort();this.pending.clear();this.inflight=new WeakMap();}
}

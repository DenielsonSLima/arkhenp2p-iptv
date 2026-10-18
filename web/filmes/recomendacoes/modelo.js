import {withRequestSignals} from '../../request-signals.js';
import {isAdultItem} from '../../parental-classification.js';
import {movieID,movieScope,movieScopeKey} from '../scope.js';
import {MOVIE_RECOMMENDATION_LIMIT,MOVIE_RECOMMENDATION_RANKING_VERSION,MOVIE_RECOMMENDATION_IDENTITY_VERSION,recommendationReply,recommendationUnavailable} from './contrato.js';

const cancelled=()=>new DOMException('A consulta foi cancelada.','AbortError');
const unavailable=recommendationUnavailable;
export const movieRecommendationQueryKey=scope=>['arkhen-movie-recommendations',movieScopeKey(scope)];
/** Cache server-ranked API results. Preview/end share work, not cancellation;
 * outages retain a destination's prior valid DTO instead of ranking locally. */
export class MovieRecommendationsModel{
  constructor({request,services=null,getScope,getRevision=()=>'',requestTimeoutMs=12000,loadQueryCore=()=>import('/assets/vendor/cloud-client.js'),now=Date.now}={}){
    Object.assign(this,{request:services?.api||request,getScope,getRevision,loadQueryCore,now});
    // The RPC has an 8 s SQL budget and a 10 s server transport budget. This
    // outer deadline leaves time for local routing without changing playback.
    this.requestTimeoutMs=Number.isFinite(requestTimeoutMs)?Math.max(500,Math.min(15000,requestTimeoutMs)):12000;
    this.scope=null;this.epoch=0;this.jobs=new Map();this.failures=new Map();this.client=null;this.clientPromise=null;this.disposed=false;
  }
  reset(){
    this.epoch++;for(const job of this.jobs.values())job.controller.abort();this.jobs.clear();this.failures.clear();
    this.scope=null;void this.client?.cancelQueries();this.client?.clear();
  }
  async queries(){
    if(!this.clientPromise)this.clientPromise=Promise.resolve().then(()=>this.loadQueryCore()).then(({QueryClient})=>this.client=new QueryClient({defaultOptions:{queries:{retry:0,staleTime:60000,gcTime:Infinity,refetchOnWindowFocus:false,refetchOnReconnect:false,structuralSharing:false}}})).catch(()=>null);
    return this.clientPromise;
  }
  // Read only an already validated RPC result from this exact owner/filter
  // partition. A failed refresh never turns cached recommendations into empty.
  // A previous catalogue revision can remain visible while its successor loads.
  peek(item,{limit=MOVIE_RECOMMENDATION_LIMIT}={}){
    const id=movieID(item),scope=movieScope(this.getScope()),scopeKey=movieScopeKey(scope);
    if(this.disposed||!id||isAdultItem(item)||!scopeKey||scopeKey!==this.scope)return null;
    const entries=(this.client?.getQueryCache().getAll()||[]).filter(query=>{
      const key=query.queryKey;
      return key[0]==='arkhen-movie-recommendations'&&key[1]===scopeKey&&key[2]===MOVIE_RECOMMENDATION_RANKING_VERSION&&
        key[3]===MOVIE_RECOMMENDATION_IDENTITY_VERSION&&key[5]===id&&query.state.data;
    }).sort((a,b)=>b.state.dataUpdatedAt-a.state.dataUpdatedAt);
    for(const query of entries){
      try{
        const value=recommendationReply(query.state.data,id),maximum=Number.isInteger(limit)?Math.min(MOVIE_RECOMMENDATION_LIMIT,Math.max(1,limit)):MOVIE_RECOMMENDATION_LIMIT;
        return {...value,items:value.items.slice(0,maximum)};
      }catch{/* Invalid cache entries cannot supply a presentation fallback. */}
    }
    return null;
  }
  lookup(item,{signal,limit=MOVIE_RECOMMENDATION_LIMIT,force=false}={}){
    if(signal?.aborted)return Promise.reject(cancelled());
    const id=movieID(item),scope=movieScope(this.getScope());
    if(this.disposed||!id||isAdultItem(item)||!scope?.account){if(this.scope!==null)this.reset();return Promise.reject(unavailable());}
    const scopeKey=JSON.stringify(scope);
    if(this.scope!==scopeKey){this.reset();this.scope=scopeKey;}
    const failureKey=JSON.stringify([scopeKey,id]),failure=this.failures.get(failureKey);
    // Automatic recovery/revision churn shares one transient pause per movie.
    // An explicit click may retry 5xx immediately; a provider's 429 is binding.
    if(failure?.until>this.now()&&(!force||failure.error.status===429))return Promise.reject(unavailable({...failure.error,retryAfterSeconds:Math.ceil((failure.until-this.now())/1000)}));
    const epoch=this.epoch,revision=JSON.stringify(this.getRevision()),queryKey=[...movieRecommendationQueryKey(scope),MOVIE_RECOMMENDATION_RANKING_VERSION,MOVIE_RECOMMENDATION_IDENTITY_VERSION,revision,id],key=JSON.stringify(queryKey);
    let job=this.jobs.get(key);
    if(!job||job.controller.signal.aborted){
      job={controller:new AbortController(),consumers:new Set(),settled:false};this.jobs.set(key,job);
      const current=()=>!this.disposed&&this.epoch===epoch&&!job.controller.signal.aborted&&movieScopeKey(this.getScope())===scopeKey;
      job.promise=(async()=>{
        let sdkDeadline;
        const client=await Promise.race([this.queries(),new Promise(resolve=>{sdkDeadline=setTimeout(()=>resolve(null),500);})]);
        clearTimeout(sdkDeadline);if(!current())throw cancelled();
        const run=async({signal:querySignal}={})=>{
          const input={id,limit:MOVIE_RECOMMENDATION_LIMIT,hidden:scope.hidden||{},hiddenItems:scope.hiddenItems||{}},deadline=new AbortController();
          const timer=setTimeout(()=>deadline.abort(),this.requestTimeoutMs);timer.unref?.();
          try{
            const value=await withRequestSignals([querySignal,job.controller.signal,deadline.signal],combined=>this.request('/api/recommendations/movie',{method:'POST',body:JSON.stringify(input),signal:combined}));
            return recommendationReply(value,id);
          }catch(error){
            if(deadline.signal.aborted&&!job.controller.signal.aborted&&!querySignal?.aborted)throw unavailable({code:'MOVIE_RECOMMENDATIONS_TIMEOUT',phase:'transport',status:504});
            throw error;
          }finally{clearTimeout(timer);}
        };
        const value=client?await client.fetchQuery({queryKey,queryFn:run,staleTime:force?0:60000}):await run();
        if(!current())throw cancelled();this.failures.delete(failureKey);
        const cached=(client?.getQueryCache().getAll()||[]).filter(query=>query.queryKey[0]==='arkhen-movie-recommendations');
        for(const query of cached.filter(query=>!this.jobs.has(JSON.stringify(query.queryKey))).sort((a,b)=>a.state.dataUpdatedAt-b.state.dataUpdatedAt).slice(0,Math.max(0,cached.length-8)))client.removeQueries({queryKey:query.queryKey,exact:true});
        return value;
      })().catch(error=>{
        const status=Number(error?.status);
        if(current()&&error?.name!=='AbortError'&&(!status||status===429||status>=500)){
          const previous=this.failures.get(failureKey),attempts=(previous?.attempts||0)+1;
          const pause=status===429&&Number.isFinite(error.retryAfterSeconds)?Math.max(1,Math.min(86400,error.retryAfterSeconds))*1000:
            Math.min(300000,30000*2**Math.min(attempts-1,4));
          this.failures.delete(failureKey);this.failures.set(failureKey,{until:this.now()+pause,attempts,error:unavailable(error)});
          while(this.failures.size>32)this.failures.delete(this.failures.keys().next().value);
        }
        throw error;
      }).finally(()=>{job.settled=true;if(this.jobs.get(key)===job)this.jobs.delete(key);});
    }
    const maximum=Number.isInteger(limit)?Math.min(MOVIE_RECOMMENDATION_LIMIT,Math.max(1,limit)):MOVIE_RECOMMENDATION_LIMIT;
    return new Promise((resolve,reject)=>{
      const consumer={};job.consumers.add(consumer);let settled=false;
      const finish=(error,value)=>{
        if(settled)return;settled=true;signal?.removeEventListener('abort',abort);job.consumers.delete(consumer);
        if(!error&&(this.epoch!==epoch||movieScopeKey(this.getScope())!==scopeKey))error=cancelled();
        if(!job.settled&&!job.consumers.size){job.controller.abort();void this.client?.cancelQueries({queryKey,exact:true});}
        if(error)reject(error);else resolve({...value,items:value.items.slice(0,maximum)});
      };
      const abort=()=>finish(cancelled());signal?.addEventListener('abort',abort,{once:true});
      job.promise.then(value=>finish(null,value),error=>finish(error?.name==='AbortError'?error:unavailable(error)));
      if(signal?.aborted)abort();
    });
  }
  invalidate(){void this.client?.invalidateQueries({queryKey:['arkhen-movie-recommendations'],refetchType:'none'});}
  dispose(){this.disposed=true;this.reset();}
}

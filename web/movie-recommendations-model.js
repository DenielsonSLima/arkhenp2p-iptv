import {withRequestSignals} from './request-signals.js';
import {isAdultItem} from './parental-classification.js';

const cancelled=()=>new DOMException('A consulta foi cancelada.','AbortError');
const unavailable=()=>Object.assign(new Error('Não foi possível carregar as recomendações agora.'),{code:'MOVIE_RECOMMENDATIONS_UNAVAILABLE'});
const movieID=item=>item?.kind==='movie'&&/^\d{1,12}$/.test(String(item.id??''))?String(item.id):null;

/** Cache private RPC results. Ranking and similarity stay in PostgreSQL; a
 * preview and an end screen share one request without sharing cancellation. */
export class MovieRecommendationsModel{
  constructor({request,getScope,getRevision=()=>'',loadQueryCore=()=>import('/assets/vendor/cloud-client.js')}={}){
    Object.assign(this,{request,getScope,getRevision,loadQueryCore});
    this.scope=null;this.epoch=0;this.jobs=new Map();this.client=null;this.clientPromise=null;this.disposed=false;
  }
  reset(){
    this.epoch++;for(const job of this.jobs.values())job.controller.abort();this.jobs.clear();
    this.scope=null;void this.client?.cancelQueries();this.client?.clear();
  }
  async queries(){
    if(!this.clientPromise)this.clientPromise=Promise.resolve().then(()=>this.loadQueryCore()).then(({QueryClient})=>this.client=new QueryClient({defaultOptions:{queries:{retry:0,staleTime:60000,gcTime:Infinity,refetchOnWindowFocus:false,refetchOnReconnect:false,structuralSharing:false}}})).catch(()=>null);
    return this.clientPromise;
  }
  lookup(item,{signal,limit=3,force=false}={}){
    if(signal?.aborted)return Promise.reject(cancelled());
    const id=movieID(item),scope=this.getScope();
    if(this.disposed||!id||isAdultItem(item)||!scope?.account){if(this.scope!==null)this.reset();return Promise.reject(unavailable());}
    const scopeKey=JSON.stringify(scope);
    if(this.scope!==scopeKey){this.reset();this.scope=scopeKey;}
    const epoch=this.epoch,revision=JSON.stringify(this.getRevision()),queryKey=['arkhen-movie-recommendations',scopeKey,revision,id],key=JSON.stringify(queryKey);
    let job=this.jobs.get(key);
    if(!job||job.controller.signal.aborted){
      job={controller:new AbortController(),consumers:new Set(),settled:false};this.jobs.set(key,job);
      const current=()=>!this.disposed&&this.epoch===epoch&&!job.controller.signal.aborted&&JSON.stringify(this.getScope())===scopeKey;
      job.promise=(async()=>{
        const client=await this.queries();if(!current())throw cancelled();
        const run=async({signal:querySignal}={})=>{
          const value=await withRequestSignals([querySignal,job.controller.signal],combined=>this.request('/api/recommendations/movie',{method:'POST',body:JSON.stringify({id,limit:12,hidden:scope.hidden||{},hiddenItems:scope.hiddenItems||{}}),signal:combined}));
          if(value?.schemaVersion!==1||String(value.sourceId)!==id||!Array.isArray(value.items)||value.items.length>12)throw unavailable();
          const seen=new Set();
          for(const candidate of value.items){const candidateId=movieID(candidate);if(!candidateId||candidateId===id||seen.has(candidateId)||isAdultItem(candidate)||typeof candidate.name!=='string'||!candidate.name.trim())throw unavailable();seen.add(candidateId);}
          return value;
        };
        const value=client?await client.fetchQuery({queryKey,queryFn:run,staleTime:force?0:60000}):await run();
        if(!current())throw cancelled();
        const cached=client?.getQueryCache().getAll()||[];
        for(const query of cached.filter(query=>!this.jobs.has(JSON.stringify(query.queryKey))).sort((a,b)=>a.state.dataUpdatedAt-b.state.dataUpdatedAt).slice(0,Math.max(0,cached.length-8)))client.removeQueries({queryKey:query.queryKey,exact:true});
        return value;
      })().finally(()=>{job.settled=true;if(this.jobs.get(key)===job)this.jobs.delete(key);});
    }
    const maximum=Number.isInteger(limit)?Math.min(12,Math.max(1,limit)):3;
    return new Promise((resolve,reject)=>{
      const consumer={};job.consumers.add(consumer);let settled=false;
      const finish=(error,value)=>{
        if(settled)return;settled=true;signal?.removeEventListener('abort',abort);job.consumers.delete(consumer);
        if(!error&&(this.epoch!==epoch||JSON.stringify(this.getScope())!==scopeKey))error=cancelled();
        if(!job.settled&&!job.consumers.size){job.controller.abort();void this.client?.cancelQueries({queryKey,exact:true});}
        if(error)reject(error);else resolve({...value,items:value.items.slice(0,maximum)});
      };
      const abort=()=>finish(cancelled());signal?.addEventListener('abort',abort,{once:true});
      job.promise.then(value=>finish(null,value),error=>finish(error?.name==='AbortError'?error:unavailable()));
      if(signal?.aborted)abort();
    });
  }
  dispose(){this.disposed=true;this.reset();}
}

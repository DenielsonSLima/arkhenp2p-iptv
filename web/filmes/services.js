import {CatalogTabServices} from '../sistema/catalogo/services.js';
import {withRequestSignals} from '../request-signals.js';
import {movieID,movieScope,movieScopeKey} from './scope.js';
import {MOVIE_RECOMMENDATION_LIMIT} from './recomendacoes/contrato.js';

const cancelled=()=>new DOMException('A consulta do filme foi encerrada.','AbortError');
const metadataScopeKey=value=>{
  const scope=movieScope(value);return scope?JSON.stringify({account:scope.account,epoch:scope.epoch,includeAdult:scope.includeAdult,
    hidden:scope.hidden,hiddenItems:scope.hiddenItems}):null;
};

/** Movie catalogue loads retain the existing repository. Detail/duration and
 * recommendation requests use the same authenticated local JSON transport,
 * without opening video or initializing any TV metadata/engine. */
export class MoviesServices extends CatalogTabServices{
  constructor({request,getScope=()=>null,...catalog}={}){
    super('movies',catalog);Object.assign(this,{request,getScope});
    this.scopes=new Map();this.epoch=0;this.metadataRevision=0;this.jobs=new Map();this.detailsCache=new Map();
    this.api=(path,options={})=>{
      const url=new URL(path,'http://arkhen.local');
      if(url.pathname==='/api/details'&&url.searchParams.get('type')==='movie')return this.details({kind:'movie',id:url.searchParams.get('id')},
        {duration:url.searchParams.get('duration')==='1',signal:options.signal});
      if(url.pathname==='/api/recommendations/movie'){
        let input;try{input=JSON.parse(options.body||'{}');}catch{return Promise.reject(new TypeError('Parâmetros de sugestões inválidos.'));}
        return this.recommendations(input,{signal:options.signal});
      }
      return Promise.reject(new Error('MOVIES_SERVICE_ROUTE_UNSUPPORTED'));
    };
  }
  configure({request=this.request,getScope=this.getScope}={}){this.reset();Object.assign(this,{request,getScope});return this;}
  synchronizeScope(partition='recommendations',scopeFor=movieScopeKey){
    const key=scopeFor(this.getScope());
    if(key!==this.scopes.get(partition)){
      for(const [id,job] of this.jobs)if(job.partition===partition){job.controller.abort();this.jobs.delete(id);}
      if(partition==='details'){this.detailsCache.clear();this.metadataRevision++;}this.scopes.set(partition,key);
    }
    return key;
  }
  #current(job){return job.epoch===this.epoch&&job.scope===job.scopeFor(this.getScope())&&!job.controller.signal.aborted;}
  #read(key,path,options={},prepare=value=>value,{partition='recommendations',scopeFor=movieScopeKey}={}){
    const scope=this.synchronizeScope(partition,scopeFor),signal=options.signal;
    if(!scope||signal?.aborted||typeof this.request!=='function')return Promise.reject(cancelled());
    const jobKey=partition+':'+key;let job=this.jobs.get(jobKey);
    if(job?.controller.signal.aborted||job?.settled){this.jobs.delete(jobKey);job=null;}
    if(!job){
      job={scope,partition,scopeFor,epoch:this.epoch,controller:new AbortController(),readers:0,settled:false};this.jobs.set(jobKey,job);
      job.promise=Promise.resolve().then(()=>{
        if(!this.#current(job))throw cancelled();return this.request(path,{...options,signal:job.controller.signal});
      }).then(value=>{if(!this.#current(job))throw cancelled();return prepare(value);})
        .finally(()=>{job.settled=true;if(this.jobs.get(jobKey)===job)this.jobs.delete(jobKey);});
    }
    job.readers++;
    return withRequestSignals([signal,job.controller.signal],combined=>new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(error,value)=>{
        if(settled)return;settled=true;combined?.removeEventListener('abort',abort);job.readers--;
        if(!job.readers&&!job.settled){if(this.jobs.get(jobKey)===job)this.jobs.delete(jobKey);job.controller.abort();}
        if(error)reject(error);else resolve(value);
      };
      const abort=()=>finish(cancelled());combined?.addEventListener('abort',abort,{once:true});
      if(combined?.aborted){abort();return;}job.promise.then(value=>finish(null,value),error=>finish(error));
    }));
  }
  details(item,{duration=false,signal,force=false}={}){
    const id=movieID(item);if(!id)return Promise.reject(new TypeError('Filme inválido.'));
    // The local provider session was already validated. Attaching the cloud
    // bootstrap later must not cancel this same account's selected preview.
    this.synchronizeScope('details',metadataScopeKey);const key=id+(duration?':duration':''),cacheRevision=this.metadataRevision;
    if(!force&&!signal?.aborted&&this.detailsCache.has(key))return Promise.resolve(this.detailsCache.get(key));
    const path='/api/details?type=movie&id='+encodeURIComponent(id)+(duration?'&duration=1':'');
    return this.#read('details:'+key+':'+cacheRevision,path,{signal},value=>{
      if(!value||typeof value!=='object'||Array.isArray(value)||value.id!=null&&String(value.id)!==id||value.kind!=null&&value.kind!=='movie')throw new Error('MOVIE_DETAILS_RESPONSE_INVALID');
      if(cacheRevision!==this.metadataRevision)return value;
      // A slower ordinary detail reader cannot erase a duration already
      // returned by the selected movie's bounded measurement request.
      const measured=!duration&&this.detailsCache.get(id+':duration'),result=measured?{...value,
        ...(Number.isFinite(measured.durationSeconds)&&measured.durationSeconds>0?{durationSeconds:measured.durationSeconds}:{}),
        ...(typeof measured.duration==='string'&&measured.duration.trim()?{duration:measured.duration}:{})}:value;
      this.detailsCache.delete(key);this.detailsCache.set(key,result);
      if(duration){this.detailsCache.delete(id);this.detailsCache.set(id,result);}
      while(this.detailsCache.size>64)this.detailsCache.delete(this.detailsCache.keys().next().value);return result;
    },{partition:'details',scopeFor:metadataScopeKey});
  }
  recommendations(input,{signal}={}){
    const id=movieID({kind:'movie',id:input?.id}),scope=movieScope(this.getScope());
    if(!id||!scope)return Promise.reject(new TypeError('Filme inválido.'));
    const body={id,limit:MOVIE_RECOMMENDATION_LIMIT,hidden:scope.hidden,hiddenItems:scope.hiddenItems};
    return this.#read('recommendations:'+id,'/api/recommendations/movie',{method:'POST',body:JSON.stringify(body),signal});
  }
  playbackURL(item,{attempt=''}={}){
    const id=movieID(item);if(!id)throw new TypeError('Filme inválido.');
    if(typeof attempt!=='string'||attempt&&!/^[A-Za-z0-9_-]{1,128}$/.test(attempt))throw new TypeError('Tentativa de reprodução inválida.');
    const supplied=String(item.container||'mp4').toLowerCase(),container=/^[a-z0-9]{1,12}$/.test(supplied)?supplied:'mp4';
    const params=new URLSearchParams();if(attempt)params.set('attempt',attempt);
    return `/api/play/movie/${encodeURIComponent(id)}.${container}${params.size?'?'+params:''}`;
  }
  invalidate(){
    this.metadataRevision++;this.detailsCache.clear();
    // Registry publication changes future metadata/cache reads. It does not
    // abandon the already selected preview's authorized provider response.
    for(const [id,job] of this.jobs)if(job.partition==='recommendations'){job.controller.abort();this.jobs.delete(id);}
    this.scopes.delete('recommendations');
  }
  reset(){this.epoch++;this.metadataRevision++;for(const job of this.jobs.values())job.controller.abort();this.jobs.clear();this.detailsCache.clear();this.scopes.clear();}
  dispose(){this.reset();}
}

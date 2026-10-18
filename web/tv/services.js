import {withRequestSignals} from '../request-signals.js';
import {tvScopeKey} from './scope.js';

const cancelled=()=>new DOMException('A consulta de TV foi encerrada.','AbortError');
const scopeKey=tvScopeKey;
const channelID=value=>/^\d{1,12}$/.test(String(value??''))?String(value):null;
const sourceID=value=>typeof value==='string'&&/^[nwo]_[a-f0-9]{28}$/.test(value);
const boundedNumber=(value,max)=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=max?value:null;

/** Keep only public descriptors. Playback addresses and provider credentials
 * remain behind the authenticated same-origin playback routes. */
function sourceCatalog(value,id){
  if(String(value?.channelId)!==id||!Array.isArray(value.sources)||value.sources.length>128)throw new Error('TV_SOURCES_RESPONSE_INVALID');
  const ids=new Set(),sources=value.sources.map(source=>{
    if(!sourceID(source?.id)||ids.has(source.id)||typeof source.label!=='string')throw new Error('TV_SOURCES_RESPONSE_INVALID');
    ids.add(source.id);const result={id:source.id,label:source.label.slice(0,200),available:source.available===true};
    for(const field of ['quality','videoCodec','reason'])if(typeof source[field]==='string')result[field]=source[field].slice(0,100);
    for(const [field,max] of [['declaredWidth',16384],['declaredHeight',16384],['frameRate',240],['bitrateBps',1e12]]){
      const number=boundedNumber(source[field],max);if(number!==null)result[field]=number;
    }
    return result;
  });
  return {channelId:id,revision:typeof value.revision==='string'?value.revision:'',
    selectedSourceId:sources.some(source=>source.available&&source.id===value.selectedSourceId)?value.selectedSourceId:null,sources};
}

/** Same-origin TV metadata transport. It has no provider login, media engine,
 * library Auth client or independent catalogue repository. Scope/abort owns every reader. */
export class TVServices{
  constructor({request,getScope=()=>null,now=Date.now}={}){
    Object.assign(this,{request,getScope,now});this.scope=null;this.epoch=0;this.jobs=new Map();this.sources=new Map();
    this.api=(path,options={})=>{
      const url=new URL(path,'http://arkhen.local');
      if(url.pathname==='/api/tv/guide')return this.guide({signal:options.signal,fresh:url.searchParams.get('fresh')==='1',ids:url.searchParams.has('ids')?url.searchParams.get('ids').split(','):null});
      if(url.pathname==='/api/live/sources')return this.liveSources(url.searchParams.get('id'),{signal:options.signal});
      if(url.pathname==='/api/games')return this.games({date:url.searchParams.get('date'),timeZone:url.searchParams.get('timezone')||'UTC',lang:url.searchParams.get('lang')||'pt',signal:options.signal});
      if(url.pathname==='/api/catalog'&&url.searchParams.get('type')==='live')return this.catalog({force:url.searchParams.get('refresh')==='1',revalidate:url.searchParams.get('cache')==='reload',paged:url.searchParams.get('paged')==='1',signal:options.signal});
      return Promise.reject(new Error('TV_SERVICE_ROUTE_UNSUPPORTED'));
    };
  }
  synchronizeScope(){
    const key=scopeKey(this.getScope());if(key!==this.scope){this.reset();this.scope=key;}return key;
  }
  reset(){this.epoch++;for(const job of this.jobs.values())job.controller.abort();this.jobs.clear();this.sources.clear();this.scope=null;}
  #current(job){return job.epoch===this.epoch&&job.scope===scopeKey(this.getScope())&&!job.controller.signal.aborted;}
  #read(key,path,{signal,prepare=value=>value}={}){
    const scope=this.synchronizeScope();if(!scope||signal?.aborted||typeof this.request!=='function')return Promise.reject(cancelled());
    let job=this.jobs.get(key);
    if(job?.controller.signal.aborted||job?.settled){this.jobs.delete(key);job=null;}
    if(!job){
      job={scope,epoch:this.epoch,controller:new AbortController(),readers:0,settled:false,promise:null};this.jobs.set(key,job);
      job.promise=Promise.resolve().then(()=>{
        if(!this.#current(job))throw cancelled();return this.request(path,{signal:job.controller.signal});
      }).then(value=>{
        if(!this.#current(job))throw cancelled();return prepare(value);
      }).finally(()=>{job.settled=true;if(this.jobs.get(key)===job)this.jobs.delete(key);});
    }
    job.readers++;
    return withRequestSignals([signal,job.controller.signal],combined=>new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(error,value)=>{
        if(settled)return;settled=true;combined?.removeEventListener('abort',abort);job.readers--;
        if(!job.readers&&!job.settled){if(this.jobs.get(key)===job)this.jobs.delete(key);job.controller.abort();}
        if(error)reject(error);else resolve(value);
      };
      const abort=()=>finish(cancelled());combined?.addEventListener('abort',abort,{once:true});
      if(combined?.aborted){abort();return;}job.promise.then(value=>finish(null,value),error=>finish(error));
    }));
  }
  guide({signal,fresh=false,ids=null}={}){
    if(ids!==null&&(!Array.isArray(ids)||!ids.length||ids.length>2000||ids.some(id=>!channelID(id))))return Promise.reject(new TypeError('Lista de canais inválida.'));
    const params=new URLSearchParams();if(fresh)params.set('fresh','1');if(ids!==null)params.set('ids',[...new Set(ids.map(String))].sort().join(','));
    return this.#read('guide:'+params,'/api/tv/guide'+(params.size?'?'+params:''),{signal});
  }
  catalog({force=false,revalidate=false,paged=false,signal}={}){
    const params=new URLSearchParams({type:'live'});if(paged)params.set('paged','1');
    if(force)params.set('refresh','1');else if(revalidate)params.set('cache','reload');
    return this.#read('catalog:'+params,'/api/catalog?'+params,{signal});
  }
  games({date,timeZone='UTC',lang='pt',signal}={}){
    const params=new URLSearchParams({timezone:timeZone,lang});if(date)params.set('date',date);
    return this.#read('games:'+params,'/api/games?'+params,{signal});
  }
  liveSources(value,{signal,force=false}={}){
    const id=channelID(value);if(!id)return Promise.reject(new TypeError('Canal de TV inválido.'));
    this.synchronizeScope();const cached=this.sources.get(id);
    if(!force&&!signal?.aborted&&cached?.expiresAt>this.now())return Promise.resolve(cached.value);
    return this.#read('sources:'+id,'/api/live/sources?id='+encodeURIComponent(id),{signal,prepare:data=>{
      const result=sourceCatalog(data,id);this.sources.delete(id);this.sources.set(id,{value:result,expiresAt:this.now()+30_000});
      while(this.sources.size>64)this.sources.delete(this.sources.keys().next().value);return result;
    }});
  }
  dispose(){this.reset();}
}

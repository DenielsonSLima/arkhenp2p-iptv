import {CatalogTabServices} from '../sistema/catalogo/services.js';
import {SeriesReadHooks} from './hooks.js';
import {seriesID} from './scope.js';

/** Catalogue storage remains in the shared repository. Selected series
 * details use the existing authenticated API, never a TV or movie reader. */
export class SeriesServices extends CatalogTabServices{
  constructor({request,getScope=()=>null,...catalog}={}){
    super('series',catalog);Object.assign(this,{request,getScope});
    this.readers=new SeriesReadHooks({getScope:()=>this.getScope()});this.detailsCache=new Map();this.cacheScope=null;this.revision=0;
  }
  configure({request=this.request,getScope=this.getScope}={}){this.reset();Object.assign(this,{request,getScope});return this;}
  synchronize(){
    const scope=this.readers.synchronize();
    if(scope!==this.cacheScope){this.detailsCache.clear();this.cacheScope=scope;this.revision++;}return scope;
  }
  peekDetails(item){const id=seriesID(item);return id&&this.synchronize()?this.detailsCache.get(id)||null:null;}
  details(item,{signal,force=false}={}){
    const id=seriesID(item);if(!id)return Promise.reject(new TypeError('Série inválida.'));
    if(!this.synchronize()||typeof this.request!=='function'||signal?.aborted)return Promise.reject(new DOMException('A consulta da série foi encerrada.','AbortError'));
    if(!force&&this.detailsCache.has(id))return Promise.resolve(this.detailsCache.get(id));
    const revision=this.revision;
    return this.readers.read(`details:${revision}:${id}`,async combined=>{
      const value=await this.request('/api/details?type=series&id='+encodeURIComponent(id),{signal:combined});
      if(!value||typeof value!=='object'||Array.isArray(value)||value.id!=null&&String(value.id)!==id||value.kind!=null&&value.kind!=='series')throw new Error('SERIES_DETAILS_RESPONSE_INVALID');
      return value;
    },{signal}).then(value=>{
      // A publication invalidates future reads; the selected preview may
      // still finish its authorized request without repopulating that cache.
      if(revision===this.revision){this.detailsCache.delete(id);this.detailsCache.set(id,value);while(this.detailsCache.size>64)this.detailsCache.delete(this.detailsCache.keys().next().value);}
      return value;
    });
  }
  playbackURL(item,{episode,attempt=''}={}){
    const id=seriesID(item),episodeId=String(episode?.id??'');
    if(!id||!/^\d{1,12}$/.test(episodeId))throw new TypeError('Série ou episódio inválido.');
    if(typeof attempt!=='string'||attempt&&!/^[A-Za-z0-9_-]{1,128}$/.test(attempt))throw new TypeError('Tentativa de reprodução inválida.');
    const container=String(episode?.container||item.container||'mp4').toLowerCase();
    if(!/^[a-z0-9]{1,12}$/.test(container))throw new TypeError('Formato do episódio inválido.');
    const params=new URLSearchParams();if(attempt)params.set('attempt',attempt);
    return `/api/play/series/${episodeId}.${container}${params.size?'?'+params:''}`;
  }
  invalidate(){this.revision++;this.detailsCache.clear();}
  reset(){this.revision++;this.readers?.reset();this.detailsCache?.clear();this.cacheScope=null;}
  dispose(){this.reset();}
}

import {seriesID,seriesMetadataScopeKey,seriesScopeKey} from './scope.js';

export const seriesQueryKeys=Object.freeze({
  all:['arkhen-series'],
  details:(scope,revision,id)=>['arkhen-series','details',seriesMetadataScopeKey(scope),revision,id],
  favorites:scope=>['arkhen-series','favorites',seriesScopeKey(scope)],
  progress:scope=>['arkhen-series','progress',seriesScopeKey(scope)],
});

/** Borrow the existing application's QueryClient. Metadata IO/coalescing is
 * owned by SeriesServices, so no extra SDK/client or parallel fetch is made. */
export class SeriesQueries{
  constructor({services,getScope=()=>null,getQueryClient=()=>null,maxEntries=64}={}){
    Object.assign(this,{services,getScope,getQueryClient});this.revision=0;this.epoch=0;this.maxEntries=Number.isSafeInteger(maxEntries)?Math.max(1,Math.min(64,maxEntries)):64;
  }
  key(item){return seriesQueryKeys.details(this.getScope(),this.revision,seriesID(item));}
  remember(key,value){
    const client=this.getQueryClient();if(!client||client.getQueryData(key)===value)return;
    client.setQueryData(key,value);
    const queries=(client.getQueryCache?.()?.getAll?.()||[]).filter(query=>query.queryKey?.[0]==='arkhen-series'&&query.queryKey?.[1]==='details');
    for(const query of queries.sort((a,b)=>a.state.dataUpdatedAt-b.state.dataUpdatedAt).slice(0,Math.max(0,queries.length-this.maxEntries)))client.removeQueries({queryKey:query.queryKey,exact:true});
  }
  peek(item){
    const id=seriesID(item);if(!id||!seriesMetadataScopeKey(this.getScope()))return null;
    return this.getQueryClient()?.getQueryData(this.key(item))||this.services.peekDetails(item);
  }
  async lookup(item,{signal,force=false}={}){
    const id=seriesID(item),scope=seriesMetadataScopeKey(this.getScope()),epoch=this.epoch,revision=this.revision;
    if(!id||!scope||signal?.aborted)throw new DOMException('A consulta da série foi encerrada.','AbortError');
    const queryKey=this.key(item),cached=!force&&this.peek(item);if(cached){this.remember(queryKey,cached);return cached;}
    const value=await this.services.details(item,{signal,force});
    if(signal?.aborted||epoch!==this.epoch||scope!==seriesMetadataScopeKey(this.getScope()))throw new DOMException('A consulta da série foi encerrada.','AbortError');
    if(revision===this.revision)this.remember(queryKey,value);return value;
  }
  invalidate(partition='details'){
    if(partition==='details'){this.revision++;this.services.invalidate();}
    void this.getQueryClient()?.invalidateQueries({queryKey:['arkhen-series',partition],refetchType:'none'});
  }
  reset(){this.epoch++;this.revision++;this.getQueryClient()?.removeQueries({queryKey:seriesQueryKeys.all});}
}

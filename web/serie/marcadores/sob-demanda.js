import {resolveMarkerSeries,markerEpisodeNumbers} from '../../series-markers/index.js';
import {SeriesMarkerSupabase} from './supabase.js';
import {fingerprintSource} from '../../episode-skip.js';
import {markerRequest,markerRequestKey,validEpisodeReference} from './referencia.js';

const storageKey='arkhen.series-episode-references.v1';
const storage=()=>{try{return globalThis.localStorage;}catch{return null;}};
const cancelled=()=>new DOMException('Consulta do episódio cancelada.','AbortError');

/** The player calls this only after playing. No catalogue/preview consumer. */
export class EpisodeOnDemandReader{
  constructor({request,getCloud=()=>null,getNamespace=()=>'',storage:device=storage(),now=Date.now}={}){
    Object.assign(this,{request,getCloud,getNamespace,device,now});this.cache=new Map();this.identities=new Map();this.epoch=0;
    this.cloud=new SeriesMarkerSupabase({getCloud,getNamespace});
    try{const text=device?.getItem(storageKey);if(text&&text.length<=262144){const saved=JSON.parse(text);if(saved.version===1)for(const row of saved.entries.slice(-120)){
      if(/^[a-f0-9]{16}$/.test(row.key)&&row.expires>now()&&row.expires<=now()+86400000&&validEpisodeReference(row.value,row.value))this.cache.set(row.key,row);
    }}}catch{/* A disabled/full device cache must not block playback. */}
  }
  reset(){this.epoch++;this.identities.clear();}
  save(key,value,namespace){
    const ttl=Math.min(value.status==='reference'?86400:value.status==='empty'?3600:60,Number(value.ttlSeconds)||60);
    this.cache.delete(key);this.cache.set(key,{key,value,expires:this.now()+ttl*1000,persistent:/^[a-f0-9]{64}$/i.test(namespace)});
    while(this.cache.size>120)this.cache.delete(this.cache.keys().next().value);
    try{this.device?.setItem(storageKey,JSON.stringify({version:1,entries:[...this.cache.values()].filter(row=>row.persistent&&row.expires>this.now())}));}catch{}
  }
  async lookup(context={}){
    if(context.playing!==true)return {status:'unavailable',reason:'playback-required',markers:null};
    const epoch=this.epoch,namespace=String(this.getNamespace()),signal=context.signal;
    const check=()=>{if(signal?.aborted||epoch!==this.epoch||namespace!==String(this.getNamespace()))throw cancelled();};check();
    const {item,episode,duration}=context,numbers=markerEpisodeNumbers(episode);
    if(item?.kind!=='series'||!numbers||!/^\d{1,12}$/.test(String(episode.id||'')))return {status:'unavailable',markers:null};
    const explicit=item.imdbId??item.imdb_id??item.externalIds?.imdb??item.external_ids?.imdb_id;
    const tmdbId=item.tmdbId??item.tmdb_id??item.externalIds?.tmdb??item.external_ids?.tmdb_id;
    const identityKey=JSON.stringify([namespace,item.id,item.name,item.year,item.releaseYear,item.release_year,item.first_air_date,explicit,tmdbId]);
    const named=resolveMarkerSeries({kind:item.kind,name:item.name,year:item.year,releaseYear:item.releaseYear});
    if(named&&!resolveMarkerSeries(item))return {status:'unavailable',reason:'identity-conflict',markers:null};
    let series=resolveMarkerSeries(item)||this.identities.get(identityKey);
    if(!series&&/^tt\d{6,10}$/.test(explicit||'')){
      const candidate={slug:'imdb-'+explicit,imdbId:explicit,tmdbId,title:item.name,aliases:[item.name],resolved:true};
      series=resolveMarkerSeries(item,[candidate]);
    }
    if(!series){const identity=await this.cloud.identity(item);check();if(identity)series=resolveMarkerSeries(item,[identity]);}
    if(!series)return {status:'unavailable',reason:'unknown-series',markers:null};
    this.identities.set(identityKey,series);
    while(this.identities.size>128)this.identities.delete(this.identities.keys().next().value);
    const input=markerRequest({imdbId:series.imdbId,...numbers,duration});if(!input)return {status:'unavailable',markers:null};
    const key=fingerprintSource(JSON.stringify([namespace,item.id,episode.id,context.sourceFingerprint,markerRequestKey(input)]));
    const cached=this.cache.get(key);let reference=cached?.expires>this.now()?cached.value:null;
    if(!reference){
      const params=new URLSearchParams({...input,episodeId:String(episode.id)});
      try{reference=await this.request('/api/series/episode-markers?'+params,{signal});check();}
      catch(error){check();return {status:'unavailable',reason:'source-unavailable',markers:null};}
      if(!validEpisodeReference(reference,input))return {status:'unavailable',reason:'invalid-reference',markers:null};
      this.save(key,reference,namespace);
    }
    check();
    // The response is tied to this consumer, not a fabricated verified edition.
    return {status:reference.status,markers:null,reference,
      binding:{mediaId:String(item.id),episodeId:String(episode.id),sourceFingerprint:context.sourceFingerprint,...input}};
  }
}

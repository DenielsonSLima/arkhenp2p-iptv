import {safeID} from '../provider.mjs';

const cancelled=()=>new DOMException('A consulta do filme foi cancelada.','AbortError');
const artworkFields=['id','kind','name','poster','posterOriginal','backdrop','isAdult'];

/** Selected-movie metadata/duration policy. The provider keeps source lookup,
 * its MP4 range budget and cancellation on playback; no second prober/engine
 * or season/episode reader is created here. Source dimensions, when present,
 * remain provider metadata rather than a resolution inferred from a title. */
export class MetadadosFilmes{
  async read(state,id,{artworkOnly=false,probeDuration=false,signal,current=()=>true}={}){
    id=safeID(id);const client=state.client;
    const check=()=>{if(signal?.aborted||!current())throw cancelled();};check();
    const details=artworkOnly&&typeof client.artworkMetadata==='function'
      ?await client.artworkMetadata('movie',id,{signal})
      :await client.details('movie',id,{probeDuration:!artworkOnly&&probeDuration,signal});
    check();if(!details)return null;
    if(artworkOnly&&client.nativeVOD?.registered&&!state.parental.items.has('movie:'+id)){
      // The targeted /@id lookup already classified this native title. Do not
      // enumerate the full movie catalogue merely to authorize its artwork.
      state.parental.rememberCatalog({categories:client.nativeVOD.snapshot('movies').categories,items:[]},'movies');
      state.parental.registerDetails('movie',id,details);
    }
    await state.parental.authorize(client,'movie',id,{details});check();
    return artworkOnly?Object.fromEntries(artworkFields.filter(field=>field in details).map(field=>[field,details[field]])):details;
  }
}

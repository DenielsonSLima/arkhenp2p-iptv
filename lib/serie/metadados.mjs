import {safeID} from '../provider.mjs';

const cancelled=()=>new DOMException('A consulta da série foi cancelada.','AbortError');
const artworkFields=['id','kind','name','poster','posterOriginal','backdrop','isAdult'];

/** Selected-series metadata includes the provider's own seasons/episodes.
 * No episode is opened/probed to invent a duration for its parent series. */
export class MetadadosSeries{
  async read(state,id,{artworkOnly=false,signal,current=()=>true}={}){
    id=safeID(id);const client=state.client;
    const check=()=>{if(signal?.aborted||!current())throw cancelled();};check();
    const details=artworkOnly&&typeof client.artworkMetadata==='function'
      ?await client.artworkMetadata('series',id,{signal})
      :await client.details('series',id,{probeDuration:false,signal});
    check();if(!details)return null;
    if(artworkOnly&&client.nativeVOD?.registered&&!state.parental.items.has('series:'+id)){
      // Targeted native metadata already classified the selected series. Do
      // not enumerate every series merely to authorize this poster.
      state.parental.rememberCatalog({categories:client.nativeVOD.snapshot('series').categories,items:[]},'series');
      state.parental.registerDetails('series',id,details);
    }
    await state.parental.authorize(client,'series',id,{details});check();
    return artworkOnly?Object.fromEntries(artworkFields.filter(field=>field in details).map(field=>[field,details[field]])):details;
  }
}

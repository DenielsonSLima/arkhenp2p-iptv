import {decodeText} from '../../provider.mjs';
import {mediaDuration} from '../../media-duration.mjs';
import {loadWplayVOD} from '../vod/catalogo-legado.mjs';
import {wplayEpisodeParts,wplaySeriesSeasons} from './episodios.mjs';

const list=value=>Array.isArray(value)?value:[];
const text=value=>decodeText(value&&typeof value==='object'?value.init??value.i18n?.en??'':value);

/** Series catalog/details share authentication and transport with the provider,
 * while pages, generation and episode interpretation belong to this domain. */
export class WplaySeries{
  constructor(client){this.client=client;}
  episodeParts(source){return wplayEpisodeParts(source);}
  isSeries(raw){return Number(raw?.seasonCount)>0||this.client.sources(raw).some(source=>this.episodeParts(source));}
  async catalog(){
    const client=this.client;await client.connect();
    if(client.authInfo.service?.vod_tag_url){
      if(client.authInfo.service.enabledVoD===false)return {categories:[],items:[]};
      return client.nativeVOD.catalog('series');
    }
    return client.memo('catalog:series',async()=>{
      if(client.authInfo.service?.enabledVoD===false)return {categories:[],items:[]};
      const payload=await loadWplayVOD(client);
      return client.normalizeItems(payload.filter(item=>this.isSeries(item)),'series');
    });
  }
  async page(category,page){
    const client=this.client;await client.connect();
    return client.authInfo.service?.vod_tag_url?client.nativeVOD.page('series',category,page):this.catalog();
  }
  invalidate(){this.client.nativeVOD.invalidate('series');this.client.cache.delete('wplay:vod');}
  async details(id){
    const client=this.client;await client.connect();
    const native=Boolean(client.authInfo.service?.vod_tag_url);
    const item=native?await client.nativeVOD.detail('series',id):await client.item('series',id);
    const raw=client.rawItems.get('series:'+item.id);
    // An episode's duration describes only that episode. Never probe playback
    // or inspect its source time to assign a running time to the whole series.
    return {...item,genre:list(raw.tags).map(tag=>text(tag.name)).filter(Boolean).join(', '),
      ...mediaDuration(raw),cast:text(raw.cast||raw.actors),director:text(raw.director),
      seasons:wplaySeriesSeasons(client,item,raw)};
  }
}

import {decodeText} from '../../provider.mjs';
import {validUpstreamURL} from '../../upstream.mjs';
import {mediaDuration} from '../../media-duration.mjs';
import {loadWplayVOD} from '../vod/catalogo-legado.mjs';

const list=value=>Array.isArray(value)?value:[];
const text=value=>decodeText(value&&typeof value==='object'?value.init??value.i18n?.en??'':value);

/** Movie metadata over the one authorized WPLAY client. Catalog generations
 * stay in the shared kernel, independently from the series generation. */
export class WplayFilmes{
  constructor(client){this.client=client;}
  async catalog(){
    const client=this.client;await client.connect();
    if(client.authInfo.service?.vod_tag_url){
      if(client.authInfo.service.enabledVoD===false)return {categories:[],items:[]};
      return client.nativeVOD.catalog('movies');
    }
    return client.memo('catalog:movies',async()=>{
      if(client.authInfo.service?.enabledVoD===false)return {categories:[],items:[]};
      const payload=await loadWplayVOD(client);
      return client.normalizeItems(payload.filter(item=>!client.isSeries(item)),'movie');
    });
  }
  async page(category,page){
    const client=this.client;await client.connect();
    return client.authInfo.service?.vod_tag_url?client.nativeVOD.page('movies',category,page):this.catalog();
  }
  invalidate(){this.client.nativeVOD.invalidate('movies');this.client.cache.delete('wplay:vod');}
  async details(id,{probeDuration=false,signal}={}){
    const client=this.client;await client.connect();
    const native=Boolean(client.authInfo.service?.vod_tag_url);
    const item=native?await client.nativeVOD.detail('movie',id):await client.item('movies',id);
    const raw=client.rawItems.get('movie:'+item.id),sources=client.sources(raw);
    const result={...item,genre:list(raw.tags).map(tag=>text(tag.name)).filter(Boolean).join(', '),
      ...mediaDuration(raw,...sources),cast:text(raw.cast||raw.actors),director:text(raw.director),seasons:[]};
    if(!probeDuration||result.durationSeconds>0||signal?.aborted)return result;
    for(const source of sources){
      if(typeof source.address!=='string'||!/^https?:\/\//i.test(source.address))continue;
      let url;try{url=validUpstreamURL(source.address,client.allowPrivate);}catch{continue;}
      const seconds=await client.durationForSource(url,signal);
      return seconds===null?result:{...result,...mediaDuration({durationSeconds:seconds})};
    }
    return result;
  }
}

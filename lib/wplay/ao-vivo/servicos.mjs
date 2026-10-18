import {ProviderError,safeID} from '../../provider.mjs';
import {liveSourceCatalog} from './fontes.mjs';
import {wplayEPG} from './grade.mjs';
import {wplayGames} from './jogos.mjs';
import {inventarioFontesWplay} from './inventario-fontes.mjs';

/** Authenticated live domain: metadata reads never load VOD or start an OTT
 * transport. Actual media ownership remains with the connection orchestrator. */
export class WplayAoVivo{
  constructor(client,tokenURL){this.client=client;this.tokenURL=tokenURL;}
  async catalog(){
    const client=this.client;await client.connect();
    return client.memo('catalog:live',async()=>{
      if(client.authInfo.service?.enabledLive===false)return {categories:[],items:[]};
      const payload=await client.requestJSON(client.serviceURL('ch_url'));
      if(!Array.isArray(payload))throw new ProviderError('O serviço WPlay retornou um catálogo ao vivo inválido.','WPLAY_INVALID_CATALOG');
      return client.normalizeItems(payload,'live');
    });
  }
  async epg(id){
    const client=this.client,item=await client.item('live',id);
    return wplayEPG(client,client.rawItems.get('live:'+item.id),item.id);
  }
  async games(options){await this.client.connect();return wplayGames(this.client,options,this.tokenURL);}
  async sources(id,{signal}={}){
    id=safeID(id);const {entries}=await inventarioFontesWplay({client:this.client,id,signal});
    return liveSourceCatalog(id,entries);
  }
}

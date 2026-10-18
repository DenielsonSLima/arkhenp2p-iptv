import {ProviderError} from '../../provider.mjs';

/** Legacy whole-VOD response shared by the two domain readers. It is metadata
 * only; neither caller creates another authenticated client or media session. */
export function loadWplayVOD(client){
  return client.memo('wplay:vod',async()=>{
    const payload=await client.requestJSON(client.serviceURL('vod_url'));
    if(!Array.isArray(payload))throw new ProviderError('O serviço WPlay retornou um catálogo de vídeos inválido.','WPLAY_INVALID_CATALOG');
    return payload;
  });
}

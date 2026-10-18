import {ProviderError,safeID} from '../../provider.mjs';
import {nativeLiveSourceEntries,selectLiveSource,uniqueLiveSources} from './fontes.mjs';
import {authorizedWplayLiveSession,readWplayLiveSourceCatalog} from './catalogo-autorizado.mjs';

const cancelled=()=>new ProviderError('A reprodução foi interrompida.','PLAYBACK_CANCELLED',409);

/** Read the authenticated channel's supplied sources. Listing metadata never
 * starts/stops an engine and never translates TVBus/TVCarS into invented HTTP. */
export async function inventarioFontesWplay({client,id,signal,web=null,includeWeb=true}){
  id=safeID(id);
  if(signal?.aborted)throw cancelled();
  let item;
  if(client.libraryProvider==='wplay'&&authorizedWplayLiveSession(client,Date.now())){
    const session=client.session,auth=client.authInfo;
    const sameAccount=()=>client.session===session&&client.authInfo===auth;
    const current=()=>!signal?.aborted&&sameAccount();
    const catalog=await readWplayLiveSourceCatalog(client,{current:sameAccount});
    if(!current())throw cancelled();item=catalog.items.find(candidate=>String(candidate.id)===id);
    if(!item)throw new ProviderError('Este canal não está disponível no catálogo desta conta.','LIVE_SOURCE_UNAVAILABLE',404);
  }else item=await client.item('live',id);
  if(signal?.aborted)throw cancelled();
  const raw=client.rawItems.get(`live:${id}`),entries=nativeLiveSourceEntries(id,raw,{allowPrivate:client.allowPrivate});
  let initialSourceId=selectLiveSource(entries)?.descriptor.id||null;
  if(web&&(includeWeb||!entries.some(entry=>entry.descriptor.available))){
    try{
      const result=await web.sources(item,{signal,nativeItem:raw});
      for(const descriptor of result.sources)entries.push({origin:'web',descriptor});
      if(!initialSourceId)initialSourceId=result.selectedSourceId;
    }catch(error){
      if(signal?.aborted)throw cancelled();
      if(!entries.some(entry=>entry.descriptor.available))throw error;
    }
  }
  if(signal?.aborted)throw cancelled();
  return {item,raw,entries:uniqueLiveSources(entries),initialSourceId};
}

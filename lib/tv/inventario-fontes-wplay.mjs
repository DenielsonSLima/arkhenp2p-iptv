import {ProviderError,safeID} from '../provider.mjs';
import {nativeLiveSourceEntries,uniqueLiveSources} from './fontes.mjs';

const cancelled=()=>new ProviderError('A reprodução foi interrompida.','PLAYBACK_CANCELLED',409);

/** Read the authenticated channel's supplied sources. Listing metadata never
 * starts/stops an engine and never translates TVBus/TVCarS into invented HTTP. */
export async function inventarioFontesWplay({client,id,signal,web=null,nativeEnabled=false}){
  id=safeID(id);
  const item=await client.item('live',id);if(signal?.aborted)throw cancelled();
  const raw=client.rawItems.get(`live:${id}`),entries=nativeLiveSourceEntries(id,raw,{allowPrivate:client.allowPrivate,nativeEnabled});
  if(web){
    try{
      const result=await web.sources(item,{signal,nativeItem:raw});
      for(const descriptor of result.sources)entries.push({origin:'web',descriptor});
    }catch(error){
      if(signal?.aborted)throw cancelled();
      if(!entries.some(entry=>entry.descriptor.available))throw error;
    }
  }
  if(signal?.aborted)throw cancelled();
  return {item,raw,entries:uniqueLiveSources(entries)};
}

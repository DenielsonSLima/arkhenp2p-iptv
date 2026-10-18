import {probeMP4Duration} from '../../mp4-duration.mjs';

/** A selected movie may use bounded Range metadata probing. The owner remains
 * the existing provider client so playback/STOP cancels the same probe. */
export async function probeWplayMovieDuration(client,source,signal){
  if(client.playback||signal?.aborted)return null;
  const key='duration:'+source.href,discard=probe=>{
    if(probe?.controller.signal.aborted&&client.cache.get(probe.key)?.promise===probe.promise)client.cache.delete(probe.key);
  };
  discard(client.durationProbe);let createdProbe;
  const promise=client.memo(key,async()=>{
    client.durationProbe?.controller.abort();discard(client.durationProbe);
    const probe={key,controller:new AbortController()};client.durationProbe=probe;createdProbe=probe;
    const cancel=()=>probe.controller.abort();signal?.addEventListener('abort',cancel,{once:true});
    try{
      const seconds=await probeMP4Duration(source,{headers:client.upstreamHeaders(source),allowPrivate:client.allowPrivate,signal:probe.controller.signal});
      if(seconds===null||probe.controller.signal.aborted)throw new Error('Duration unavailable.');
      return seconds;
    }finally{signal?.removeEventListener('abort',cancel);if(client.durationProbe===probe)client.durationProbe=null;}
  },24*60*60*1000);
  if(createdProbe)createdProbe.promise=promise;
  return promise.catch(()=>null);
}

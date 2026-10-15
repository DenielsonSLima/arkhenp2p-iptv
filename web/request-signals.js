/** AbortSignal.any is absent in several TV browser versions. Detach fallback
 * listeners when the request settles, not only when a source eventually aborts. */
export async function withRequestSignals(signals,run){
  const sources=[...new Set(signals.filter(Boolean))];
  if(!sources.length)return run(undefined);
  if(sources.length===1)return run(sources[0]);
  if(typeof AbortSignal.any==='function')return run(AbortSignal.any(sources));
  const controller=new AbortController(),abort=()=>controller.abort();
  for(const source of sources){if(source.aborted){controller.abort();break;}source.addEventListener('abort',abort,{once:true});}
  try{return await run(controller.signal);}finally{for(const source of sources)source.removeEventListener('abort',abort);}
}

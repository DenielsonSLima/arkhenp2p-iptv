/** Read-only adapter over the already authorized CloudLibrary. It never
 * creates Auth, a second Supabase client, playback URLs or a global account cache. */
export class SeriesMarkerSupabase {
  constructor({getCloud=()=>null,getNamespace=()=>'',timeoutMs=1000,
    schedule=(callback,delay)=>globalThis.setTimeout(callback,delay),cancel=timer=>globalThis.clearTimeout(timer)}={}){
    Object.assign(this,{getCloud,getNamespace,schedule,cancel});
    this.timeoutMs=Math.max(100,Math.min(2000,Number(timeoutMs)||1000));
  }
  async bounded(read){
    let timer;
    try{return await Promise.race([
      Promise.resolve().then(read).catch(()=>null),
      new Promise(resolve=>{timer=this.schedule(()=>resolve(null),this.timeoutMs);})
    ]);}finally{if(timer!==undefined)this.cancel(timer);}
  }
  async manifest(slug,{signal,season,episode}={}){
    const namespace=String(this.getNamespace()),cloud=this.getCloud();
    const manifest=slug&&typeof cloud?.markerManifest==='function'
      ?await this.bounded(()=>cloud.markerManifest(slug,{season,episode})):null;
    if(signal?.aborted||String(this.getNamespace())!==namespace)
      throw new DOMException('Marker lookup cancelled','AbortError');
    return manifest;
  }
  identity(item){
    const cloud=this.getCloud();
    return typeof cloud?.markerSeriesIdentity==='function'
      ?this.bounded(()=>cloud.markerSeriesIdentity(item)):Promise.resolve(null);
  }
}

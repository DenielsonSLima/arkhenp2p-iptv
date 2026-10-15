import {EpisodeMarkerCatalog} from './index.js';

/** Prefer the account-authorized cloud manifest; local researched data is the
 * bounded fallback while the cloud is unavailable or still being connected. */
export class EpisodeMarkerReader {
  constructor({getCloud=()=>null,getNamespace=()=>'',allowReferenceMarkers=false,
    request=(url,options)=>globalThis.fetch(url,options),cloudTimeoutMs=1000,
    schedule=(callback,delay)=>globalThis.setTimeout(callback,delay),cancel=timer=>globalThis.clearTimeout(timer)}={}){
    Object.assign(this,{getCloud,getNamespace,allowReferenceMarkers,request,schedule,cancel});
    this.cloudTimeoutMs=Math.max(100,Math.min(2000,Number(cloudTimeoutMs)||1000));this.namespace=String(getNamespace());
    this.catalog=new EpisodeMarkerCatalog({request:(url,options)=>this.load(url,options),schedule,cancel});
    this.openDataCatalog=new EpisodeMarkerCatalog({request:(url,options)=>request(url.replace('/series-markers/','/series-markers/open-data/'),options),schedule,cancel});
    this.localCatalog=new EpisodeMarkerCatalog({request,schedule,cancel});
  }
  reset(){this.namespace=String(this.getNamespace());this.catalog.reset();this.openDataCatalog.reset();this.localCatalog.reset();}
  async load(url,{signal}={}){
    const namespace=String(this.getNamespace()),slug=/^\/series-markers\/([a-z0-9-]+)\/manifest\.json$/.exec(url)?.[1];
    let timer;
    try{
      const cloud=this.getCloud();
      if(slug&&typeof cloud?.markerManifest==='function'){
        const work=Promise.resolve().then(()=>cloud.markerManifest(slug)).catch(()=>null);
        const timeout=new Promise(resolve=>{timer=this.schedule(()=>resolve(null),this.cloudTimeoutMs);});
        const manifest=await Promise.race([work,timeout]);
        if(signal?.aborted||String(this.getNamespace())!==namespace)throw new DOMException('Marker lookup cancelled','AbortError');
        if(manifest)return manifest;
      }
    }finally{if(timer!==undefined)this.cancel(timer);}
    if(signal?.aborted||String(this.getNamespace())!==namespace)throw new DOMException('Marker lookup cancelled','AbortError');
    return {ok:false};
  }
  async lookup(context={}){
    const namespace=String(this.getNamespace());if(namespace!==this.namespace)this.reset();
    const input={...context,signal:context.signal,allowReferenceMarkers:context.allowReferenceMarkers??this.allowReferenceMarkers};
    let value=await this.catalog.lookup(input);
    // A partial source must not hide another source's compatible episode or
    // edition. All three adapters enforce the same identity and runtime guards.
    for(const fallback of [this.openDataCatalog,this.localCatalog]){
      if(value.status==='matched'||value.status==='cancelled'||String(this.getNamespace())!==namespace)break;
      const local=await fallback.lookup(input);if(local.status==='matched'||local.status==='cancelled')value=local;
    }
    return String(this.getNamespace())===namespace?value:{status:'cancelled',markers:null};
  }
}

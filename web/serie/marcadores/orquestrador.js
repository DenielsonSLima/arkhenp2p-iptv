import {EpisodeMarkerCatalog,resolveMarkerSeries} from '../../series-markers/index.js';
import {SeriesMarkerSupabase} from './supabase.js';

/** Prefer the account-authorized cloud manifest; local researched data is the
 * bounded fallback while the cloud is unavailable or still being connected. */
export class EpisodeMarkerReader {
  constructor({getCloud=()=>null,getNamespace=()=>'',allowReferenceMarkers=false,
    request=(url,options)=>globalThis.fetch(url,options),cloudTimeoutMs=1000,
    schedule=(callback,delay)=>globalThis.setTimeout(callback,delay),cancel=timer=>globalThis.clearTimeout(timer)}={}){
    Object.assign(this,{getCloud,getNamespace,allowReferenceMarkers,request,schedule,cancel});
    this.cloudTimeoutMs=Math.max(100,Math.min(2000,Number(cloudTimeoutMs)||1000));this.namespace=String(getNamespace());
    this.supabase=new SeriesMarkerSupabase({getCloud,getNamespace,timeoutMs:this.cloudTimeoutMs,schedule,cancel});
    this.catalog=new EpisodeMarkerCatalog({request:(url,options)=>this.load(url,options),schedule,cancel,perEpisode:true});
    this.openDataCatalog=new EpisodeMarkerCatalog({request:(url,options)=>request(url.replace('/series-markers/','/series-markers/open-data/'),options),schedule,cancel});
    this.localCatalog=new EpisodeMarkerCatalog({request,schedule,cancel});
  }
  reset(){this.namespace=String(this.getNamespace());this.catalog.reset();this.openDataCatalog.reset();this.localCatalog.reset();}
  async load(url,{signal,season,episode}={}){
    const slug=/^\/series-markers\/([a-z0-9-]+)\/manifest\.json$/.exec(url)?.[1];
    return await this.supabase.manifest(slug,{signal,season,episode})||{ok:false};
  }
  async lookup(context={}){
    const namespace=String(this.getNamespace());if(namespace!==this.namespace)this.reset();
    const input={...context,signal:context.signal,allowReferenceMarkers:context.allowReferenceMarkers??this.allowReferenceMarkers};
    if(!resolveMarkerSeries(context.item)&&typeof this.getCloud()?.markerSeriesIdentity==='function'){
      input.seriesIdentity=await this.supabase.identity(context.item);
      if(context.signal?.aborted||String(this.getNamespace())!==namespace)return {status:'cancelled',markers:null};
    }
    let value=await this.catalog.lookup(input);const references=[...(value.references||[])];
    // A partial source must not hide another source's compatible episode or
    // edition. All three adapters enforce the same identity and runtime guards.
    for(const fallback of [this.openDataCatalog,this.localCatalog]){
      // A verified cloud edition is authoritative. An explicit conflict must
      // not be hidden by an older fallback. References never become actions,
      // and windows from different sources are never combined or intersected.
      if(value.status==='matched'||value.status==='edition-conflict'||value.status==='cancelled'||String(this.getNamespace())!==namespace)break;
      const local=await fallback.lookup(input);
      references.push(...(local.references||[]));
      const diagnostics={unavailable:0,'invalid-data':1,unverified:2,'edition-unverified':3,'edition-mismatch':4,'edition-conflict':5};
      if(local.status==='matched'||local.status==='cancelled'||(diagnostics[local.status]??0)>(diagnostics[value.status]??0))value=local;
    }
    return String(this.getNamespace())===namespace?{...value,...(references.length?{references:references.slice(0,6)}:{})}:{status:'cancelled',markers:null};
  }
}

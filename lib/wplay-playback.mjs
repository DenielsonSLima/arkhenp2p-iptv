import { WplayProviderClient } from './wplay-provider.mjs';
import { ProviderError, safeID } from './provider.mjs';
import { requestUpstream, validUpstreamURL } from './upstream.mjs';
import { requestVODUpstream } from './vod-upstream.mjs';
import { WplayWebPlayback } from './tv/transporte-web.mjs';
import {liveSourceCatalog,selectLiveSource} from './tv/fontes.mjs';
import {inventarioFontesWplay} from './tv/inventario-fontes-wplay.mjs';

const cancelled=()=>new ProviderError('A reprodução foi interrompida.','PLAYBACK_CANCELLED',409);

export class WplayPlaybackProviderClient extends WplayProviderClient {
  #bridge;#web;#selection=null;#selectionGeneration=0;
  constructor(config,{bridge=null,webPlayback=false,webPlaybackFactory,...options}={}){
    super(config,options);this.#bridge=bridge;
    this.#web=webPlayback?new WplayWebPlayback({username:config.rawUsername??config.username,password:config.password},{createClient:webPlaybackFactory}):null;
  }
  async #liveOptions(id,{signal}={}){
    return inventarioFontesWplay({client:this,id,signal,web:this.#web,nativeEnabled:!!this.#bridge&&!this.#web});
  }
  async liveSources(id,{signal}={}){
    id=safeID(id);const {entries}=await this.#liveOptions(id,{signal});
    return liveSourceCatalog(id,entries,this.#selection?.key===`live:${id}`?this.#selection.sourceId:null);
  }
  #waitSelection(selection,signal){
    if(signal?.aborted)return Promise.reject(cancelled());
    selection.readers++;
    return new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(error,value)=>{
        if(settled)return;settled=true;signal?.removeEventListener('abort',abort);selection.readers--;
        if(error&&signal?.aborted&&!selection.readers&&!selection.url)selection.controller.abort();
        if(error)reject(error);else resolve(value);
      };
      const abort=()=>finish(cancelled());
      signal?.addEventListener('abort',abort,{once:true});
      selection.promise.then(value=>finish(null,value),error=>finish(error));
    });
  }
  async playbackURL(type,id,_container,{signal,attempt,sourceId}={}){
    if(signal?.aborted)throw cancelled();
    if(type==='live'&&sourceId!==undefined&&sourceId!==null&&sourceId!==''&&(typeof sourceId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(sourceId)))throw new ProviderError('A fonte selecionada é inválida.','LIVE_SOURCE_INVALID',400);
    id=safeID(id);const key=`${type}:${id}`,previous=this.#selection;
    // An opening/retry token is stable across HEAD/GET and manifest polls. Only
    // an actual new intent creates a fresh provider sid/gen for the same live ID.
    const liveAttempt=typeof attempt==='string'?attempt:'';
    const selector=type==='live'?(sourceId||'auto'):'';
    if(previous?.key===key&&previous.attempt===liveAttempt&&previous.selector===selector&&!previous.controller.signal.aborted&&(!previous.url||previous.transport==='http'||this.isNativeMediaURL(previous.url)||this.#web?.owns(previous.url)))return this.#waitSelection(previous,signal);
    previous?.controller.abort();
    if(type==='live'&&previous?.key===key&&(previous.attempt!==liveAttempt||previous.selector!==selector)){
      // The server has already reserved playbackGeneration for this intent.
      // Reset its transfers without invalidating that reservation.
      this.playback?.controller.abort();this.playback=null;this.assets.clear();this.segmentCache.clear();this.segmentBytes=0;this.diagnosticLast=null;
    }
    const selection={key,attempt:liveAttempt,selector,sourceId:null,generation:++this.#selectionGeneration,controller:new AbortController(),url:null,promise:null,readers:0};
    this.#selection=selection;
    const check=()=>{if(this.#selection!==selection||selection.controller.signal.aborted)throw cancelled();};
    selection.promise=(async()=>{
      const webStop=this.#web?.stop();
      await Promise.all([this.#bridge?.stop(this),type==='live'?webStop:webStop?.catch(()=>{})]);check();
      if(type==='live'){
        const {item,raw,entries}=await this.#liveOptions(id,{signal:selection.controller.signal});check();
        const selected=selectLiveSource(entries,sourceId);
        if(!selected){
          if(entries.some(entry=>entry.protocol==='tvbus'))throw new ProviderError('A reprodução deste canal precisa da ponte P2P local. Inicie o serviço Android para assistir.','NATIVE_BRIDGE_UNAVAILABLE',503);
          throw new ProviderError('Não há uma fonte compatível disponível para este canal.','LIVE_SOURCE_UNAVAILABLE',503);
        }
        selection.sourceId=selected.descriptor.id;
        let url;
        if(selected.origin==='web')url=await this.#web.start(item,{signal:selection.controller.signal,nativeItem:raw,sourceId:selected.descriptor.id});
        else if(selected.protocol==='http'){url=validUpstreamURL(selected.address,this.allowPrivate);selection.transport='http';}
        else{
          // Only the exact TVBus source supplied for this channel can reach
          // this bridge. BinStream/tvcars is never passed to TVCore.
          if(selected.protocol!=='tvbus'||!this.#bridge||this.#web)throw new ProviderError('Esta fonte não é compatível com a ponte ativa.','LIVE_SOURCE_UNAVAILABLE',503);
          const input=this.config.username.trim(),username=input.includes('@')?input:input+'@wareztv.io';
          const configuration={authUrl:this.authInfo?.service?.auth_url_sdk,username,password:this.config.password.trim()};
          const doh=this.authInfo?.service?.doh_url;if(doh)configuration.options={doh_url:doh};
          url=await this.#bridge.start(this,configuration,selected.address,{signal:selection.controller.signal});
        }
        check();selection.url=new URL(url).href;return new URL(selection.url);
      }
      try{
        const direct=await super.playbackURL(type,id);check();selection.url=String(direct);selection.transport='http';return direct;
      }catch(error){
        check();if(error.code!=='WPLAY_NATIVE_ENGINE_REQUIRED')throw error;
        const sources=type==='series'?[this.episodes.get(id)?.source]:this.sources(this.rawItems.get(`${type}:${id}`));
        // The web mode never starts an old Android bridge implicitly, including
        // a VOD source without HTTP. Legacy native mode remains explicit.
        if(this.#web)throw error;
        const source=sources.find(value=>typeof value?.address==='string'&&value.address.startsWith('tvbus://'));
        if(!source)throw error;
        if(!this.#bridge)throw new ProviderError('A reprodução deste canal precisa da ponte P2P local. Inicie o serviço Android para assistir.','NATIVE_BRIDGE_UNAVAILABLE',503);
        const input=this.config.username.trim(),username=input.includes('@')?input:input+'@wareztv.io';
        const configuration={authUrl:this.authInfo?.service?.auth_url_sdk,username,password:this.config.password.trim()};
        const doh=this.authInfo?.service?.doh_url;if(doh)configuration.options={doh_url:doh};
        const url=await this.#bridge.start(this,configuration,source.address,{signal:selection.controller.signal});check();
        selection.url=url;return new URL(url);
      }
    })().finally(()=>{if(this.#selection===selection&&!selection.url)this.#selection=null;});
    return this.#waitSelection(selection,signal);
  }
  isNativeMediaURL(value){return !!this.#bridge?.acceptsMediaURL(this,value);}
  isWebMediaURL(value){return !!this.#web?.owns(value);}
  mediaURL(value){return this.isNativeMediaURL(value)?new URL(value).href:this.#web?.active?this.#web.mediaURL(value):validUpstreamURL(value,this.allowPrivate).href;}
  upstreamHeaders(value){return this.isWebMediaURL(value)?this.#web.upstreamHeaders(value):super.upstreamHeaders(value);}
  upstreamRequest(value,options={}){
    if(this.isNativeMediaURL(value))return this.#bridge.fetchMedia(this,value,{method:options.method,signal:options.signal,timeout:options.timeout,range:options.headers?.Range??options.headers?.range});
    if(this.isWebMediaURL(value))return this.#web.upstreamRequest(value,options);
    const request=/^(?:movie|series):/.test(this.playback?.key||'')?requestVODUpstream:requestUpstream;
    return request(this.mediaURL(value),{...options,allowPrivate:this.allowPrivate});
  }
  stopPlayback(){
    this.#selectionGeneration++;this.#selection?.controller.abort();this.#selection=null;
    super.stopPlayback();return Promise.all([this.#bridge?.stop(this).catch(()=>{}),this.#web?.stop().catch(()=>{})]);
  }
  async logout(){
    await this.stopPlayback();
    try{await Promise.all([this.#bridge?.close(this),this.#web?.close()]);}
    finally{this.session=null;this.authInfo=null;this.config.username='';this.config.password='';this.cache.clear();this.rawItems.clear();this.episodes.clear();this.images.clear();this.refs.clear();}
  }
}

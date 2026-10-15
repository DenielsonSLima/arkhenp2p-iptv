import { WplayProviderClient } from './wplay-provider.mjs';
import { ProviderError, safeID } from './provider.mjs';
import { requestUpstream, validUpstreamURL } from './upstream.mjs';
import { requestVODUpstream } from './vod-upstream.mjs';
import { WplayWebPlayback } from './wplay-web-playback.mjs';

const cancelled=()=>new ProviderError('A reprodução foi interrompida.','PLAYBACK_CANCELLED',409);

export class WplayPlaybackProviderClient extends WplayProviderClient {
  #bridge;#web;#selection=null;#selectionGeneration=0;
  constructor(config,{bridge=null,webPlayback=false,webPlaybackFactory,...options}={}){
    super(config,options);this.#bridge=bridge;
    this.#web=webPlayback?new WplayWebPlayback({username:config.rawUsername??config.username,password:config.password},{createClient:webPlaybackFactory}):null;
  }
  async playbackURL(type,id){
    id=safeID(id);const key=`${type}:${id}`,previous=this.#selection;
    if(previous?.key===key&&(!previous.url||this.isNativeMediaURL(previous.url)||this.#web?.owns(previous.url)))return previous.promise;
    previous?.controller.abort();
    const selection={key,generation:++this.#selectionGeneration,controller:new AbortController(),url:null,promise:null};
    this.#selection=selection;
    const check=()=>{if(this.#selection!==selection||selection.controller.signal.aborted)throw cancelled();};
    selection.promise=(async()=>{
      await Promise.all([this.#bridge?.stop(this),this.#web?.stop()]);check();
      try{
        const direct=await super.playbackURL(type,id);check();return direct;
      }catch(error){
        check();if(error.code!=='WPLAY_NATIVE_ENGINE_REQUIRED')throw error;
        const sources=type==='series'?[this.episodes.get(id)?.source]:this.sources(this.rawItems.get(`${type}:${id}`));
        const source=sources.find(value=>typeof value?.address==='string'&&value.address.startsWith('tvbus://'));
        if(!source)throw error;
        if(type==='live'&&this.#web){
          const item=await this.item('live',id);check();
          const url=await this.#web.start(item,{signal:selection.controller.signal});check();
          selection.url=url.href;return url;
        }
        // The web mode never starts an old Android bridge implicitly, including
        // a VOD source without HTTP. Legacy native mode remains explicit.
        if(this.#web)throw error;
        if(!this.#bridge)throw new ProviderError('A reprodução deste canal precisa da ponte P2P local. Inicie o serviço Android para assistir.','NATIVE_BRIDGE_UNAVAILABLE',503);
        const input=this.config.username.trim(),username=input.includes('@')?input:input+'@wareztv.io';
        const configuration={authUrl:this.authInfo?.service?.auth_url_sdk,username,password:this.config.password.trim()};
        const doh=this.authInfo?.service?.doh_url;if(doh)configuration.options={doh_url:doh};
        const url=await this.#bridge.start(this,configuration,source.address,{signal:selection.controller.signal});check();
        selection.url=url;return new URL(url);
      }
    })().finally(()=>{if(this.#selection===selection&&!selection.url)this.#selection=null;});
    return selection.promise;
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

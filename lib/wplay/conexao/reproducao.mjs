import { WplayProviderClient } from './provedor-nativo.mjs';
import { ProviderError, safeID } from '../../provider.mjs';
import { requestUpstream, validUpstreamURL } from '../../upstream.mjs';
import { requestVODUpstream } from '../../vod-upstream.mjs';
import { WplayWebPlayback } from '../ao-vivo/transporte-web.mjs';
import {liveSourceCatalog,selectLiveSource} from '../ao-vivo/fontes.mjs';
import {inventarioFontesWplay} from '../ao-vivo/inventario-fontes.mjs';
import {WebLiveSegmentIdentity} from '../../tv/web-segment-identity.mjs';

const cancelled=()=>new ProviderError('A reprodução foi interrompida.','PLAYBACK_CANCELLED',409);

export class WplayPlaybackProviderClient extends WplayProviderClient {
  #web;#selection=null;#selectionGeneration=0;#segmentIdentity=new WebLiveSegmentIdentity();
  constructor(config,{webPlayback=false,webPlaybackFactory,...options}={}){
    super(config,options);
    this.#web=webPlayback?new WplayWebPlayback({username:config.rawUsername??config.username,password:config.password},{createClient:webPlaybackFactory}):null;
  }
  exportRuntimeState() {
    const selection=this.#selection;
    const completed=!!selection?.url&&!selection.controller.signal.aborted;
    return {...super.exportRuntimeState(),playbackRuntime:{selectionGeneration:this.#selectionGeneration,
      selection:selection?{key:selection.key,attempt:selection.attempt,selector:selection.selector,sourceId:selection.sourceId,
        generation:selection.generation,url:completed?selection.url:null,transport:selection.transport??null,aborted:selection.controller.signal.aborted}:null,
      pending:!!selection&&!completed,web:this.#web?.exportRuntimeState()??null,
      segmentIdentity:this.#segmentIdentity.exportRuntimeState()}};
  }
  restoreRuntimeState(state) {
    super.restoreRuntimeState(state);
    const runtime=state.playbackRuntime;
    if(!runtime)throw new Error('Estado da reprodução WPLAY inválido.');
    if(runtime.web){if(!this.#web)throw new Error('Transporte web não configurado para restauração.');this.#web.restoreRuntimeState(runtime.web);}
    this.#selectionGeneration=runtime.selectionGeneration||0;this.#selection=null;
    const saved=runtime.selection;
    if(saved?.url&&!saved.aborted&&!runtime.pending){
      const url=new URL(saved.url);
      if(saved.transport==='http'||saved.transport==='web'&&this.#web?.owns(url)){
        const {aborted,...fields}=saved;
        this.#selection={...fields,url:url.href,controller:new AbortController(),readers:0,promise:Promise.resolve(url)};
      }
    }
    this.runtimePending=runtime.pending?saved:null;
    if(runtime.pending||saved&&!this.#selection)this.playback=null;
    this.#segmentIdentity.restoreRuntimeState(runtime.segmentIdentity,{owner:this.#selection});
    return this;
  }
  async #liveOptions(id,{signal,includeWeb=true}={}){
    return inventarioFontesWplay({client:this,id,signal,web:this.#web,includeWeb});
  }
  async liveSources(id,{signal,includeWeb=false}={}){
    // Match automatic playback: a supplied native HTTP source needs no OTT
    // login/catalog. Full web alternatives remain an explicit metadata option.
    id=safeID(id);const {entries,initialSourceId}=await this.#liveOptions(id,{signal,includeWeb});
    return liveSourceCatalog(id,entries,this.#selection?.key===`live:${id}`?this.#selection.sourceId:initialSourceId);
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
    if(previous?.key===key&&previous.attempt===liveAttempt&&previous.selector===selector&&!previous.controller.signal.aborted&&(!previous.url||previous.transport==='http'||this.#web?.owns(previous.url)))return this.#waitSelection(previous,signal);
    previous?.controller.abort();
    this.#segmentIdentity.reset();
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
      await (type==='live'?webStop:webStop?.catch(()=>{}));check();
      if(type==='live'){
        // Direct HTTP already supplied for this same channel needs no second
        // login/catalog. Listing qualities can still request web alternatives.
        const {item,raw,entries,initialSourceId}=await this.#liveOptions(id,{signal:selection.controller.signal,includeWeb:typeof sourceId==='string'&&sourceId.startsWith('w_')});check();
        const selected=selectLiveSource(entries,sourceId||initialSourceId);
        if(!selected){
          throw new ProviderError('O serviço WPLAY não informou uma fonte HTTP compatível para este canal.','LIVE_SOURCE_UNAVAILABLE',503);
        }
        selection.sourceId=selected.descriptor.id;
        let url;
        if(selected.origin==='web'){url=await this.#web.start(item,{signal:selection.controller.signal,nativeItem:raw,sourceId:selected.descriptor.id});selection.transport='web';}
        else if(selected.protocol==='http'){url=validUpstreamURL(selected.address,this.allowPrivate);selection.transport='http';}
        else throw new ProviderError('Esta fonte não está disponível pelo transporte web WPLAY.','LIVE_SOURCE_UNAVAILABLE',503);
        check();selection.url=new URL(url).href;return new URL(selection.url);
      }
      const direct=await super.playbackURL(type,id);check();selection.url=String(direct);selection.transport='http';return direct;
    })().finally(()=>{if(this.#selection===selection&&!selection.url)this.#selection=null;});
    return this.#waitSelection(selection,signal);
  }
  isWebMediaURL(value){return !!this.#web?.owns(value);}
  liveSegmentIdentity({text,base,key}){
    const selection=this.#selection;
    if(!key.startsWith('live:')||selection?.key!==key||selection.transport!=='web'||selection.controller.signal.aborted||
      this.playback?.key!==key||this.playback.controller.signal.aborted||!this.#web?.owns(selection.url)||!this.#web.owns(base)){
      this.#segmentIdentity.reset();return null;
    }
    return this.#segmentIdentity.manifest({text,base,owner:selection});
  }
  mediaURL(value){return this.#web?.active?this.#web.mediaURL(value):validUpstreamURL(value,this.allowPrivate).href;}
  upstreamHeaders(value){return this.isWebMediaURL(value)?this.#web.upstreamHeaders(value):super.upstreamHeaders(value);}
  upstreamRequest(value,options={}){
    if(this.isWebMediaURL(value))return this.#web.upstreamRequest(value,options);
    const request=/^(?:movie|series):/.test(this.playback?.key||'')?requestVODUpstream:requestUpstream;
    return request(this.mediaURL(value),{...options,allowPrivate:this.allowPrivate});
  }
  stopPlayback(){
    this.#segmentIdentity.reset();
    this.#selectionGeneration++;this.#selection?.controller.abort();this.#selection=null;
    super.stopPlayback();return this.#web?.stop().catch(()=>{})||Promise.resolve();
  }
  async logout(){
    // Close account metadata immediately; otherwise its pending catalogue can
    // sit ahead of STOP and delay reaching close() for its entire deadline.
    const closing=this.#web?.close();
    await this.stopPlayback();
    try{await closing;}
    finally{this.session=null;this.authInfo=null;this.config.username='';this.config.password='';this.cache.clear();this.rawItems.clear();this.episodes.clear();this.images.clear();this.refs.clear();}
  }
}

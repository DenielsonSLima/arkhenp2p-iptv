import {wplayDevice,wplayUserAgent,wplayServiceURL,resolveWplayAuthURLs,authenticateWplay} from './autenticacao.mjs';
export {WPLAY_AUTH_URLS,wplayDevice,wplayAuthForm,wplayUserAgent,wplayServiceURL} from './autenticacao.mjs';
import { ProviderClient, ProviderError, decodeText, safeID } from '../../provider.mjs';
import { validUpstreamURL, requestUpstream, readBody } from '../../upstream.mjs';
import {WplayVODCatalog} from '../vod/catalogo-nativo.mjs';
import {WplayFilmes} from '../filmes/servicos.mjs';
import {WplaySeries} from '../series/servicos.mjs';
import {WplayAoVivo} from '../ao-vivo/servicos.mjs';
import {probeWplayMovieDuration} from '../filmes/duracao.mjs';
import {sportsLogoCache} from '../../sports-logo-cache.mjs';
import {isAdultCategory,isAdultItem} from '../../../web/parental-classification.js';
import {nativeLiveSourceEntries,selectLiveSource} from '../ao-vivo/fontes.mjs';
import {readWplayLiveSourceCatalog} from '../ao-vivo/catalogo-autorizado.mjs';
import {runtimeSessionContext} from '../../runtime-session-context.mjs';

const text=value=>decodeText(typeof value==='object'&&value!==null?value.init??value.i18n?.en??'':value);
const numericID=value=>/^\d{1,12}$/.test(String(value??''))?String(value):null;
const list=value=>Array.isArray(value)?value:[];
const dateISO=value=>{if(typeof value==='string'&&value&&!/^\d+(?:\.\d+)?$/.test(value)){const time=Date.parse(value);return Number.isFinite(time)?new Date(time).toISOString():null;}const n=Number(value);if(!Number.isFinite(n)||n<=0)return null;const time=n>=1e12?n:n*1000;return Number.isFinite(new Date(time).getTime())?new Date(time).toISOString():null;};
export class WplayProviderClient extends ProviderClient {
  constructor(config,{allowPrivate=false,sportsLogos=sportsLogoCache,authenticate:providerAuthenticate}={}) {
    const endpoints=resolveWplayAuthURLs(config,{allowPrivate});
    super({server:endpoints[0],username:config?.username,password:config?.password},{allowPrivate});
    this.device=wplayDevice(config.device);this.config={...this.config,provider:'wplay',server:endpoints[0],device:this.device};
    this.authURLs=endpoints;this.authInfo=null;this.rawItems=new Map();this.userAgent=wplayUserAgent(this.device);this.nativeVOD=new WplayVODCatalog(this,wplayServiceURL);this.durationProbe=null;this.sportsLogos=sportsLogos;
    this.domains={live:new WplayAoVivo(this,wplayServiceURL),movies:new WplayFilmes(this),series:new WplaySeries(this)};
    this.providerAuthenticate=typeof providerAuthenticate==='function'?providerAuthenticate:null;this.cloudCollection=false;
  }
  exportRuntimeState() {
    const vod=this.nativeVOD;
    return {...super.exportRuntimeState(),native:{authInfo:this.authInfo,rawItems:new Map(this.rawItems),
      device:this.device,authURLs:this.authURLs,userAgent:this.userAgent,cloudCollection:this.cloudCollection,
      vod:{categories:new Map(vod.categories),pages:new Map(vod.pages),items:{movies:new Map(vod.items.movies),series:new Map(vod.items.series)},
        registered:vod.registered,generations:{...vod.generations},registrationGeneration:vod.registrationGeneration}}};
  }
  restoreRuntimeState(state) {
    super.restoreRuntimeState(state);
    const native=state.native;
    if(!native)throw new Error('Estado WPLAY inválido.');
    this.authInfo=native.authInfo??null;this.rawItems=new Map(native.rawItems);this.device=native.device;
    this.authURLs=native.authURLs;this.userAgent=native.userAgent;this.cloudCollection=native.cloudCollection===true;this.durationProbe=null;
    const vod=native.vod;
    this.nativeVOD.categories=new Map(vod.categories);this.nativeVOD.pages=new Map(vod.pages);
    this.nativeVOD.items={movies:new Map(vod.items.movies),series:new Map(vod.items.series)};
    this.nativeVOD.registered=vod.registered===true;this.nativeVOD.generations={...vod.generations};
    this.nativeVOD.registrationGeneration=vod.registrationGeneration;this.nativeVOD.initializing=new Map();
    return this;
  }
  apiURL(){throw new ProviderError('Esta conta utiliza a autenticação WPlay P2P.','WPLAY_OPERATION_INVALID',400);}
  async requestJSON(url,{method='GET',body,timeout=10000,signal,maxBytes=64*1024*1024}={}) {
    const headers={'User-Agent':this.userAgent};
    if(body!==undefined){headers['Content-Type']='application/x-www-form-urlencoded';headers['Content-Length']=Buffer.byteLength(body);}
    const response=await requestUpstream(url,{method,body,headers,timeout,signal,allowPrivate:this.allowPrivate,followRedirects:false});
    if(response.status!==200){response.body.destroy();throw new ProviderError(`O serviço WPlay retornou HTTP ${response.status}.`,'WPLAY_UPSTREAM_HTTP',[401,403].includes(response.status)?401:502);}
    const buffer=await readBody(response,maxBytes);
    try{return JSON.parse(buffer.toString());}catch{throw new ProviderError('O serviço WPlay retornou uma resposta inválida.','WPLAY_INVALID_RESPONSE');}
  }
  authenticate(options={}) {return authenticateWplay(this,options);}
  account(data) {
    return {status:'Active',expiresAt:dateISO(data.user?.end_time??data.user?.EndTime),maxConnections:null,activeConnections:null,usernameMasked:'••••'+this.config.username.slice(-4),provider:'wplay'};
  }
  async connect() {
    if(this.session&&Date.now()-this.authenticatedAt<5*60*1000)return this.session;
    if(runtimeSessionContext()?.readOnly)throw new ProviderError('Valide novamente a sessão antes de atualizar os dados.','PROVIDER_SESSION_REFRESH_REQUIRED',503);
    if(this.connecting)return this.connecting;
    this.connecting=(async()=>{const data=await this.authenticate();this.authInfo=data;this.session={connected:true,account:this.account(data)};this.authenticatedAt=Date.now();return this.session;})();
    try{return await this.connecting;}finally{this.connecting=null;}
  }
  async api(action,params={},options={}) {
    if(action)throw new ProviderError('Operação indisponível para esta conta WPlay.','WPLAY_OPERATION_INVALID',400);
    const data=await this.authenticate(options),account=this.account(data);
    // A normalized metadata probe for the existing connection diagnostics.
    return {user_info:{auth:1,status:account.status,exp_date:account.expiresAt?Date.parse(account.expiresAt)/1000:null,max_connections:null,active_cons:null}};
  }
  serviceURL(field) {
    const raw=this.authInfo?.service?.[field];
    const value=wplayServiceURL(raw,this.authInfo?.service?.token);
    if(!value)throw new ProviderError('O serviço WPlay não disponibilizou este catálogo para a conta.','WPLAY_CATALOG_UNAVAILABLE',404);
    return validUpstreamURL(value,this.allowPrivate).href;
  }
  sources(raw){return list(raw?.sources).filter(source=>source&&typeof source==='object');}
  upstreamHeaders(){return {'User-Agent':this.userAgent};}
  episodeParts(source){return this.domains.series.episodeParts(source);}
  isSeries(raw){return this.domains.series.isSeries(raw);}
  normalizeItems(rawItems,kind,providedTags=[]) {
    const categories=new Map(providedTags.map(tag=>[numericID(tag.id),{id:numericID(tag.id),name:text(tag.name)||'Outros',...(tag.restricted===true||tag.restrictedAccess===true||isAdultCategory(tag)?{isAdult:true}:{})}]).filter(([id])=>id));
    const items=[],seen=new Set();
    for(const raw of rawItems){
      if(!raw||typeof raw!=='object')continue;
      const id=numericID(raw.chid)||numericID(raw.id),name=text(raw.name);if(!id||!name||seen.has(id))continue;
      seen.add(id);const tags=list(raw.tags).filter(tag=>tag&&numericID(tag._id??tag.id));
      for(const tag of tags){const tagID=numericID(tag._id??tag.id),known=this.nativeVOD?.categories.get(tagID),name=text(tag.name)||'Outros';categories.set(tagID,{id:tagID,name,...(categories.get(tagID)?.isAdult||known?.restricted||tag.restrictedAccess===true||isAdultCategory({name})?{isAdult:true}:{})});}
      const categoryIds=[...new Set([...providedTags.map(tag=>numericID(tag.id)),...tags.map(tag=>numericID(tag._id??tag.id))].filter(Boolean))];
      const categoryId=tags.length?numericID(tags[0]._id??tags[0].id):categoryIds[0]||'0';if(!categories.has(categoryId))categories.set(categoryId,{id:categoryId,name:'Outros'});
      // Native artwork: `big` is the portrait cover; `full` is the backdrop.
      // `image_logo` can be transparent title lettering, never a cover override.
      const poster=raw.logo?.image?.big||raw.logo?.image?.small||raw.image_logo;
      const item={id,name,categoryId,categoryIds:categoryIds.length?categoryIds:[categoryId],poster:this.image(poster),backdrop:this.image(raw.image_backdrop||raw.logo?.image?.full),year:String(raw.year||''),rating:Number(raw.rating)||0,kind,added:String(raw.updatedAt||''),plot:text(raw.description),genre:list(raw.tags).map(tag=>text(tag?.name)).filter(Boolean).join(', '),container:'mp4'};
      if(raw.restrictedAccess===true||isAdultItem({...raw,...item},[...categories.values()]))item.isAdult=true;
      const existing=this.rawItems.get(`${kind}:${id}`);
      this.rawItems.set(`${kind}:${id}`,{...existing,...raw});items.push(item);
    }
    return {categories:[...categories.values()],items};
  }
  async catalog(type) {
    if(!['live','movies','series'].includes(type))throw new ProviderError('Tipo de catálogo inválido.','INVALID_CATALOG',400);
    return this.domains[type].catalog();
  }
  async catalogPage(type,category,page){
    if(!['movies','series'].includes(type))throw new ProviderError('Tipo de catálogo inválido.','INVALID_CATALOG',400);
    return this.domains[type].page(category,page);
  }
  invalidateCatalog(type){
    super.invalidateCatalog(type);
    this.domains[type]?.invalidate?.();
  }
  async artworkMetadata(type,id,{signal}={}){
    if(!['live','movie','series'].includes(type)||signal?.aborted)return null;
    await this.connect();if(signal?.aborted)return null;
    // The native VOD search fetches exactly /@id. Legacy/live artwork can
    // reuse already authorized in-memory items, but never downloads a catalog
    // just to reconstruct a cover after another browser opens the application.
    if(type!=='live'&&this.authInfo.service?.vod_tag_url)return this.details(type,id,{signal});
    const raw=this.rawItems.get(`${type}:${safeID(id)}`);
    return raw?this.normalizeItems([raw],type).items[0]||null:null;
  }
  async details(type,id,options={}) {
    if(!['movie','series'].includes(type))throw new ProviderError('Tipo de mídia inválido.','INVALID_MEDIA',400);
    return this.domains[type==='movie'?'movies':'series'].details(id,options);
  }
  durationForSource(source,signal){return probeWplayMovieDuration(this,source,signal);}
  beginPlayback(key){this.durationProbe?.controller.abort();return super.beginPlayback(key);}
  stopPlayback(){this.durationProbe?.controller.abort();return super.stopPlayback();}
  epg(id){return this.domains.live.epg(id);}
  games(options){return this.domains.live.games(options);}
  liveSources(id,options){return this.domains.live.sources(id,options);}
  liveSourceCatalog(options){return readWplayLiveSourceCatalog(this,options);}
  async playbackURL(type,id) {
    id=safeID(id);let sources;
    if(type==='series'){const episode=this.episodes.get(id);if(!episode)throw new ProviderError('Abra a série e escolha um episódio antes de reproduzir.','EPISODE_NOT_REGISTERED',400);sources=[episode.source];}
    else if(['live','movie'].includes(type)){if(type==='movie')await this.details(type,id);else await this.item('live',id);sources=this.sources(this.rawItems.get(`${type}:${id}`));}
    else throw new ProviderError('Tipo de mídia inválido.','INVALID_MEDIA',400);
    if(!sources.length)throw new ProviderError('O catálogo WPlay não disponibilizou uma fonte para este conteúdo.','WPLAY_SOURCE_UNAVAILABLE',404);
    if(type==='live'){
      const selected=selectLiveSource(nativeLiveSourceEntries(id,{sources},{allowPrivate:this.allowPrivate}));
      if(selected)return validUpstreamURL(selected.address,this.allowPrivate);
    }
    let httpSource=false;
    for(const source of sources){
      if(typeof source.address!=='string'||!/^https?:\/\//i.test(source.address))continue;
      httpSource=true;
      try{return validUpstreamURL(source.address,this.allowPrivate);}catch{/* Reject addresses outside the registered safe network boundary. */}
    }
    if(httpSource)throw new ProviderError('O endereço de reprodução recebido do serviço WPlay não é permitido.','WPLAY_SOURCE_INVALID',502);
    const error=new ProviderError('Esta fonte utiliza TVCore/BinStream e o serviço WPLAY não informou uma alternativa HTTP para o navegador.','WPLAY_NATIVE_ENGINE_REQUIRED',501);
    error.provider='wplay';error.supported=false;throw error;
  }
}

import { ProviderClient, ProviderError, decodeText, safeID } from './provider.mjs';
import { validUpstreamURL, requestUpstream, readBody } from './upstream.mjs';
import { WplayVODCatalog, nativeEpisodeID } from './wplay-vod.mjs';
import { mediaDuration } from './media-duration.mjs';
import { probeMP4Duration } from './mp4-duration.mjs';
import { wplayEPG } from './wplay-epg.mjs';
import { wplayGames } from './wplay-games.mjs';
import {sportsLogoCache} from './sports-logo-cache.mjs';
import {isAdultCategory,isAdultItem} from '../web/parental-classification.js';
import {nativeLiveSourceEntries,liveSourceCatalog,selectLiveSource} from './tv/fontes.mjs';
import {inventarioFontesWplay} from './tv/inventario-fontes-wplay.mjs';

// WPLAYP2P 11.9.0d: td.m.e() POST builder and recovered td.m.i/k/d VM.
// See analysis/WPLAYP2P-11.9.0d-auth-contract.md for the APK offsets.
export const WPLAY_AUTH_URLS=Object.freeze(['https://auth1.wareztv.io/api/v2/auth','https://auth1.authwplays.one/api/v2/auth']);
const PACKAGE='io.wareztv.android.one',APP_NAME='WPlay',VERSION_NAME='11.9.0d',VERSION_CODE=1190;
const EPISODE_PATTERN=/[ST](\d+)-?E(\d+)/;
const text=value=>decodeText(typeof value==='object'&&value!==null?value.init??value.i18n?.en??'':value);
const numericID=value=>/^\d{1,12}$/.test(String(value??''))?String(value):null;
const list=value=>Array.isArray(value)?value:[];
const dateISO=value=>{if(typeof value==='string'&&value&&!/^\d+(?:\.\d+)?$/.test(value)){const time=Date.parse(value);return Number.isFinite(time)?new Date(time).toISOString():null;}const n=Number(value);if(!Number.isFinite(n)||n<=0)return null;const time=n>=1e12?n:n*1000;return Number.isFinite(new Date(time).getTime())?new Date(time).toISOString():null;};
function deviceText(value,fallback=''){const string=String(value??fallback);if(string.length>200||/[\x00-\x1f\x7f]/.test(string))throw new ProviderError('Identificação do dispositivo inválida.','WPLAY_DEVICE_INVALID',400);return string;}
export function wplayDevice(value={}) {
  const keys=['buildBrand','buildProduct','buildBoard','buildABI','buildDisplay','buildModel','sysVersion'];
  const device=Object.fromEntries(keys.map(key=>[key,deviceText(value[key])]));
  // ic.y.A() uses this literal when Settings.Secure.android_id is unavailable.
  device.deviceID=deviceText(value.deviceID,'did')||'did';
  device.operateMode=Number.isInteger(Number(value.operateMode))?Number(value.operateMode):0;
  return device;
}
export function wplayAuthForm(config) {
  const device=wplayDevice(config.device);
  // be.e.onClick() trims both fields and adds h.d before saving USER/PASSWORD.
  const input=String(config.username).trim(),username=input.includes('@')?input:input+'@wareztv.io';
  return new URLSearchParams({from:'ap',username,password:String(config.password).trim(),deviceID:device.deviceID,packageName:PACKAGE,appName:APP_NAME,appVersion:String(VERSION_CODE),buildBrand:device.buildBrand,buildProduct:device.buildProduct,buildBoard:device.buildBoard,buildABI:device.buildABI,operateMode:String(device.operateMode),buildDisplay:device.buildDisplay,buildModel:device.buildModel,sysVersion:device.sysVersion}).toString();
}
export function wplayUserAgent(device) {return `Apache-HttpClient/Null (${APP_NAME} ${VERSION_NAME}; Android ${device.sysVersion}; ${device.buildModel}; ${device.deviceID})`;}
export function wplayServiceURL(value,token) {
  if(typeof value!=='string'||!value)return '';
  // Recovered td.m.d() deliberately appends the original token verbatim.
  if(!token||value.includes('?t=')||value.includes('&t='))return value;
  return value+(value.indexOf('?')>0?'&t=':'?t=')+String(token);
}

export class WplayProviderClient extends ProviderClient {
  constructor(config,{allowPrivate=false,sportsLogos=sportsLogoCache,authenticate:providerAuthenticate}={}) {
    const custom=config?.authURLs??(config?.server?[config.server]:null);
    // Additional destinations are used only when the caller explicitly selected
    // them; discovering a backup in an APK does not authorize credential replay.
    const endpoints=(custom||[WPLAY_AUTH_URLS[0]]).map(value=>validUpstreamURL(value,allowPrivate).href);
    if(!endpoints.length||(!allowPrivate&&endpoints.some(value=>!WPLAY_AUTH_URLS.includes(value))))throw new ProviderError('Servidor WPlay não reconhecido pelo contrato do APK.','WPLAY_SERVER_INVALID',400);
    super({server:endpoints[0],username:config?.username,password:config?.password},{allowPrivate});
    this.device=wplayDevice(config.device);this.config={...this.config,provider:'wplay',server:endpoints[0],device:this.device};
    this.authURLs=endpoints;this.authInfo=null;this.rawItems=new Map();this.userAgent=wplayUserAgent(this.device);this.nativeVOD=new WplayVODCatalog(this,wplayServiceURL);this.durationProbe=null;this.sportsLogos=sportsLogos;
    this.providerAuthenticate=typeof providerAuthenticate==='function'?providerAuthenticate:null;this.cloudCollection=false;
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
  async authenticate(options={}) {
    const body=wplayAuthForm(this.config);let failure;
    for(const url of this.authURLs){
      try {
        let data;
        if(this.providerAuthenticate){
          try{
            const response=await this.providerAuthenticate({server:url,scopeServer:this.config.server,form:body,userAgent:this.userAgent,signal:options.signal});
            data=response.payload;this.cloudCollection=response.cloudCollector===true;
          }catch(error){
            if(error?.providerAuthFallback!==true||[401,403].includes(error?.remoteStatus)||[401,403].includes(error?.status)||options.signal?.aborted)throw error;
            // Cloud transport is optional; provider authentication remains
            // mandatory, with the same approved URL, form and response checks.
            this.cloudCollection=false;data=await this.requestJSON(url,{method:'POST',body,...options});
          }
        }
        else data=await this.requestJSON(url,{method:'POST',body,...options});
        const hasCode=typeof data?.code==='number'||(typeof data?.code==='string'&&/^-?\d+$/.test(data.code));
        if(!data||typeof data!=='object'||Array.isArray(data)||!hasCode||!Number.isInteger(Number(data.code)))throw new ProviderError('O serviço WPlay retornou uma resposta inválida.','WPLAY_INVALID_RESPONSE');
        if(Number(data.code)!==0){
          const authCode=Number(data.code),missing=authCode===-11,passwordRejected=authCode===-10;
          const message=missing?'Conta não encontrada neste servidor WPlay.':passwordRejected?'Senha não aceita neste servidor WPlay.':'O serviço WPlay não autorizou esta conta. Confira os dados de acesso.';
          const error=new ProviderError(message,missing?'WPLAY_ACCOUNT_NOT_FOUND':passwordRejected?'WPLAY_PASSWORD_REJECTED':'AUTH_REJECTED',401);
          error.authCode=authCode;error.provider='wplay';throw error;
        }
        return data;
      } catch(error){failure=error;if(Number.isInteger(error.authCode)||options.signal?.aborted)throw error;}
    }
    throw failure;
  }
  account(data) {
    return {status:'Active',expiresAt:dateISO(data.user?.end_time??data.user?.EndTime),maxConnections:null,activeConnections:null,usernameMasked:'••••'+this.config.username.slice(-4),provider:'wplay'};
  }
  async connect() {
    if(this.session&&Date.now()-this.authenticatedAt<5*60*1000)return this.session;
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
  episodeParts(source){return String(source.subTitle??'').match(EPISODE_PATTERN);}
  isSeries(raw){return Number(raw?.seasonCount)>0||this.sources(raw).some(source=>this.episodeParts(source));}
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
  async loadVOD() {
    return this.memo('wplay:vod',async()=>{
      const payload=await this.requestJSON(this.serviceURL('vod_url'));
      if(!Array.isArray(payload))throw new ProviderError('O serviço WPlay retornou um catálogo de vídeos inválido.','WPLAY_INVALID_CATALOG');
      return payload;
    });
  }
  async catalog(type) {
    if(!['live','movies','series'].includes(type))throw new ProviderError('Tipo de catálogo inválido.','INVALID_CATALOG',400);
    await this.connect();
    if(type!=='live'&&this.authInfo.service?.vod_tag_url){
      if(this.authInfo.service.enabledVoD===false)return {categories:[],items:[]};
      return this.nativeVOD.catalog(type);
    }
    return this.memo('catalog:'+type,async()=>{
      if(type==='live'){
        if(this.authInfo.service?.enabledLive===false)return {categories:[],items:[]};
        const payload=await this.requestJSON(this.serviceURL('ch_url'));
        if(!Array.isArray(payload))throw new ProviderError('O serviço WPlay retornou um catálogo ao vivo inválido.','WPLAY_INVALID_CATALOG');
        return this.normalizeItems(payload,'live');
      }
      if(this.authInfo.service?.enabledVoD===false)return {categories:[],items:[]};
      const payload=await this.loadVOD(),series=type==='series';
      return this.normalizeItems(payload.filter(item=>this.isSeries(item)===series),series?'series':'movie');
    });
  }
  async catalogPage(type,category,page){
    if(!['movies','series'].includes(type))throw new ProviderError('Tipo de catálogo inválido.','INVALID_CATALOG',400);
    await this.connect();
    if(!this.authInfo.service?.vod_tag_url)return this.catalog(type);
    return this.nativeVOD.page(type,category,page);
  }
  invalidateCatalog(type){
    super.invalidateCatalog(type);
    if(type!=='live'){
      this.nativeVOD.invalidate(type);
      this.cache.delete('wplay:vod');
    }
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
  async details(type,id,{probeDuration=false,signal}={}) {
    if(!['movie','series'].includes(type))throw new ProviderError('Tipo de mídia inválido.','INVALID_MEDIA',400);
    await this.connect();
    const native=!!this.authInfo.service?.vod_tag_url;
    const item=native?await this.nativeVOD.detail(type,id):await this.item(type==='movie'?'movies':'series',id),raw=this.rawItems.get(`${type}:${item.id}`);
    const duration=mediaDuration(raw,...this.sources(raw));
    const result={...item,genre:list(raw.tags).map(tag=>text(tag.name)).filter(Boolean).join(', '),...duration,cast:text(raw.cast||raw.actors),director:text(raw.director),seasons:[]};
    if(type==='series'){
      const seasons=new Map();
      for(const [index,source] of this.sources(raw).entries()){
        const match=this.episodeParts(source),episodeID=nativeEpisodeID(item.id,source,index);if(!match)continue;
        const season=Number(match[1]),number=Number(match[2]);if(!seasons.has(season))seasons.set(season,new Map());
        if(seasons.get(season).has(number))continue;
        const thumbnail=[source.thumbnail,source.still,source.image,source.poster,source.cover].map(value=>this.image(value)).find(Boolean)||'';
        const episode={id:episodeID,title:text(source.subTitle),number,season,...mediaDuration(source),container:'mp4',...(thumbnail?{thumbnail}:{})};
        seasons.get(season).set(number,episode);this.episodes.set(episodeID,{...episode,source});
      }
      result.seasons=[...seasons].sort(([a],[b])=>a-b).map(([number,entries])=>({number,name:`Temporada ${number}`,episodes:[...entries.values()].sort((a,b)=>a.number-b.number)}));
    }
    if(type!=='movie'||!probeDuration||result.durationSeconds>0||signal?.aborted)return result;
    for(const source of this.sources(raw)){
      if(typeof source.address!=='string'||!/^https?:\/\//i.test(source.address))continue;
      let url;try{url=validUpstreamURL(source.address,this.allowPrivate);}catch{continue;}
      const seconds=await this.durationForSource(url,signal);
      return seconds===null?result:{...result,...mediaDuration({durationSeconds:seconds})};
    }
    return result;
  }
  async durationForSource(source,signal) {
    if(this.playback||signal?.aborted)return null;
    const key='duration:'+source.href,discard=probe=>{
      if(probe?.controller.signal.aborted&&this.cache.get(probe.key)?.promise===probe.promise)this.cache.delete(probe.key);
    };
    discard(this.durationProbe);let createdProbe;
    const promise=this.memo(key,async()=>{
      this.durationProbe?.controller.abort();discard(this.durationProbe);
      const probe={key,controller:new AbortController()};this.durationProbe=probe;createdProbe=probe;
      const cancel=()=>probe.controller.abort();signal?.addEventListener('abort',cancel,{once:true});
      try{
        const seconds=await probeMP4Duration(source,{headers:this.upstreamHeaders(source),allowPrivate:this.allowPrivate,signal:probe.controller.signal});
        if(seconds===null||probe.controller.signal.aborted)throw new Error('Duration unavailable.');
        return seconds;
      }finally{signal?.removeEventListener('abort',cancel);if(this.durationProbe===probe)this.durationProbe=null;}
    },24*60*60*1000);
    if(createdProbe)createdProbe.promise=promise;
    return promise.catch(()=>null);
  }
  beginPlayback(key){this.durationProbe?.controller.abort();return super.beginPlayback(key);}
  stopPlayback(){this.durationProbe?.controller.abort();return super.stopPlayback();}
  async epg(id){const item=await this.item('live',id);return wplayEPG(this,this.rawItems.get(`live:${item.id}`),item.id);}
  async games(options){await this.connect();return wplayGames(this,options,wplayServiceURL);}
  async liveSources(id,{signal}={}){
    id=safeID(id);const {entries}=await inventarioFontesWplay({client:this,id,signal});
    return liveSourceCatalog(id,entries);
  }
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
    const error=new ProviderError('Este conteúdo utiliza a engine nativa WPlay P2P. A reprodução precisa de uma ponte compatível com TVCore/BinStream.','WPLAY_NATIVE_ENGINE_REQUIRED',501);
    error.provider='wplay';error.supported=false;throw error;
  }
}

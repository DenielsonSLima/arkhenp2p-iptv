import http from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { ProviderError } from './provider.mjs';
import {OrquestradorConexaoWplay} from './wplay/orquestrador.mjs';
import {configuredConnection} from './wplay/conexao/configuracao.mjs';
import {reservePlaybackIntent,currentPlaybackIntent,retirePlaybackAttempt,playbackReader,liveRetryAfter} from './live-playback-session.mjs';
import {OrquestradorHomeTv,TV_HOME_API_PATHS} from './tv/home-orquestrador.mjs';
import {MediaRequestBackoff} from './media-request-backoff.mjs';
import {createCloudAttachment} from './wplay/conector-supabase.mjs';
import {SessionCatalogSearch} from './session-catalog-search.mjs';
import {OrquestradorFilmes} from './filmes/orquestrador.mjs';
import {OrquestradorSeries} from './serie/orquestrador.mjs';
import {EpisodeMarkerRoute} from './serie/marcadores/rota.mjs';
import { requestUpstream, readBody } from './upstream.mjs';
import { analyzeConnection } from './diagnostics.mjs';
import {OrquestradorTv,TV_API_PATHS} from './tv/orquestrador.mjs';
import {createTvTransportObserver,tvPlaylistTransportMetadata,tvPlaylistUriIdentity} from './tv/transport-observer.mjs';
import { accountLibrarySession } from './account-library.mjs';
import { CloudRuntime } from './cloud-runtime.mjs';
import { ARKHEN_SUPABASE_PROJECT } from './supabase-cloud.mjs';
import { readSportsLogo,cacheSharedSportsLogo } from './sports-logo-cache.mjs';
import { ParentalControl } from './parental-control.mjs';
import {catalogSearchRequest,shortCatalogSearch} from './catalog-search-request.mjs';
import {createRequestHostPolicy} from './request-host-policy.mjs';
import {runtimeSessionContext} from './runtime-session-context.mjs';
import {captureRuntimeSession,restoreRuntimeSession} from './runtime-session-state.mjs';
import {runtimeSessionReadPolicy} from './runtime-session-read-policy.mjs';

// Compare requested files to the same canonical filesystem spelling (macOS
// may return NFD paths even when the module was imported through an NFC URL).
// The trailing separator keeps similarly named sibling directories outside.
const root=(await realpath(fileURLToPath(new URL('../web/',import.meta.url))))+path.sep;
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json','.png':'image/png','.ico':'image/x-icon','.jpg':'image/jpeg','.svg':'image/svg+xml','.webp':'image/webp','.mp4':'video/mp4','.webm':'video/webm','.woff':'font/woff','.txt':'text/plain; charset=utf-8','.m3u':'audio/x-mpegurl'};
export function parseRange(range,size) {
  const match=/^bytes=(\d*)-(\d*)$/.exec(range||'');
  if(!match||(!match[1]&&!match[2])||size<=0)return null;
  const start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));
  const end=match[1]?(match[2]?Number(match[2]):size-1):size-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||start>end)return null;
  return {start,end:Math.min(end,size-1)};
}
function json(res,data,status=200) {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function input(req,{maxBytes=8192}={}) {const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>maxBytes)throw new Error('Dados de conexão excederam o tamanho permitido.');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{throw new Error('Dados de conexão inválidos.');}}

export function createApp({connection,allowPrivateUpstream=false,environment=process.env,cloud=null,sharedWorker,providerFactory,sportsLogoReader=readSportsLogo,sportsLogoMirror=cacheSharedSportsLogo,onPlaybackError,onPlaybackTransport,episodeMarkers,sessionStore=null}={}) {
  const allowedRequestHost=createRequestHostPolicy(environment);
  const configuration=connection?Promise.resolve(connection):configuredConnection();
  const sessions=new Map();const images=new Map();const imageNamespaces=new WeakMap();let imageBytes=0,shuttingDown=false;
  const cloudRuntime=new CloudRuntime({cloud,worker:sharedWorker,workerEnabled:!sessionStore});
  const attachCloud=sessionStore?(...args)=>cloudRuntime.attach(...args):createCloudAttachment(cloudRuntime);
  const providerConnection=new OrquestradorConexaoWplay({allowPrivateUpstream,providerFactory,cloud});
  const localSearch=new SessionCatalogSearch();
  const mediaBackoff=new MediaRequestBackoff();
  const observeTvTransport=createTvTransportObserver({emit:onPlaybackTransport});
  const tvRoutes=new OrquestradorTv({cloudRuntime,respond:json,isClosed:()=>shuttingDown});
  const homeTvRoutes=new OrquestradorHomeTv({cloudRuntime,respond:json,readInput:input,isClosed:()=>shuttingDown});
  const movieRoutes=new OrquestradorFilmes({cloudRuntime,catalogSearch:localSearch,respond:json,readInput:input,isClosed:()=>shuttingDown});
  const seriesRoutes=new OrquestradorSeries({cloudRuntime,catalogSearch:localSearch,respond:json,isClosed:()=>shuttingDown});
  const episodeMarkerRoute=new EpisodeMarkerRoute({respond:json,service:episodeMarkers});
  const capabilities=()=>({games:true,accountLibrary:true,cloud:cloudRuntime.enabled});
  const playbackError=({kind,code,status=502,upstreamStatus=null})=>{
    if(typeof onPlaybackError!=='function'||!['live','movie','series'].includes(kind))return;
    const validStatus=value=>Number.isInteger(value)&&value>=100&&value<=599;
    const event=Object.freeze({kind,code:typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:'CONNECTION_FAILED',status:validStatus(status)?status:502,upstreamStatus:validStatus(upstreamStatus)?upstreamStatus:null});
    try{onPlaybackError(event);}catch{/* Diagnostics cannot interrupt playback or its error response. */}
  };
  const releaseClient=async client=>{try{if(client?.logout)await client.logout();else await client?.stopPlayback();}catch{/* cleanup must not create an unhandled rejection */}};
  function createSessionState(){
    const state={client:null,loggedOut:false,authGeneration:0,seen:Date.now(),attempts:[],parental:new ParentalControl()};
    state.parental.lookupItem=(kind,id)=>cloudRuntime.parentalCatalogItem(state,kind,id);return state;
  }
  async function drainSession(state){
    const tasks=[state.cloudPending?.promise,state.cloudValidationPending?.promise,state.cloudRecovery?.pending?state.cloudRecovery.promise:null,...state.cloudRevocations||[]].filter(Boolean);
    if(tasks.length)await Promise.allSettled(tasks);
  }
  function browserSession(req,res) {
    const token=req.headers.cookie?.match(/(?:^|;\s*)ORBIT_SID=([\w-]+)/)?.[1];
    if(token&&sessions.has(token)){const existing=sessions.get(token);existing.seen=Date.now();return existing;}
    const next=randomBytes(24).toString('base64url');const state=createSessionState();sessions.set(next,state);
    res.setHeader('Set-Cookie',`ORBIT_SID=${next}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
    if(sessions.size>64){for(const [id,item]of sessions)if(Date.now()-item.seen>24*60*60*1000){sessions.delete(id);cloudRuntime.detach(item);void releaseClient(item.client);}}
    return state;
  }
  function friendly(error,client) {
    let message=error instanceof Error?error.message:'Não foi possível concluir a operação.';
    for(const value of [client?.config.username,client?.config.password])if(value)message=message.split(value).join('••••');
    if(/getaddrinfo|ECONN|socket|certificate|ENOTFOUND|AbortError|aborted/i.test(message))return 'Não foi possível conectar ao provedor. Verifique o servidor e tente novamente.';
    return message.slice(0,240);
  }
  async function api(req,res,url,state=browserSession(req,res)) {
    if(url.pathname==='/api/session') {
      if(req.method!=='GET'){json(res,{error:'Método inválido.'},405);return;}
      const config=await configuration;
      const login={configuredServer:typeof config?.server==='string'&&Boolean(config.server),defaultProvider:'wplay'};
      const client=state.client,generation=state.authGeneration;
      try{
        const session=client?accountLibrarySession(await client.connect(),client.config,client.libraryProvider):{connected:false,code:'SESSION_REQUIRED'};
        if(client&&state.client===client&&state.authGeneration===generation){
          if(url.searchParams.get('cloud')==='refresh')await cloudRuntime.recoverSession(state,session,client,generation);
          else await attachCloud(state,session,client,generation);
        }
        const current=state.client===client&&state.authGeneration===generation;
        json(res,{...(current?session:{connected:false}),capabilities:capabilities(),login,...(current?cloudRuntime.fields(state):{cloud:null,cloudStatus:{state:'disabled'}})});
      }catch(error){const current=state.client===client&&state.authGeneration===generation;if(current){
        if([401,403].includes(error?.status)){
          await cloudRuntime.attach(state,{connected:false,account:{...client.session?.account,libraryId:state.cloud?.libraryId,status:'Disabled'}},client,generation);
          client.session=null;state.authGeneration++;
        }else cloudRuntime.detach(state);
      }json(res,{connected:false,error:friendly(error,client),capabilities:capabilities(),login,...(current?cloudRuntime.fields(state):{cloud:null,cloudStatus:{state:'disabled'}})});}
      return;
    }
    if(url.pathname==='/api/login') {
      if(req.method!=='POST'){json(res,{error:'Método inválido.'},405);return;}
      state.attempts=state.attempts.filter(t=>Date.now()-t<60000);
      if(state.attempts.length>=8){json(res,{error:'Aguarde um minuto antes de tentar novamente.'},429);return;}
      state.attempts.push(Date.now());state.parental.reset();const generation=++state.authGeneration;const value=await input(req);
      if(typeof value.username!=='string'||!value.username.trim()||typeof value.password!=='string'||!value.password){json(res,{connected:false,error:'Informe seu usuário e sua senha.'},400);return;}
      const config=await configuration;
      let client,provider;
      try{const resolved=providerConnection.resolveConnection(value,config);provider=resolved.provider;
        client=await providerConnection.createClient(resolved);}
      catch(error){json(res,{connected:false,error:friendly(error),code:'INVALID_CONNECTION'},400);return;}
      try{
        const session=await client.connect();
        if(generation!==state.authGeneration){await releaseClient(client);json(res,{connected:false,error:'Esta tentativa de entrada foi cancelada. Entre novamente para continuar.',code:'LOGIN_CANCELLED'},409);return;}
        cloudRuntime.detach(state);if(state.client?.logout)await state.client.logout();else await state.client?.stopPlayback();
        if(generation!==state.authGeneration){await client.logout?.();json(res,{connected:false,error:'Esta tentativa de entrada foi cancelada.',code:'LOGIN_CANCELLED'},409);return;}
        client.libraryProvider=provider;state.client=client;state.loggedOut=false;state.attempts=[];
        const connected=accountLibrarySession(session,client.config,provider);await attachCloud(state,connected,client,generation);
        if(generation!==state.authGeneration||state.client!==client){json(res,{connected:false,error:'Esta tentativa de entrada foi cancelada.',code:'LOGIN_CANCELLED'},409);return;}
        json(res,{...connected,capabilities:capabilities(),...cloudRuntime.fields(state)});
      }catch(error){json(res,{connected:false,error:friendly(error,client),code:error instanceof ProviderError?error.code:'CONNECTION_FAILED'},error instanceof ProviderError&&[400,401,403,404,409,422,429,501,502,503,504].includes(error.status)?error.status:502);}
      return;
    }
    if(url.pathname==='/api/logout'||url.pathname==='/api/stop') {
      if(req.method!=='POST'){json(res,{error:'Método inválido.'},405);return;}
      const previous=state.client;
      if(url.pathname==='/api/stop'&&url.searchParams.has('attempt')&&!currentPlaybackIntent(state,previous,{attempt:url.searchParams.get('attempt'),purpose:url.searchParams.get('purpose')||undefined})){
        retirePlaybackAttempt(state,previous,url.searchParams.get('attempt'));
        json(res,{connected:!!state.client,stopped:false});return;
      }
      const finish=homeTvRoutes.finish(state,previous);if(sessionStore)await finish;else void finish;
      if(url.pathname==='/api/logout'){
        state.authGeneration++;state.parental.reset();cloudRuntime.detach(state,previous);state.client=null;state.loggedOut=true;
        // The local session is already closed. A provider outage must not make
        // the browser treat that logout as a failed operation.
        try{if(previous?.logout)await previous.logout();else await previous?.stopPlayback();}catch{}
      }else await previous?.stopPlayback();
      json(res,{connected:!!state.client});return;
    }
    const client=state.client;
    if(!client?.session){json(res,{error:'Conecte a conta para carregar o catálogo.',code:'SESSION_REQUIRED'},401);return;}
    if(await episodeMarkerRoute.handle(req,res,url,{state,client}))return;
    const play=/^\/api\/play\/(live|movie|series)\/(\d{1,12})(?:\/index\.m3u8|\.[a-z0-9]{2,6})$/.exec(url.pathname);
    // Reserve this selection before authorization can load metadata. Stop,
    // logout and a newer selection must invalidate every pending preflight.
    let playbackIntent=null;
    if(play&&['GET','HEAD'].includes(req.method)){
      const previousIntent=state.playbackIntent;
      playbackIntent=reservePlaybackIntent(state,client,{kind:play[1],id:play[2],attempt:url.searchParams.get('attempt')||'',sourceId:play[1]==='live'?(url.searchParams.get('sourceId')||''):'',purpose:url.searchParams.get('purpose')||'playback'});
      if(playbackIntent!==previousIntent){const finish=homeTvRoutes.finish(state,client,{intent:previousIntent});if(sessionStore)await finish;else void finish;}
    }
    const cancelledPlayback=()=>{
      if(!playbackIntent)return false;
      const reason=playbackIntent.generation!==client.playbackGeneration?'PLAYBACK_GENERATION_CHANGED':
        playbackIntent.authGeneration!==state.authGeneration?'PLAYBACK_AUTH_CHANGED':state.client!==client?'PLAYBACK_CLIENT_CHANGED':
        req.aborted?'PLAYBACK_READER_ABORTED':res.destroyed?'PLAYBACK_RESPONSE_CLOSED':null;
      if(!reason)return false;
      playbackError({kind:play[1],code:reason,status:409});
      if(!res.destroyed)json(res,{error:'Esta seleção de reprodução foi encerrada.',code:reason},409);return true;
    };
    if(url.pathname==='/api/playback/status'){
      if(req.method!=='GET'){json(res,{error:'Método inválido.'},405);return;}
      const kind=url.searchParams.get('kind'),id=url.searchParams.get('id'),attempt=url.searchParams.get('attempt')||'';
      if(!['live','movie','series'].includes(kind)||!/^\d{1,12}$/.test(id||'')){json(res,{error:'Reprodução inválida.'},400);return;}
      const intent=state.playbackIntent;
      if(intent?.key!==`${kind}:${id}`||intent.attempt!==attempt||intent.authGeneration!==state.authGeneration){json(res,{error:'Esta seleção foi encerrada.'},409);return;}
      json(res,{failure:mediaBackoff.status(client,intent.key,intent.attempt)});return;
    }
    if(url.pathname==='/api/parental'){
      if(req.method!=='GET'){json(res,{error:'Método inválido.'},405);return;}json(res,state.parental.status());return;
    }
    if(['/api/parental/unlock','/api/parental/lock'].includes(url.pathname)){
      if(req.method!=='POST'){json(res,{error:'Método inválido.'},405);return;}
      if(url.pathname.endsWith('/lock')){state.parental.lock();await client.stopPlayback?.();json(res,state.parental.status());return;}
      const generation=state.authGeneration,value=await input(req);if(generation!==state.authGeneration||state.client!==client){json(res,{error:'Esta sessão foi encerrada.'},401);return;}json(res,state.parental.unlock(value.pin));return;
    }
    const searchRequest=url.pathname==='/api/search',homeRequest=url.pathname==='/api/home/library',movieRequest=url.pathname==='/api/recommendations/movie',homeTvRequest=TV_HOME_API_PATHS.includes(url.pathname);
    if(searchRequest||homeRequest||movieRequest||homeTvRequest?req.method!=='POST':!['GET','HEAD'].includes(req.method)){json(res,{error:'Método inválido.'},405);return;}
    let searchInput;
    if(searchRequest){
      try{searchInput=catalogSearchRequest(await input(req,{maxBytes:65536}));}catch{json(res,{error:'Parâmetros de busca inválidos.',code:'SEARCH_INVALID_REQUEST'},400);return;}
      if(Array.from(searchInput.query).length<3){json(res,shortCatalogSearch(searchInput.query));return;}
    }
    if(homeRequest){
      try{const value=await input(req,{maxBytes:65536});if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid');searchInput=catalogSearchRequest({query:'home',hidden:value.hidden,hiddenItems:value.hiddenItems});}catch{json(res,{error:'Preferências de catálogo inválidas.',code:'HOME_INVALID_REQUEST'},400);return;}
    }
    const catalogRevisionRead=url.pathname==='/api/catalog/revision';
    if(url.pathname!=='/api/live/sources'&&cloudRuntime.enabled&&['wplay','wplay-ott'].includes(client.libraryProvider)&&(['/api/catalog','/api/catalog/read-model','/api/catalog/revision',...TV_API_PATHS,...TV_HOME_API_PATHS,'/api/markers/sync-status','/api/search','/api/home/library','/api/recommendations/movie'].includes(url.pathname)||/^\/api\/(?:shared|sports)-image\//.test(url.pathname))){
      const generation=state.authGeneration;let verified;
      // Database projections use the same validated provider session as EPG.
      // Opening suggestions must not renew WPLAY login on the read path; the
      // active status, expiry and proof age are still checked below and by attach.
      const readonly=runtimeSessionContext()?.readOnly;
      const validatedRead=readonly||url.pathname==='/api/tv/guide'||url.pathname==='/api/epg'||homeTvRequest||homeRequest||movieRequest||catalogRevisionRead;
      try{verified=accountLibrarySession(validatedRead?client.session:await client.connect(),client.config,client.libraryProvider);}
      catch(error){
        if(!readonly&&state.client===client&&state.authGeneration===generation){
          if([401,403].includes(error?.status)){
            await cloudRuntime.attach(state,{connected:false,account:{...client.session?.account,libraryId:state.cloud?.libraryId,status:'Disabled'}},client,generation);
            client.session=null;state.authGeneration++;
          }
          else cloudRuntime.detach(state,client);
        }
        throw error;
      }
      if(state.client!==client||state.authGeneration!==generation){json(res,{error:'Esta sessão foi encerrada.'},401);return;}
      // A revision check stays small even during an Auth outage. The normal
      // connection/library paths own recovery; this route preserves old data.
      if(!catalogRevisionRead&&!readonly)await attachCloud(state,verified,client,generation);
      if(state.client!==client||state.authGeneration!==generation){json(res,{error:'Esta sessão foi encerrada.'},401);return;}
      const account=verified.account,expiry=account?.expiresAt;
      if(!verified.connected||String(account?.status||'').toLowerCase()!=='active'||expiry&&(!Number.isFinite(Date.parse(expiry))||Date.parse(expiry)<=Date.now())||!Number.isFinite(client.authenticatedAt)||Date.now()-client.authenticatedAt>86400000){
        json(res,{error:'Valide novamente sua conta para continuar.',code:'CLOUD_PROVIDER_VALIDATION_REQUIRED'},401);return;
      }
    }
    // Auth and its refresh remain serialized. Shared metadata reads can then
    // overlap; the runtime validates the captured account/PIN scope before
    // releasing any buffered response and never writes these read caches back.
    const detachedMetadataRead=state.cloud&&(
      req.method==='GET'&&(['/api/catalog/read-model','/api/catalog/revision','/api/tv/guide'].includes(url.pathname)||url.pathname==='/api/catalog'&&url.searchParams.get('refresh')!=='1')||
      req.method==='POST'&&(homeRequest||url.pathname==='/api/tv/home'));
    if(detachedMetadataRead)await runtimeSessionContext()?.beforeReadonly();
    if(catalogRevisionRead){
      if(req.method!=='GET'){json(res,{error:'Método inválido.'},405);return;}
      const type=url.searchParams.get('type');if(!['live','movies','series'].includes(type)){json(res,{error:'Tipo de catálogo inválido.'},400);return;}
      const reader=playbackReader(req,res),generation=state.authGeneration,unlocked=state.parental?.unlocked===true;
      try{
        const publication=await cloudRuntime.catalogRevision(state,type,{signal:reader.signal});
        if(reader.signal.aborted||req.aborted||res.destroyed)return;
        if(state.client!==client||state.authGeneration!==generation){json(res,{error:'Esta sessão foi encerrada.'},401);return;}
        if((state.parental?.unlocked===true)!==unlocked){json(res,{error:'A proteção de conteúdo foi alterada.',code:'CATALOG_SCOPE_CHANGED'},409);return;}
        if(!publication){json(res,{error:'A revisão do catálogo está temporariamente indisponível.',code:'CATALOG_REVISION_UNAVAILABLE'},503);return;}
        json(res,publication);return;
      }finally{reader.dispose();}
    }
    if(await homeTvRoutes.handle(req,res,url,{state,client}))return;
    if(await tvRoutes.handle(req,res,url,{state,client}))return;
    if(await movieRoutes.handle(req,res,url,{state,client}))return;
    if(await seriesRoutes.handle(req,res,url,{state,client}))return;
    if(searchRequest||homeRequest){
      const generation=state.authGeneration,unlocked=state.parental?.unlocked===true,abort=new AbortController();
      const cancel=()=>abort.abort();res.once('close',cancel);req.once('aborted',cancel);let result;
      try{
        try{result=await cloudRuntime[homeRequest?'homeLibrary':'searchCatalog'](state,searchInput,{signal:abort.signal});}catch{/* A failed indexed read can use an authorized snapshot below. */}
        if(searchRequest&&!result&&!abort.signal.aborted&&state.client===client&&state.authGeneration===generation&&(state.parental?.unlocked===true)===unlocked)result=await localSearch.search(state,searchInput,{signal:abort.signal});
      }catch{/* Never expose internals or replace unavailable data with a false zero. */}
      finally{res.off('close',cancel);req.off('aborted',cancel);}
      if(res.destroyed)return;
      if(state.client!==client||state.authGeneration!==generation){json(res,{error:'Esta sessão foi encerrada.'},401);return;}
      if((state.parental?.unlocked===true)!==unlocked){json(res,{error:'A proteção de conteúdo foi alterada. Tente novamente.',code:homeRequest?'HOME_SCOPE_CHANGED':'SEARCH_SCOPE_CHANGED'},409);return;}
      if(!result){json(res,{error:homeRequest?'Não foi possível atualizar suas recomendações.':'A busca está temporariamente indisponível. Tente novamente.',code:homeRequest?'HOME_UNAVAILABLE':'SEARCH_UNAVAILABLE'},503);return;}
      // Remember only this bounded result for artwork/playback authorization.
      const items=homeRequest?[...result.favoriteChannels,...result.recommendations.items,...Object.values(result.history).flat()]:result.items;
      for(const type of ['live','movies','series'])state.parental?.rememberCatalog({categories:[],items:items.filter(item=>item?.kind===(type==='movies'?'movie':type))},type);
      json(res,result);return;
    }
    if(url.pathname==='/api/markers/sync-status'){
      if(req.method!=='GET'){json(res,{error:'Método inválido.'},405);return;}
      const generation=state.authGeneration;let report;
      try{report=await cloudRuntime.markerSyncStatus(state);}catch{/* Only the sanitized read model is exposed. */}
      if(state.client!==client||state.authGeneration!==generation){json(res,{error:'Esta sessão foi encerrada.'},401);return;}
      if(!report){json(res,{error:'O registro de sincronização está temporariamente indisponível. Tente novamente.',code:'MARKER_SYNC_STATUS_UNAVAILABLE'},503);return;}
      json(res,report);return;
    }
    if(url.pathname==='/api/catalog/read-model'){
      if(req.method!=='GET'){json(res,{error:'Método inválido.'},405);return;}
      const type=url.searchParams.get('type');if(!['live','movies','series'].includes(type)){json(res,{error:'Tipo de catálogo inválido.'},400);return;}
      const generation=state.authGeneration,unlocked=state.parental?.unlocked===true;let model;
      try{model=await cloudRuntime.catalogReadModel(state,type);}catch{/* Keep the previous navigation model when its replacement is unavailable. */}
      if(state.client!==client||state.authGeneration!==generation){json(res,{error:'Esta sessão foi encerrada.'},401);return;}
      if((state.parental?.unlocked===true)!==unlocked){json(res,{error:'A proteção de conteúdo foi alterada.',code:'CATALOG_SCOPE_CHANGED'},409);return;}
      if(!model){json(res,{error:'A organização do catálogo está sendo preparada.',code:'CATALOG_MODEL_PREPARING'},503);return;}
      json(res,model);return;
    }
    if(url.pathname==='/api/catalog'){
      const type=url.searchParams.get('type');
      if(!['live','movies','series'].includes(type)){json(res,{error:'Tipo de catálogo inválido.'},400);return;}
      const filter=data=>{localSearch.remember(client,type,data);return state.parental?state.parental.filterCatalog(data,type):data;};
      if(state.cloud){
        if(url.searchParams.get('refresh')==='1')await cloudRuntime.refresh(state,'catalog',{media_type:type});
        const paged=url.searchParams.get('paged')==='1'||url.searchParams.has('snapshot');
        if(paged){
          const shared=await cloudRuntime.catalogPage(state,type,{category:url.searchParams.get('category'),page:Number(url.searchParams.get('page')||1),cursor:Number(url.searchParams.get('cursor')??-1),snapshotId:url.searchParams.get('snapshot'),includeAdult:state.parental?.unlocked===true,fresh:url.searchParams.get('cache')==='reload'});
          if(shared){json(res,filter(shared));return;}
        }
        const generation=state.authGeneration;
        const [shared,model]=await Promise.all([cloudRuntime.catalog(state,type,{fresh:url.searchParams.get('cache')==='reload'}),cloudRuntime.catalogReadModel(state,type).catch(()=>null)]);
        if(state.client!==client||state.authGeneration!==generation){json(res,{error:'Esta sessão foi encerrada.'},401);return;}
        if(Array.isArray(shared?.items)&&Array.isArray(shared?.categories)){
          const result=filter({...shared,catalogComplete:true});
          if(model?.mediaType===type&&model.snapshotId===shared.pagination?.snapshotId&&Date.parse(model.revisionAt)===Date.parse(shared.pagination?.revisionAt)&&model.includeAdult===(state.parental?.unlocked===true)&&model.total===result.items.length)result.readModel=model;
          json(res,result);return;
        }
      }
      if(url.searchParams.get('refresh')==='1')client.invalidateCatalog(type);
      const category=url.searchParams.get('category');
      if(category!==null&&category!=='__all'&&client.catalogPage){const page=Number(url.searchParams.get('page')||1);json(res,filter(await cloudRuntime.fallback(state,'catalog',[type,category,page],metadataClient=>metadataClient.catalogPage(type,category,page))));}
      else json(res,filter(await cloudRuntime.fallback(state,'catalog',[type],metadataClient=>metadataClient.catalog(type))));return;
    }
    if(url.pathname==='/api/diagnostics') {
      if(!client.diagnosticPending && (!client.diagnosticLast || Date.now()-client.diagnosticLast.time>15000)) {
        client.diagnosticPending=analyzeConnection(client).then(data=>{client.diagnosticLast={time:Date.now(),data};return data;}).finally(()=>{client.diagnosticPending=null;});
      }
      json(res,client.diagnosticPending?await client.diagnosticPending:client.diagnosticLast.data);return;
    }
    if(url.pathname==='/api/details'){
      const abort=new AbortController(),cancel=()=>abort.abort();res.once('close',cancel);req.once('aborted',cancel);
      const generation=state.authGeneration,unlocked=state.parental.unlocked;
      const current=()=>state.client===client&&state.authGeneration===generation&&state.parental.unlocked===unlocked&&!abort.signal.aborted;
      try{
        const kind=url.searchParams.get('type'),id=url.searchParams.get('id'),artworkOnly=url.searchParams.get('artwork')==='1';
        const details=artworkOnly&&typeof client.artworkMetadata==='function'?await client.artworkMetadata(kind,id,{signal:abort.signal}):await client.details(kind,id,{probeDuration:!artworkOnly&&url.searchParams.get('duration')==='1',signal:abort.signal});
        if(!current()){if(!res.destroyed)json(res,{error:'A sessão foi alterada.'},409);return;}
        if(!details){res.writeHead(404,{'Cache-Control':'no-store'}).end();return;}
        if(artworkOnly&&['movie','series'].includes(kind)&&client.nativeVOD?.registered&&!state.parental.items.has(`${kind}:${id}`)){
          const type=kind==='movie'?'movies':kind;
          // The targeted /@id lookup already loaded trusted native category
          // classification. It need not enumerate a whole VOD catalog again.
          state.parental.rememberCatalog({categories:client.nativeVOD.snapshot(type).categories,items:[]},type);
          state.parental.registerDetails(kind,id,details);
        }
        await state.parental.authorize(client,kind,id,{details});
        if(!current()){if(!res.destroyed)json(res,{error:'A sessão foi alterada.'},409);return;}
        json(res,artworkOnly?Object.fromEntries(['id','kind','name','poster','posterOriginal','backdrop','isAdult'].filter(field=>field in details).map(field=>[field,details[field]])):details);
      }
      finally{res.off('close',cancel);req.off('aborted',cancel);}return;
    }
    if(/^\/api\/sports-image\/[a-f0-9]{64}$/.test(url.pathname)){
      const ref=url.pathname.split('/').at(-1);let image=await sportsLogoReader(ref);
      if(!image&&await cloudRuntime.isSportsLogoReference(state,ref)){
        const stored=await cloudRuntime.cloudArtwork(state,ref);if(stored)image=await sportsLogoMirror(ref,stored);
      }
      if(!image){res.writeHead(404).end();return;}
      const etag='"'+ref+'"',headers={'Content-Type':image.contentType,'Cache-Control':'private, max-age=86400','ETag':etag};
      if(req.headers['if-none-match']===etag){res.writeHead(304,headers).end();return;}
      res.writeHead(200,{...headers,'Content-Length':image.bytes.length});res.end(req.method==='HEAD'?undefined:image.bytes);return;
    }
    if(url.pathname==='/api/image'||/^\/api\/shared-image\/[a-f0-9]{64}$/.test(url.pathname)) {
      res.setHeader('Cache-Control','no-store');
      const generation=state.authGeneration,unlocked=state.parental.unlocked;
      const current=()=>state.client===client&&state.authGeneration===generation&&state.parental.unlocked===unlocked&&!res.destroyed;
      const rejectChanged=()=>{if(current())return false;if(!res.destroyed)json(res,{error:'A sessão ou proteção de conteúdo foi alterada.'},409);return true;};
      const artworkKey=url.pathname==='/api/image'?'/api/image?ref='+url.searchParams.get('ref'):url.pathname;
      const sharedArtwork=url.pathname.startsWith('/api/shared-image/');
      // Shared ownership is an indexed cloud read; it may overlap other reads
      // under the final account/PIN validation without extending the writer lock.
      if(sharedArtwork&&state.cloud)await runtimeSessionContext()?.beforeReadonly();
      await state.parental.authorizeArtwork(artworkKey,sharedArtwork?()=>cloudRuntime.parentalArtworkItem(state,url.pathname.split('/').at(-1)):null);
      if(rejectChanged())return;
      await runtimeSessionContext()?.beforeReadonly();
      const sharedRef=url.pathname.startsWith('/api/shared-image/')?url.pathname.split('/').at(-1):null;
      const cachedShared=sharedRef?images.get('shared:'+url.pathname):null;
      if(cachedShared){res.writeHead(200,{'Content-Type':cachedShared.type,'Content-Length':cachedShared.buffer.length,'Cache-Control':'private, max-age=3600'});res.end(req.method==='HEAD'?undefined:cachedShared.buffer);return;}
      if(sharedRef&&!state.cloud){json(res,{error:'As imagens do catálogo estão temporariamente indisponíveis.',code:'CLOUD_ARTWORK_UNAVAILABLE'},503);return;}
      let shared=sharedRef?cloudRuntime.imageSource(state,sharedRef):null;
      if(sharedRef&&!shared){
        const cloudImage=await cloudRuntime.cloudArtwork(state,sharedRef);
        if(rejectChanged())return;
        if(cloudImage){res.writeHead(302,{Location:cloudImage,'Cache-Control':'private, max-age=900'}).end();return;}
        shared=await cloudRuntime.ensureImageSource(state,sharedRef);
        if(rejectChanged())return;
      }
      const ref=url.searchParams.get('ref');const source=shared?.source||(url.pathname==='/api/image'?client.images.get(ref):null);if(!source){res.writeHead(404).end();return;}
      if(!imageNamespaces.has(client))imageNamespaces.set(client,randomBytes(18).toString('base64url'));
      const imageKey=shared?'shared:'+url.pathname:imageNamespaces.get(client)+':'+source;
      let image=images.get(imageKey);
      if(!image){
        const upstream=await requestUpstream(source,{allowPrivate:allowPrivateUpstream,timeout:20000,headers:shared?.headers||client.upstreamHeaders?.(source)});
        const contentType=String(upstream.headers['content-type']||'').split(';')[0];
        if(upstream.status!==200||!/^image\/(?:jpeg|jpg|png|webp|gif|avif)$/.test(contentType)){upstream.body.destroy();res.writeHead(404).end();return;}
        const buffer=await readBody(upstream,5*1024*1024);image={buffer,type:contentType};images.set(imageKey,image);imageBytes+=buffer.length;
        while(imageBytes>64*1024*1024){const oldest=images.keys().next().value;imageBytes-=images.get(oldest).buffer.length;images.delete(oldest);}
      }
      if(rejectChanged())return;
      // Sharing the recovered image is background work, never a second
      // twenty-second prerequisite for displaying an already available cover.
      if(shared)void cloudRuntime.cloudArtwork(state,sharedRef,{source:{url:shared.source,userAgent:shared.headers?.['User-Agent']||shared.headers?.['user-agent']||client.userAgent||''}}).catch(()=>{});
      res.writeHead(200,{'Content-Type':image.type,'Content-Length':image.buffer.length,'Cache-Control':'private, max-age=3600'});res.end(req.method==='HEAD'?undefined:image.buffer);return;
    }
    let source,key,asset,entrySource,prepareMs=null,resolvedURL=false;
    if(play){
      const reader=playbackReader(req,res),prepareStarted=performance.now();let prepareOk=false,prepareStatus=502;
      try{
        if(play[1]==='series')state.parental.assertPlayback(play[1],play[2]);else await state.parental.authorize(client,play[1],play[2]);
        if(cancelledPlayback())return;
        mediaBackoff.assert(client,`${play[1]}:${play[2]}`);
        source=await client.playbackURL(play[1],play[2],path.extname(url.pathname).slice(1),{signal:reader.signal,attempt:playbackIntent?.attempt,sourceId:playbackIntent?.sourceId});
        prepareOk=true;prepareStatus=200;
      }
      catch(error){prepareStatus=error?.status||502;if(cancelledPlayback())return;throw error;}
      finally{
        prepareMs=Math.max(0,performance.now()-prepareStarted);
        if(play[1]==='live'&&req.method==='GET'&&!reader.signal.aborted&&currentPlaybackIntent(state,client)===playbackIntent)
          observeTvTransport(client,playbackIntent,{phase:'prepare',durationMs:prepareMs,ok:prepareOk,status:prepareStatus});
        reader.dispose();if(!res.headersSent&&!res.destroyed)res.setHeader('Server-Timing',`prepare;dur=${prepareMs.toFixed(1)}`);
      }
      if(cancelledPlayback())return;
      key=play[1]+':'+play[2];client.beginPlayback(key);entrySource=source;if(play[1]==='live'&&client.playback.manifestURL){source=client.playback.manifestURL;resolvedURL=true;}
    }
    else if(url.pathname.startsWith('/api/asset/')){asset=client.assets.get(url.pathname.slice(11));if(!asset||client.playback?.key!==asset.key){res.writeHead(404).end();return;}const [kind,id]=asset.key.split(':');state.parental.assertPlayback(kind,id);source=asset.url;key=asset.key;}
    else {json(res,{error:'Rota não encontrada.'},404);return;}
    const current=client.playback;const abort=new AbortController();const stop=()=>abort.abort();res.on('close',stop);current.controller.signal.addEventListener('abort',stop,{once:true});
    const started=performance.now();let ttfbMs=0,bytes=0,upstreamFailed=false,headersMs=null,firstBodyMs=null,rewriteMs=null,upstreamStatus=null;
    const kind=asset?.mediaDurationSeconds?'segment':play?.[1]==='live'||/\.m3u8(?:[?#]|$)/i.test(String(source))?'playlist':'video';
    let transportPhase=kind==='playlist'?'manifest':kind==='segment'?'segment':'asset',playlistMetadata=null;
    const transportIdentity=key.startsWith('live:')?currentPlaybackIntent(state,client,{active:true}):null;
    const firstBody=()=>{if(firstBodyMs===null)firstBodyMs=Math.max(0,performance.now()-started);};
    const reportTransport=(ok,status)=>{
      if(req.method==='GET'&&transportIdentity&&client.playback===current&&!current.controller.signal.aborted&&currentPlaybackIntent(state,client,{active:true})===transportIdentity)
        observeTvTransport(client,transportIdentity,{phase:transportPhase,durationMs:performance.now()-started,headersMs,firstBodyMs,rewriteMs,bytes,mediaSeconds:asset?.mediaDurationSeconds||null,ok,status,...playlistMetadata});
    };
    try {
      const range=req.headers.range;if(range&&(!/^bytes=\d*-\d*$/.test(range)||range==='bytes=-')){reportTransport(false,416);res.writeHead(416).end();return;}
      const cached=!range&&kind==='segment'&&asset?.cacheKey?client.cachedSegment(asset.cacheKey,key):null;
      if(cached){res.writeHead(200,{'Content-Type':cached.type,'Content-Length':cached.buffer.length,'Cache-Control':'private, max-age=30','Server-Timing':'segmentcache;dur=0'});res.end(req.method==='HEAD'?undefined:cached.buffer);transportPhase='cache';bytes=cached.buffer.length;reportTransport(true,200);return;}
      const requestOptions={allowPrivate:allowPrivateUpstream,method:req.method,signal:abort.signal,timeout:kind==='playlist'?10000:kind==='segment'?15000:25000,headers:{...client.upstreamHeaders?.(source),...(range?{Range:range}:{})}};
      const mediaRequest=client.upstreamRequest?.bind(client)||requestUpstream;
      mediaBackoff.assert(client,key,source);
      // The provider sid/gen and local source must be durable before a media
      // request can start that source on WPLAY. A new owner can then STOP it.
      await runtimeSessionContext()?.checkpoint();
      let upstream=await mediaRequest(source,requestOptions);
      if(play?.[1]==='live'&&entrySource&&String(source)!==String(entrySource)&&[401,403,404,410].includes(upstream.status)){
        upstream.body.destroy();current.manifestURL=null;source=entrySource;resolvedURL=false;
        requestOptions.headers={...client.upstreamHeaders?.(source),...(range?{Range:range}:{})};
        upstream=await mediaRequest(source,requestOptions);
      }
      ttfbMs=performance.now()-started;
      headersMs=ttfbMs;upstreamStatus=upstream.status;
      upstream.body.once('error',()=>{if(!abort.signal.aborted&&!current.controller.signal.aborted)upstreamFailed=true;});
      if(![200,206].includes(upstream.status)){
        upstream.body.destroy();
        if(upstream.status===416){const headers={'Cache-Control':'no-store'};if(/^bytes \*\/\d+$/.test(upstream.headers['content-range']||''))headers['Content-Range']=upstream.headers['content-range'];reportTransport(false,416);res.writeHead(416,headers).end();return;}
        const live=key.startsWith('live:'),limited=upstream.status===429,status=[401,403,429].includes(upstream.status)?upstream.status:502,code=limited?(live?'LIVE_RATE_LIMITED':'PLAYBACK_RATE_LIMITED'):asset?kind==='segment'?'PLAYBACK_SEGMENT_HTTP':'PLAYBACK_ASSET_HTTP':'PLAYBACK_UPSTREAM_HTTP';
        const failure={status,upstreamStatus:upstream.status,code,source,retryAfter:upstream.headers['retry-after'],attempt:state.playbackIntent?.key===key?state.playbackIntent.attempt:''};
        mediaBackoff.failure(client,key,failure);
        // Successful segments never take the writer lease. A provider failure
        // merges only its cooldown into a fresh checkpoint of this same epoch.
        if(runtimeSessionContext()?.readOnly)await runtimeSessionContext().update(fresh=>mediaBackoff.failure(fresh.client,key,failure));
        client.recordTransfer({key,kind,bytes:0,ttfbMs,durationMs:performance.now()-started,mediaDurationSeconds:asset?.mediaDurationSeconds||null,ok:false});
        reportTransport(false,upstream.status);
        playbackError({kind:play?.[1]||asset?.key.split(':')[0],code,status,upstreamStatus:upstream.status});
        if(limited){const retryAfterSeconds=mediaBackoff.remaining(client,key,source);res.setHeader('Retry-After',String(retryAfterSeconds));json(res,{error:'O provedor solicitou uma pausa antes de retomar esta transmissão.',code,retryAfterSeconds},status);}
        else json(res,{error:`O provedor não disponibilizou esta mídia (HTTP ${upstream.status}).`,code,upstreamStatus:upstream.status},status);
        return;
      }
      mediaBackoff.success(client,key);
      const manifest=/\.m3u8(?:[?#]|$)/i.test(String(source))||/mpegurl/i.test(String(upstream.headers['content-type']));
      if(manifest&&runtimeSessionContext()?.readOnly){upstream.body.destroy();throw Object.assign(new Error('O segmento retornou uma lista de reprodução inesperada.'),{status:502,code:'PLAYBACK_SEGMENT_MANIFEST'});}
      if(manifest&&req.method!=='HEAD') {
        transportPhase='manifest';
        const text=(await readBody(upstream,4*1024*1024,chunk=>{firstBody();bytes+=chunk.length;})).toString();
        // A completed body can outlive the selection that requested it. Never
        // let that response refresh assets belonging to a newer live owner.
        if(key.startsWith('live:')&&(state.client!==client||client.playback!==current||current.controller.signal.aborted||abort.signal.aborted||
          transportIdentity&&currentPlaybackIntent(state,client,{active:true})!==transportIdentity)){
          const code=state.client!==client?'PLAYBACK_CLIENT_CHANGED':client.playback!==current?'PLAYBACK_SOURCE_CHANGED':
            current.controller.signal.aborted?'PLAYBACK_SOURCE_ABORTED':abort.signal.aborted?'PLAYBACK_READER_ABORTED':'PLAYBACK_INTENT_CHANGED';
          playbackError({kind:'live',code,status:409});
          if(!res.destroyed)json(res,{error:'Esta seleção de reprodução foi encerrada.',code},409);return;
        }
        if(!text.trimStart().startsWith('#EXTM3U'))throw new Error('O provedor retornou um stream incompatível com HLS.');
        if(transportIdentity&&typeof onPlaybackTransport==='function'){
          const age=upstream.headers.age;
          playlistMetadata={...tvPlaylistTransportMetadata(text),playlistKey:asset?.url||'entry',entryPlaylist:play?.[1]==='live',
            bootstrap:play?.[1]==='live'&&!resolvedURL,resolvedURL,ageSeconds:typeof age==='string'&&/^\d+$/.test(age)?Number(age):null};
        }
        if(play?.[1]==='live')current.manifestURL=upstream.url;
        const rewriteStarted=performance.now(),body=client.rewriteManifest(text,upstream.url,key);rewriteMs=Math.max(0,performance.now()-rewriteStarted);
        if(playlistMetadata)playlistMetadata.uriIdentity=tvPlaylistUriIdentity(text,body,upstream.url);
        await runtimeSessionContext()?.beforeStreaming();
        res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl','Cache-Control':'no-store','Server-Timing':`${prepareMs===null?'':`prepare;dur=${prepareMs.toFixed(1)}, `}upstream;dur=${ttfbMs.toFixed(1)}`});res.end(body);client.recordTransfer({key,kind,bytes,ttfbMs,durationMs:performance.now()-started,ok:true});reportTransport(true,upstream.status);return;
      }
      const headers={'Content-Type':upstream.headers['content-type']||(/\.mp4/.test(upstream.url)?'video/mp4':'application/octet-stream'),'Cache-Control':kind==='segment'?'private, max-age=30':'no-store','Server-Timing':`${prepareMs===null?'':`prepare;dur=${prepareMs.toFixed(1)}, `}upstream;dur=${ttfbMs.toFixed(1)}`};
      for(const name of ['content-length','content-range','accept-ranges'])if(upstream.headers[name])headers[name]=upstream.headers[name];
      if(upstream.headers['content-encoding'])delete headers['content-length'];
      await runtimeSessionContext()?.beforeStreaming();
      res.writeHead(upstream.status,headers);
      if(req.method==='HEAD'){upstream.body.destroy();res.end();return;}
      const chunks=[];let retain=kind==='segment'&&!range&&!!asset?.cacheKey;
      const meter=new Transform({transform(chunk,encoding,callback){firstBody();bytes+=chunk.length;if(retain){if(bytes>8*1024*1024){retain=false;chunks.length=0;}else chunks.push(chunk);}callback(null,chunk);}});
      await pipeline(upstream.body,meter,res);
      client.recordTransfer({key,kind,bytes,ttfbMs,durationMs:performance.now()-started,mediaDurationSeconds:asset?.mediaDurationSeconds||null,ok:true});
      reportTransport(true,upstream.status);
      if(retain&&asset?.cacheKey)client.cacheSegment(asset.cacheKey,key,Buffer.concat(chunks),headers['Content-Type']);
    } catch(error) {if(!current.controller.signal.aborted&&(!abort.signal.aborted||upstreamFailed)){
      client.recordTransfer({key,kind,bytes,ttfbMs,durationMs:performance.now()-started,mediaDurationSeconds:asset?.mediaDurationSeconds||null,ok:false});
      reportTransport(false,upstreamStatus||502);
      if(asset)playbackError({kind:asset.key.split(':')[0],code:kind==='segment'?'PLAYBACK_SEGMENT_TRANSPORT':'PLAYBACK_ASSET_TRANSPORT',status:502});
    }throw error;
    } finally {res.off('close',stop);current.controller.signal.removeEventListener('abort',stop);}
  }
  function respondError(req,res,url,error,currentClient=null){
    if(!currentClient){const token=req.headers.cookie?.match(/(?:^|;\s*)ORBIT_SID=([\w-]+)/)?.[1];currentClient=sessions.get(token)?.client;}
      const failedPlay=/^\/api\/play\/(live|movie|series)\/\d{1,12}(?:\/index\.m3u8|\.[a-z0-9]{2,6})$/.exec(url.pathname);
      if(failedPlay&&!req.aborted&&!res.destroyed&&error?.name!=='AbortError'&&error?.code!=='ABORT_ERR'){
        const status=error instanceof ProviderError&&[400,401,403,404,409,422,429,501,502,503,504].includes(error.status)?error.status:502;
        const client=currentClient;
        if(client&&!error?.mediaCooldown)mediaBackoff.failure(client,`${failedPlay[1]}:${url.pathname.split('/')[4]?.split('.')[0]}`,{status,code:error?.code||'CONNECTION_FAILED',attempt:url.searchParams.get('attempt')||'',...(status===429?{retryAfter:String(error.retryAfterSeconds||30)}:{})});
        if(!error?.mediaCooldown)playbackError({kind:failedPlay[1],code:error?.code||error?.cause?.code||error?.errors?.find(value=>typeof value?.code==='string')?.code,status});
      }
      if(res.destroyed)return;
      if(res.headersSent){res.destroy();return;}
      if(url.pathname.startsWith('/api/')){
        const runtime=/^RUNTIME_SESSION_[A-Z_]+$/.test(error?.code||'')&&error.status===503,parental=/^PARENTAL_[A-Z_]+$/.test(error?.code||''),limited=error instanceof ProviderError&&error.status===429;
        const artworkUnavailable=/^\/api\/shared-image\/[a-f0-9]{64}$/.test(url.pathname)&&error?.code==='CLOUD_ARTWORK_UNAVAILABLE'&&error.status===503;
        const retryAfterSeconds=limited?liveRetryAfter(String(error.retryAfterSeconds||30)):parental?error.retryAfterSeconds:null;
        if(limited)res.setHeader('Retry-After',String(retryAfterSeconds));
        json(res,{error:friendly(error,currentClient),code:error instanceof ProviderError||parental||artworkUnavailable||runtime?error.code:'CONNECTION_FAILED',...(retryAfterSeconds?{retryAfterSeconds}:{})},(error instanceof ProviderError||parental||artworkUnavailable||runtime)&&[400,401,403,404,409,422,429,501,502,503,504].includes(error.status)?error.status:502);
      }
      else res.writeHead(404).end('Arquivo não encontrado');
  }
  const server=http.createServer(async(req,res)=>{
    if(shuttingDown){res.writeHead(503,{'Connection':'close'}).end();return;}
    const host=req.headers.host||'';
    if(!allowedRequestHost(host)){res.writeHead(403).end();return;}
    await cloudRuntime.refreshConfiguration();
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    // The document must allow the fixed project even if the server-only config
    // is provisioned later; a subsequent API response cannot replace its CSP.
    const cloudConnections=` https://${ARKHEN_SUPABASE_PROJECT}.supabase.co wss://${ARKHEN_SUPABASE_PROJECT}.supabase.co`;
    res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob: https://${ARKHEN_SUPABASE_PROJECT}.supabase.co/storage/v1/object/public/arkhen-catalog-artwork/; media-src 'self' blob:; connect-src 'self'${cloudConnections}; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
    let url;
    try {url=new URL(req.url,'http://'+host);}catch{res.writeHead(400).end('Endereço inválido');return;}
    try {
      if(url.pathname.startsWith('/api/')) {
        if(req.headers['sec-fetch-site']==='cross-site' || (req.headers.origin&&!['http://'+host,'https://'+host].includes(req.headers.origin))){json(res,{error:'Origem da requisição não permitida.'},403);return;}
        if(sessionStore){
          await sessionStore.run(req,res,{create:url.pathname==='/api/login',readOnly:runtimeSessionReadPolicy(req,url),createState:createSessionState,capture:captureRuntimeSession,drain:drainSession,
            restore:dto=>restoreRuntimeSession(dto,{createState:createSessionState,createClient:async({provider,config})=>{
              const resolved=providerConnection.resolveConnection({provider,...config},null);
              return providerConnection.createClient({...resolved,config:{...resolved.config,...config}});
            }})},async state=>{
              req.runtimeClient=state.client;
              try{await api(req,res,url,state);}catch(error){respondError(req,res,url,error,state.client);}finally{req.runtimeClient=state.client;}
            });
        }else await api(req,res,url);return;
      }
      if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{Allow:'GET, HEAD'}).end();return;}
      const pathname=decodeURIComponent(url.pathname);const requested=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
      if(!requested.startsWith(root)){res.writeHead(403).end();return;}
      const file=await realpath(requested);if(!file.startsWith(root)){res.writeHead(403).end();return;}
      const info=await stat(file);if(!info.isFile()){res.writeHead(404).end();return;}
      const logoAsset=/^\/(?:assets\/channels|tv\/logos(?:\/[a-z0-9-]+)*)\/[a-z0-9-]+-[a-f0-9]{16}\.webp$/.test(pathname);
      const headers={'Content-Type':types[path.extname(file)]||'application/octet-stream','Accept-Ranges':'bytes','Cache-Control':logoAsset?'public, max-age=31536000, immutable':'no-cache'};
      let start=0,end=info.size-1,status=200;
      if(req.headers.range){const range=parseRange(req.headers.range,info.size);if(!range){res.writeHead(416,{'Content-Range':`bytes */${info.size}`}).end();return;}({start,end}=range);status=206;headers['Content-Range']=`bytes ${start}-${end}/${info.size}`;}
      headers['Content-Length']=Math.max(0,end-start+1);res.writeHead(status,headers);
      if(req.method==='HEAD'||info.size===0){res.end();return;}
      await pipeline(createReadStream(file,{start,end}),res);
    } catch(error) {
      respondError(req,res,url,error,req.runtimeClient);
    }
  });
  let cleanup,shutdown;
  const closeSessions=()=>{
    if(!cleanup){
      shuttingDown=true;
      cloudRuntime.close();
      const clients=[];
      for(const state of sessions.values()){state.authGeneration++;cloudRuntime.detach(state);clients.push(state.client);state.client=null;}
      sessions.clear();cleanup=Promise.all(clients.map(releaseClient));
    }
    return cleanup;
  };
  server.on('close',()=>{void closeSessions().catch(()=>{});});
  server.shutdown=()=>{
    if(!shutdown)shutdown=(async()=>{
      const closed=new Promise(resolve=>server.close(resolve));
      server.closeIdleConnections?.();
      try{await closeSessions();}
      finally{server.closeAllConnections?.();await closed;}
    })();
    return shutdown;
  };
  return server;
}

import {createCatalogSidebar} from './sistema/catalogo/barra-lateral.js';
import {icon,replaceIcon,mountIcons,node,iconNode,button} from './sistema/ui/dom.js';
import { PlayerTools, findChannelVariants } from './player-tools.js';
import {SettingsTools} from './sistema/configuracoes/orquestrador.js';
import {SystemShell} from './sistema/orquestrador.js';
import {ApplicationServices} from './sistema/services.js';
import {CatalogContentView} from './sistema/catalogo/visualizacao.js';
import {MoviesServices} from './filmes/services.js';
import {SeriesServices} from './serie/services.js';
import {MyListServices} from './minha-lista/services.js';
import {MyListOrchestrator} from './minha-lista/orquestrador.js';
import {FavoriteTVGuide} from './minha-lista/grade-tv.js';
import {ImmersivePlayer} from './player/orquestrador.js';
import {ChannelSwitchView} from './player/troca-canal/visualizacao.js';
import {ChannelSwitchService} from './player/troca-canal/servico.js';
import {ChannelSwitchController} from './player/troca-canal/orquestrador.js';
import {LiveVideoHost} from './player/troca-canal/continuidade/host.js';
import {ContinuityAudio} from './player/troca-canal/continuidade/audio.js';
import {LiveContinuityFlow} from './player/troca-canal/continuidade/fluxo.js';
import {resolvePlayerTransport,playerEnginePreference} from './player/motores/orquestrador.js';
import {tvScopeKey} from './tv/scope.js';
import {TVOrchestrator} from './tv/orquestrador.js';
import {prepareTVOpening,TV_SOURCE_DISCOVERY_TIMEOUT_MS} from './tv/player/abertura.js';
import {TVPlaybackMeasurement} from './tv/player/medicao.js';
import {tvHasPlayableVideo,observeTVPlaybackReadiness} from './tv/player/estado-media.js';
import {programWindow} from './tv/canais/programacao.js';
import {localPlaybackMessage} from './playback-api-error.js';
import {LoginOrchestrator} from './login/orquestrador.js';
import {SessionGuard} from './login/session-guard.js';
import { reconcileChildren, reconcileCards } from './catalog-renderer.js';
import { parseContentRoute, contentRoute, fallbackContentRoute, catalogView, restoreCatalogPosition } from './page-routes.js';
import {preloadArtwork,openingArtwork} from './login/capas.js';
import {prepareHomeCatalogs,waitForEntryCatalog} from './inicio/hooks.js';
import { PreviewTools } from './preview-tools.js';
import {movieWithPlaybackDuration} from './filmes/duracao.js';
import {MoviePlayback} from './filmes/reproducao.js';
import {MovieAudio} from './filmes/audio.js';
import {SeriesPlayback} from './serie/reproducao.js';
import {SeriesAudio} from './serie/audio.js';
import {allSeriesEpisodes as allEpisodes} from './serie/episodios.js';
import {loadSeriesPlaybackSequence} from './serie/sequencia.js';
import { artworkURL, loadChannelLogos } from './channel-artwork.js';
import {featuredTitles,cloudFeaturedTitles} from './inicio/bannerprincipal/selecao.js';
import {latestReleases,HOME_SHELF_LIMIT} from './inicio/ordens.js';
import {playbackProgress} from './inicio/progresso.js';
import {HomeCloudModel} from './inicio/tanstack-query.js';
import {HomeOrchestrator} from './inicio/orquestrador.js';
import {HomeChannelShelf} from './inicio/lista-canais/visualizacao.js';
import {HomeChannelPrograms} from './inicio/lista-canais/programacao.js';
import {HomeTVModel} from './inicio/lista-canais/tanstack-query.js';
import {HomeTVRealtime} from './inicio/lista-canais/realtime.js';
import {TVWatchHeartbeat} from './inicio/lista-canais/watch-heartbeat.js';
import {MovieRecommendationsModel} from './filmes/tanstack-query.js';
import {setHeroArtwork,renderHeroFacts} from './inicio/bannerprincipal/apresentacao.js';
import { CatalogPager, isPagedCatalog, mergeCatalogPage } from './catalog-pagination.js';
import {isPreparingCatalog,completeCatalogForSession} from './catalog-loading-policy.js';
import {CatalogCache,CATALOG_CACHE_TTL_MS} from './catalog-cache.js';
import {CatalogBrowseIndex,sanitizeCatalogReadModel} from './catalog-read-model.js';
import {resolveLibraryItem} from './library-catalog.js';
import {LibraryArtworkHydrator} from './library-artwork.js';
import {bindArtworkImage,retryArtworkImages} from './artwork-image.js';
import {CatalogRepository,catalogIsComplete} from './catalog-repository.js';
import {selectLibraryFavorites,catalogCountLabel} from './library-selectors.js';
import {MoviesFeature} from './filmes/orquestrador.js';
import {SeriesFeature} from './serie/orquestrador.js';
import {LiveFeature} from './tv/aba.js';
import { withoutSessionArtwork } from './stored-artwork.js';
import { MediaLibrary } from './media-library.js';
import {canSearchGlobally,normalizeSearchText} from './global-search.js';
import {RemoteSearch} from './remote-search.js';
import {localSearchSnapshot} from './local-search-snapshot.js';
import { formatAccessValidity } from './access-validity.js';
import { normalizeSortMode, sortCatalogItems } from './catalog-sort.js';
import { ChannelVolumeMemory } from './channel-volume-memory.js';
import { AudioProcessing } from './audio-processing.js';
import { orderCatalogCategories, defaultCatalogCategory, releaseCatalogCategory, DAILY_GAMES_CATEGORY, RELEASES_CATEGORY, ADULT_CATEGORY } from './catalog-navigation.js';
import {isAdultItem,isAdultCategory} from './parental-classification.js';
import { catalogGenres } from './catalog-genres.js';
import {EpisodeProgressStore} from './serie/progresso.js';
import { SeriesPlaybackPreferences, SERIES_PLAYBACK_DEFAULTS } from './series-playback-preferences.js';
import { VodSeekController } from './vod-seek.js';
import { ResumePrompt } from './resume-prompt.js';
import {resumePlaybackPosition,PlaybackPositionGuard} from './playback-position.js';
import {CloudLibrary} from './cloud-library.js';
import {CloudAppBridge} from './cloud-app-bridge.js';
import {SharedCatalogUpdates} from './sistema/catalogo/realtime.js';
import {EpisodeOnDemandReader} from './serie/marcadores/sob-demanda.js';
import {ParentalControlUI} from './parental-control.js';
import {createHlsErrorHandler} from './hls-error-handler.js';
import {createLiveAttempt,supportsNativeHLS} from './live-playback-session.js';
import {movieFinishedForSuggestions} from './filmes/recomendacoes/sessao.js';

const $ = selector => document.querySelector(selector);
const applicationServices=new ApplicationServices();
function normalize(text) { return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
function artwork(url){return artworkURL(url);}
function image(url,className='',lazy=true,fallback='',onFailure){
  const picture=node('img',className);picture.alt='';picture.loading=lazy?'lazy':'eager';picture.decoding='async';
  return bindArtworkImage(picture,{source:url,fallback,onFailure,getScope:()=>`${connectionGeneration}:${session?.account?.libraryId||''}:${parentalControl?.unlocked===true}`});
}
function read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage is optional */ } }
function itemKey(item) { return `${item.kind}:${item.id}`; }
function mayRemember(item,details){if(!item||historyBlocked.has(itemKey(item)))return false;const type=item.kind==='movie'?'movies':item.kind,catalog=catalogs.get(type),current=catalog?.itemMap?.get(String(item.id)),categories=catalog?.sourceCategories||catalog?.categories||[];return !isAdultItem(item,categories)&&!isAdultItem(current,categories)&&!isAdultItem(details,categories);}
function historyFor(item){if(!mayRemember(item))return null;const entry=history.get(itemKey(item));return !entry||!mediaLibrary.remembersEntry(entry)||entry.libraryId&&entry.libraryId!==session?.account?.libraryId?null:entry;}
function snapshot(item) { return withoutSessionArtwork({id:String(item.id),name:String(item.name),kind:item.kind,poster:artwork(item.poster),...(item.kind==='live'?{posterOriginal:artwork(item.posterOriginal)}:{}),year:item.year || null,categoryId:item.categoryId || '',categoryIds:item.categoryIds||[item.categoryId||''],group:item.group||'',groupNames:item.groupNames||[],...(!mayRemember(item)?{isAdult:true}:{}),libraryId:session?.account?.libraryId||'',container:item.container || 'mp4',rating:item.rating || null,added:item.added ?? null,savedAt:item.savedAt ?? null}); }
const favorites = new Map(), history = new Map();
const catalogs = new Map(), loading = new Set(), failures = new Map(), pendingCatalogs = new Map(), detailsCache = new Map(),historyBlocked=new Set();
const mediaLibrary = new MediaLibrary({read,save,favorites,history,canRemember:mayRemember,onMigrate:()=>{void cloudBridge?.syncLocal();}});
const episodeProgress=new EpisodeProgressStore({read,save,canRemember:mayRemember});
const savedSortModes=read('arkehn.sortModes.v1',{}),sortModes=Object.fromEntries(['movies','series','favorites'].map(type=>[type,normalizeSortMode(savedSortModes?.[type])]));
const catalogCache=new CatalogCache(),catalogCacheRecords=new Map(),dailyCatalogAttempts=new Map();
const catalogFeatureServices={loadCatalog,getCatalog:type=>catalogs.get(type)};
const catalogFeatures=new Map([['movies',new MoviesFeature({sort:sortModes.movies,services:new MoviesServices(catalogFeatureServices)})],['series',new SeriesFeature({sort:sortModes.series,services:new SeriesServices(catalogFeatureServices)})],['live',new LiveFeature({services:{load:options=>tv.channels.load(options)}})]]);
const filmes=catalogFeatures.get('movies');
const series=catalogFeatures.get('series');
const catalogRepository=new CatalogRepository({getScope:type=>catalogRepositoryScope(type),getAccountEpoch:()=>connectionGeneration,prepare:prepareCatalog,onScopeChange:type=>{catalogs.delete(type);catalogCacheRecords.delete(type);},onCommit:(type,data)=>{catalogs.set(type,data);mediaLibrary.migrate(data);episodeProgress.reconcileCatalog(data,type);purgeRememberedHistory();}});
let dailyCatalogTimer=null,dailyCatalogWork=null,entryPreparationController=null;
let pendingTransportStop=Promise.resolve();
let lastPlaybackStop=Promise.resolve();
let playerTransportRequest=0;
const entryCatalogListeners=new Set();
let session = null, view = 'home', category = '__all', query = '', visibleLimit = 48, heroItem = null, featured = [], heroRequest = 0, detailRequest = 0, detailItem = null, detailData = null, activeSeason = 0, player = null, hls = null, toastTimer, queryTimer, progressLastSaved = 0, playbackSerial = 0, pendingStop = Promise.resolve(), playOpenRequest = 0, connectionGeneration = 0, refreshRequest = 0, immersivePlayer = null, channelGuide = null;
const sessionGuard=new SessionGuard({request:(path,options)=>applicationServices.request(path,options),
  getScope:()=>session?.connected?`${connectionGeneration}:${session.account?.libraryId||''}`:null,
  getAccountId:()=>session?.account?.libraryId||null,onLost:handleSessionLoss});
let pageRouteRequest=0,catalogReturn=null,contentReturnFocus=null,lastPageRouteKey=null,previewDurationController=null,previewDurationPending=false;
let heroDurationController=null;
let heroRotation=null;
let shelfCarousels=null,shelfSerial=0;
let dailyGames=null;
let liveProgramFeed=null;
let favoriteTVGuide=null;
let homeChannels=null,homeChannelPrograms=null,homeTVModel=null,homeTVRealtime=null,tvWatchHeartbeat=null,homePlaybackOpening=0,homeFullscreenPending=false;
let catalogRenderTimer=null,automaticRevealFrame=null;
let automaticProviderDemand=1;
let categoryDefaultPending=true;
const automaticCatalogCategories=new Set(['live','movies','series']);
let selectedGenre='__all',genreCache=null;
let playerMetadataCleanup=null;
let cloudBridge=null,episodeMarkerReader=null,cloudMarkersScope=null,parentalControl=null,channelSwitch=null,continuityFlow=null;
let cloudStatus={state:'local',message:'Biblioteca salva neste aparelho.'};
function privateProjectionScope(){
  const cloud=session?.cloud,preferences=settingsTools.getPreferences();
  return{project:cloud?.url||'',providerKey:cloud?.providerKey||'',scopeHash:cloud?.scopeHash||'',account:session?.account?.libraryId||'',epoch:connectionGeneration,includeAdult:parentalControl?.unlocked===true,hidden:preferences.hidden,hiddenItems:preferences.hiddenItems};
}
const tv=new TVOrchestrator({request:api,getScope:()=>session?.connected?privateProjectionScope():null});
const tvGuide=tv.guide;
const remoteSearch=new RemoteSearch({request:api,getScope:privateProjectionScope,prepare:prepareRemoteSearch,
  fallback:(input,{signal})=>input.type==='series'?null:localSearchSnapshot(input,{catalogs,isItemVisible,isCategoryAllowed:(type,id)=>settingsTools.isCategoryVisible(type,id),signal}),
  onChange:()=>{if(session?.connected&&query&&!contentPageOpen()&&!settingsTools.isOpen)render();}});
function searchCatalogQuery(term,options={}){return options.type==='series'?series.search(term,options):remoteSearch.search(term,options);}
function refreshCatalogSearch(){return searchCatalogQuery(remoteSearch.state.query,{type:remoteSearch.state.type,immediate:true,force:true});}
let homeLibraryRevision=0,movieLibraryRevision=0;const homeHistoryExcluded=new Set();
const homeCloudModel=new HomeCloudModel({request:api,getScope:()=>session?.connected?privateProjectionScope():null,isAvailable:centralCatalogReady,isActive:()=>catalogWorkActive()&&!settingsTools.isOpen&&!query&&(view==='home'||document.body.classList.contains('session-preparing')),getRevision:()=>({library:homeLibraryRevision,catalogs:['movies','series'].map(type=>catalogs.get(type)?.pagination?.snapshotId||'')}),onChange:()=>{if(session?.connected&&view==='home'&&!query&&!contentPageOpen()&&!settingsTools.isOpen)scheduleCatalogRender('home');}});
function ensureHomeProjection(){if(session?.connected){homeCloudModel.ensure();homeTVModel?.ensure();}}
function homeTVActive(){return Boolean(session?.connected&&view==='home'&&!query&&!document.hidden&&!contentPageOpen()&&!settingsTools.isOpen&&!player&&!homePlaybackOpening&&!$('#application').hidden&&!document.body.classList.contains('session-preparing'));}
function homePlaybackScope(){return session?.connected?`${connectionGeneration}:${session.account?.libraryId||''}`:null;}
function invalidateHomeTV(){homeTVModel?.invalidate();if(homeTVActive())scheduleCatalogRender('home');}
function syncHomeChannels(){homeChannels?.sync();homeChannelPrograms?.sync();}
function pauseHomeChannels(reason){homeChannelPrograms?.pause();void homeChannels?.pause(reason,{retryStop:false}).catch(()=>{});}
const libraryArtwork=new LibraryArtworkHydrator({request:api,getScope:()=>session?.connected?privateProjectionScope():null,
  maxItems:96,maxEntries:128,
  getItems:()=>!catalogWorkActive()?[]:view==='favorites'?myList.artworkItems():[...history.values()].filter(entry=>!entry.libraryId||entry.libraryId===session?.account?.libraryId).sort((a,b)=>Number(b.updated||0)-Number(a.updated||0)).map(entry=>resolveLibraryItem(entry.item,{catalog:catalogs.get(typeFor(entry.item.kind)),libraryId:session?.account?.libraryId,activeLibraryId:mediaLibrary.accountId})).filter(item=>item&&isAutomaticItemVisible(item)).slice(0,30),
  onResult:()=>{inicio.invalidate();if(session?.connected&&!contentPageOpen()&&!settingsTools.isOpen)scheduleCatalogRender(view);}});
const movieRecommendationsModel=new MovieRecommendationsModel({request:api,getScope:()=>session?.connected?privateProjectionScope():null,getRevision:()=>({library:movieLibraryRevision,movies:catalogs.get('movies')?.pagination?.snapshotId||''})});
const modelHydrations=new Map();
const videoHost=new LiveVideoHost({video:$('#video'),stage:$('.video-stage')});
const video=videoHost.video;
const positionGuard=new PlaybackPositionGuard();
const seriesPlaybackPreferences=new SeriesPlaybackPreferences({getNamespace:()=>session?.account?.libraryId||''});
const resumePrompt=new ResumePrompt({video,onRestart:()=>{
  if(!player||player.item.kind==='live')return;
  if(vodSeek.request(0,{play:true,reason:'restart'})){progressLastSaved=0;saveProgress(true);}
}});
const vodSeek=new VodSeekController({video,onRecover:({target,play,sourceKey,recoveryAttempt})=>{
  if(!player||sourceKey!==playbackSourceKey(player.item,player.episode))return false;
  const {item,episode,playOptions}=player;
  if(item.kind==='movie'){
    const options=moviePlayback.recoveryOptions({target,play,sourceKey,recoveryAttempt},{quality:playerTools.getQualitySelection(),retryAfterUntil:player.retryAfterUntil,failed:playerTools.current?.failed});
    return options?openPlayer(item,null,options):false;
  }
  const options=seriesPlayback.recoveryOptions({target,play,sourceKey,recoveryAttempt},{quality:playerTools.getQualitySelection(),retryAfterUntil:player.retryAfterUntil,failed:playerTools.current?.failed});
  return options?openPlayer(item,episode,options):false;
},onStateChange:({state,detail,target})=>{
  if(!player||player.item.kind==='live')return;
  positionGuard.observe({state,detail,target,reason:vodSeek.pending?.reason});
  if(Number.isFinite(target))player.seekTarget=target;
  if(state==='recovering'){immersivePlayer?.setLoading(true,'Retomando a posição escolhida');$('#player-status').textContent='Retomando a posição escolhida…';}
  else if(state==='failed')playbackFailure(detail==='interaction-required'?'Pressione play para continuar.':'Não foi possível avançar nesta fonte. Tente novamente para retomar a posição escolhida.');
  else if(state==='ready'){delete player.seekTarget;immersivePlayer?.setLoading(false);$('#player-loading').hidden=true;}
  else if(state==='paused'){immersivePlayer?.setLoading(false);$('#player-loading').hidden=true;$('#player-status').textContent='Pronto. Pressione play para continuar.';}
  if(detail==='seek-range-limited')toast('Esta fonte ainda não disponibilizou o ponto escolhido. Avançamos até o trecho acessível.');
}});
const channelVolumeMemory=new ChannelVolumeMemory({video,getNamespace:()=>session?.account?.libraryId||session?.account?.provider||'xtream'});
const audioProcessing=new ContinuityAudio({host:videoHost,AudioProcessingClass:AudioProcessing}),audioPreferenceListeners=new Set();
const movieAudio=new MovieAudio({volumeMemory:channelVolumeMemory,audioProcessing});
const moviePlayback=new MoviePlayback({video,vodSeek,positionGuard,resumePrompt,
  getScope:()=>session?.connected?{account:session.account?.libraryId,epoch:connectionGeneration}:null,
  serializeItem:snapshot,canRemember:mayRemember});
const seriesAudio=new SeriesAudio({volumeMemory:channelVolumeMemory,audioProcessing});
const seriesPlayback=new SeriesPlayback({video,vodSeek,positionGuard,resumePrompt,
  getScope:()=>session?.connected?{account:session.account?.libraryId,epoch:connectionGeneration}:null,
  serializeItem:snapshot,canRemember:mayRemember});
const audioController={
  getPreferences:()=>({...audioProcessing.getPreferences(),rememberChannelVolume:channelVolumeMemory.enabled}),
  getStatus:()=>audioProcessing.getStatus(),
  setPreferences(value={}){
    if(Object.hasOwn(value,'rememberChannelVolume'))channelVolumeMemory.setEnabled(value.rememberChannelVolume);
    if(Object.hasOwn(value,'mode'))audioProcessing.setPreferences({mode:value.mode});
    for(const notify of audioPreferenceListeners)notify();
    void cloudBridge?.preferenceChanged('audio',this.getPreferences());
    void cloudBridge?.preferenceChanged('channel-volume',channelVolumeMemory.getPreferences());
    return this.getPreferences();
  },
  requestActivation:()=>audioProcessing.requestActivation(),
  subscribe(notify){audioPreferenceListeners.add(notify);const unsubscribe=audioProcessing.subscribe(notify);return()=>{audioPreferenceListeners.delete(notify);unsubscribe();};}
};
function updateCloudStatus(status){
  const previous=cloudStatus.state;
  cloudStatus=status;inicio.onCloudStatus(status,previous);filmes.onCloudStatus(status,previous);
  homeTVRealtime?.sync();
  if(status.state==='synced'&&['offline','connecting','restricted','local'].includes(previous)){invalidateHomeTV();tvWatchHeartbeat?.recover();}
  for(const element of document.querySelectorAll('[data-cloud-status]'))element.textContent=status.message;
  const footer=$('#connection-status');if(!footer)return;
  const label=status.state==='synced'?'Biblioteca sincronizada':['connecting','syncing'].includes(status.state)?'Sincronizando biblioteca…':status.state==='restricted'?'Entre novamente para sincronizar':status.state==='offline'?'Biblioteca aguardando conexão':'Biblioteca só neste aparelho';
  footer.replaceChildren(node('span','status-dot'),document.createTextNode(' '+label));
  footer.dataset.cloudState=status.state;footer.title=status.message;footer.setAttribute('role','status');
  if(previous!==status.state&&session?.connected){ensureHomeProjection();if(status.state==='synced'){if(libraryArtwork.recoverCloud(status))retryArtworkImages(document,{limit:96,resetBudget:true});if(['offline','connecting','restricted','local'].includes(previous))tvGuide.invalidate();}if(view==='home'&&!query&&!contentPageOpen())scheduleCatalogRender('home');}
}
const cloudLibrary=new CloudLibrary({canRemember:mayRemember,onHistoryBlocked:blockRememberedItem,onStatus:updateCloudStatus,onSharedUpdate:event=>{
  const {table,type,revision,snapshotId}=event;tv.onSharedUpdate(event);filmes.onSharedUpdate(event);series.onSharedUpdate(event);inicio.onSharedUpdate(event);
  if(type==='live'&&['provider_catalog_cache','catalog_visible_generations'].includes(table))invalidateHomeTV();
  if(table==='episode_skip_markers'){episodeMarkerReader?.reset();immersivePlayer?.episodeSkip?.refreshExternalMarkers?.();}
  if(['provider_catalog_cache','catalog_visible_generations'].includes(table)&&type!=='live')sharedCatalogUpdates.notify(type,{revision,snapshotId});
}});
async function reloadSharedCatalog(type,{generation,revision,snapshotId}){
  if(generation!==connectionGeneration)return null;
  const data=await loadCatalog(type,false,{revalidate:true,expectedRevision:revision,expectedSnapshotId:snapshotId});
  if(generation!==connectionGeneration||!data)return null;
  const expected=Date.parse(revision),received=Date.parse(data.pagination?.revisionAt);
  // A failed revalidation can return the last usable snapshot. That keeps
  // cards visible, but cannot acknowledge another publication at the same ms.
  if(snapshotId&&data.pagination?.snapshotId!==snapshotId&&(!Number.isFinite(expected)||received===expected))return null;
  if(Number.isFinite(expected)&&(!Number.isFinite(received)||received<expected))return null;
  return data;
}
const sharedCatalogUpdates=new SharedCatalogUpdates({getGeneration:()=>connectionGeneration,isConnected:()=>Boolean(session?.connected&&cloudLibrary.ready),isActive:catalogWorkActive,getTypes:()=>[...catalogs.keys()].filter(type=>!dailyCatalogFresh(type)),reload:reloadSharedCatalog});
const formatNumber = value => Number(value || 0).toLocaleString('pt-BR');
const viewLabels = {home:'Para a sua próxima sessão',live:'TV ao vivo',movies:'Filmes',series:'Séries',favorites:'Minha lista'};
const typeFor = kind => kind === 'movie' ? 'movies' : kind;
let channelLogos={resolve:()=>''};
const channelLogosReady=(async()=>{
  const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),2000);
  try{const index=await loadChannelLogos((url,options={})=>fetch(url,{...options,signal:controller.signal}));if(typeof index?.resolve==='function')channelLogos=index;}
  catch{/* local logos are optional; the registered provider image remains available */}
  finally{clearTimeout(deadline);}
})();

function api(path,options={}){return sessionGuard.request(path,options);}
const catalogPager=new CatalogPager({request:api,getCatalog:type=>catalogs.get(type),onData:acceptCatalog,isActive:catalogWorkActive,isCategoryAllowed:(type,id)=>settingsTools.isCategoryVisible(type,id),onChange:scheduleCatalogRender,onProgress:scheduleCatalogRender});
function scheduleCatalogRender(type){
  if(!catalogWorkActive()||!catalogAffectsView(type)||catalogRenderTimer!==null)return;
  catalogRenderTimer=setTimeout(()=>{catalogRenderTimer=null;if(catalogWorkActive())render();},180);
}
function catalogCacheScope(type){
  const config=session?.cloud;
  if(!session?.connected||!['live','movies','series'].includes(type)||!config||!['providerKey','scopeHash'].every(key=>/^[a-f0-9]{64}$/i.test(config[key]||'')))return null;
  return {project:config.url,providerKey:config.providerKey,scopeHash:config.scopeHash,type,includeAdult:parentalControl?.unlocked===true};
}
function catalogRepositoryScope(type){return catalogCacheScope(type)||{project:'local',providerKey:session?.account?.provider||'local',scopeHash:session?.account?.libraryId||`session:${connectionGeneration}`,type,includeAdult:parentalControl?.unlocked===true};}
function dailyCatalogFresh(type){
  const scope=catalogCacheScope(type),record=catalogCacheRecords.get(type);
  return Boolean(scope&&record&&!record.needsRevisionCheck&&record.scope===JSON.stringify(scope)&&Date.now()-Math.max(record.savedAt,record.verifiedAt||0)<CATALOG_CACHE_TTL_MS&&catalogs.get(type)?.catalogComplete===true);
}
function scheduleDailyCatalogRefresh(){
  clearTimeout(dailyCatalogTimer);dailyCatalogTimer=null;if(!catalogWorkActive())return;
  const now=Date.now(),next=Math.min(...['live','movies','series'].map(type=>dailyCatalogFresh(type)?Math.max(catalogCacheRecords.get(type).savedAt,catalogCacheRecords.get(type).verifiedAt||0)+CATALOG_CACHE_TTL_MS:Math.max(now+1000,dailyCatalogAttempts.get(type)?.nextAt||now+60000)));
  dailyCatalogTimer=setTimeout(()=>{dailyCatalogTimer=null;void refreshDailyCatalogs();},Math.max(1000,next-now));
}
async function refreshDailyCatalogs(){
  if(!catalogWorkActive())return;
  if(dailyCatalogWork?.generation===connectionGeneration)return dailyCatalogWork.promise;
  const generation=connectionGeneration,work={generation,promise:null};dailyCatalogWork=work;
  work.promise=Promise.allSettled(['live','movies','series'].filter(type=>!dailyCatalogFresh(type)&&Date.now()>=(dailyCatalogAttempts.get(type)?.nextAt||0)).map(async type=>{
    // Reserve the next attempt before awaiting IO so focus/online cannot create
    // parallel refreshes. Incomplete snapshots use backoff, never a minute loop.
    const previous=dailyCatalogAttempts.get(type),attempts=(previous?.attempts||0)+1;
    const reserved={attempts,nextAt:Date.now()+Math.min(900000,60000*2**Math.min(attempts-1,4))};dailyCatalogAttempts.set(type,reserved);
    await loadCatalog(type,false,{revalidate:true});
    if(generation===connectionGeneration&&!catalogWorkActive()&&dailyCatalogAttempts.get(type)===reserved){if(previous)dailyCatalogAttempts.set(type,previous);else dailyCatalogAttempts.delete(type);return;}
    if(generation===connectionGeneration&&dailyCatalogFresh(type))dailyCatalogAttempts.delete(type);
  })).finally(()=>{if(dailyCatalogWork===work){dailyCatalogWork=null;if(generation===connectionGeneration)scheduleDailyCatalogRefresh();}});
  return work.promise;
}
async function cacheCompleteCatalog(type,data){
  const scope=catalogCacheScope(type),generation=connectionGeneration;if(!scope||!data?.catalogComplete||data.preparing||catalogs.get(type)!==data||catalogRepository.state(type).complete!==data)return false;
  const savedAt=Date.now(),saved=await catalogCache.write(scope,data,{fetchedAt:savedAt});
  // Storage may be disabled or full on a TV. Its complete in-memory snapshot
  // still counts for today's refresh budget while this application is open.
  if(generation===connectionGeneration&&JSON.stringify(catalogCacheScope(type))===JSON.stringify(scope)){catalogCacheRecords.set(type,{scope:JSON.stringify(scope),savedAt,persisted:saved});dailyCatalogAttempts.delete(type);scheduleDailyCatalogRefresh();}
  return saved;
}
async function completeCatalogs(types=['movies','series','live'],{retryBase=false}={}){
  if(!catalogWorkActive())return [];
  const generation=connectionGeneration;
  return Promise.allSettled(types.map(async type=>{
    const data=await loadCatalog(type,retryBase&&failures.has(type));
    if(!data||generation!==connectionGeneration||!catalogWorkActive())return null;
    const wasComplete=data.catalogComplete===true;
    const completed=await completeCatalogForSession(catalogPager,type,data,{cloudReady:centralCatalogReady()});
    const current=catalogs.get(type);
    if(!wasComplete&&generation===connectionGeneration&&current?.catalogComplete&&!dailyCatalogFresh(type))await cacheCompleteCatalog(type,current);
    return completed;
  }));
}
function centralCatalogReady(){return session?.cloudStatus?.state==='ready'||cloudLibrary.ready;}
function preparingCatalog(types){return types.some(type=>isPreparingCatalog(catalogs.get(type),{cloudReady:centralCatalogReady()}));}
function contentPageOpen(){return !$('#detail-dialog').hidden||!$('#player-dialog').hidden;}
function catalogWorkActive(){return Boolean(session?.connected&&!document.hidden&&!player&&!homePlaybackOpening&&!contentPageOpen()&&!$('#application').hidden);}
function pauseCatalogWork(){
  clearTimeout(catalogRenderTimer);catalogRenderTimer=null;clearTimeout(dailyCatalogTimer);dailyCatalogTimer=null;
  homeCloudModel.pause();homeTVModel?.pause();catalogRepository.pause();catalogPager.reset();cancelSearchWork();
  heroDurationController?.abort();heroDurationController=null;libraryArtwork.ensure();
  for(const task of modelHydrations.values())task.controller.abort();modelHydrations.clear();
}
function resumeCatalogWork(){
  if(!catalogWorkActive())return;
  sharedCatalogUpdates.resume();ensureHomeProjection();void refreshDailyCatalogs();
  for(const [type,data]of catalogs)if(data.catalogComplete&&!data.readModel)void hydrateCatalogReadModel(type,data,catalogCacheRecords.get(type)?.savedAt);
  void completeCatalogs([...catalogs.keys()].filter(type=>isPagedCatalog(catalogs.get(type))));
  void catalogPager.hydrateRemembered(favorites,history).catch(()=>{});
}
function catalogPosition(){return {view,category,genre:selectedGenre,query,visibleLimit,scrollY:window.scrollY};}
function setContentRoute(page,item,episode,replace=false){
  pageRouteRequest++;
  const hash=contentRoute(page,item,episode);
  if(location.hash===hash)return;
  const previous=location.hash||'#home';
  if(!parseContentRoute(previous)){
    catalogReturn=catalogPosition();contentReturnFocus=document.activeElement;
    window.history.replaceState({...window.history.state,arkehnCatalog:catalogReturn},'',previous);
  }else if(!replace)window.history.replaceState({...window.history.state,arkehnScrollY:window.scrollY},'',previous);
  const state={arkehnPage:true,returnHash:replace&&window.history.state?.arkehnPage?window.history.state.returnHash:previous,arkehnCatalog:catalogReturn||window.history.state?.arkehnCatalog};
  window.history[replace?'replaceState':'pushState'](state,'',hash);
  lastPageRouteKey=location.hash+JSON.stringify(window.history.state);
}
function showContentPage(page){
  pauseHomeChannels('content');
  cancelSearchWork();
  heroDurationController?.abort();heroDurationController=null;
  settingsTools.close(false);accountMenu.close(false);
  favoriteTVGuide?.pause();
  $('#application').hidden=true;$('#detail-dialog').hidden=page!=='preview';$('#player-dialog').hidden=page!=='watch';
  pauseCatalogWork();if(page==='watch')filmes.suggestions?.pausePreview();
  libraryArtwork.ensure();
  heroRotation?.sync();
  shelfCarousels?.sync();
  dailyGames?.stop();
  document.body.classList.add('content-page');document.body.classList.toggle('player-page',page==='watch');
  window.scrollTo({top:0,behavior:'instant'});
  const target=$(page==='watch'?'.video-stage':'#detail-back');target.focus({preventScroll:true});
}
function leaveNativeFullscreen(){
  const stage=$('.video-stage'),full=document.fullscreenElement||document.webkitFullscreenElement;
  if(full!==stage)return;
  try{Promise.resolve((document.exitFullscreen||document.webkitExitFullscreen)?.call(document)).catch(()=>{});}catch{/* full viewport remains usable */}
}
function tryNativeFullscreen(){
  if(navigator.userActivation?.isActive===false)return;
  const stage=$('.video-stage'),request=stage.requestFullscreen||stage.webkitRequestFullscreen;
  if(!request||(document.fullscreenElement||document.webkitFullscreenElement)===stage)return;
  try{Promise.resolve(request.call(stage)).then(()=>{if($('#player-dialog').hidden)leaveNativeFullscreen();}).catch(()=>{});}catch{/* full viewport does not require native fullscreen */}
}
function closeContentPages(restoreCatalog=false){
  const hadPage=contentPageOpen();detailRequest++;playOpenRequest++;stopPlayback();leaveNativeFullscreen();
  previewDurationController?.abort();previewDurationController=null;previewDurationPending=false;
  $('#detail-dialog').hidden=true;$('#player-dialog').hidden=true;document.body.classList.remove('content-page','player-page');
  $('#application').hidden=!session?.connected;channelGuide?.resume();
  if(hadPage){libraryArtwork.ensure();retryArtworkImages(document);resumeCatalogWork();}
  if(!restoreCatalog||!session?.connected)return;
  const position=restoreCatalogPosition(location.hash,window.history.state?.arkehnCatalog,catalogReturn);
  if(position&&Object.hasOwn(viewLabels,position.view)){view=position.view;category=position.category||'__all';selectedGenre=position.genre||'__all';categoryDefaultPending=false;query=position.query||'';visibleLimit=position.visibleLimit||48;$('#search-input').value=query;syncSearchControl();}
  if(query&&canSearchGlobally(query)&&(remoteSearch.state.phase==='idle'||remoteSearch.state.query!==normalizeSearchText(query).slice(0,120)))void searchCatalogQuery(query,{type:remoteSearch.state.type,immediate:true});render();if(hadPage||position)window.scrollTo({top:position?.scrollY||0,behavior:'instant'});
  if(contentReturnFocus?.isConnected)contentReturnFocus.focus({preventScroll:true});else $('#main-content').focus({preventScroll:true});
}
function backFromContentPage(){
  if(!contentPageOpen())return;
  const route=parseContentRoute(location.hash);pageRouteRequest++;playOpenRequest++;stopPlayback();leaveNativeFullscreen();
  if(window.history.state?.arkehnPage&&window.history.state.returnHash){window.history.back();return;}
  window.history.replaceState({arkehnCatalog:catalogReturn},'',fallbackContentRoute(route));restoreContentRoute();
}
async function restoreContentRoute(){
  lastPageRouteKey=location.hash+JSON.stringify(window.history.state);
  const request=++pageRouteRequest,generation=connectionGeneration,route=parseContentRoute(location.hash);
  if(!route){closeContentPages(!location.hash.startsWith('#settings/'));return;}
  if(!session?.connected)return;
  stopPlayback();leaveNativeFullscreen();
  try{
    const data=await loadCatalog(typeFor(route.kind),false,{required:true});
    if(request!==pageRouteRequest||generation!==connectionGeneration)return;
    let item=data?.itemMap.get(route.id);
    if(!item&&isPagedCatalog(data)&&['movie','series'].includes(route.kind)){
      const details=await getDetails({id:route.id,kind:route.kind});
      if(request!==pageRouteRequest||generation!==connectionGeneration)return;
      if(details?.name)item={...details,id:route.id,kind:route.kind,poster:artwork(details.poster)};
    }
    if(!item)throw new Error('Este título não está disponível no catálogo da sua conta.');
    if(route.page==='preview'){await openDetails(item,false,{route:false});return;}
    if(item.kind==='series'){
      const details=await getDetails(item);if(request!==pageRouteRequest||generation!==connectionGeneration)return;
      const episode=allEpisodes(details).find(episode=>String(episode.id)===route.episodeId);
      if(!episode){window.history.replaceState(window.history.state,'',contentRoute('preview',item));await openDetails(item,false,{route:false});return;}
      await openPlayer(item,episode,{route:false});
    }else await openPlayer(item,null,{route:false});
  }catch(error){if(request!==pageRouteRequest||generation!==connectionGeneration)return;if(error.code==='PARENTAL_LOCKED'&&await parentalControl.unlock()){if(generation===connectionGeneration)void restoreContentRoute();return;}window.history.replaceState({arkehnCatalog:catalogReturn},'','#home');closeContentPages(true);toast(error.message);}
}
function handleContentRouteChange(){
  if(document.body.classList.contains('session-preparing'))return;
  const key=location.hash+JSON.stringify(window.history.state);if(key===lastPageRouteKey)return;
  lastPageRouteKey=key;restoreContentRoute();
}
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3300); }
function categoryName(raw) { return String(raw || 'Outros').replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u2605\u2606\uFE0F\uFE0E\u200D\u20E3]/gu,'').replace(/^[\s›>»|•●○◆◇─═┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬-]+/,'').replace(/^(?:FILMES?|S[ÉE]RIES?|COLET[ÂA]NEA|CANAIS?)\s*[-|:›>]+\s*/i,'').replace(/\s{2,}/g,' ').trim() || 'Outros'; }
function prepareCatalog(data, type) {
  if(data.catalogComplete===true)data=mergeCatalogPage(null,data);
  const categoryMap = new Map(), groups = new Map();
  for (const category of data.categories || []) {
    const name = categoryName(category.name), key = normalize(name);
    if (!groups.has(key)) groups.set(key, {id:key,name,ids:new Set(),count:0});
    if(isAdultCategory(category))groups.get(key).isAdult=true;
    groups.get(key).ids.add(String(category.id)); categoryMap.set(String(category.id), groups.get(key));
  }
  const seen = new Set(), items = [];
  for (const raw of data.items || []) {
    if (!raw || raw.id === undefined || !raw.name) continue;
    const dedupe = String(raw.id);
    if (seen.has(dedupe)) continue; seen.add(dedupe);
    const groupIds=[...new Set((raw.categoryIds||[raw.categoryId]).map(String))],itemGroups=[...new Set(groupIds.map(id=>categoryMap.get(id)).filter(Boolean))];
    const group = categoryMap.get(String(raw.categoryId))||itemGroups[0];
    const item = {...raw,id:String(raw.id),categoryId:String(raw.categoryId || ''),kind:type === 'movies' ? 'movie' : type,categoryIds:groupIds,groupKeys:itemGroups.map(group=>group.id),groupNames:itemGroups.map(group=>group.name),poster:artwork(raw.poster),group:group?.name || 'Outros',groupKey:group?.id || 'outros'};
    if(historyBlocked.has(itemKey(item)))item.isAdult=true;
    if(item.kind==='live'){item.posterOriginal=item.poster;item.poster=artwork(channelLogos.resolve(item))||item.posterOriginal;}
    item.search = normalize(`${item.name} ${item.group}`); items.push(item); for(const matchedGroup of itemGroups)matchedGroup.count++;
  }
  const prepared={items,categories:[...groups.values()].filter(group => group.count||isPagedCatalog(data)),sourceCategories:data.categories||[],pagination:data.pagination,preparing:data.preparing===true,catalogComplete:data.catalogComplete===true,itemMap:new Map(items.map(item => [item.id,item]))};
  const readModel=sanitizeCatalogReadModel(data.readModel,prepared,{type,includeAdult:parentalControl?.unlocked===true});if(readModel)prepared.readModel=readModel;return prepared;
}
function acceptCatalog(type,response,options){
  const data=catalogRepository.commit(type,response,options);
  if(data){for(const listener of entryCatalogListeners)listener();ensureHomeProjection();}
  return data;
}
async function hydrateCatalogReadModel(type,catalog,savedAt){
  if(!catalogWorkActive()||catalog?.readModel||!catalogIsComplete(catalog)||!catalog.pagination?.snapshotId||!centralCatalogReady())return;
  const scope=catalogCacheScope(type),key=JSON.stringify([scope,catalog.pagination.snapshotId]),existing=modelHydrations.get(type);if(existing?.key===key)return;
  existing?.controller.abort();const task={key,controller:new AbortController()},generation=connectionGeneration;modelHydrations.set(type,task);
  const current=()=>generation===connectionGeneration&&modelHydrations.get(type)===task&&!task.controller.signal.aborted&&catalogs.get(type)===catalog;
  try{
    const value=await api(`/api/catalog/read-model?type=${type}`,{signal:task.controller.signal});if(!current())return;
    const readModel=sanitizeCatalogReadModel(value,catalog,{type,includeAdult:parentalControl?.unlocked===true});if(!readModel)return;
    const prepared=acceptCatalog(type,{...catalog,categories:catalog.sourceCategories,readModel},{savedAt});
    if(prepared?.readModel&&scope&&Number.isFinite(savedAt))await catalogCache.write(scope,prepared,{fetchedAt:savedAt});
    if(generation===connectionGeneration&&catalogAffectsView(type))scheduleCatalogRender(type);
  }catch{/* Keep the daily snapshot usable; retry only on a later session/publication. */}
}
function remapStoredChannelArtwork(data){
  let favoritesChanged=false,historyChanged=false;
  for(const [key,stored]of favorites){
    if(stored.kind!=='live')continue;const current=data.itemMap.get(stored.id),saved=current&&withoutSessionArtwork(current);if(!saved||stored.poster===saved.poster&&stored.posterOriginal===saved.posterOriginal)continue;
    favorites.set(key,{...stored,poster:saved.poster,posterOriginal:saved.posterOriginal});favoritesChanged=true;
  }
  for(const [key,entry]of history){
    if(entry.item.kind!=='live')continue;const current=data.itemMap.get(entry.item.id),saved=current&&withoutSessionArtwork(current);if(!saved||entry.item.poster===saved.poster&&entry.item.posterOriginal===saved.posterOriginal)continue;
    history.set(key,{...entry,item:{...entry.item,poster:saved.poster,posterOriginal:saved.posterOriginal}});historyChanged=true;
  }
  if(favoritesChanged)mediaLibrary.saveFavorites();
  if(historyChanged)mediaLibrary.saveHistory();
}
function resetConnectionData() {
  sessionGuard.reset();
  homeChannelPrograms?.reset();void homeChannels?.reset().catch(()=>{});homeTVModel?.reset();void homeTVRealtime?.reset();tvWatchHeartbeat?.reset();
  channelSwitch?.cancel();
  favoriteTVGuide?.reset();
  tv.reset();
  libraryArtwork.reset();
  entryPreparationController?.abort();entryPreparationController=null;
  historyBlocked.clear();
  automaticCatalogCategories.clear();for(const type of ['live','movies','series'])automaticCatalogCategories.add(type);
  inicio.reset();homeHistoryExcluded.clear();homeLibraryRevision++;movieLibraryRevision++;for(const task of modelHydrations.values())task.controller.abort();modelHydrations.clear();
  clearTimeout(dailyCatalogTimer);dailyCatalogTimer=null;dailyCatalogWork=null;dailyCatalogAttempts.clear();catalogCacheRecords.clear();
  parentalControl?.reset();
  void cloudBridge?.stop({flush:false});
  sharedCatalogUpdates.reset();
  episodeMarkerReader?.reset();
  cloudMarkersScope=null;
  cancelSearchWork();
  remoteSearch.reset();
  heroRotation?.stop();
  shelfCarousels?.sync(null);
  dailyGames?.reset();
  episodeProgress.setNamespace(null);
  categoryDefaultPending=true;
  selectedGenre='__all';genreCache=null;
  clearTimeout(catalogRenderTimer);catalogRenderTimer=null;
  cancelAnimationFrame(automaticRevealFrame);automaticRevealFrame=null;
  automaticProviderDemand=1;
  heroDurationController?.abort();heroDurationController=null;
  connectionGeneration++;pageRouteRequest++;lastPageRouteKey=null;channelGuide?.reset();refreshRequest++;$('#catalog-refresh').hidden=true;$('#refresh-catalog').disabled=false;
  catalogRepository.reset();for(const feature of catalogFeatures.values())feature.reset();
  catalogPager.reset();catalogs.clear(); pendingCatalogs.clear(); detailsCache.clear(); loading.clear(); failures.clear();
  heroItem=null; featured=[]; detailItem=null; detailData=null; heroRequest++; detailRequest++; playOpenRequest++;
  return connectionGeneration;
}
async function loadCatalog(type, force = false, {revalidate=false,expectedRevision,expectedSnapshotId,required=false} = {}) {
  if(!required&&!catalogWorkActive())return catalogs.get(type)||null;
  const generation=connectionGeneration;
  catalogRepository.state(type);
  if(revalidate&&pendingCatalogs.has(type)){
    await pendingCatalogs.get(type);
    if(generation!==connectionGeneration||!required&&!catalogWorkActive())return null;
  }
  if (!force && pendingCatalogs.has(type)) return pendingCatalogs.get(type);
  if (!force && !revalidate && catalogs.has(type)) return catalogs.get(type);
  if(force)catalogPager.reset(type);
  const ticket=catalogRepository.begin(type);
  loading.add(type); failures.delete(type); if(!catalogs.has(type) && catalogAffectsView(type))render();
  const pending = (async () => {
    let cachedData=catalogRepository.state(type).complete,publicationChanged=false,backgroundRevision=false;
    const scope=catalogCacheScope(type);
    const current=()=>generation===connectionGeneration&&pendingCatalogs.get(type)===pending&&catalogRepository.current(ticket)&&JSON.stringify(catalogCacheScope(type))===JSON.stringify(scope);
    const preserveSnapshot=()=>{
      if(!cachedData||!current())return null;
      const record=catalogCacheRecords.get(type);
      if(scope&&record?.scope===JSON.stringify(scope)){
        record.needsRevisionCheck=true;
        if(!dailyCatalogAttempts.has(type))dailyCatalogAttempts.set(type,{attempts:1,nextAt:Date.now()+60000});
      }
      scheduleDailyCatalogRefresh();return catalogRepository.state(type).complete||cachedData;
    };
    try {
      if(scope&&!force&&!cachedData){
        const cached=await catalogCache.read(scope);
        if(generation!==connectionGeneration||pendingCatalogs.get(type)!==pending||JSON.stringify(catalogCacheScope(type))!==JSON.stringify(scope))return null;
        if(cached){
          if(type==='live')await channelLogosReady;
          if(generation!==connectionGeneration||pendingCatalogs.get(type)!==pending||JSON.stringify(catalogCacheScope(type))!==JSON.stringify(scope))return null;
          cachedData=acceptCatalog(type,cached.catalog,{ticket,savedAt:cached.savedAt});catalogCacheRecords.set(type,{scope:JSON.stringify(scope),savedAt:cached.savedAt,verifiedAt:cached.verifiedAt||0,needsRevisionCheck:true});
          if(cached.fresh&&!revalidate){backgroundRevision=true;void hydrateCatalogReadModel(type,cachedData,cached.savedAt);scheduleDailyCatalogRefresh();return cachedData;}
          if(catalogAffectsView(type))render();
        }
      }
      if(scope&&!force&&cachedData){
        const check=await catalogRepository.checkRevision(ticket,({signal})=>api(`/api/catalog/revision?type=${type}`,{signal}),{expectedRevision,expectedSnapshotId});
        if(generation!==connectionGeneration||!catalogRepository.current(ticket)||JSON.stringify(catalogCacheScope(type))!==JSON.stringify(scope))return null;
        if(check.state==='unchanged'){
          const previous=catalogCacheRecords.get(type),savedAt=previous?.scope===JSON.stringify(scope)?previous.savedAt:catalogRepository.state(type).savedAt;
          catalogCacheRecords.set(type,{scope:JSON.stringify(scope),savedAt,verifiedAt:check.verifiedAt});dailyCatalogAttempts.delete(type);
          // Persist only the small verification. Full catalogue bytes and
          // their original savedAt remain untouched by a successful check.
          void catalogCache.verify(scope,check.publication,{verifiedAt:check.verifiedAt});
          void hydrateCatalogReadModel(type,cachedData,savedAt);scheduleDailyCatalogRefresh();return cachedData;
        }
        if(check.state==='unavailable'||check.state==='cooldown')return preserveSnapshot();
        publicationChanged=check.state==='changed';
      }
      if(revalidate||publicationChanged)catalogPager.reset(type);
      // A device with the current publication needs only its compact header.
      // First load or a changed immutable generation downloads a full snapshot.
      const response=await catalogRepository.fetch(ticket,async({signal})=>{
        const reload=revalidate||publicationChanged;
        let [value]=await Promise.all([type==='live'?tv.services.catalog({force,revalidate:reload,signal}):api(`/api/catalog?type=${type}${force?'&refresh=1':reload?'&cache=reload':''}`,{signal}),type==='live'?channelLogosReady:undefined]);
        if(isPreparingCatalog(value,{cloudReady:centralCatalogReady()})&&!value.items?.length)value=await (type==='live'?tv.services.catalog({paged:true,revalidate:reload,signal}):api(`/api/catalog?type=${type}&paged=1${reload?'&cache=reload':''}`,{signal}));
        return value;
      },{force:force||revalidate||publicationChanged});
      if(generation!==connectionGeneration || pendingCatalogs.get(type)!==pending||JSON.stringify(catalogCacheScope(type))!==JSON.stringify(scope))return null;
      // A transient shared-cache failure can fall back to the provider's first
      // pages. Keep the current snapshot until a complete replacement exists.
      if(cachedData&&response.catalogComplete!==true)return preserveSnapshot();
      if(revalidate&&isPagedCatalog(response)&&response.pagination?.source!=='supabase'&&!response.preparing)return preserveSnapshot();
      const data=acceptCatalog(type,response,{ticket});if(!data)return null;genreCache=null;if(type==='live')remapStoredChannelArtwork(data);
      if(catalogIsComplete(response)&&data.catalogComplete&&catalogRepository.acceptedResponse(type,response))await cacheCompleteCatalog(type,data);
      if(!current())return null;
      if(data.catalogComplete&&!data.readModel)void hydrateCatalogReadModel(type,data,catalogCacheRecords.get(type)?.savedAt);
      if(revalidate&&data.pagination?.source==='supabase')void completeCatalogForSession(catalogPager,type,data,{cloudReady:centralCatalogReady()});
      scheduleDailyCatalogRefresh();
      return data;
    } catch (error) {
      if(cachedData)return preserveSnapshot();
      if(current()&&error.name!=='AbortError'){failures.set(type,error.message);catalogRepository.finish(ticket,error.message);}
      return catalogRepository.current(ticket)?catalogRepository.state(type).current:null;
    } finally {
      if(generation===connectionGeneration && pendingCatalogs.get(type)===pending){
        catalogRepository.finish(ticket,failures.get(type)||null);
        loading.delete(type); pendingCatalogs.delete(type); if(session?.connected){if(catalogWorkActive()&&catalogAffectsView(type))render();immersivePlayer?.setChannels(getChannels());}
        if(backgroundRevision&&catalogWorkActive())queueMicrotask(()=>{
          if(generation===connectionGeneration&&catalogWorkActive()&&catalogCacheRecords.get(type)?.needsRevisionCheck)void loadCatalog(type,false,{revalidate:true});
        });
      }
    }
  })();
  pendingCatalogs.set(type,pending); return pending;
}
function catalogAffectsView(type) { return Boolean(query) || ['home','favorites',type].includes(view); }
function showConnection(error=''){login.show(error);}
function handleSessionLoss({reason}={}){
  if(!session?.connected)return;
  // Save progress in its existing account before invalidating the UI. The
  // queued STOP is scoped to that generation and cannot stop a later login.
  stopPlayback();session=null;resetConnectionData();
  window.history.replaceState(null,'','#home');catalogReturn=null;contentReturnFocus=null;
  clearTimeout(toastTimer);$('#toast').hidden=true;
  showConnection(reason==='session-changed'?'A conta foi alterada em outra aba. Entre novamente para continuar.':'Sua sessão foi encerrada. Entre novamente para continuar.');
}
async function checkVisibleSession(){
  if(document.hidden||!session?.connected)return false;
  const generation=connectionGeneration;await sessionGuard.check();
  return generation===connectionGeneration&&Boolean(session?.connected);
}
async function enterApplication() {
  const generation=connectionGeneration,account=session?.account?.libraryId,signal=sessionLoader.controller?.signal||sessionLoader.start('Preparando seu catálogo');
  entryPreparationController?.abort();const preparation=new AbortController();entryPreparationController=preparation;
  const current=()=>generation===connectionGeneration&&session?.connected&&session?.account?.libraryId===account&&entryPreparationController===preparation&&!preparation.signal.aborted;
  await parentalControl?.refresh();if(!current()||signal.aborted)return;
  mediaLibrary.activate(session?.account?.provider||'xtream',session?.account?.libraryId);
  for(const item of favorites.values())if(isAdultItem(item))historyBlocked.add(itemKey(item));
  episodeProgress.setNamespace(session?.account?.libraryId||null);
  settingsTools.activateAccount(session?.account?.libraryId);
  if(session?.account?.libraryId)episodeProgress.seed([...history.values()].filter(entry=>entry.libraryId===session.account.libraryId),{namespace:session.account.libraryId});
  void Promise.resolve(cloudBridge?.start()).then(()=>{if(current())ensureHomeProjection();}).catch(()=>{});
  ensureHomeProjection();
  sessionLoader.mark('auth');sessionLoader.text('Organizando seu catálogo');
  document.body.classList.remove('login-active');
  login.hide(); $('#application').hidden = false; view=catalogView(location.hash)||settingsTools.getStartupView();category='__all';query='';visibleLimit=48; $('#search-input').value='';syncSearchControl();updateAccessValidity();
  categoryDefaultPending=true;
  selectedGenre='__all';genreCache=null;
  heroRotation?.start();
  render();window.scrollTo({top:0,behavior:'instant'});
  const openingView=view,types=['live','movies','series'];
  const openingTypes=types.includes(openingView)?[openingView,...types.filter(type=>type!==openingView)]:types;
  const openingCatalogs=new Map(openingTypes.map(type=>{
    sessionLoader.mark(type,'loading');
    const task=loadCatalog(type).then(catalog=>{
      if(!current())return null;
      if(!signal.aborted)sessionLoader.mark(type,catalog?'done':'partial');
      ensureHomeProjection();return catalog;
    }).catch(()=>{if(current()&&!signal.aborted)sessionLoader.mark(type,'partial');return null;});
    return [type,task];
  }));
  // Each domain continues independently. Closing the entry cover must not
  // abort a catalog, home preparation or image decode still useful to the account.
  void Promise.allSettled([...openingCatalogs].map(async([type,task])=>{
    const catalog=await task;if(!current()||!catalog)return;
    if(openingView==='home'&&type!=='live')await prepareHomeCatalogs({getCatalog:kind=>kind===type?catalogs.get(kind):null,pager:catalogPager,isItemVisible,signal:preparation.signal,target:HOME_SHELF_LIMIT});
    if(current())await completeCatalogs([type]);
  }));
  const priorityTypes=types.includes(openingView)?[openingView]:types;
  await waitForEntryCatalog({tasks:priorityTypes.map(type=>openingCatalogs.get(type)),
    isReady:()=>current()&&priorityTypes.some(type=>catalogs.get(type)?.items?.some(openingView==='home'?isAutomaticItemVisible:isItemVisible)),
    subscribe:listener=>{entryCatalogListeners.add(listener);return()=>entryCatalogListeners.delete(listener);},signal:preparation.signal,deadlineMs:1500});
  if(!current()||signal.aborted)return;
  render();sessionLoader.finish();homeTVModel?.ensure();syncHomeChannels();shelfCarousels?.sync();settingsTools.restoreRoute();
  void catalogPager.hydrateRemembered(favorites,history).catch(()=>{});
  void Promise.resolve().then(async()=>{
    if(!current())return;
    const priorityArtwork=[...document.querySelectorAll(view==='home'?'#hero-art img':'#catalog-content img')].map(picture=>picture.getAttribute('src')).filter(artwork).slice(0,6);
    const opening=openingArtwork({hero:priorityArtwork,shelves:homeShelfSections(),perType:8,resolveArtwork:item=>item.kind==='live'?artwork(channelLogos.resolve(item))||item.poster:item.poster});
    await preloadArtwork(opening,{signal:preparation.signal,maxItems:30,concurrency:6,timeoutMs:1800,deadlineMs:2500});
  }).catch(()=>{});
  if(failures.size)toast('Alguns conteúdos ainda não responderam. Você pode atualizar o catálogo.');
  if(parseContentRoute(location.hash))handleContentRouteChange();
}
function setView(next) {
  pauseHomeChannels('navigate');
  captureCatalogFeature();
  cancelSearchWork();pageRouteRequest++;closeContentPages();settingsTools.close();view = next; category='__all';visibleLimit=48; query=''; $('#search-input').value='';syncSearchControl();
  categoryDefaultPending=true;
  automaticProviderDemand=1;
  selectedGenre='__all';genreCache=null;restoreCatalogFeature(next);
  window.history.replaceState(null,'','#'+next);catalogReturn=null;contentReturnFocus=null;
  lastPageRouteKey=location.hash+JSON.stringify(window.history.state);
  if (!['home','favorites'].includes(next)) void catalogFeatures.get(next)?.load(); render(); window.scrollTo({top:0,behavior:'instant'});
}
function refreshFavoritePresentation(item){
  automaticCatalogCategories.delete(view);mediaLibrary.saveFavorites();
  if(item.kind!=='live')homeLibraryRevision++;if(item.kind==='movie')movieLibraryRevision++;ensureHomeProjection();
  const key=itemKey(item);
  for(const element of document.querySelectorAll('.card-favorite'))if(element.dataset.favoriteKey===key)updateFavoriteButton(element,item);
  if(view==='favorites'||view==='home'||category==='__favorites')render();
  else if(['live','movies','series'].includes(view)&&!query)updateCategorySidebar($('#catalog-content .catalog-sidebar'),categoriesFor(matchedCategoryItems()));
  immersivePlayer?.setChannels(getChannels());refreshDetailFavorite();refreshPlayerFavorite();
  toast(favorites.has(key)?'Adicionado à sua lista':'Removido da sua lista');
}
function favoriteWriteFinished(generation,account,kind){
  if(generation!==connectionGeneration||account!==session?.account?.libraryId)return;
  if(kind!=='live')homeLibraryRevision++;if(kind==='movie')movieLibraryRevision++;ensureHomeProjection();if(view==='home'&&!query&&!contentPageOpen()&&!settingsTools.isOpen)scheduleCatalogRender('home');
}
function toggleFavorite(item) {
  const generation=connectionGeneration,account=session?.account?.libraryId;
  if(item.kind==='live'){
    void tv.favorites.toggle(snapshot(item)).then(()=>favoriteWriteFinished(generation,account,item.kind)).catch(()=>{});return;
  }
  if(item.kind==='movie'){
    void filmes.favoritesStore.toggle(snapshot(item)).then(()=>favoriteWriteFinished(generation,account,item.kind)).catch(()=>{});return;
  }
  const key=itemKey(item);favorites.has(key)?favorites.delete(key):favorites.set(key,snapshot({...item,savedAt:Date.now()}));
  refreshFavoritePresentation(item);
  void Promise.resolve(cloudBridge?.favoriteChanged(favorites.get(key)||snapshot(item),favorites.has(key)))
    .then(()=>favoriteWriteFinished(generation,account,item.kind)).catch(()=>{});
}
function captureCatalogFeature(){
  if(query||!catalogFeatures.has(view))return;
  const feature=catalogFeatures.get(view);feature.capture({category,genre:selectedGenre,sort:sortModes[view]||'date',limit:visibleLimit,defaultPending:categoryDefaultPending,scrollY:window.scrollY});feature.genreIndex=genreCache;
}
function restoreCatalogFeature(type){
  const feature=catalogFeatures.get(type);if(!feature)return;
  const state=feature.restore();category=state.category;selectedGenre=state.genre;sortModes[type]=state.sort;visibleLimit=state.limit;categoryDefaultPending=state.defaultPending;genreCache=feature.genreIndex;
}
function updateFavoriteButton(element,item) {
  const selected=favorites.has(itemKey(item));element.classList.toggle('selected',selected);element.title=selected?'Remover dos favoritos':'Adicionar aos favoritos';
  element.setAttribute('aria-label',`${selected ? 'Remover dos' : 'Adicionar aos'} favoritos: ${item.name}`);element.setAttribute('aria-pressed',String(selected));
}
function makeFavorite(item, className = 'card-favorite', canAct = () => true) {
  const element=button('',className,() => {if(canAct())toggleFavorite(item);},'star');element.dataset.favoriteKey=itemKey(item);updateFavoriteButton(element,item);return element;
}
function cleanTitle(name) { return String(name || '').replace(/\s*\((?:19|20)\d{2}\)\s*$/,'').trim(); }
function displayYear(item) { const year = String(item.year || '').match(/(?:19|20)\d{2}/)?.[0] || String(item.name || '').match(/\(((?:19|20)\d{2})\)/)?.[1]; return year || ''; }
function metadataText(value) {
  const text = String(value ?? '').trim();
  if (!text || /^(?:0+(?:[.,]0+)?(?:\s*(?:min(?:utos?)?|mins?|h(?:oras?)?))?|(?:00?:){1,2}00?|null|undefined|n\/?a|none|-)$/i.test(text)) return '';
  return text;
}
function ratingNode(value) { const text = metadataText(value), number = Number(text.replace(',', '.')); if (!text || !Number.isFinite(number) || number <= 0) return null; const badge = node('span','rating'); badge.append(iconNode('star'),document.createTextNode(number.toFixed(1).replace('.',','))); return badge; }
function mediaCard(item, {onDetails = openDetails, canAct = () => true} = {}) {
  if (item.kind === 'live') return channelCard(item);
  const card = node('article','media-card'), play = button('','poster-button',() => {if(canAct())onDetails(item);}); play.setAttribute('aria-label',`Ver ${item.name}`);
  const poster = node('div','poster'), placeholder = node('div','poster-placeholder'); const mark=node('img','tiny-brand');mark.src='/assets/brand/symbol.svg';mark.alt='';placeholder.append(mark,node('span','',cleanTitle(item.name))); poster.append(placeholder);
  if (artwork(item.poster)) poster.append(image(item.poster,'',true,'',source=>libraryArtwork.failSource(item,source)));
  const badge = node('span','poster-badge', item.kind === 'series' ? 'SÉRIE' : 'FILME'); poster.append(badge);
  const over = node('span','poster-play');over.append(iconNode('play'));poster.append(over);
  const previous=historyFor(item),position=playbackProgress(previous),episode=position.episodeLabel;
  if(position.percent!==null&&previous.time>5){const progress=node('div','card-progress'),fill=node('span');progress.setAttribute('role','progressbar');progress.setAttribute('aria-label',`Progresso de ${item.name}${episode?' · '+episode:''}`);progress.setAttribute('aria-valuemin','0');progress.setAttribute('aria-valuemax','100');progress.setAttribute('aria-valuenow',String(Math.round(position.percent)));fill.style.width=`${position.percent}%`;progress.append(fill);poster.append(progress);}
  const copy=node('div','card-copy'), title=node('h3','',cleanTitle(item.name));title.title=item.name;copy.append(title);
  const meta=node('div','card-meta');const year=displayYear(item);if(year)meta.append(node('span','year',year));meta.append(node('span','',item.kind==='series'?'Série':'Filme'));if(episode){meta.append(node('span','resume-episode',episode));play.setAttribute('aria-label',`Ver ${item.name} · ${episode}`);}const rating=ratingNode(item.rating);if(rating)meta.append(rating);copy.append(meta);play.append(poster,copy);card.append(play,makeFavorite(item,'card-favorite',canAct));return card;
}
function channelCard(item) {
  return tv.createCard(item);
}
tv.createView({node,button,artwork,image,makeFavorite,updateFavoriteButton,resolveLogo:item=>channelLogos.resolve(item),logoGeometry:file=>channelLogos.geometry?.(file),getGuide:()=>channelGuide,onWatch:item=>openPlayer(item)});
function renderCards(grid,items) {
  reconcileCards(grid,items,{key:itemKey,signature:item=>{const previous=historyFor(item);return JSON.stringify([item.name,item.poster,item.posterOriginal,item.year,item.rating,item.group,previous?.time,previous?.duration,previous?.episode?.id,previous?.episode?.season,previous?.episode?.number]);},create:mediaCard,mounted:(card,item)=>{if(item.kind==='live')tv.mountCard(card,item);else updateFavoriteButton(card.querySelector('.card-favorite'),item);}});
  grid.style.animation='none';
}
function skeletons(count = 6) { const grid=node('div','poster-grid'); for(let index=0;index<count;index++){const card=node('div');card.append(node('div','skeleton skeleton-poster'),node('div','skeleton skeleton-line'),node('div','skeleton skeleton-line small'));grid.append(card);} return grid; }
function emptyState(title,copy,action) { const element=node('div','empty-state');element.append(iconNode(view==='live'?'tv':view==='favorites'?'bookmark':'film'),node('h2','',title),node('p','',copy));if(action)element.append(button(action.label,'button secondary',action.run,'refresh'));return element; }
function shelf(title,subtitle,items,type,existing) {
  if(existing){existing.querySelector('.shelf-header h2').textContent=title;existing.setAttribute('aria-label',title);for(const control of existing.querySelectorAll('.shelf-nav'))control.setAttribute('aria-label',`${control.classList.contains('shelf-nav-prev')?'Voltar':'Avançar'} na coleção: ${title}`);renderCards(existing.querySelector('.poster-shelf,.live-shelf'),items);return existing;}
  const section=node('section','shelf'), header=node('div','shelf-header'), titles=node('div');if(subtitle)titles.append(node('span','eyebrow',subtitle));titles.append(node('h2','',title));
  section.setAttribute('aria-label',title);section.setAttribute('aria-roledescription','carrossel');
  const tools=node('div','shelf-tools');if(['live','movies','series'].includes(type)){const more=button('VER TUDO','shelf-more',() => setView(type));more.append(iconNode('arrow'));tools.append(more);}
  const row=node('div',type==='live'?'live-shelf':'poster-shelf');renderCards(row,items);
  row.id=`home-shelf-${++shelfSerial}`;
  const carousel=node('div','shelf-carousel');carousel.append(row);
  for(const direction of [-1,1]){const control=button('',`shelf-nav shelf-nav-${direction===-1?'prev':'next'}`,null,direction===-1?'chevron-left':'chevron-right');control.hidden=true;control.setAttribute('aria-label',`${direction===-1?'Voltar':'Avançar'} na coleção: ${title}`);control.setAttribute('aria-controls',row.id);carousel.append(control);}
  header.append(titles,tools);section.append(header,carousel);return section;
}
function allowsKnownItem(item){return Boolean((parentalControl?.unlocked||mayRemember(item))&&(parentalControl?.allows(item,catalogs.get(typeFor(item.kind))?.categories||[])??false));}
function isItemVisible(item){const type=typeFor(item.kind);return allowsKnownItem(item)&&(item.categoryIds||[item.categoryId]).some(id=>settingsTools.isCategoryVisible(type,id))&&(settingsTools.isItemVisible?.(type,item.id) ?? true);}
function isAutomaticItemVisible(item){return isItemVisible(item)&&mayRemember(item);}
function visibleCatalog(type){if(type==='live')return tv.channels?.snapshot()||null;const data=catalogs.get(type);return data?{...data,items:data.items.filter(isItemVisible)}:null;}
function catalogHiddenBySettings(type){const items=catalogs.get(type)?.items||[];return items.length>0&&!items.some(isItemVisible);}
function sortItems(items){
  if(view==='favorites'&&category==='live'){
    const numbers=new Map(settingsTools.getNumberedChannels({favoritesOnly:true,fallbackToAll:false}).map(({item,number})=>[String(item.id),number]));
    return [...items].sort((a,b)=>(numbers.get(String(a.id))??Infinity)-(numbers.get(String(b.id))??Infinity)||a.name.localeCompare(b.name,'pt-BR'));
  }
  const mode=sortModes[view];if(!['movies','series','favorites'].includes(view)||!mode)return items;
  return sortCatalogItems(items,mode,{getAdded:item=>view==='favorites'?favorites.get(itemKey(item))?.savedAt??item.added:item.added});
}
function renderSort(){
  const controls=$('#sort-controls');controls.hidden=!['movies','series','favorites'].includes(view)||Boolean(query)||view==='favorites'&&category==='live';if(controls.hidden)return;
  if(controls.dataset.view!==view){controls.dataset.view=view;controls.replaceChildren();for(const [mode,label] of [['name','Nome'],['date',view==='favorites'?'Favoritos recentes':'Adicionados recentemente'],['rating','Nota']]){
    const choice=button(label,'sort-choice',()=>{if(sortModes[view]===mode)return;automaticCatalogCategories.delete(view);sortModes[view]=mode;save('arkehn.sortModes.v1',sortModes);void cloudBridge?.preferenceChanged('sort',sortModes);visibleLimit=48;render();window.scrollTo({top:0,behavior:'instant'});});choice.dataset.mode=mode;controls.append(choice);
  }}
  for(const choice of controls.children){const selected=(sortModes[view]||'date')===choice.dataset.mode;choice.classList.toggle('active',selected);choice.setAttribute('aria-pressed',String(selected));}
}
function favoriteTVGuideActive(){return Boolean(session?.connected&&view==='favorites'&&category==='live'&&!query&&!contentPageOpen()&&!settingsTools.isOpen&&!document.hidden);}
function createFavoriteChannelLogo(item){
  const logo=node('div','channel-logo'),initials=String(item.name||'TV').replace(/^(?:CANAL|TV)\s*/i,'').slice(0,2).toUpperCase();
  logo.append(node('span','channel-initial',initials));
  const poster=artwork(channelLogos.resolve(item))||artwork(item.poster),original=artwork(item.posterOriginal)||artwork(item.poster);
  if(poster){
    const graphic=image(poster,'',true,original),geometry=channelLogos.geometry?.(poster);
    if(geometry){const frame=()=>{const local=graphic.getAttribute('src')===poster;graphic.classList.toggle('channel-logo-framed',local);for(const [property,value]of Object.entries(geometry))graphic.style[property]=local?value:'';};frame();graphic.addEventListener('load',frame);graphic.addEventListener('error',frame);}
    logo.append(graphic);
  }
  return logo;
}
function renderFavoriteGroups(container,items){return myList.render(container,items);}
function renderFavoriteTabs(bar,groups){
  const existing=new Map([...bar.children].map(chip=>[chip.dataset.favoriteKind,chip]));
  reconcileChildren(bar,groups.map(group=>{
    const chip=existing.get(group.id)||button(group.name,'category-chip',()=>void chooseCatalogCategory(group.id));
    chip.dataset.favoriteKind=group.id;chip.classList.toggle('active',category===group.id);chip.setAttribute('aria-pressed',String(category===group.id));return chip;
  }));
}
function getChannels(){return tv.visibleChannels();}

function currentStoredItem(item){const resolved=resolveLibraryItem(item,{catalog:catalogs.get(typeFor(item.kind)),libraryId:session?.account?.libraryId,activeLibraryId:mediaLibrary.accountId});if(!resolved)return null;if(resolved.kind==='live')return {...resolved,poster:artwork(channelLogos.resolve(resolved))||resolved.poster};return {...resolved,...libraryArtwork.get(resolved)};}
function librarySelection(type){return {favorites,catalogs,libraryId:session?.account?.libraryId,activeLibraryId:mediaLibrary.accountId,type,visible:isItemVisible};}
function domainFavorites(type){return catalogFeatures.get(type)?.favorites(librarySelection(type))||selectLibraryFavorites(librarySelection(type));}
function customGroupItems(group,items){const keys=new Set(group.itemKeys || []);return items.filter(item=>keys.has(itemKey(item)));}
function prepareRemoteSearch(data){
  const prepared=new Map();
  for(const type of ['live','movies','series']){
    const kind=type==='movies'?'movie':type,items=data.items.filter(item=>item.kind===kind),categories=data.categoriesByType?.[type]||catalogs.get(type)?.sourceCategories||[];
    for(const item of prepareCatalog({items,categories},type).items)if(isItemVisible(item))prepared.set(itemKey(item),item);
  }
  return {...data,items:data.items.map(item=>prepared.get(itemKey(item))).filter(Boolean)};
}
function globalSearchResults(){return remoteSearch.state.query===normalizeSearchText(query).slice(0,120)?remoteSearch.state.data||{items:[],counts:{live:0,movie:0,series:0},total:null,hasMore:false}:{items:[],counts:{live:0,movie:0,series:0},total:null,hasMore:false};}
function renderGlobalSearch(container){
  const state=remoteSearch.state,data=globalSearchResults(),items=data.items,busy=['queued','loading','more'].includes(state.phase),bar=$('#category-bar');
  bar.hidden=!data.total;$('#result-count').textContent=data.total===null?'':`${formatNumber(data.total)} resultados${data.preparing?' disponíveis':''}`;
  if(!canSearchGlobally(query)){bar.hidden=true;bar.replaceChildren();$('#result-count').textContent='';container.replaceChildren(emptyState('Encontre sua próxima história','Digite ao menos 3 caracteres para buscar filmes, séries e canais.'));return;}
  bar.hidden=false;
  const tabs=[['all','Tudo',data.counts.live+data.counts.movie+data.counts.series],['live','Ao vivo',data.counts.live],['movies','Filmes',data.counts.movie],['series','Séries',data.counts.series]];
  const existing=new Map([...bar.children].map(chip=>[chip.dataset.searchType,chip]));
  reconcileChildren(bar,tabs.map(([type,label,count])=>{
    const chip=existing.get(type)||button('','category-chip',()=>{if(remoteSearch.state.type===type)return;category=type==='movies'?'movie':type==='all'?'__all':type;visibleLimit=48;void searchCatalogQuery(query,{type,immediate:true});});chip.textContent=`${label}${data.total!==null&&Number.isFinite(count)?' · '+formatNumber(count):''}`;chip.dataset.searchType=type;chip.classList.toggle('active',state.type===type);chip.setAttribute('aria-pressed',String(state.type===type));return chip;
  }));
  if(items.length){let grid=container.querySelector(':scope>.poster-grid');if(!grid){grid=node('div','poster-grid');container.replaceChildren(grid);}renderCards(grid,items.slice(0,visibleLimit));}
  else if(state.error)container.replaceChildren(emptyState('Não foi possível concluir a busca',state.error,{label:'Tentar novamente',run:()=>void refreshCatalogSearch()}));
  else if(busy)container.replaceChildren(emptyState('Buscando no catálogo','Consultando filmes, séries e canais…'));
  else if(data.preparing)container.replaceChildren(emptyState('A busca ainda está sendo preparada','O catálogo está sendo atualizado. Tente novamente em instantes.',{label:'Atualizar busca',run:()=>void refreshCatalogSearch()}));
  else container.replaceChildren(emptyState('Nenhuma história com esse nome','Tente outro título, canal ou categoria.'));
  const more=items.length>visibleLimit||data.hasMore,wrap=$('#load-more-wrap'),sentinel=$('#catalog-load-sentinel'),retry=$('#catalog-load-retry');
  wrap.hidden=!(more||state.error&&items.length||busy&&items.length);sentinel.hidden=!more||busy||Boolean(state.error);retry.hidden=!state.error;retry.firstChild.textContent='Tentar novamente';
  $('#page-progress').textContent=state.error?`${state.error}${items.length?' Os resultados anteriores continuam disponíveis.':''}`:busy?'Buscando mais resultados…':more?`${formatNumber(Math.min(visibleLimit,items.length))} de ${formatNumber(data.total)} resultados`:'';
  scheduleAutomaticReveal();
}
const browseIndexes=new WeakMap();
function currentBrowseIndex(){
  if(query||!['live','movies','series'].includes(view))return null;const catalog=catalogs.get(view);if(!catalog||!catalogIsComplete(catalog))return null;
  let index=browseIndexes.get(catalog);if(!index){index=new CatalogBrowseIndex(catalog);browseIndexes.set(catalog,index);}
  const preferences=settingsTools.getPreferences(),key=JSON.stringify([parentalControl?.unlocked===true,preferences.hidden[view],preferences.hiddenItems[view]]);
  return index.project(key,isItemVisible);
}
function currentGenreIndex(){
  if(query||!['movies','series'].includes(view))return null;
  const prepared=currentBrowseIndex();if(prepared)return prepared.genreIndex;
  const catalog=catalogs.get(view);
  if(!genreCache||genreCache.view!==view||genreCache.catalog!==catalog)genreCache={view,catalog,index:catalogGenres(catalog,{items:(catalog?.items||[]).filter(isAutomaticItemVisible)})};
  return genreCache.index;
}
function renderGenreStrip(body){
  const index=currentGenreIndex();if(!index||index.choices.length<2)return null;
  let strip=body.querySelector(':scope>.catalog-genre-strip');
  if(!strip){strip=node('nav','catalog-genre-strip');strip.setAttribute('aria-label','Filtrar por gênero');}
  const existing=new Map([...strip.children].map(choice=>[choice.dataset.genreId,choice]));
  const choices=index.choices.map(genre=>{
    const choice=existing.get(genre.id)||button(genre.name,'catalog-genre-button',()=>{if(selectedGenre===genre.id)return;automaticCatalogCategories.delete(view);selectedGenre=genre.id;visibleLimit=48;render();window.scrollTo({top:0,behavior:'instant'});});
    choice.dataset.genreId=genre.id;choice.classList.toggle('active',selectedGenre===genre.id);choice.setAttribute('aria-pressed',String(selectedGenre===genre.id));choice.setAttribute('aria-label',`${genre.name} · ${formatNumber(genre.count)} títulos carregados`);return choice;
  });
  reconcileChildren(strip,choices);return strip;
}
function matchedItems(shouldSort=true) {
  const prepared=currentBrowseIndex();if(prepared&&!category.startsWith('custom:')&&category!=='__favorites')return prepared.select({category,genre:selectedGenre,sort:shouldSort?category===RELEASES_CATEGORY&&(sortModes[view]||'date')==='date'?'releases':sortModes[view]||'name':'name'});
  let items;
  if(query){items=globalSearchResults().items;}
  else if(view==='favorites'){items=myList.items();}
  else {items=catalogFeatures.get(view)?.items(catalogs.get(view),{...librarySelection(view),favoritesOnly:category==='__favorites'})||[];}
  items=items.filter(isItemVisible);
  if(!query&&catalogFeatures.has(view)&&category!=='__favorites')items=items.filter(item=>category===ADULT_CATEGORY?!mayRemember(item):mayRemember(item));
  if(category.startsWith('custom:')){const group=settingsTools.getCustomGroups().find(group=>group.id===category.slice(7));items=group?customGroupItems(group,items):[];}
  else if(category==='__favorites')items=items.filter(item=>favorites.has(itemKey(item)));
  else if(category!==ADULT_CATEGORY&&category!==RELEASES_CATEGORY&&category!=='__all')items=items.filter(item=>query || view==='favorites'?item.kind===category:(item.groupKeys||[item.groupKey]).includes(category));
  if(!query&&selectedGenre!=='__all'){const genres=currentGenreIndex();if(genres)items=items.filter(item=>genres.matches(item,selectedGenre));}
  return category===RELEASES_CATEGORY&&shouldSort&&(sortModes[view]||'date')==='date'?latestReleases(items,items.length):shouldSort&&!query?sortItems(items):items;
}
function matchedCategoryItems(){const selected=category;category='__all';const items=matchedItems(false);category=selected;return items;}
function categoriesFor(items) {
  if(view==='favorites'&&!query)return ['live','movie','series'].map(kind=>({id:kind,name:{live:'Ao vivo',movie:'Filmes',series:'S\u00e9ries'}[kind],count:items.filter(item=>item.kind===kind).length}));
  if(query)return [{id:'__all',name:'Tudo',count:items.length},...['live','movie','series'].map(kind=>({id:kind,name:{live:'Ao vivo',movie:'Filmes',series:'S\u00e9ries'}[kind],count:items.filter(item=>item.kind===kind).length})).filter(item=>item.count)];
  const data=catalogs.get(view),prepared=currentBrowseIndex(),paged=isPagedCatalog(data),counts=new Map();
  if(!prepared)for(const item of items)for(const key of item.groupKeys||[item.groupKey])counts.set(key,(counts.get(key)||0)+1);
  let groups=(prepared?prepared.categories(selectedGenre):(data?.categories||[]).map(group=>({...group,count:counts.get(group.id)||0,unloaded:paged&&[...group.ids].some(id=>!data.pagination.byCategory?.[id]?.loaded)}))).filter(group=>!isAdultCategory(group)&&[...group.ids].some(id=>settingsTools.isCategoryVisible(view,id))&&(group.count||paged));
  const realRelease=view==='live'?null:releaseCatalogCategory((data?.categories||[]).filter(group=>[...group.ids].some(id=>settingsTools.isCategoryVisible(view,id))));
  if(realRelease){const available=groups.find(group=>group.id===realRelease.id);groups=groups.filter(group=>group.id!==realRelease.id);groups.push({...realRelease,...available,name:'Lan\u00e7amentos',count:available?.count||0});}
  else if(view!=='live')groups.push({id:RELEASES_CATEGORY,name:'Lan\u00e7amentos',fallback:true,count:prepared?prepared.select({category:RELEASES_CATEGORY,genre:selectedGenre,sort:'releases'}).length:items.length});
  const personal=settingsTools.getCustomGroups().filter(group=>group.type===view).map(group=>({id:'custom:'+group.id,name:group.name,count:customGroupItems(group,items).length}));
  const games=view==='live'&&session?.capabilities?.games===true?[{id:DAILY_GAMES_CATEGORY,name:'Jogos de hoje',utility:'games'}]:[];
  const adult={id:ADULT_CATEGORY,name:'Adulto',protected:true,locked:parentalControl?.unlocked!==true,count:prepared?prepared.select({category:ADULT_CATEGORY,sort:'name'}).length:(data?.items||[]).filter(item=>isItemVisible(item)&&!mayRemember(item)).length};
  const genres=selectedGenre!=='__all'?currentGenreIndex():null,favoriteCount=domainFavorites(view).filter(item=>!genres||genres.matches(item,selectedGenre)).length;
  return orderCatalogCategories(view,[{id:'__all',name:'Todos',count:items.length},{id:'__favorites',name:'Favoritos',count:favoriteCount},...games,...personal,...groups,adult]);
}
async function chooseCatalogCategory(id){
  if(category===id&&!(id===ADULT_CATEGORY&&!parentalControl?.unlocked))return;
  const type=view,generation=connectionGeneration;automaticCatalogCategories.delete(type);category=id;categoryDefaultPending=false;visibleLimit=48;
  if(id===ADULT_CATEGORY)selectedGenre='__all';
  if(![DAILY_GAMES_CATEGORY,ADULT_CATEGORY,RELEASES_CATEGORY].includes(id))void catalogPager.load(type,id,{initialOnly:true});
  render();window.scrollTo({top:0,behavior:'instant'});
  if(id===ADULT_CATEGORY&&!parentalControl?.unlocked){await parentalControl.unlock();if(generation===connectionGeneration&&view===type&&category===id)render();}
}
const catalogSidebar=createCatalogSidebar({node,button,icon,normalize,reconcileChildren,formatNumber,
  getState:()=>({view,category}),onSelect:chooseCatalogCategory,onManage:type=>settingsTools.open('catalog',type)});
function categoryButtons(groups,live=false){return catalogSidebar.buttons(groups,live);}
function categorySidebar(groups){return catalogSidebar.create(groups);}
function updateCategorySidebar(sidebar,groups){return catalogSidebar.update(sidebar,groups);}
function homeOrderedCatalogs(){return inicio.orderedCatalogs();}
function homeShelfSections(){return inicio.sections();}
function renderHome(container){return inicio.render(container);}
function render() {
  if(!homeTVActive())pauseHomeChannels('inactive');
  if(!session?.connected){favoriteTVGuide?.pause();return;}
  if(!catalogWorkActive()){favoriteTVGuide?.pause();return;}
  if(view==='favorites'&&!query&&!['live','movie','series'].includes(category))category='live';
  if(!favoriteTVGuideActive())favoriteTVGuide?.pause();
  captureCatalogFeature();
  heroRotation?.sync();
  if(view!=='live'||category!==DAILY_GAMES_CATEGORY||query||contentPageOpen()||settingsTools.isOpen||document.hidden)dailyGames?.stop();
  syncSearchControl();updateAccessValidity();
  shell.navigation.update({view,query});
  const home=view==='home' && !query;$('#hero').hidden=!home;$('#page-heading').classList.toggle('home-heading',home);$('#page-title').textContent=query?`Resultados para “${query}”`:viewLabels[view];$('#page-eyebrow').hidden=!home;$('#page-eyebrow').textContent='EXPLORE O SEU CATÁLOGO';
  if(!home)shelfCarousels?.sync(null);
  if(!query&&['live','movies','series'].includes(view))$('#browse').dataset.catalogView=view;else delete $('#browse').dataset.catalogView;
  if(!home){heroDurationController?.abort();heroDurationController=null;}
  if(!settingsTools.isOpen&&!contentPageOpen())document.title=`ARKHEN P2 IPTV · ${query?'Busca':{home:'Seu universo em cena',live:'Ao vivo',movies:'Filmes',series:'Séries',favorites:'Minha lista'}[view]}`;
  renderSort();$('#load-more-wrap').hidden=true;$('#catalog-load-retry').hidden=true;$('#catalog-load-sentinel').hidden=true;const container=$('#catalog-content'),mode=home?'home':query?'search':view==='favorites'?`favorites:${category}`:`catalog:${view}`;
  if(container.dataset.renderMode!==mode){container.dataset.renderMode=mode;container.replaceChildren();}
  if(home){renderHome(container);return;}
  if(query){renderGlobalSearch(container);return;}
  const currentCatalog=catalogs.get(view);if(loading.has(view) && !currentCatalog && !query){$('#category-bar').hidden=true;$('#result-count').textContent='';if(!container.querySelector('.skeleton'))container.replaceChildren(skeletons(12));return;}
  if(currentCatalog&&!query&&['live','movies','series'].includes(view)&&(categoryDefaultPending||automaticCatalogCategories.has(view))){
    const groups=categoriesFor(currentBrowseIndex()?.select({sort:'name'})||currentCatalog.items.filter(isAutomaticItemVisible));
    const choice=defaultCatalogCategory(view,groups,{favoritesCount:groups.find(group=>group.id==='__favorites')?.count||0});
    if(category!==choice){category=choice;visibleLimit=48;}categoryDefaultPending=false;if(![RELEASES_CATEGORY,ADULT_CATEGORY].includes(category))void catalogPager.load(view,category,{initialOnly:true});
  }
  if(currentCatalog&&!query&&selectedGenre!=='__all'&&['movies','series'].includes(view)&&!catalogLoading([view])&&!currentGenreIndex().choices.some(choice=>choice.id===selectedGenre))selectedGenre='__all';
  const allItems=category==='__all'?matchedItems(false):matchedCategoryItems();
  const searchState=query?globalSearchResults():null;
  const groups=categoriesFor(allItems),items=currentBrowseIndex()?matchedItems():category==='__all'?(query?allItems:sortItems(allItems)):matchedItems(),partialSearch=Boolean(searchState?.partial),partialCatalog=!query&&category!=='__favorites'&&catalogFeatures.has(view)&&!catalogIsComplete(currentCatalog);$('#result-count').textContent=query?`${formatNumber(items.length)} resultados${partialSearch?' disponíveis':''}`:view==='favorites'||category==='__favorites'?`${formatNumber(items.length)} ${items.length===1?'favorito':'favoritos'}`:catalogFeatures.get(view)?.count(items.length,currentCatalog,catalogLoading([view]))||catalogCountLabel(items.length,{catalog:currentCatalog});
  const live=view==='live'&&!query,categorized=['live','movies','series'].includes(view)&&!query,bar=$('#category-bar');bar.hidden=categorized;if(view==='favorites'&&!query)renderFavoriteTabs(bar,groups);else bar.replaceChildren(...categoryButtons(groups));
  if(!items.length&&!categorized){if(view==='favorites')favoriteTVGuide?.reset();const error=query?catalogFailure(['live','movies','series']):failures.get(view),busy=query&&partialSearch&&catalogLoading(['live','movies','series']);container.replaceChildren(emptyState(error?'Não foi possível completar o catálogo':busy?'Buscando nos títulos disponíveis':query?partialSearch?'Mais títulos estão chegando':'Nenhuma história com esse nome':view==='favorites'?'Guarde a próxima descoberta':'Esta categoria está vazia',error || (query?partialSearch?'Ainda não encontramos esse título entre os disponíveis. Novas opções aparecerão aqui.':'Tente outro título, canal ou categoria.':view==='favorites'?`Toque na estrela ${category==='live'?'de um canal':category==='movie'?'de um filme':'de uma série'} para encontrar seus favoritos aqui.`:'Escolha outra categoria para continuar explorando.'),error&&!query?{label:'Tentar novamente',run:()=>loadCatalog(view,true)}:null));if(query)renderCatalogStatus(items);return;}
  if(view==='favorites'&&!query){renderFavoriteGroups(container,items);return;}
  if(catalogContent.render(container,{view,category,groups,items,catalog:currentCatalog,limit:visibleLimit,categorized,error:failures.get(view)})===false)return;
  renderCatalogStatus(items);
}
function updateHero() {
  featured=cloudFeaturedTitles(homeOrderedCatalogs(),{visible:isAutomaticItemVisible,perType:3});$('#hero').hidden=!featured.length&&!loading.has('movies')&&!loading.has('series');
  $('#hero').classList.toggle('loading',!featured.length);if(!featured.length){heroItem=null;heroRequest++;heroDurationController?.abort();heroDurationController=null;$('#hero-title').textContent='Seu universo em cena.';$('#hero-meta').replaceChildren();$('#hero-plot').textContent='Escolha as categorias que quer explorar em Configurações.';setHeroArtwork($('#hero-art'),{});$('#hero-picker').replaceChildren();heroRotation?.sync();return;}
  if(!heroItem || !featured.some(item=>itemKey(item)===itemKey(heroItem)))setHero(featured[0]);
  const picker=$('#hero-picker'),existing=new Map([...picker.children].map(element=>[element.dataset.heroKey,element]));
  reconcileChildren(picker,featured.map(item=>{const key=itemKey(item),select=existing.get(key)||button('','',()=>{const current=featured.find(candidate=>itemKey(candidate)===key);if(current){setHero(current);heroRotation?.restart();}});select.dataset.heroKey=key;select.classList.toggle('active',key===itemKey(heroItem));select.setAttribute('aria-label',`Destacar ${item.kind==='series'?'série':'filme'} ${item.name}`);select.setAttribute('aria-pressed',String(key===itemKey(heroItem)));return select;}));
  heroPauseReasons.delete('hero-picker:focus');if(picker.contains(document.activeElement))heroPauseReasons.add('hero-picker:focus');heroRotation?.setPaused(heroPauseReasons.size>0);
  heroRotation?.sync();
}
function setArt(element,url,poster=false,fallback=''){
  const existing=element.querySelector(':scope>img'),source=artwork(url),recovery=artwork(fallback);
  if(source&&existing?.getAttribute('src')===source&&element.classList.contains('is-poster')===Boolean(poster)&&!existing.classList.contains('image-failed')){existing.dataset.fallbackArtwork=recovery;return;}
  element.classList.toggle('is-poster',poster);element.replaceChildren();
  if(!source)return;
  const picture=image(url,'',false);
  picture.dataset.fallbackArtwork=recovery;
  picture.addEventListener('error',()=>{if(picture.parentNode!==element)return;const replacement=picture.dataset.fallbackArtwork;if(artwork(replacement)&&replacement!==source)setArt(element,replacement,true);else element.replaceChildren();},{once:true});
  element.append(picture);
}
async function setHero(item) {
  heroDurationController?.abort();heroDurationController=null;
  heroItem=item;const token=++heroRequest,previousDuration=historyFor(item)?.duration;
  const facts=(value,durationPending=false)=>renderHeroFacts($('#hero-meta'),value,{previousDuration,durationPending},node);
  $('#hero-title').textContent=cleanTitle(item.name);$('#hero-plot').textContent=metadataText(item.plot)||'';$('#hero-watch').disabled=false;$('#hero-details').disabled=false;
  facts(item,item.kind==='movie');setHeroArtwork($('#hero-art'),item);
  $('#hero-picker').querySelectorAll('button').forEach((element,index)=>{const featuredItem=featured[index],selected=Boolean(featuredItem&&itemKey(featuredItem)===itemKey(item));element.classList.toggle('active',selected);element.setAttribute('aria-pressed',String(selected));});
  let current=item;
  try{
    const details=await getDetails(item);if(token!==heroRequest)return;if(!mayRemember(item,details)){updateHero();return;}current={...item,...details};
    const needsDuration=item.kind==='movie'&&!metadataText(movieWithPlaybackDuration(current,previousDuration).duration);
    facts(current,needsDuration);$('#hero-plot').textContent=metadataText(current.plot);setHeroArtwork($('#hero-art'),current);
    if(!needsDuration||view!=='home'||query||contentPageOpen()||settingsTools.isOpen)return;
    const controller=new AbortController();heroDurationController=controller;
    const deadline=setTimeout(()=>controller.abort(),7000);
    try{const measured=await getDetails(item,{duration:true,signal:controller.signal});if(token===heroRequest&&!controller.signal.aborted){if(!mayRemember(item,measured)){updateHero();return;}current={...current,...measured};}}
    finally{clearTimeout(deadline);if(heroDurationController===controller)heroDurationController=null;}
  }catch{/* Keep real catalog fields when optional metadata cannot be loaded. */}
  finally{if(token===heroRequest)facts(current);}
}
async function getDetails(item,{duration=false,signal}={}) {
  if(item.kind==='movie'){
    const data=await filmes.services.details(item,{duration,signal});
    if(!mayRemember(item,data)){blockRememberedItem(item);return {...data,isAdult:true};}
    return data;
  }
  if(item.kind==='series'){
    const data=await series.details(item,{signal});
    if(!mayRemember(item,data)){blockRememberedItem(item);return {...data,isAdult:true};}
    return data;
  }
  duration=Boolean(duration&&item.kind==='movie');
  const baseKey=itemKey(item),key=baseKey+(duration?':duration':'');if(detailsCache.has(key))return detailsCache.get(key);
  const generation=connectionGeneration;
  const pending=api(`/api/details?type=${item.kind}&id=${encodeURIComponent(item.id)}${duration?'&duration=1':''}`,{signal}).then(data=>{
    if(generation!==connectionGeneration || detailsCache.get(key)!==pending)throw new DOMException('A conexão foi alterada.','AbortError');
    if(!mayRemember(item,data)){blockRememberedItem(item);data={...data,isAdult:true};}
    detailsCache.set(key,data);if(duration)detailsCache.set(baseKey,data);return data;
  }).catch(error=>{
    if(generation===connectionGeneration && detailsCache.get(key)===pending)detailsCache.delete(key);
    throw error;
  });
  detailsCache.set(key,pending);return pending;
}
const previewTools=new PreviewTools({root:$('#detail-content'),background:$('#detail-art'),setArt,icon:iconNode,onWatch:watchDetail,onFavorite:()=>toggleFavorite(detailItem),onRetry:()=>{if(detailItem)openDetails(detailItem,false,{route:false});},onCatalog:()=>setView(typeFor(detailItem?.kind||'movie'))});
const movieSuggestions=filmes.createSuggestions({stage:$('.video-stage'),video,getScope:()=>({generation:connectionGeneration,scope:privateProjectionScope()}),allowed:isAutomaticItemVisible,createCard:mediaCard,setArt,
  onWatch:item=>openPlayer(item),onDetails:item=>openDetails(item),onReplay:item=>openPlayer(item,null,{startFromBeginning:true}),onBack:()=>setView('movies')});
function refreshDetailFavorite(){if(detailItem)previewTools.favorite(favorites.has(itemKey(detailItem)));}
async function openDetails(item,watch=false,pageOptions={}) {
  if(!allowsKnownItem(item)&&!await parentalControl.unlock())return;
  if(pageOptions.route!==false)setContentRoute('preview',item);
  const previousSeason=pageOptions.route===false&&detailItem&&itemKey(detailItem)===itemKey(item)?activeSeason:0;
  playOpenRequest++;const stopped=stopPlayback();previewDurationController?.abort();previewDurationController=null;previewDurationPending=item.kind==='movie';leaveNativeFullscreen();channelGuide?.pause();detailItem=item;detailData=null;activeSeason=previousSeason;const token=++detailRequest;
  showContentPage('preview');document.title=`ARKHEN P2 IPTV · ${cleanTitle(item.name)}`;
  setArt($('#detail-art'),item.backdrop||item.poster,!item.backdrop,item.poster);detailData={...item,seasons:[],loading:true};renderDetails();
  const loading=node('div','detail-loading');loading.append(node('span','spinner'),node('span','','Carregando informações…'));$('#detail-content').append(loading);
  try{
    await stopped;if(token!==detailRequest||$('#detail-dialog').hidden)return;
    const details=await getDetails(item);if(token!==detailRequest || $('#detail-dialog').hidden)return;detailData=details;renderDetails();
    if(pageOptions.route===false)window.scrollTo({top:window.history.state?.arkehnScrollY||0,behavior:'instant'});
    if(watch){previewDurationPending=false;watchDetail();return;}
    if(item.kind==='series')return;
    previewDurationController=new AbortController();
    getDetails(item,{duration:true,signal:previewDurationController.signal}).then(measured=>{if(token===detailRequest&&!$('#detail-dialog').hidden)detailData=measured;}).catch(()=>{}).finally(()=>{if(token===detailRequest&&!$('#detail-dialog').hidden){previewDurationPending=false;updateDetailDuration();}});
  }
  catch(error){if(token!==detailRequest || error.name==='AbortError')return;previewDurationPending=false;detailData={...item,plot:'',error:error.message,unavailable:error.code==='WPLAY_TITLE_NOT_FOUND'};renderDetails();}
}
function updateDetailDuration(){
  if(detailItem?.kind==='movie'&&detailData&&!$('#detail-dialog').hidden)filmes.updateDuration(previewTools,{...detailItem,...detailData,kind:'movie'},{previousDuration:historyFor(detailItem)?.duration,historyEntry:historyFor(detailItem),durationPending:previewDurationPending});
}
function renderDetails() {
  if(!detailItem||!detailData)return;
  const item={...detailItem,...detailData,kind:detailItem.kind},continuing=playbackProgress(historyFor(item)).resumable;
  if(item.kind==='series')activeSeason=series.renderPreview(previewTools,item,{continuing,historyEntry:historyFor(item),readEpisodeProgress:(title,episode)=>episodeProgress.read(title,episode),activeSeason,onSeason:selectPreviewSeason,onEpisode:episode=>openPlayer(detailItem,episode)});
  else filmes.renderPreview(previewTools,item,{continuing,previousDuration:historyFor(item)?.duration,historyEntry:historyFor(item),durationPending:previewDurationPending});
  refreshDetailFavorite();
}
function selectPreviewSeason(index){if(activeSeason===index)return;activeSeason=index;renderDetails();$('#detail-content').querySelector(`.season-tab[data-season-index="${index}"]`)?.focus({preventScroll:true});}
function watchDetail() {if(!detailItem)return;if(detailItem.kind==='series'){const episodes=allEpisodes(detailData||{}),previous=historyFor(detailItem);const next=episodes.find(episode=>String(episode.id)===String(previous?.episode?.id)) || episodes[0];if(next)openPlayer(detailItem,next);else toast('Nenhum episódio está disponível para esta série.');}else openPlayer(detailItem);}
function playerURL(item,episode,attempt='',sourceId='') {if(item.kind==='live')return tv.playbackURL(item,{attempt,sourceId});if(item.kind==='movie')return filmes.services.playbackURL(item,{attempt});return series.services.playbackURL(item,{episode,attempt});}
function playbackSourceKey(item,episode){return `${item.kind}:${item.id}:${episode?.id||''}`;}
function playbackContinuationOptions(){
  if(!player||player.item.kind==='live')return {};
  if(player.detachedContinuation)return {...player.detachedContinuation};
  if(player.item.kind==='movie')return moviePlayback.continuation({seekTarget:player.seekTarget});
  return seriesPlayback.continuation({seekTarget:player.seekTarget});
}
function refreshPlayerFavorite(){if(!player)return;const selected=favorites.has(itemKey(player.item));replaceIcon($('#player-favorite'),'star');$('#player-favorite').classList.toggle('selected',selected);$('#player-favorite').setAttribute('aria-label',selected?'Remover dos favoritos':'Adicionar aos favoritos');$('#player-favorite').setAttribute('aria-pressed',String(selected));}
function rememberAdultClassification(item){
  const key=itemKey(item),newlyBlocked=!historyBlocked.has(key);historyBlocked.add(key);
  const catalog=catalogs.get(typeFor(item.kind)),current=catalog?.itemMap.get(String(item.id)),newClassification=current&&current.isAdult!==true;
  if(newClassification){current.isAdult=true;browseIndexes.delete(catalog);genreCache=null;}
  if(newlyBlocked||newClassification){homeLibraryRevision++;inicio.invalidate();}
  return Boolean(newlyBlocked||newClassification);
}
function purgeRememberedHistory(){
  let favoritesChanged=false;
  for(const [key,item]of favorites)if(!mayRemember(item)){if(rememberAdultClassification(item))episodeProgress.purge(item);if(item.isAdult!==true){favorites.set(key,{...item,isAdult:true});favoritesChanged=true;}}
  if(favoritesChanged)mediaLibrary.saveFavorites();
  const removed=mediaLibrary.purgeHistory();cloudLibrary.purgeHistory();
  if(removed||favoritesChanged){homeLibraryRevision++;inicio.invalidate();}return removed;
}
function blockRememberedItem(item){
  if(!item)return;const changed=rememberAdultClassification(item);
  episodeProgress.purge(item);purgeRememberedHistory();
  if(changed&&session?.connected&&!contentPageOpen()&&!settingsTools.isOpen)scheduleCatalogRender(view);
}
function persistHistory(kind){if(kind!=='live')homeLibraryRevision++;if(kind==='movie')movieLibraryRevision++;const entries=[...history.values()].filter(entry=>mediaLibrary.remembersEntry(entry)).sort((first,second)=>Number(second.updated||0)-Number(first.updated||0)).slice(0,40);history.clear();for(const entry of entries)history.set(itemKey(entry.item),entry);mediaLibrary.saveHistory();ensureHomeProjection();}
function saveLiveWatch(){if(!player||!mayRemember(player.item)||player.item.kind!=='live'||!player.nativeSourceStarted&&!hls||video.readyState<2||video.paused)return;const entry={item:snapshot(player.item),time:0,duration:0,episode:null,updated:Date.now(),...(session?.account?.libraryId?{libraryId:session.account.libraryId}:{})};homeHistoryExcluded.delete(itemKey(player.item));history.set(itemKey(player.item),entry);persistHistory('live');void cloudBridge?.progressChanged(entry);}
function saveProgress(force=false,{completed=false}={}){
  if(!player||!mayRemember(player.item,player.episode)||player.item.kind==='live'||!player.mediaReady||!positionGuard.canSave(video.currentTime)||!Number.isFinite(video.currentTime)||video.currentTime<0||!force&&video.currentTime<3)return;
  if(player.item.kind==='movie'){
    const entry=moviePlayback.progress({force,completed:completed||Boolean(player.completed),mediaReady:player.mediaReady,lastSavedAt:progressLastSaved});
    if(entry){progressLastSaved=entry.updated;if(completed)player.completed=true;void filmes.progress.salvar(entry,{force}).catch(()=>{});}
    return;
  }
  const entry=seriesPlayback.progress({force,completed:completed||Boolean(player.completed),mediaReady:player.mediaReady,lastSavedAt:progressLastSaved});
  if(!entry)return;progressLastSaved=entry.updated;
  if(completed)player.completed=true;
  homeHistoryExcluded.delete(itemKey(player.item));history.set(itemKey(player.item),entry);if(player.episode)episodeProgress.save({...entry,episode:player.episode});persistHistory(player.item.kind);
  void cloudBridge?.progressChanged(entry,{force});
}
function showCompletedMovieSuggestions(){
  const active=player,serial=playbackSerial,generation=connectionGeneration;
  if(!active?.mediaReady||!movieFinishedForSuggestions(active.item,video,isAutomaticItemVisible))return false;
  saveProgress(true,{completed:true});
  movieSuggestions.showEnd(active.item,{isCurrent:()=>player===active&&serial===playbackSerial&&generation===connectionGeneration&&!$('#player-dialog').hidden});
  return true;
}
function registerTransportStop(task){
  // Wait for every local teardown even when one rejects. A rejected teardown
  // keeps new media closed until this page is reloaded; never race a decoder.
  const next=Promise.allSettled([pendingTransportStop,task]).then(results=>{const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;});
  pendingTransportStop=next;void next.catch(()=>{});return next;
}
function requestPlaybackStop({attempt='',purpose='',scope=homePlaybackScope()}={}){
  const params=new URLSearchParams();if(attempt)params.set('attempt',attempt);if(purpose)params.set('purpose',purpose);
  const remote=Promise.resolve(pendingStop).catch(()=>{}).then(()=>{
    if(scope!==homePlaybackScope())return {connected:false,stopped:false};
    return api('/api/stop'+(params.size?'?'+params:''),{method:'POST',body:'{}',keepalive:true});
  });
  const next=Promise.allSettled([pendingTransportStop,remote]).then(results=>{const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;return results[1].value;});
  lastPlaybackStop=next;pendingStop=next.catch(()=>{});return next;
}
function destroyPlayerTransport(instance){
  if(!instance)return;
  try{const result=instance.destroy();if(result?.then||instance.whenStopped?.then)return registerTransportStop(instance.whenStopped||result);}
  catch(error){return registerTransportStop(Promise.reject(error));}
}
function stopPlayback({preserveTicket=null,preservePreparedVideo=false}={}){void tvWatchHeartbeat?.stop();channelSwitch?.cancel({preserveTicket});continuityFlow?.reset({preserveTicket:preservePreparedVideo?preserveTicket:null});const wasPlaying=Boolean(player);player?.sourceController?.abort();movieSuggestions.reset();saveProgress(true);++playbackSerial;playerMetadataCleanup?.();playerMetadataCleanup=null;moviePlayback.reset();seriesPlayback.reset();vodSeek.reset();positionGuard.reset();resumePrompt.reset();if(player?.item.kind==='live')tv.audio?.reset();else if(player?.item.kind==='movie')movieAudio.reset();else if(player?.item.kind==='series')seriesAudio.reset();else{channelVolumeMemory.reset();audioProcessing.reset();}tv.stopProgram();immersivePlayer?.reset();playerTools.reset();if(hls){const previous=hls;hls=null;destroyPlayerTransport(previous);}player=null;video.pause();video.removeAttribute('src');video.load();$('#player-loading').hidden=true;if(wasPlaying&&!preservePreparedVideo)void requestPlaybackStop().catch(()=>{});const stopped=Promise.allSettled([lastPlaybackStop,pendingTransportStop]).then(results=>{const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;});void stopped.catch(()=>{});return stopped;}
function advanceEpisode(options={}){if(!player?.next)return;saveProgress(true,{completed:Boolean(options.automatic||options.reason==='credits')});openPlayer(player.item,player.next,{startFromBeginning:true});}
function retryPlayback(){if(player?.pendingChannelItem){void channelSwitch.select(player.pendingChannelItem);return;}const retryUntil=Math.max(player?.retryAfterUntil||0,playerTools.current?.rateLimitedUntil||0);if(retryUntil>Date.now()){toast(`Aguarde ${Math.ceil((retryUntil-Date.now())/1000)} segundos antes de tentar novamente.`);return;}if(player)openPlayer(player.item,player.episode,{...player.playOptions,...playerTools.getQualitySelection(),...playbackContinuationOptions(),...(player.item.kind==='live'?{}:{resumePlay:true,seekRecoveryAttempt:0}),automatic:false});}
function detachNativeMedia(){if(!player||hls||!player.nativeSourceStarted)return;player.detachedContinuation=playbackContinuationOptions();saveProgress(true);player.mediaReady=false;player.nativeSourceStarted=false;playerMetadataCleanup?.();playerMetadataCleanup=null;vodSeek.reset();resumePrompt.reset();video.pause();video.removeAttribute('src');video.load();}
function playbackFailure(message){channelSwitch?.markFailure(player);hls?.stopLoad();if(!hls)detachNativeMedia();playerTools.fail();immersivePlayer?.setFailure?.(message);$('#player-loading').hidden=true;$('#player-status').textContent=message;$('#player-retry').hidden=false;}
async function openPlayer(item,episode=null,playOptions={}) {
  const switchTicket=playOptions.channelSwitchTicket;
  if(switchTicket&&!channelSwitch?.owns(switchTicket,item))return;
  const preparedLiveSources=switchTicket?.prepared||null;
  const preparedVideo=switchTicket?.preparedVideo||null;
  if(preparedVideo&&!continuityFlow?.owns(switchTicket))return;
  // Handoff data belongs to this opening only, never to retries or source changes.
  const {channelSwitchTicket:_ticket,preparedLiveSources:_prepared,preparedLiveVideo:_video,beforePlayback,fullscreen,...persistentOptions}=playOptions;playOptions=persistentOptions;
  homePlaybackOpening++;
  pauseCatalogWork();filmes.suggestions?.pausePreview();
  if(!playOptions.automatic)playerTools.tvQuality?.cancel();
  try {
  homeChannelPrograms?.pause();
  const previewStopped=homeChannels?.pause('watch')||Promise.resolve();void previewStopped.catch(()=>{});
  if(!switchTicket)channelSwitch?.cancel();
  const transportRequest=++playerTransportRequest,accountGeneration=connectionGeneration,previousSerial=playbackSerial;
  if(!allowsKnownItem(item)&&!await parentalControl.unlock())return;
  if(transportRequest!==playerTransportRequest||previousSerial!==playbackSerial||accountGeneration!==connectionGeneration)return;
  if(switchTicket&&!channelSwitch?.owns(switchTicket,item))return;
  // Home card activation must request fullscreen before a cold engine import
  // yields. Authorization still precedes opening this temporary surface.
  if(fullscreen===true&&item.kind==='live'&&session?.connected&&!player&&!contentPageOpen()&&$('#player-dialog').hidden){
    homeFullscreenPending=true;$('#player-dialog').hidden=false;$('#player-loading').hidden=false;tryNativeFullscreen();
  }
  if(item.kind==='series'&&!episode){await openDetails(item);return;}
  const playbackMeasurement=item.kind==='live'?new TVPlaybackMeasurement({prepared:Boolean(preparedLiveSources||preparedVideo),reason:playOptions.reason||(switchTicket?'channel-navigation':playOptions.nativeFallback?'native-fallback':playOptions.automatic?'automatic':'opening')}):null;
  // Resolve the selected library before retiring the current video. These are
  // static files only; a missing/unsupported Shaka must not stop a good stream.
  playOptions={...playOptions,engine:preparedVideo?.engine||playOptions.engine||playerEnginePreference.get()};
  let transport;
  try{
    const choice=preparedVideo?{HlsClass:preparedVideo.hls?.constructor||window.Hls,usingNativeHLS:preparedVideo.usingNativeHLS,engine:preparedVideo.engine}:resolvePlayerTransport({engine:playOptions.engine,video:videoHost.element});
    if(choice?.then){void audioProcessing.prepare(videoHost.element);toast('Preparando o Shaka…');transport=await choice;}else transport=choice;
  }catch(error){if(transportRequest===playerTransportRequest&&previousSerial===playbackSerial&&accountGeneration===connectionGeneration)toast(error.message);return;}
  if(transportRequest!==playerTransportRequest||previousSerial!==playbackSerial||accountGeneration!==connectionGeneration||switchTicket&&!channelSwitch?.owns(switchTicket,item))return;
  channelGuide?.pause();
  const wasPlayerPage=!homeFullscreenPending&&!$('#player-dialog').hidden;
  if(playOptions.route!==false)setContentRoute('watch',item,episode,wasPlayerPage);
  const channelNumber=item.kind==='live'?(playOptions.channelNumber ?? (playOptions.automatic?player?.channelNumber:null) ?? settingsTools.getChannelNumber(item.id,null)):null;
  const initialProgram=item.kind==='live'?(liveProgramFeed?.peek(item.id)||channelGuide?.peek(item.id)):null;
  const sameLiveChannel=playOptions.automatic&&item.kind==='live'&&player?.item.kind==='live'&&(String(player.item.id)===String(item.id)||playerTools.current?.variants.some(variant=>String(variant.id)===String(item.id)));
  const continuation=sameLiveChannel?immersivePlayer?.preparationContinuation():null;
  const openRequest=++playOpenRequest,stopped=stopPlayback({preserveTicket:switchTicket,preservePreparedVideo:Boolean(preparedVideo)});
  const adopted=preparedVideo?continuityFlow.adopt(switchTicket):null;
  detailRequest++;player={item,episode,channelNumber,playOptions,engine:transport.engine,openRequest,channelSwitchTicket:switchTicket,usingNativeHLS:Boolean(adopted?.usingNativeHLS),attempt:adopted?.attempt||createLiveAttempt(),sourceController:new AbortController(),mediaReady:Boolean(adopted)};homeFullscreenPending=false;const serial=playbackSerial;
  if(item.kind==='live')tv.audio.begin(item,playerURL(item,episode,player.attempt));
  else if(item.kind==='movie')movieAudio.begin(item,playerURL(item,null,player.attempt),{isCurrent:()=>openRequest===playOpenRequest&&serial===playbackSerial&&accountGeneration===connectionGeneration});
  else seriesAudio.begin(item,playerURL(item,episode,player.attempt),{episode,isCurrent:()=>openRequest===playOpenRequest&&serial===playbackSerial&&accountGeneration===connectionGeneration});
  previewDurationController?.abort();previewDurationController=null;previewDurationPending=false;
  showContentPage('watch');document.title=`ARKHEN P2 IPTV · Assistindo ${cleanTitle(item.name)}`;
  $('#player-title').textContent=episode?`${cleanTitle(item.name)} · T${episode.season} E${episode.number}`:item.name;$('#player-kind').textContent=item.kind==='live'?'ARKHEN P2 IPTV · TV AO VIVO':item.kind==='series'?'ARKHEN P2 IPTV · SÉRIES':'ARKHEN P2 IPTV · CINEMA';$('#player-status').textContent='Conectando ao vídeo…';$('#player-program').hidden=true;$('#player-program').replaceChildren();$('#player-loading').hidden=false;$('#player-retry').hidden=true;video.preload='auto';refreshPlayerFavorite();
  const episodes=allEpisodes((item.kind==='series'?series.peekDetails(item):detailsCache.get(itemKey(item)))||{});const index=episodes.findIndex(value=>String(value.id)===String(episode?.id));player.next=index>=0?episodes[index+1]||null:null;$('#player-next').hidden=!player.next;
  immersivePlayer?.attach({item,episode,channelNumber,initialProgram,continuation});
  if(item.kind==='series')void loadSeriesPlaybackSequence({item,episode,getDetails,isCurrent:()=>openRequest===playOpenRequest&&serial===playbackSerial&&accountGeneration===connectionGeneration&&Boolean(player),onUpdate:sequence=>{
    player.episode=sequence.episode;player.next=sequence.next;player.sequenceStatus=sequence.status;seriesPlayback.updateEpisode(sequence.episode);
    $('#player-next').hidden=!player.next;immersivePlayer?.setEpisodeSequence(sequence);
  }});
  if(playOptions.route!==false&&!playOptions.automatic)tryNativeFullscreen();
  let sourceId=playOptions.sourceId||'',sources=[];
  try {
    if(item.kind==='live') {
      playbackMeasurement?.mark('preparation');
      const available=await prepareTVOpening({stopped:[stopped,previewStopped,beforePlayback],
        onPhase:phase=>playbackMeasurement?.mark(phase),
        signal:player.sourceController.signal,
        prepare:({signal})=>preparedLiveSources||tv.preparePlayback(item,{sourceId,
          signal:AbortSignal.any([signal,AbortSignal.timeout(TV_SOURCE_DISCOVERY_TIMEOUT_MS)])})});
      if(openRequest!==playOpenRequest||serial!==playbackSerial)return;
      sources=available.sources;sourceId=available.sourceId;
    } else await Promise.all([stopped,previewStopped,beforePlayback]);
  } catch(error) {
    if(openRequest!==playOpenRequest||serial!==playbackSerial)return;
    playbackMeasurement?.close(video,{failed:true});
    if(item.kind!=='live'||error.code==='LIVE_PREVIOUS_STOP_FAILED') {
      playbackFailure('Não foi possível encerrar a reprodução anterior. Recarregue a página para tentar novamente.');
    } else if(error.status===429) {
      const seconds=error.retryAfterSeconds||30;player.retryAfterUntil=Date.now()+seconds*1000;
      playbackFailure(`O provedor limitou a abertura deste canal. Aguarde ${seconds} segundos antes de tentar novamente.`);
    } else {
      // A failed source lookup is terminal for this opening. Repeating it via
      // /api/play used to hide the first error and add another discovery wait.
      playbackFailure(localPlaybackMessage(error.code)||(['AbortError','TimeoutError'].includes(error.name)
        ?'A busca da fonte demorou para responder. Tente novamente.'
        :error.message||'Não foi possível preparar a fonte deste canal.'));
    }
    return;
  }
  if(openRequest!==playOpenRequest||serial!==playbackSerial)return;
  // STOP and metadata are both complete before any new media is attached.
  if(!session?.connected){playbackFailure('Sua conexão precisa ser restabelecida. Entre novamente para assistir.');return;}
  player.sourceId=sourceId;player.playOptions={...playOptions,sourceId};
  const url=playerURL(item,episode,player.attempt,sourceId),isHLS=/\.m3u8(?:[?#]|$)/i.test(url);
  const sourceOptions={sources,sourceId,measurement:playbackMeasurement,onSourceChange:(descriptor,options)=>{if(serial!==playbackSerial)return;openPlayer(item,episode,{...playOptions,...options,sourceId:descriptor.id,route:false});}};
  const playNow=()=>{if(serial!==playbackSerial)return;if(playOptions.resumePlay===false){playbackMeasurement?.waitForUser();video.pause();immersivePlayer?.waitForPlay({ready:false});return;}video.play().catch(error=>{if(serial!==playbackSerial||error.name==='AbortError'||playerTools.current?.failed)return;if(error.name==='NotAllowedError'){playbackMeasurement?.waitForUser();immersivePlayer?.waitForPlay();if(player?.mediaReady&&video.readyState>=2)channelSwitch?.markReady(player);$('#player-loading').hidden=true;$('#player-status').textContent='Pronto. Pressione play para assistir.';}else if(!video.error)playbackFailure('O vídeo não pôde iniciar. Tente novamente ou escolha outra fonte.');});};
  if(adopted){player.mediaReady=true;}else if(item.kind==='movie'){
    const attached=moviePlayback.attach({item,historyEntry:historyFor(item),accountLibraryId:session?.account?.libraryId,playOptions,
      categories:catalogs.get('movies')?.sourceCategories||catalogs.get('movies')?.categories||[],
      isCurrent:()=>serial===playbackSerial&&openRequest===playOpenRequest&&accountGeneration===connectionGeneration&&Boolean(player),
      onReady:()=>{player.mediaReady=true;playerMetadataCleanup=null;},playNow});
    if(!attached){playbackFailure('Sua conexão precisa ser restabelecida. Entre novamente para assistir.');return;}
    playerMetadataCleanup=attached.cleanup;
  }else if(item.kind==='series'){
    const attached=seriesPlayback.attach({item,episode:player.episode,episodeEntry:episodeProgress.read(item,player.episode),historyEntry:historyFor(item),accountLibraryId:session?.account?.libraryId,playOptions,
      categories:catalogs.get('series')?.sourceCategories||catalogs.get('series')?.categories||[],sourceKey:playbackSourceKey(item,player.episode),
      isCurrent:()=>serial===playbackSerial&&openRequest===playOpenRequest&&accountGeneration===connectionGeneration&&Boolean(player),
      onReady:()=>{player.mediaReady=true;playerMetadataCleanup=null;},playNow});
    if(!attached){playbackFailure('Sua conexão precisa ser restabelecida. Entre novamente para assistir.');return;}
    playerMetadataCleanup=attached.cleanup;
  }else{
    const resumeTime=resumePlaybackPosition({item,episode,episodeEntry:episodeProgress.read(item,episode),historyEntry:historyFor(item),accountLibraryId:session?.account?.libraryId,options:playOptions});
    positionGuard.attach({resumeTime});
    vodSeek.attach({kind:item.kind,sourceKey:playbackSourceKey(item,episode),recoveryAttempt:playOptions.seekRecoveryAttempt||0});
    resumePrompt.attach({time:playOptions.seekRecoveryAttempt?0:resumeTime});
    const start=()=>{if(serial!==playbackSerial)return;player.mediaReady=true;playerMetadataCleanup=null;if(resumeTime>0)vodSeek.request(resumeTime,{play:playOptions.resumePlay!==false,reason:playOptions.seekRecoveryAttempt?'recovery':'resume'});if(playOptions.resumePlay!==false)playNow();};
    video.addEventListener('loadedmetadata',start,{once:true});
    playerMetadataCleanup=()=>video.removeEventListener('loadedmetadata',start);
  }
  const variants=findChannelVariants(item,catalogs.get('live')?.items || []);
  const nativeHLS=adopted?adopted.usingNativeHLS:transport.usingNativeHLS;
  if(adopted?.hls||transport.engine==='shaka'||isHLS&&!playOptions.preferNative&&(playOptions.preferHls||!nativeHLS)&&transport.HlsClass?.isSupported()){
    playbackMeasurement?.media(transport.engine==='shaka'?'shaka':'hls');
    const instance=adopted?.hls||new transport.HlsClass(playerTools.configFor(item.kind));hls=instance;playerTools.attach({item,hls:instance,variants,...sourceOptions,qualityMode:playOptions.qualityMode,qualityHeight:playOptions.qualityHeight,automatic:playOptions.automatic,adaptiveState:playOptions.adaptiveState,errorEvents:playOptions.errorEvents});
    const isCurrent=()=>openRequest===playOpenRequest&&serial===playbackSerial&&hls===instance&&Boolean(player)&&!continuityFlow?.isDraining();
    instance.on(window.Hls.Events.MANIFEST_PARSED,()=>{if(isCurrent())playNow();});
    instance.on(window.Hls.Events.ERROR,createHlsErrorHandler({isCurrent,tools:playerTools,video,
      onAuthFailure:()=>{void sessionGuard.check();},
      onRateLimit:limit=>{if(isCurrent())player.retryAfterUntil=Date.now()+Math.min(604800000,Number.isFinite(limit.waitMs)?limit.waitMs:35000);},
      fail:(message,{terminalService=false}={})=>{if(!isCurrent())return;playbackFailure(message);if(terminalService&&isCurrent()){hls=null;destroyPlayerTransport(instance);}},
      canUseNative:()=>transport.engine==='current'&&!playOptions.nativeFallback&&supportsNativeHLS(video),
      useNative:({interrupted})=>{if(!isCurrent())return;toast(interrupted?'Tentando reprodução nativa após a interrupção.':'Usando a reprodução nativa para esta fonte.');
        openPlayer(item,episode,{...playOptions,...playerTools.getQualitySelection(),...playbackContinuationOptions(),preferNative:true,nativeFallback:true,automatic:true,adaptiveState:playerTools.adaptiveState,errorEvents:playerTools.getErrorEvents()});}
    }));
    immersivePlayer?.setLoadingSource({url,hls:instance});if(!adopted){instance.loadSource(url);instance.attachMedia(videoHost.element);}
  }else{playbackMeasurement?.media('native');player.usingNativeHLS=isHLS&&nativeHLS;playerTools.attach({item,variants,...sourceOptions,qualityMode:playOptions.qualityMode,qualityHeight:playOptions.qualityHeight,automatic:playOptions.automatic,adaptiveState:playOptions.adaptiveState,errorEvents:playOptions.errorEvents});player.nativeSourceStarted=true;immersivePlayer?.setLoadingSource({url});if(!adopted){video.src=url;video.load();playNow();}}
  if(item.kind==='live')tv.startProgram(item.id,{initialData:initialProgram});
  if(adopted){
    video.muted=adopted.restoreMuted;
    if(playerTools.current){if(item.kind!=='live')playerTools.current.started=!video.paused;playerTools.current.mediaReadyAt=Date.now();playerTools.renderMenus();playerTools.updateMetrics();}
    playNow();
    // A prepared TV may have lost readiness during promotion. Its active-slot
    // observer owns confirmation, including when no new playing event arrives.
    if(item.kind!=='live'&&!video.paused&&video.readyState>=2){playbackMeasurement?.playing(video);immersivePlayer?.acceptPreparedPlayback();onActiveVideoPlaying();channelSwitch?.markPlaying(player);}
  }
  }finally{homePlaybackOpening--;if(homeFullscreenPending&&!player&&!homePlaybackOpening){homeFullscreenPending=false;$('#player-dialog').hidden=true;$('#player-loading').hidden=true;leaveNativeFullscreen();}if(!player&&!homePlaybackOpening){resumeCatalogWork();if(!document.hidden&&!$('#detail-dialog').hidden&&detailItem?.kind==='movie')filmes.suggestions?.previewFor(detailItem);}if(homeTVActive())syncHomeChannels();}
}
function updateProgram(data){
  if(player?.item.kind!=='live')return;
  immersivePlayer?.setProgram(data);
  const element=$('#player-program'),program=programWindow(data).current;
  element.replaceChildren();element.hidden=!program;if(!program)return;
  element.append(node('strong','',`${program.startLabel} — ${program.endLabel} · ${program.title}`));
  if(program.description)element.append(node('p','',program.description));
  const progress=node('div','program-progress'),fill=node('span');
  fill.style.width=`${Number.isFinite(data.progressPercent)?data.progressPercent:0}%`;
  progress.append(fill);element.append(progress);
}
async function refreshCatalog(){
  dailyCatalogAttempts.clear();
  cancelSearchWork();
  const request=++refreshRequest,generation=connectionGeneration,types=['live','movies','series'],labels={live:'TV ao vivo',movies:'Filmes',series:'Séries'};
  detailsCache.clear();series.invalidateDetails();failures.clear();heroItem=null;heroRequest++;$('#account-dialog').close();$('#refresh-catalog').disabled=true;
  const panel=$('#catalog-refresh'),progress=$('#catalog-refresh-progress'),status=$('#catalog-refresh-status'),stages=$('#catalog-refresh-stages');panel.hidden=false;progress.value=0;status.textContent='Conectando ao serviço · 0 de 3 etapas concluídas';stages.replaceChildren();
  const rows=new Map(types.map(type=>{const row=node('div','refresh-stage');row.dataset.state='loading';row.append(node('span','spinner'),node('span','',labels[type]),node('small','','Atualizando'));stages.append(row);return[type,row];}));
  let completed=0,succeeded=0,preparing=0;
  await Promise.allSettled(types.map(async type=>{
    const data=await loadCatalog(type,true);if(request!==refreshRequest||generation!==connectionGeneration)return;
    const waiting=isPreparingCatalog(data,{cloudReady:centralCatalogReady()});
    const completion=data&&['movies','series'].includes(type)?await completeCatalogForSession(catalogPager,type,data,{cloudReady:centralCatalogReady()}):null;
    if(request!==refreshRequest||generation!==connectionGeneration)return;
    const result=data&&!waiting&&(!completion||completion.status==='complete');
    completed++;if(result)succeeded++;if(waiting)preparing++;const row=rows.get(type);row.dataset.state=result?'done':waiting?'partial':'error';row.firstElementChild.replaceWith(iconNode(result?'check':'info'));row.querySelector('small').textContent=result?'Concluído':waiting?'Em preparação':'Falha na atualização';progress.value=completed;status.textContent=`${completed} de 3 etapas concluídas`;
  }));
  if(request!==refreshRequest||generation!==connectionGeneration)return;$('#refresh-catalog').disabled=false;
  if(preparing){status.textContent='Seu catálogo está sendo preparado. Você já pode explorar os títulos disponíveis.';toast('Mais títulos estão chegando.');}
  else if(succeeded===3){status.textContent='Tudo atualizado. Seu catálogo está pronto.';toast('TV ao vivo, filmes e séries atualizados');setTimeout(()=>{if(request===refreshRequest)panel.hidden=true;},6500);}
  else{status.textContent=`${succeeded} de 3 catálogos atualizados. Tente novamente para completar.`;toast(succeeded?'Atualização parcial. Confira as etapas.':'Não foi possível atualizar. Confira a conexão.');}
}
function showAccount(){const info=$('#account-information');info.replaceChildren();const account=session?.account||{};for(const [label,value,active] of [['Usuário',account.usernameMasked||'Conexão local'],['Status',account.status==='Active'?'Ativa':account.status||'Conectada',true],['Validade',formatAccessValidity(session).value],['Conexões',`${account.activeConnections ?? 0} de ${account.maxConnections ?? '—'}`]]){const row=node('div','account-row');row.append(node('span','',label),node('strong',active?'account-active':'',value));info.append(row);}$('#account-dialog').showModal();}

function updateAccessValidity(){return shell.header.update();}
function syncSearchControl(){return shell.search.sync({query,searchPhase:remoteSearch.state.phase});}
function cancelSearchWork(){
  clearTimeout(queryTimer);
  remoteSearch.cancel();
}
function catalogLoading(types){
  return types.some(type=>loading.has(type)||catalogPager.progressFor(type)?.status==='loading'||catalogPager.pendingFor(type,'__all'));
}
function catalogFailure(types){
  return types.map(type=>failures.get(type)||catalogPager.progressFor(type)?.error||catalogPager.errorFor(type,'__all')).find(Boolean)||'';
}
function catalogStatusTypes(){return query?['live','movies','series']:view==='favorites'?[typeFor(category)]:[view];}
function renderCatalogStatus(items,{shown=Math.min(visibleLimit,items.length),more=items.length>visibleLimit}={}){
  const types=catalogStatusTypes(),busy=catalogLoading(types),error=catalogFailure(types);
  const remote=['live','movies','series'].includes(view)&&!query&&catalogPager.choices(view,category).length>0,preparing=preparingCatalog(types);
  const wrap=$('#load-more-wrap'),sentinel=$('#catalog-load-sentinel'),retry=$('#catalog-load-retry');
  wrap.hidden=!(more||busy||error||remote||preparing);sentinel.hidden=!(more||remote&&!error);retry.hidden=busy||!(error||remote);retry.firstChild.textContent=error?'Tentar novamente':view==='live'?'Ver mais canais':'Ver mais títulos';
  const completions=types.map(type=>catalogPager.progressFor(type)).filter(progress=>progress?.status==='loading');
  const progress=completions.reduce((sum,value)=>({done:sum.done+value.categoriesComplete,total:sum.total+value.categoriesTotal}),{done:0,total:0});
  $('#page-progress').textContent=error&&!busy?`Carregamento parcial: ${error}`:busy?`Carregando mais títulos${progress.total?` · ${formatNumber(progress.done)} de ${formatNumber(progress.total)} categorias concluídas`:''}`:preparing?query?'Mais títulos estão chegando. A busca continua nos títulos disponíveis.':'Catálogo sendo preparado. Explore os títulos disponíveis.':`${formatNumber(shown)} de ${formatNumber(items.length)} ${query?'resultados':view==='favorites'?'favoritos':view==='live'?'canais':'títulos'}`;
  scheduleAutomaticReveal();
}
function scheduleAutomaticReveal(event){
  if(event?.type==='scroll')automaticProviderDemand=1;
  if(automaticRevealFrame!==null)return;
  automaticRevealFrame=requestAnimationFrame(()=>{
    automaticRevealFrame=null;
    const sentinel=$('#catalog-load-sentinel');
    if(!session?.connected||contentPageOpen()||settingsTools.isOpen||sentinel.hidden||$('#load-more-wrap').hidden)return;
    if(sentinel.getBoundingClientRect().top>window.innerHeight+800)return;
    const items=matchedItems(),more=items.length>visibleLimit;
    if(more){visibleLimit+=48;render();}
    else if(query&&remoteSearch.state.data?.hasMore&&!remoteSearch.state.error)void remoteSearch.more();
    else if(['live','movies','series'].includes(view)&&!query&&!catalogPager.pendingFor(view,category)&&!catalogPager.errorFor(view,category)){
      const preparing=isPreparingCatalog(catalogs.get(view),{cloudReady:centralCatalogReady()});
      if(preparing&&!automaticProviderDemand)return;
      if(preparing)automaticProviderDemand=0;
      void catalogPager.load(view,category);
    }
  });
}
async function retryCatalogCompletion(){
  if(query){void refreshCatalogSearch();return;}
  const types=catalogStatusTypes();
  for(const type of types){
    if(!query&&catalogs.has(type)&&!failures.has(type)&&catalogPager.choices(type,category).length){void catalogPager.load(type,category);continue;}
    void completeCatalogs([type],{retryBase:true});
  }
}

function cloudPreferences(){
  const {groups,...catalog}=settingsTools.getPreferences();
  return {'catalog-settings':catalog,'series-playback':seriesPlaybackPreferences.getPreferences(),audio:audioController.getPreferences(),'channel-volume':channelVolumeMemory.getPreferences(),player:{autoQuality:playerTools.autoQuality,profiles:{...playerTools.profiles}},sort:{...sortModes}};
}
function applyCloudPreferences(values){
  if(values['catalog-settings'])settingsTools.applyPreferences(values['catalog-settings']);
  if(values['series-playback'])seriesPlaybackPreferences.setPreferences(values['series-playback']);
  if(values.audio)audioController.setPreferences(values.audio);
  if(values['channel-volume'])channelVolumeMemory.setPreferences(values['channel-volume']);
  if(values.player){if(typeof values.player.autoQuality==='boolean')playerTools.setAutoQuality(values.player.autoQuality,null,{restore:true});for(const type of ['live','vod'])if(values.player.profiles?.[type])playerTools.setProfile(type,values.player.profiles[type],{restore:true});}
  if(values.sort){for(const type of ['movies','series','favorites']){sortModes[type]=normalizeSortMode(values.sort[type]);const feature=catalogFeatures.get(type);if(feature)feature.browse.sort=sortModes[type];}save('arkehn.sortModes.v1',sortModes);}
  genreCache=null;
}
function cloudLibraryUpdated(snapshot,changes={initial:true,favorites:[],progress:[],preferences:[],collections:[]}){
  if(!session?.connected)return;
  tv.onLibraryChange(snapshot,changes);filmes.onLibraryChange(snapshot,changes);series.onLibraryChange(snapshot,changes);inicio.onLibraryChange(snapshot,changes);
  homeTVRealtime?.sync();
  if(changes.initial||changes.progress.includes('live')||changes.preferences.includes('catalog-settings'))invalidateHomeTV();
  purgeRememberedHistory();
  if(changes.initial||changes.progress.length){const active=new Set((snapshot.history||[]).map(entry=>itemKey(entry.item)));homeHistoryExcluded.clear();for(const row of snapshot.progressRecords||[])if(row.deleted_at&&!active.has(row.item_key))homeHistoryExcluded.add(row.item_key);}
  const markerScope=snapshot?.ready?`${connectionGeneration}:${session?.account?.libraryId||''}:${snapshot.userId}`:null;
  if(markerScope&&markerScope!==cloudMarkersScope){cloudMarkersScope=markerScope;episodeMarkerReader?.reset();immersivePlayer?.episodeSkip?.refreshExternalMarkers?.();}
  if(changes.initial||changes.favorites.some(kind=>['movie','series'].includes(kind))||changes.progress.some(kind=>['movie','series'].includes(kind)))homeLibraryRevision++;
  if(changes.initial||changes.favorites.includes('movie')||changes.progress.includes('movie'))movieLibraryRevision++;
  const catalogPreferences=changes.preferences.includes('catalog-settings')||changes.preferences.includes('sort');
  if(changes.initial||changes.favorites.length||changes.progress.length||catalogPreferences)ensureHomeProjection();
  if(catalogPreferences){genreCache=null;for(const feature of catalogFeatures.values())feature.genreIndex=null;if(query){if(settingsTools.isOpen)remoteSearch.reset();else if(catalogWorkActive())void searchCatalogQuery(query,{type:remoteSearch.state.type,immediate:true});}}
  if(changes.initial||changes.favorites.length){
    refreshDetailFavorite();refreshPlayerFavorite();
    for(const element of document.querySelectorAll('.card-favorite')){const key=element.dataset.favoriteKey,[kind,id]=key.split(':');if(!changes.initial&&!changes.favorites.includes(kind))continue;const item=favorites.get(key)||snapshot.favoriteRecords?.find(row=>row.item_key===key)?.item||catalogs.get(typeFor(kind))?.itemMap.get(id);if(item)updateFavoriteButton(element,item);}
  }
  const relevant=changes.initial||view==='home'&&Boolean(changes.favorites.length||changes.progress.length||catalogPreferences)||view==='favorites'&&Boolean(changes.favorites.length||catalogPreferences||changes.collections.length)||catalogFeatures.get(view)?.libraryAffectsBrowse(changes)||query&&Boolean(changes.favorites.length||catalogPreferences);
  if(relevant&&!contentPageOpen()&&!settingsTools.isOpen)scheduleCatalogRender(view);
  else if((changes.initial||catalogPreferences)&&!$('#detail-dialog').hidden&&detailData&&!$('#detail-content').contains(document.activeElement))renderDetails();
  if(changes.initial||changes.favorites.includes('live')||catalogPreferences)immersivePlayer?.setChannels(getChannels());
  if(changes.initial||changes.favorites.length)void catalogPager.hydrateRemembered(favorites,history).catch(()=>{});
}
const playerTools=new PlayerTools({video,api,toast,connectionGeneration:()=>connectionGeneration,isTVNavigationPending:()=>Boolean(channelSwitch?.isPending()||homePlaybackOpening>0),switchChannel:(item,options)=>openPlayer(item,null,options),onPreferencesChange:()=>{if(cloudBridge)void cloudBridge.preferenceChanged('player',{autoQuality:playerTools.autoQuality,profiles:{...playerTools.profiles}});}});
parentalControl=new ParentalControlUI({api,getGeneration:()=>connectionGeneration,onChange:async({unlocked}={})=>{
  favoriteTVGuide?.reset();
  homeChannelPrograms?.reset();void homeChannels?.reset().catch(()=>{});homeTVModel?.reset();tvWatchHeartbeat?.reset();
  tv.reset();
  entryPreparationController?.abort();entryPreparationController=null;
  const retainAdult=unlocked&&category===ADULT_CATEGORY;
  clearTimeout(dailyCatalogTimer);dailyCatalogTimer=null;dailyCatalogWork=null;dailyCatalogAttempts.clear();catalogCacheRecords.clear();
  if(!unlocked&&session?.cloud)void catalogCache.clearAdult({project:session.cloud.url,providerKey:session.cloud.providerKey,scopeHash:session.cloud.scopeHash});
  cancelSearchWork();remoteSearch.reset();inicio.reset({stopAnimations:false});pageRouteRequest++;playOpenRequest++;const stopping=stopPlayback();closeContentPages();
  catalogRepository.reset();for(const feature of catalogFeatures.values())feature.reset();
  catalogPager.reset();catalogs.clear();pendingCatalogs.clear();detailsCache.clear();loading.clear();failures.clear();heroItem=null;heroRequest++;genreCache=null;selectedGenre='__all';category=retainAdult?ADULT_CATEGORY:'__all';categoryDefaultPending=!retainAdult;visibleLimit=48;
  ensureHomeProjection();if(query)void searchCatalogQuery(query,{immediate:true});render();await stopping;await Promise.allSettled(['live','movies','series'].map(type=>loadCatalog(type)));immersivePlayer?.setChannels(getChannels());
}});
const settingsTools=new SettingsTools({api,toast,getSession:()=>session,getCloudStatus:()=>cloudStatus,getCatalogs:()=>catalogs,loadCatalog:type=>loadCatalog(type),getFavorites:()=>favorites,resolveFavoriteItem:item=>{const resolved=currentStoredItem(item);return resolved&&isItemVisible(resolved)?resolved:null;},playerTools,audioController,seriesPlaybackPreferences,mediaLibrary,parentalControl,onStore:()=>cloudBridge?.settingsChanged(),onLibraryChange:()=>{void cloudBridge?.syncLocal();},onLogout:()=>logout(),onRefresh:()=>{settingsTools.close();refreshCatalog();},onOpen:()=>{pauseHomeChannels('settings');cancelSearchWork();dailyGames?.stop();$('#account-dialog').close();closeContentPages();favoriteTVGuide?.pause();$('#open-settings').setAttribute('aria-current','page');queueMicrotask(()=>shelfCarousels?.sync());},onClose:()=>{$('#open-settings').removeAttribute('aria-current');if(query&&remoteSearch.state.phase==='idle')void searchCatalogQuery(query,{type:remoteSearch.state.type,immediate:true});render();},onChange:()=>{pauseHomeChannels('preferences');if(view!=='favorites'||!['live','movie','series'].includes(category))category='__all';categoryDefaultPending=true;selectedGenre='__all';genreCache=null;visibleLimit=48;heroItem=null;entryPreparationController?.abort();entryPreparationController=null;inicio.invalidate();ensureHomeProjection();if(query)remoteSearch.reset();render();immersivePlayer?.setChannels(getChannels());}});
tv.configure({cloudLibrary,getSession:()=>session,repository:catalogRepository,getCatalog:type=>catalogs.get(type),loadCatalog,
  getLocalFavorites:()=>favorites,onLocalChange:({item})=>refreshFavoritePresentation(item),isVisible:isItemVisible,
  isCategoryAllowed:(type,id)=>settingsTools.isCategoryVisible(type,id),getNumber:(id,fallback)=>settingsTools.getChannelNumber(id,fallback),
  getVisibleChannels:()=>settingsTools.getNumberedChannels({favoritesOnly:true,fallbackToAll:true}),volumeMemory:channelVolumeMemory,audioProcessing});
homeTVModel=new HomeTVModel({request:api,getScope:()=>session?.connected?privateProjectionScope():null,isAvailable:centralCatalogReady,
  getRevision:()=>catalogs.get('live')?.pagination?.snapshotId||'',isActive:homeTVActive,
  onChange:()=>{if(homeTVActive())scheduleCatalogRender('home');}});
homeTVRealtime=new HomeTVRealtime({getCloud:()=>cloudLibrary,onChange:invalidateHomeTV});
homeChannels=new HomeChannelShelf({getScope:homePlaybackScope,isActive:homeTVActive,isVisible:isAutomaticItemVisible,
  createLogo:createFavoriteChannelLogo,createFavorite:makeFavorite,refreshFavorite:updateFavoriteButton,
  onWatch:(item,{stopped,fullscreen})=>openPlayer(item,null,{beforePlayback:stopped,fullscreen}),onMore:()=>setView('live'),onRetry:async()=>{if(!centralCatalogReady())await cloudBridge?.recover();return homeTVModel.ensure({force:true});}});
homeChannelPrograms=new HomeChannelPrograms({guide:tvGuide,getScope:homePlaybackScope,isActive:homeTVActive,
  getItems:()=>homeChannels.getItems(),onUpdate:(programs,state)=>homeChannels.updatePrograms(programs,state)});
tvWatchHeartbeat=new TVWatchHeartbeat({video,getPlayer:()=>player,request:api,
  getScope:()=>session?.connected&&centralCatalogReady()?privateProjectionScope():null,
  isAllowed:item=>mayRemember(item)&&isAutomaticItemVisible(item)&&!continuityFlow?.isDraining(),onUpdate:invalidateHomeTV});
const inicio=new HomeOrchestrator({request:api,model:homeCloudModel,getScope:privateProjectionScope,
  getState:()=>({catalogs,favorites,history,excludedHistory:homeHistoryExcluded,libraryRevision:homeLibraryRevision,loading,failures,
    customGroups:settingsTools.getCustomGroups(),account:session?.account?.libraryId,settingsOpen:settingsTools.isOpen,contentOpen:contentPageOpen()}),
  ensureArtwork:()=>libraryArtwork.ensure(),renderHero:updateHero,isAvailable:centralCatalogReady,recover:()=>cloudBridge?.recover(),
  ui:{node,shelf,skeletons,emptyState,reconcileChildren,isVisible:isAutomaticItemVisible,resolveItem:currentStoredItem,
    renderChannels:existing=>{homeTVRealtime.sync();homeTVModel.ensure();return homeChannels.render(existing,homeTVModel.state.data||{},homeTVModel.state);},
    syncChannels:syncHomeChannels,
    hideCategoryBar:()=>{$('#category-bar').hidden=true;},clearResultCount:()=>{$('#result-count').textContent='';},
    catalogHiddenBySettings,openCatalogSettings:type=>settingsTools.open('catalog',type),refreshCatalog,renderPage:render}});
favoriteTVGuide=new FavoriteTVGuide({guide:tvGuide,getChannelNumber:item=>settingsTools.getChannelNumber(item.id,null),
  getScope:()=>`${connectionGeneration}:${session?.account?.libraryId||''}:${parentalControl?.unlocked===true}`,
  isActive:favoriteTVGuideActive,createLogo:createFavoriteChannelLogo,makeFavorite,updateFavoriteButton,onPlay:item=>openPlayer(item)});
const myList=new MyListOrchestrator({services:new MyListServices({getSelection:()=>librarySelection(),resolveItem:currentStoredItem,isVisible:isItemVisible}),
  getLimit:()=>visibleLimit,ensureArtwork:()=>libraryArtwork.ensure(),ui:{node,formatNumber,renderCards,renderLive:(container,items)=>favoriteTVGuide.render(container,items),reconcileChildren,renderCatalogStatus}});
const catalogContent=new CatalogContentView({features:catalogFeatures,pager:catalogPager,getGames:()=>dailyGames,
  isUnlocked:()=>parentalControl?.unlocked===true,isForeground:()=>!contentPageOpen()&&!settingsTools.isOpen&&!document.hidden,
  isHidden:catalogHiddenBySettings,onCategory:chooseCatalogCategory,onSettings:type=>settingsTools.open('catalog',type),onLoad:loadCatalog,onRender:render,
  ui:{node,formatNumber,sidebar:catalogSidebar,renderCards,skeletons,emptyState,reconcileChildren,genreStrip:renderGenreStrip,
    clearResultCount:()=>{$('#result-count').textContent='';}}});
const shell=new SystemShell({getSession:()=>session,settings:settingsTools,onNavigate:setView,
  onSearch:term=>{cancelSearchWork();applySearchTerm(term);settingsTools.close();void searchCatalogQuery(term);syncSearchControl();render();},
  onClearSearch:()=>{cancelSearchWork();applySearchTerm('');shell.setSearchValue('');syncSearchControl();render();},
  accountMenuOptions:{trigger:$('#account-button'),onProfile:()=>settingsTools.open('profile'),onSettings:()=>settingsTools.open(),
    onRefresh:()=>{settingsTools.close();refreshCatalog();},onLogout:()=>logout()}});
const accountMenu=shell.accountMenu;
cloudBridge=new CloudAppBridge({cloud:cloudLibrary,getSession:()=>session,refreshSession:async({forceCloud=false}={})=>{const generation=connectionGeneration,account=session?.account?.libraryId;const refreshed=await api('/api/session'+(forceCloud?'?cloud=refresh':''));if(generation===connectionGeneration&&account&&refreshed.connected&&refreshed.account?.libraryId===account){session=refreshed;ensureHomeProjection();return refreshed;}return null;},getGeneration:()=>connectionGeneration,favoritesMap:favorites,historyMap:history,episodeProgress,localLibrary:mediaLibrary,getPreferences:cloudPreferences,applyPreferences:applyCloudPreferences,getCollections:()=>settingsTools.getCustomGroups(),applyCollections:groups=>settingsTools.setCustomGroups(groups),
  defaultPreferences:{'catalog-settings':{hidden:{live:[],movies:[],series:[]},hiddenItems:{live:[],movies:[],series:[]},channelNumbers:{},startupView:'home'},'series-playback':{...SERIES_PLAYBACK_DEFAULTS},audio:{mode:'original',rememberChannelVolume:true},'channel-volume':{enabled:true,lastUserVolume:1,volumes:[]},player:{autoQuality:true,profiles:{live:'balanced',vod:'balanced'}},sort:{movies:'date',series:'date',favorites:'date'}},onUpdate:cloudLibraryUpdated});
filmes.configure({request:api,getScope:()=>session?.connected?privateProjectionScope():null,getSession:()=>session,cloudLibrary,
  recommendationsModel:movieRecommendationsModel,getLocalFavorites:()=>favorites,getLocalHistory:()=>history,
  isVisible:isItemVisible,canRemember:mayRemember,
  onLocalFavoriteChange:({item})=>refreshFavoritePresentation(item),
  onLocalProgressChange:entry=>{homeHistoryExcluded.delete(itemKey(entry.item));persistHistory(entry.item.kind);},
  saveFavorite:(item,active)=>cloudBridge.favoriteChanged(item,active),
  saveProgress:(entry,options)=>cloudBridge.progressChanged(entry,options)});
series.configure({request:api,getScope:()=>session?.connected?privateProjectionScope():null,getSession:()=>session,cloudLibrary,
  getQueryClient:()=>remoteSearch.client,search:remoteSearch,
  isVisible:isItemVisible,canRemember:mayRemember,
  onCatalogRevision:()=>{genreCache=null;}});
seriesPlaybackPreferences.subscribe(value=>{void cloudBridge?.preferenceChanged('series-playback',value);});
episodeMarkerReader=new EpisodeOnDemandReader({request:api,getCloud:()=>cloudLibrary,getNamespace:()=>session?.account?.libraryId||`session_${connectionGeneration}`});
immersivePlayer=new ImmersivePlayer({video,managedErrors:true,programGuide:tvGuide,stage:$('.video-stage'),api,toast,getPlayer:()=>player,seriesPlaybackPreferences,getEpisodeMarkers:context=>episodeMarkerReader.lookup(context),getAccountNamespace:()=>session?.account?.libraryId||`session_${connectionGeneration}`,onSeek:(target,options)=>{resumePrompt.dismiss();return vodSeek.request(target,options);},onVolumeChange:value=>{channelVolumeMemory.remember(value);void cloudBridge?.preferenceChanged('channel-volume',channelVolumeMemory.getPreferences());},getSourceNamespace:()=>`${session?.account?.provider || 'xtream'}:${session?.account?.usernameMasked || ''}`,getProgramNamespace:()=>`${connectionGeneration}:${session?.account?.provider || 'xtream'}:${session?.account?.usernameMasked || ''}`,getChannels,onSwitchChannel:(item,{origin}={})=>origin==='preview'?channelSwitch.select(item):openPlayer(item),onClose:backFromContentPage,onNextEpisode:advanceEpisode,onRetry:retryPlayback});
const channelSwitchView=new ChannelSwitchView();immersivePlayer.root.append(channelSwitchView.root);
continuityFlow=new LiveContinuityFlow({host:videoHost,audio:audioProcessing,getCurrent:()=>player,getHls:()=>hls,
  getTransport:(_item,{signal,video})=>resolvePlayerTransport({video,signal}),registerTransportStop,
  getScope:()=>tvScopeKey(tv.getScope()),stopRemote:async()=>{const result=await requestPlaybackStop();if(!result.connected)throw new Error('PLAYBACK_SESSION_ENDED');},
  makeAttempt:createLiveAttempt,playbackURL:(item,options)=>tv.playbackURL(item,options),getConfig:()=>playerTools.configFor('live'),
  readFailure:async(item,{attempt,signal})=>{const params=new URLSearchParams({kind:'live',id:String(item.id),attempt});const status=await api('/api/playback/status?'+params,{signal:AbortSignal.any([signal,AbortSignal.timeout(1500)])});return status.failure===null?null:status.failure;},
  suspendRecovery:()=>playerTools.reset(),onBufferEmpty:()=>{if(!channelSwitch?.isPending())return;channelSwitchView.update({phase:'buffering'});$('#player-status').textContent='Aguardando o canal escolhido · último quadro disponível';}
});
channelSwitch=new ChannelSwitchController({
  view:channelSwitchView,service:new ChannelSwitchService({preparePlayback:(item,options)=>tv.preparePlayback(item,options)}),
  getScope:()=>tvScopeKey(tv.getScope()),getCurrent:()=>player,
  getContext:item=>({item,channelNumber:settingsTools.getChannelNumber(item.id,null),program:tvGuide.peek(item.id)?.window.current||null}),
  isAllowed:item=>Boolean(session?.connected&&item?.kind==='live'&&isItemVisible(item)&&getChannels().some(entry=>String(entry.item.id)===String(item.id))),
  subscribeProgram:(callback,item)=>tvGuide.subscribe(callback,{immediate:false,ids:[String(item.id)]}),
  primeMedia:()=>{playerTransportRequest++;continuityFlow.prime();},prepareMedia:(item,ticket)=>continuityFlow.prepare(item,ticket),
  onRelease:ticket=>continuityFlow.cancel(ticket),commit:(item,options)=>openPlayer(item,null,options),
  onActivity:active=>{if(active)playerTools.tvQuality?.cancel();immersivePlayer.setChannelSwitchActive(active);},
  onFailure:(error,{item,phase}={})=>{
    if(phase==='connecting'&&player&&continuityFlow.isDraining()){player.pendingChannelItem=item;videoHost.holdFrame();playbackFailure('O canal escolhido não carregou. Tente novamente ou selecione outro canal.');}
    else toast(error?.code==='PLAYER_ENGINE_UNAVAILABLE'?error.message:error?.status===429?'O provedor limitou a preparação deste canal. Tente novamente mais tarde.':'Não foi possível preparar o canal escolhido. Tente novamente.');
  }
});
video.addEventListener('playing',()=>{if(player?.mediaReady&&player.item.kind!=='live'&&!video.paused&&video.readyState>=2)channelSwitch?.markPlaying(player);});
for(const event of ['loadeddata','canplay'])video.addEventListener(event,()=>{
  if(player?.mediaReady&&video.readyState>=2&&immersivePlayer.current?.awaitingPlay)channelSwitch?.markReady(player);
});
immersivePlayer.root.append(resumePrompt.root);
const playerToolsPanel=node('div','player-page-tools');playerToolsPanel.append($('.player-controls'),$('#player-telemetry'));immersivePlayer.setTools(playerToolsPanel);
$('#player-favorite').classList.add('ip-button');$('.ip-controls-row').insertBefore($('#player-favorite'),immersivePlayer.settingsButton);
channelGuide=tv.createCardGuide({connectionGeneration:()=>connectionGeneration});
liveProgramFeed=tv.createProgramFeed({onUpdate:updateProgram,getNamespace:()=>String(connectionGeneration)});
dailyGames=tv.createGames({supportsGames:()=>session?.capabilities?.games===true,getNamespace:()=>`${connectionGeneration}:${session?.account?.provider||'xtream'}:${session?.account?.usernameMasked||''}`,getChannels:()=>visibleCatalog('live')?.items||[],onWatch:item=>openPlayer(item)});
heroRotation=inicio.createHeroRotation({getItems:()=>featured,getCurrent:()=>heroItem,select:setHero,isVisible:()=>Boolean(session?.connected&&view==='home'&&!query&&!document.hidden&&!contentPageOpen()&&!settingsTools.isOpen&&!$('#hero').hidden),interval:5000});
shelfCarousels=inicio.createCarousels({isActive:()=>Boolean(session?.connected&&view==='home'&&!query&&!document.hidden&&!contentPageOpen()&&!settingsTools.isOpen&&!$('#application').hidden&&!$('#main-content').hidden&&!document.body.classList.contains('session-preparing')&&!document.querySelector('dialog[open]'))});
const heroPauseReasons=new Set();
for(const target of [$('#hero-watch'),$('#hero-details'),$('#hero-picker')]){
  const pause=(reason,active)=>{active?heroPauseReasons.add(reason):heroPauseReasons.delete(reason);heroRotation.setPaused(heroPauseReasons.size>0);};
  target.addEventListener('pointerenter',()=>pause(target.id+':pointer',true));target.addEventListener('pointerleave',()=>pause(target.id+':pointer',false));
  target.addEventListener('focusin',()=>pause(target.id+':focus',true));target.addEventListener('focusout',()=>queueMicrotask(()=>pause(target.id+':focus',target.contains(document.activeElement))));
}
document.addEventListener('visibilitychange',()=>{if(!catalogWorkActive())pauseCatalogWork();else resumeCatalogWork();libraryArtwork.ensure();if(!document.hidden)retryArtworkImages(document);if(homeTVActive()){homeTVModel?.ensure();syncHomeChannels();}else pauseHomeChannels('hidden');heroRotation.sync();shelfCarousels.sync();if(favoriteTVGuideActive())favoriteTVGuide?.resume();else favoriteTVGuide?.pause();if(document.hidden){dailyGames.stop();filmes.suggestions?.pausePreview();}else{if(catalogWorkActive()){if(query&&remoteSearch.state.phase==='idle')void searchCatalogQuery(query,{type:remoteSearch.state.type,immediate:true});void tv.channels?.resume()?.catch(()=>{});}else if(!player&&!homePlaybackOpening&&!$('#detail-dialog').hidden&&detailItem?.kind==='movie')filmes.suggestions?.previewFor(detailItem);if(session?.connected&&view==='live'&&category===DAILY_GAMES_CATEGORY&&!query&&!contentPageOpen()&&!settingsTools.isOpen)void dailyGames.start();}});
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('close',()=>shelfCarousels.sync());

mountIcons();
const login=new LoginOrchestrator({root:$('#connection-screen'),startup:$('#startup'),request:api,
  beginConnection:resetConnectionData,getGeneration:()=>connectionGeneration,onSession:value=>{session=value;},onConnected:enterApplication,
  beforeShow:()=>{shelfCarousels?.sync(null);document.body.classList.add('login-active');closeContentPages();shell.closeTransient();
    $('#account-dialog').close();$('#diagnostics-dialog').close();$('#startup').hidden=true;$('#application').hidden=true;}});
const sessionLoader=login.loader;
function openSearch(){shell.openSearch();}
function applySearchTerm(term){if(!query)captureCatalogFeature();query=term;category='__all';visibleLimit=48;selectedGenre='__all';if(!query)restoreCatalogFeature(view);}
$('#catalog-load-retry').addEventListener('click',retryCatalogCompletion);
window.addEventListener('scroll',scheduleAutomaticReveal,{passive:true});
window.addEventListener('resize',scheduleAutomaticReveal,{passive:true});
window.addEventListener('focus',()=>{void checkVisibleSession().then(connected=>{if(connected)void refreshDailyCatalogs();});});
window.addEventListener('online',()=>{void checkVisibleSession().then(connected=>{if(connected)void refreshDailyCatalogs();});});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void checkVisibleSession();});
if('IntersectionObserver' in window)new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))scheduleAutomaticReveal();},{rootMargin:'800px'}).observe($('#catalog-load-sentinel'));
$('#hero-watch').addEventListener('click',()=>{if(heroItem)openDetails(heroItem);});$('#hero-details').addEventListener('click',()=>{if(heroItem)openDetails(heroItem);});
$('#catalog-refresh-close').addEventListener('click',()=>{$('#catalog-refresh').hidden=true;});
$('#refresh-catalog').addEventListener('click',refreshCatalog);
async function logout(){pauseHomeChannels('logout');void homeTVRealtime?.reset();accountMenu.close(false);closeContentPages();const previous=connectionGeneration;await cloudBridge?.stop({flush:true});if(previous!==connectionGeneration)return;window.history.replaceState(null,'','#home');catalogReturn=null;contentReturnFocus=null;const generation=resetConnectionData();try{await api('/api/logout',{method:'POST',body:'{}'});if(generation!==connectionGeneration)return;session=null;showConnection();}catch(error){if(generation!==connectionGeneration)return;render();void loadCatalog('live');void completeCatalogs();toast(error.message);}}
$('#change-connection').addEventListener('click',logout);
for(const dialog of document.querySelectorAll('dialog')){dialog.querySelector('[data-close]')?.addEventListener('click',()=>dialog.close());dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();});}
$('#detail-back').addEventListener('click',backFromContentPage);$('#player-back').addEventListener('click',backFromContentPage);$('#detail-start').addEventListener('click',()=>setView('home'));$('#detail-home').addEventListener('click',event=>{event.preventDefault();setView('home');});
window.addEventListener('popstate',handleContentRouteChange);window.addEventListener('hashchange',handleContentRouteChange);
$('#player-retry').addEventListener('click',retryPlayback);
$('#player-favorite').addEventListener('click',()=>{if(player)toggleFavorite(player.item);});$('#player-next').addEventListener('click',()=>advanceEpisode());$('#player-fullscreen').addEventListener('click',()=>immersivePlayer.toggleFullscreen());
for(const event of ['pointerdown','keydown'])document.addEventListener(event,input=>{if(player&&input.isTrusted!==false)void audioProcessing.requestActivation();},{capture:true,passive:true});
function onActiveVideoPlaying(){if(!player||continuityFlow?.isDraining()||playerTools.current?.failed||player.item.kind==='live'&&(!tvHasPlayableVideo(video)||video.seeking))return;if(player.item.kind==='live'&&player.mediaReady)channelSwitch?.markPlaying(player);void tvWatchHeartbeat?.confirmPlaying();if(player.item.kind==='live')tv.audio.playing();else if(player.item.kind==='movie')movieAudio.playing();else if(player.item.kind==='series')seriesAudio.playing();saveLiveWatch();$('#player-loading').hidden=true;$('#player-status').textContent=player.item.kind==='live'?'Ao vivo · Reprodução em andamento':'Reprodução em andamento';}
video.addEventListener('playing',()=>{if(player?.item.kind!=='live')onActiveVideoPlaying();});
observeTVPlaybackReadiness({video,getOwner:()=>player?.item.kind==='live'&&!playerTools.current?.failed&&!continuityFlow?.isDraining()?player:null,onReady:onActiveVideoPlaying});
video.addEventListener('waiting',()=>{if(player)$('#player-status').textContent='Carregando vídeo…';});video.addEventListener('pause',()=>{if(player&&!video.ended&&(player.nativeSourceStarted||hls)){$('#player-status').textContent='Pausado';saveProgress(true);}});video.addEventListener('timeupdate',()=>saveProgress());video.addEventListener('ended',()=>{if(player){if(!showCompletedMovieSuggestions())saveProgress(true);$('#player-status').textContent=player.next?'Episódio concluído. O próximo está pronto para você.':'Sua sessão chegou ao fim.';}});video.addEventListener('error',async()=>{
  if(continuityFlow?.isDraining())return;
  if(!player||hls||!player.nativeSourceStarted)return;
  // load() clears MediaError. A queued event from the retired native source
  // must not detach or reopen the replacement now using this same element.
  if(!video.error)return;
  const active=player,serial=playbackSerial;
  // Detach immediately: Safari may otherwise keep probing MP4 ranges after
  // reporting a terminal error and turn a provider cooldown into a request loop.
  detachNativeMedia();let failure=null;
  try{const params=new URLSearchParams({kind:active.item.kind,id:String(active.episode?.id||active.item.id),attempt:active.attempt});failure=(await api('/api/playback/status?'+params,{signal:AbortSignal.timeout(1500)})).failure;}catch{}
  if(player!==active||serial!==playbackSerial||continuityFlow?.isDraining())return;
  if(failure?.status===429&&failure.retryAfterSeconds>0){active.retryAfterUntil=Date.now()+failure.retryAfterSeconds*1000;if(playerTools.current)playerTools.current.rateLimitedUntil=active.retryAfterUntil;playbackFailure(`O provedor limitou esta transmissão. Aguarde ${failure.retryAfterSeconds} segundos antes de tentar novamente.`);return;}
  if([401,403].includes(failure?.status)){playbackFailure('Sua conexão precisa ser restabelecida. Entre novamente para assistir.');return;}
  const message=localPlaybackMessage(failure?.code);
  if(message){playbackFailure(message);return;}
  if(playerTools.trySourceFallback?.('source-error',{status:failure?.status,code:failure?.code}))return;
  if(active.usingNativeHLS&&!active.playOptions.hlsFallback&&window.Hls?.isSupported()){
    const {item,episode,playOptions}=active;openPlayer(item,episode,{...playOptions,...playerTools.getQualitySelection(),...playbackContinuationOptions(),preferHls:true,preferNative:false,hlsFallback:true,nativeFallback:true,automatic:true,adaptiveState:playerTools.adaptiveState,errorEvents:playerTools.getErrorEvents()});return;
  }
  playbackFailure('Não foi possível reproduzir este vídeo. Tente novamente; o formato ou o canal pode estar indisponível no navegador.');
});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&!document.querySelector('dialog[open]')&&contentPageOpen()){
    event.preventDefault();if((document.fullscreenElement||document.webkitFullscreenElement)===$('.video-stage'))leaveNativeFullscreen();else backFromContentPage();return;
  }
  if(event.key==='/'&&!contentPageOpen()&&!['INPUT','TEXTAREA','VIDEO'].includes(document.activeElement.tagName)&&!document.querySelector('dialog[open]')&&session?.connected){event.preventDefault();openSearch();}
  if(event.key==='Escape'&&!document.querySelector('dialog[open]')&&(query||$('#search-input').value)){event.preventDefault();$('#close-search').click();}
});
window.addEventListener('pagehide',()=>{pauseHomeChannels('pagehide');favoriteTVGuide?.pause();stopPlayback();});
window.addEventListener('pageshow',event=>{if(event.persisted&&session?.connected)void checkVisibleSession().then(connected=>{if(connected){lastPageRouteKey=null;pageRouteRequest++;handleContentRouteChange();}});});
void login.restore();

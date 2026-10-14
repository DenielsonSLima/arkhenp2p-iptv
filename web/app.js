import { PlayerTools, findChannelVariants } from './player-tools.js';
import { SettingsTools } from './settings-tools.js';
import { AccountMenu } from './account-menu.js';
import { ImmersivePlayer } from './immersive-player.js';
import { ChannelGuide } from './channel-guide.js';
import { LiveProgramFeed, programWindow } from './program-guide.js';
import { LoginScreen } from './login-screen.js';
import { reconcileChildren, reconcileCards } from './catalog-renderer.js';
import { parseContentRoute, contentRoute, fallbackContentRoute, catalogView, restoreCatalogPosition } from './page-routes.js';
import { SessionLoader, preloadArtwork } from './session-loader.js';
import { PreviewTools } from './preview-tools.js';
import { renderMoviePreview, updateMovieDuration, movieWithPlaybackDuration } from './movie-preview.js';
import { renderSeriesPreview, allSeriesEpisodes as allEpisodes } from './series-preview.js';
import { createLiveView } from './live-view.js';
import { artworkURL, loadChannelLogos } from './channel-artwork.js';
import { featuredMovies, homeShelves, playbackProgress } from './home-sections.js';
import { setHeroArtwork, renderHeroFacts } from './home-hero.js';
import { CatalogPager, isPagedCatalog, pageChoices } from './catalog-pagination.js';
import { withoutSessionArtwork } from './stored-artwork.js';
import { MediaLibrary } from './media-library.js';

const $ = selector => document.querySelector(selector);
const icons = {
  user:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  settings:'<path d="m9 3-.7 2.1-2 .9-2-.5-2 3.5 1.4 1.6v2.3l-1.4 1.6 2 3.5 2-.5 2 .9L9 21h4l.7-2.1 2-.9 2 .5 2-3.5-1.4-1.6v-2.3l1.4-1.6-2-3.5-2 .5-2-.9L13 3z"/><circle cx="11" cy="12" r="3"/>',
  activity:'<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  play:'<path d="m9 5 10 7-10 7z" fill="currentColor" stroke="none"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  star:'<path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  eye:'<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-2L20 8M4 16l2.3 3A7 7 0 0 0 18 17"/>',
  expand:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  'chevron-down':'<path d="m6 9 6 6 6-6"/>',
  'chevron-left':'<path d="m15 6-6 6 6 6"/>',
  'chevron-right':'<path d="m9 6 6 6-6 6"/>',
  tv:'<rect x="3" y="5" width="18" height="13" rx="2"/><path d="M8 22h8M12 18v4"/>',
  bookmark:'<path d="M6 4h12v17l-6-4-6 4z"/>',
  film:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4m-4 8h4M17 8h4m-4 8h4"/>'
};
const SVG_NS = 'http://www.w3.org/2000/svg';
const iconTemplates = new Map();
function icon(name) {
  const key = Object.hasOwn(icons, name) ? name : 'info';
  if (!iconTemplates.has(key)) {
    // Every SVG fragment comes from the fixed, local icon table above.
    const parsed = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}" viewBox="0 0 24 24" aria-hidden="true">${icons[key]}</svg>`, 'image/svg+xml');
    iconTemplates.set(key, document.importNode(parsed.documentElement, true));
  }
  return iconTemplates.get(key).cloneNode(true);
}
function replaceIcon(element, name) {
  const graphic = icon(name);
  if (element.namespaceURI === SVG_NS && element.localName === 'svg') {
    element.setAttribute('viewBox', '0 0 24 24');
    element.setAttribute('aria-hidden', 'true');
    element.replaceChildren(...Array.from(graphic.childNodes));
  } else element.replaceChildren(graphic);
}
function mountIcons(root = document) {
  const targets = [...root.querySelectorAll('[data-icon]')];
  if (root.matches?.('[data-icon]')) targets.unshift(root);
  targets.forEach(element => replaceIcon(element, element.dataset.icon));
}
function node(tag, className = '', content) { const element = document.createElement(tag); if (className) element.className = className; if (content !== undefined) element.textContent = content; return element; }
function iconNode(name, className = '') { const element = node('span', className); element.replaceChildren(icon(name)); return element; }
function button(text, className, handler, name) { const element = node('button', className); element.type = 'button'; if (name) element.append(iconNode(name)); element.append(document.createTextNode(text)); if (handler) element.addEventListener('click', handler); return element; }
function normalize(text) { return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
function artwork(url){return artworkURL(url);}
function image(url,className='',lazy=true,fallback=''){
  const picture=node('img',className),source=artwork(url),remote=artwork(fallback);let fallbackTried=false;
  picture.alt='';picture.loading=lazy?'lazy':'eager';picture.decoding='async';picture.src=source;
  picture.addEventListener('load',()=>picture.parentElement?.classList.add('artwork-ready'));
  picture.addEventListener('error',()=>{
    if(!fallbackTried&&source.startsWith('/assets/channels/')&&remote.startsWith('/api/image?')&&remote!==source){fallbackTried=true;picture.src=remote;return;}
    picture.parentElement?.classList.remove('artwork-ready');
    picture.classList.add('image-failed');picture.style.display='none';
  });return picture;
}
function read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage is optional */ } }
function itemKey(item) { return `${item.kind}:${item.id}`; }
function snapshot(item) { return withoutSessionArtwork({id:String(item.id),name:String(item.name),kind:item.kind,poster:artwork(item.poster),...(item.kind==='live'?{posterOriginal:artwork(item.posterOriginal)}:{}),year:item.year || null,categoryId:item.categoryId || '',container:item.container || 'mp4',rating:item.rating || null,added:item.added ?? null,savedAt:item.savedAt ?? null}); }
const favorites = new Map(), history = new Map();
const mediaLibrary = new MediaLibrary({read,save,favorites,history});
const savedSortModes=read('arkehn.sortModes.v1',{}),sortModes=Object.fromEntries(['movies','series','favorites'].map(type=>[type,savedSortModes?.[type]==='name'?'name':'date']));
const titleCollator=new Intl.Collator('pt-BR',{sensitivity:'base',numeric:true});
const catalogs = new Map(), loading = new Set(), failures = new Map(), pendingCatalogs = new Map(), detailsCache = new Map();
let session = null, view = 'home', category = '__all', query = '', visibleLimit = 48, heroItem = null, featured = [], heroRequest = 0, detailRequest = 0, detailItem = null, detailData = null, activeSeason = 0, player = null, hls = null, toastTimer, queryTimer, progressLastSaved = 0, playbackSerial = 0, pendingStop = Promise.resolve(), playOpenRequest = 0, connectionGeneration = 0, refreshRequest = 0, immersivePlayer = null, channelGuide = null;
let pageRouteRequest=0,catalogReturn=null,contentReturnFocus=null,lastPageRouteKey=null,previewDurationController=null,previewDurationPending=false;
let heroDurationController=null;
let liveProgramFeed=null;
const video = $('#video');
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

async function api(path, options = {}) {
  const response = await fetch(path, {...options, headers:{'Content-Type':'application/json',...options.headers}});
  let body; try { body = await response.json(); } catch { throw new Error('O servidor não retornou uma resposta válida.'); }
  if (!response.ok) throw Object.assign(new Error(body.error || body.message || 'Não foi possível completar a conexão.'),{status:response.status,code:body.code});
  return body;
}
const catalogPager=new CatalogPager({request:api,getCatalog:type=>catalogs.get(type),onData:acceptCatalog,isCategoryAllowed:(type,id)=>settingsTools.isCategoryVisible(type,id),onChange:type=>{if(session?.connected&&catalogAffectsView(type))render();}});
function contentPageOpen(){return !$('#detail-dialog').hidden||!$('#player-dialog').hidden;}
function catalogPosition(){return {view,category,query,visibleLimit,scrollY:window.scrollY};}
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
  heroDurationController?.abort();heroDurationController=null;
  settingsTools.close(false);accountMenu.close(false);
  $('#application').hidden=true;$('#detail-dialog').hidden=page!=='preview';$('#player-dialog').hidden=page!=='watch';
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
  if(!restoreCatalog||!session?.connected)return;
  const position=restoreCatalogPosition(location.hash,window.history.state?.arkehnCatalog,catalogReturn);
  if(position&&Object.hasOwn(viewLabels,position.view)){view=position.view;category=position.category||'__all';query=position.query||'';visibleLimit=position.visibleLimit||48;$('#search-input').value=query;$('#search-panel').hidden=!query;}
  render();if(hadPage||position)window.scrollTo({top:position?.scrollY||0,behavior:'instant'});
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
    const data=await loadCatalog(typeFor(route.kind));
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
  }catch(error){if(request!==pageRouteRequest||generation!==connectionGeneration)return;window.history.replaceState({arkehnCatalog:catalogReturn},'','#home');closeContentPages(true);toast(error.message);}
}
function handleContentRouteChange(){
  if(document.body.classList.contains('session-preparing'))return;
  const key=location.hash+JSON.stringify(window.history.state);if(key===lastPageRouteKey)return;
  lastPageRouteKey=key;restoreContentRoute();
}
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3300); }
function categoryName(raw) { return String(raw || 'Outros').replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u2605\u2606\uFE0F\uFE0E\u200D\u20E3]/gu,'').replace(/^[\s›>»|•●○◆◇─═┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬-]+/,'').replace(/^(?:FILMES?|S[ÉE]RIES?|COLET[ÂA]NEA|CANAIS?)\s*[-|:›>]+\s*/i,'').replace(/\s{2,}/g,' ').trim() || 'Outros'; }
function prepareCatalog(data, type) {
  const categoryMap = new Map(), groups = new Map();
  for (const category of data.categories || []) {
    const name = categoryName(category.name), key = normalize(name);
    if (!groups.has(key)) groups.set(key, {id:key,name,ids:new Set(),count:0});
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
    if(item.kind==='live'){item.posterOriginal=item.poster;item.poster=artwork(channelLogos.resolve(item))||item.posterOriginal;}
    item.search = normalize(`${item.name} ${item.group}`); items.push(item); for(const matchedGroup of itemGroups)matchedGroup.count++;
  }
  return {items,categories:[...groups.values()].filter(group => group.count||isPagedCatalog(data)),sourceCategories:data.categories||[],pagination:data.pagination,itemMap:new Map(items.map(item => [item.id,item]))};
}
function acceptCatalog(type,response){const data=prepareCatalog(response,type);catalogs.set(type,data);mediaLibrary.migrate(data);return data;}
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
  heroDurationController?.abort();heroDurationController=null;
  connectionGeneration++;pageRouteRequest++;lastPageRouteKey=null;channelGuide?.reset();refreshRequest++;$('#catalog-refresh').hidden=true;$('#refresh-catalog').disabled=false;
  catalogPager.reset();catalogs.clear(); pendingCatalogs.clear(); detailsCache.clear(); loading.clear(); failures.clear();
  heroItem=null; featured=[]; detailItem=null; detailData=null; heroRequest++; detailRequest++; playOpenRequest++;
  return connectionGeneration;
}
async function loadCatalog(type, force = false) {
  if (!force && catalogs.has(type)) return catalogs.get(type);
  if (!force && pendingCatalogs.has(type)) return pendingCatalogs.get(type);
  const generation=connectionGeneration;
  if(force)catalogPager.reset(type);
  loading.add(type); failures.delete(type); if(!catalogs.has(type) && catalogAffectsView(type))render();
  const pending = (async () => {
    try {
      const [response]=await Promise.all([api(`/api/catalog?type=${type}${force?'&refresh=1':''}`),type==='live'?channelLogosReady:undefined]);
      if(generation!==connectionGeneration || pendingCatalogs.get(type)!==pending)return null;
      const data=acceptCatalog(type,response);if(type==='live')remapStoredChannelArtwork(data);return data;
    } catch (error) {
      if(generation===connectionGeneration && pendingCatalogs.get(type)===pending)failures.set(type,error.message);
      return null;
    } finally {
      if(generation===connectionGeneration && pendingCatalogs.get(type)===pending){
        loading.delete(type); pendingCatalogs.delete(type); if(session?.connected){if(catalogAffectsView(type))render();immersivePlayer?.setChannels(getChannels());}
      }
    }
  })();
  pendingCatalogs.set(type,pending); return pending;
}
function catalogAffectsView(type) { return Boolean(query) || ['home','favorites',type].includes(view); }
async function connect(body) {
  const generation=resetConnectionData();
  sessionLoader.start();
  loginScreen.setBusy(true);
  try {
    const connected=await api('/api/login',{method:'POST',body:JSON.stringify(body)});
    if(generation!==connectionGeneration)return;
    session=connected;if(!session.connected)throw new Error(session.error || 'A conexão ainda não está disponível.');
    loginScreen.clearPassword(); await enterApplication();
  } catch (error) { if(generation===connectionGeneration){sessionLoader.finish();$('#login-error').textContent=error.message;} }
  finally { loginScreen.setBusy(false); }
}
function showConnection(error = '') {
  sessionLoader.finish();
  document.body.classList.add('login-active');
  closeContentPages();accountMenu.close(false);$('#account-dialog').close();$('#diagnostics-dialog').close();settingsTools.close(false);
  $('#startup').hidden=true;$('#application').hidden=true;$('#connection-screen').hidden=false;$('#login-error').textContent=error;
  loginScreen.clearPassword();window.scrollTo({top:0,behavior:'instant'});loginScreen.focus();document.title='ARKHEN P2 IPTV · Seu universo em cena';
}
async function enterApplication() {
  const generation=connectionGeneration,signal=sessionLoader.controller?.signal||sessionLoader.start('Preparando seu catálogo');
  mediaLibrary.activate(session?.account?.provider||'xtream');
  sessionLoader.mark('auth');sessionLoader.text('Organizando seu catálogo');
  document.body.classList.remove('login-active');
  $('#connection-screen').hidden = true; $('#application').hidden = false; view=catalogView(location.hash)||settingsTools.getStartupView();category='__all';query='';visibleLimit=48; $('#search-input').value='';$('#search-panel').hidden=true;
  render();window.scrollTo({top:0,behavior:'instant'});
  await Promise.allSettled(['movies','series','live'].map(async type=>{
    sessionLoader.mark(type,'loading');const catalog=await loadCatalog(type);
    if(generation===connectionGeneration&&!signal.aborted)sessionLoader.mark(type,catalog?'done':'partial');
  }));
  if(generation!==connectionGeneration||signal.aborted)return;
  await catalogPager.hydrateRemembered(favorites,history);
  if(generation!==connectionGeneration||signal.aborted)return;
  sessionLoader.text('Preparando as primeiras capas');sessionLoader.mark('artwork','loading');
  const openingArtwork=[...document.querySelectorAll('#hero-art img')].map(picture=>picture.getAttribute('src'));
  if(view==='home'){
    for(const shelf of document.querySelectorAll('#catalog-content .poster-shelf,#catalog-content .live-shelf'))openingArtwork.push(...[...shelf.querySelectorAll('img')].map(picture=>picture.getAttribute('src')).filter(artwork).slice(0,6));
  }else openingArtwork.push(...[...document.querySelectorAll('#catalog-content img')].map(picture=>picture.getAttribute('src')).filter(artwork).slice(0,12));
  const artworkResult=await preloadArtwork(openingArtwork,{signal,onProgress:({completed,total})=>{if(generation===connectionGeneration&&!signal.aborted)sessionLoader.caption.textContent=`${completed} de ${total} capas verificadas`;} });
  if(generation!==connectionGeneration||signal.aborted)return;
  sessionLoader.mark('artwork',artworkResult.loaded<artworkResult.total?'partial':'done');sessionLoader.finish();settingsTools.restoreRoute();
  if(failures.size)toast('Alguns conteúdos ainda não responderam. Você pode atualizar o catálogo.');
  if(parseContentRoute(location.hash))handleContentRouteChange();
}
function setView(next) {
  pageRouteRequest++;closeContentPages();settingsTools.close();view = next; category='__all';visibleLimit=48; query=''; $('#search-input').value=''; $('#search-panel').hidden=true;
  window.history.replaceState(null,'','#'+next);catalogReturn=null;contentReturnFocus=null;
  lastPageRouteKey=location.hash+JSON.stringify(window.history.state);
  if (!['home','favorites'].includes(next)) loadCatalog(next); render(); window.scrollTo({top:0,behavior:'instant'});
}
function toggleFavorite(item) {
  const key = itemKey(item); favorites.has(key) ? favorites.delete(key) : favorites.set(key,snapshot({...item,savedAt:Date.now()})); mediaLibrary.saveFavorites();
  for(const element of document.querySelectorAll('.card-favorite'))if(element.dataset.favoriteKey===key)updateFavoriteButton(element,item);
  if(view==='favorites' || category==='__favorites')render();
  else if(['live','movies','series'].includes(view)&&!query)updateCategorySidebar($('#catalog-content .catalog-sidebar'),categoriesFor(matchedCategoryItems()));
  immersivePlayer?.setChannels(getChannels()); refreshDetailFavorite(); refreshPlayerFavorite(); toast(favorites.has(key) ? 'Adicionado à sua lista' : 'Removido da sua lista');
}
function updateFavoriteButton(element,item) {
  const selected=favorites.has(itemKey(item));element.classList.toggle('selected',selected);element.title=selected?'Remover dos favoritos':'Adicionar aos favoritos';
  element.setAttribute('aria-label',`${selected ? 'Remover dos' : 'Adicionar aos'} favoritos: ${item.name}`);element.setAttribute('aria-pressed',String(selected));
}
function makeFavorite(item, className = 'card-favorite') {
  const element=button('',className,() => toggleFavorite(item),'star');element.dataset.favoriteKey=itemKey(item);updateFavoriteButton(element,item);return element;
}
function cleanTitle(name) { return String(name || '').replace(/\s*\((?:19|20)\d{2}\)\s*$/,'').trim(); }
function displayYear(item) { const year = String(item.year || '').match(/(?:19|20)\d{2}/)?.[0] || String(item.name || '').match(/\(((?:19|20)\d{2})\)/)?.[1]; return year || ''; }
function metadataText(value) {
  const text = String(value ?? '').trim();
  if (!text || /^(?:0+(?:[.,]0+)?(?:\s*(?:min(?:utos?)?|mins?|h(?:oras?)?))?|(?:00?:){1,2}00?|null|undefined|n\/?a|none|-)$/i.test(text)) return '';
  return text;
}
function ratingNode(value) { const text = metadataText(value), number = Number(text.replace(',', '.')); if (!text || !Number.isFinite(number) || number <= 0) return null; const badge = node('span','rating'); badge.append(iconNode('star'),document.createTextNode(number.toFixed(1).replace('.',','))); return badge; }
function mediaCard(item) {
  if (item.kind === 'live') return channelCard(item);
  const card = node('article','media-card'), play = button('','poster-button',() => openDetails(item)); play.setAttribute('aria-label',`Ver ${item.name}`);
  const poster = node('div','poster'), placeholder = node('div','poster-placeholder'); const mark=node('img','tiny-brand');mark.src='/assets/brand/symbol.svg';mark.alt='';placeholder.append(mark,node('span','',cleanTitle(item.name))); poster.append(placeholder);
  if (artwork(item.poster)) poster.append(image(item.poster));
  const badge = node('span','poster-badge', item.kind === 'series' ? 'SÉRIE' : 'FILME'); poster.append(badge);
  const over = node('span','poster-play');over.append(iconNode('play'));poster.append(over);
  const previous=history.get(itemKey(item)),position=playbackProgress(previous),episode=position.episodeLabel;
  if(position.percent!==null&&previous.time>5){const progress=node('div','card-progress'),fill=node('span');progress.setAttribute('role','progressbar');progress.setAttribute('aria-label',`Progresso de ${item.name}${episode?' · '+episode:''}`);progress.setAttribute('aria-valuemin','0');progress.setAttribute('aria-valuemax','100');progress.setAttribute('aria-valuenow',String(Math.round(position.percent)));fill.style.width=`${position.percent}%`;progress.append(fill);poster.append(progress);}
  const copy=node('div','card-copy'), title=node('h3','',cleanTitle(item.name));title.title=item.name;copy.append(title);
  const meta=node('div','card-meta');const year=displayYear(item);if(year)meta.append(node('span','year',year));meta.append(node('span','',item.kind==='series'?'Série':'Filme'));if(episode){meta.append(node('span','resume-episode',episode));play.setAttribute('aria-label',`Ver ${item.name} · ${episode}`);}const rating=ratingNode(item.rating);if(rating)meta.append(rating);copy.append(meta);play.append(poster,copy);card.append(play,makeFavorite(item));return card;
}
function channelCard(item) {
  return liveView.createCard(item);
}
const liveView=createLiveView({node,button,artwork,image,makeFavorite,updateFavoriteButton,resolveLogo:item=>channelLogos.resolve(item),logoGeometry:file=>channelLogos.geometry?.(file),getGuide:()=>channelGuide,onWatch:item=>openPlayer(item)});
function renderCards(grid,items) {
  reconcileCards(grid,items,{key:itemKey,signature:item=>{const previous=history.get(itemKey(item));return JSON.stringify([item.name,item.poster,item.posterOriginal,item.year,item.rating,item.group,previous?.time,previous?.duration,previous?.episode?.id,previous?.episode?.season,previous?.episode?.number]);},create:mediaCard,mounted:(card,item)=>{if(item.kind==='live')liveView.mountCard(card,item);else updateFavoriteButton(card.querySelector('.card-favorite'),item);}});
  grid.style.animation='none';
}
function skeletons(count = 6) { const grid=node('div','poster-grid'); for(let index=0;index<count;index++){const card=node('div');card.append(node('div','skeleton skeleton-poster'),node('div','skeleton skeleton-line'),node('div','skeleton skeleton-line small'));grid.append(card);} return grid; }
function emptyState(title,copy,action) { const element=node('div','empty-state');element.append(iconNode(view==='live'?'tv':view==='favorites'?'bookmark':'film'),node('h2','',title),node('p','',copy));if(action)element.append(button(action.label,'button secondary',action.run,'refresh'));return element; }
function shelf(title,subtitle,items,type,existing) {
  if(existing){existing.querySelector('.shelf-header h2').textContent=title;renderCards(existing.querySelector('.poster-shelf,.live-shelf'),items);return existing;}
  const section=node('section','shelf'), header=node('div','shelf-header'), titles=node('div');if(subtitle)titles.append(node('span','eyebrow',subtitle));titles.append(node('h2','',title));
  const tools=node('div','shelf-tools'); const more=button('Ver tudo','shelf-more',() => setView(type));more.append(iconNode('arrow'));tools.append(more);
  const row=node('div',type==='live'?'live-shelf':'poster-shelf');renderCards(row,items);
  for(const direction of [-1,1]){const control=button('','icon-button',()=>row.scrollBy({left:direction*row.clientWidth*.85,behavior:'smooth'}),direction===-1?'chevron-left':'chevron-right');control.setAttribute('aria-label',direction===-1?'Voltar na coleção':'Avançar na coleção');tools.append(control);}
  header.append(titles,tools);section.append(header,row);return section;
}
function isItemVisible(item){const type=typeFor(item.kind);return (item.categoryIds||[item.categoryId]).some(id=>settingsTools.isCategoryVisible(type,id))&&(settingsTools.isItemVisible?.(type,item.id) ?? true);}
function visibleCatalog(type){const data=catalogs.get(type);return data?{...data,items:data.items.filter(isItemVisible)}:null;}
function catalogHiddenBySettings(type){const items=catalogs.get(type)?.items||[];return items.length>0&&!items.some(isItemVisible);}
function validDateValue(value){
  if(typeof value==='string'&&!/^\d+(?:\.\d+)?$/.test(value.trim()))return null;
  const numeric=Number(value);if(!Number.isFinite(numeric)||numeric<=0)return null;
  const milliseconds=numeric<100000000000?numeric*1000:numeric;
  return Number.isFinite(new Date(milliseconds).getTime())?milliseconds:null;
}
function sortItems(items){
  const mode=sortModes[view];if(!['movies','series','favorites'].includes(view)||!mode)return items;
  return items.map((item,index)=>({item,index,date:mode==='date'?(view==='favorites'?validDateValue(favorites.get(itemKey(item))?.savedAt)??validDateValue(item.added):validDateValue(item.added)):null})).sort((first,second)=>{
    if(mode==='name')return titleCollator.compare(first.item.name,second.item.name)||first.index-second.index;
    return (second.date??-Infinity)-(first.date??-Infinity)||first.index-second.index;
  }).map(entry=>entry.item);
}
function renderSort(){
  const controls=$('#sort-controls');controls.hidden=!['movies','series','favorites'].includes(view)||Boolean(query);if(controls.hidden)return;
  if(controls.dataset.view!==view){controls.dataset.view=view;controls.replaceChildren();for(const [mode,label] of [['name','Nome'],['date',view==='favorites'?'Favoritos recentes':'Adicionados recentemente']]){
    const choice=button(label,'sort-choice',()=>{if(sortModes[view]===mode)return;sortModes[view]=mode;save('arkehn.sortModes.v1',sortModes);visibleLimit=48;render();window.scrollTo({top:0,behavior:'instant'});});choice.dataset.mode=mode;controls.append(choice);
  }}
  for(const choice of controls.children){const selected=(sortModes[view]||'date')===choice.dataset.mode;choice.classList.toggle('active',selected);choice.setAttribute('aria-pressed',String(selected));}
}
function renderFavoriteGroups(container,items){
  let shown=0;const sections=[];
  for(const [kind,title] of [['live','TV ao vivo'],['movie','Filmes'],['series','Séries']]){
    const values=items.filter(item=>item.kind===kind);if(!values.length)continue;
    let section=[...container.children].find(element=>element.dataset.favoriteKind===kind);
    if(!section){section=node('section','favorite-section');section.dataset.favoriteKind=kind;const heading=node('div','live-grid-title');heading.append(node('h2','',title),node('span'));section.append(heading,node('div',kind==='live'?'live-grid':'poster-grid'));}
    section.querySelector('.live-grid-title>span').textContent=`${formatNumber(values.length)} favoritos`;
    const visible=values.slice(0,visibleLimit);shown+=visible.length;renderCards(section.lastElementChild,visible);sections.push(section);
  }
  reconcileChildren(container,sections);
  if(shown<items.length){$('#load-more-wrap').hidden=false;$('#page-progress').textContent=`${formatNumber(shown)} de ${formatNumber(items.length)} favoritos`;}
}
function getChannels(){return settingsTools.getNumberedChannels({favoritesOnly:true,fallbackToAll:true});}

function currentStoredItem(item){const data=catalogs.get(typeFor(item.kind));return data?.itemMap.get(item.id) || null;}
function customGroupItems(group,items){const keys=new Set(group.itemKeys || []);return items.filter(item=>keys.has(itemKey(item)));}
function matchedItems(shouldSort=true) {
  let items;
  if(query){items=[...catalogs.values()].flatMap(data=>data.items);}
  else if(view==='favorites'){items=[...favorites.values()].map(currentStoredItem).filter(Boolean);}
  else {items=catalogs.get(view)?.items || [];}
  items=items.filter(isItemVisible);
  if(query) {const words=normalize(query).trim().split(/\s+/);items=items.filter(item=>words.every(word=>(item.search || normalize(item.name)).includes(word)));}
  if(category.startsWith('custom:')){const group=settingsTools.getCustomGroups().find(group=>group.id===category.slice(7));items=group?customGroupItems(group,items):[];}
  else if(category==='__favorites')items=items.filter(item=>favorites.has(itemKey(item)));
  else if(category!=='__all')items=items.filter(item=>query || view==='favorites'?item.kind===category:(item.groupKeys||[item.groupKey]).includes(category));
  return shouldSort?sortItems(items):items;
}
function matchedCategoryItems(){const selected=category;category='__all';const items=matchedItems(false);category=selected;return items;}
function categoriesFor(items) {
  if(query || view==='favorites'){return [{id:'__all',name:'Tudo',count:items.length},...['live','movie','series'].map(kind=>({id:kind,name:{live:'Ao vivo',movie:'Filmes',series:'Séries'}[kind],count:items.filter(item=>item.kind===kind).length})).filter(item=>item.count)];}
  const counts=new Map();for(const item of items)for(const key of item.groupKeys||[item.groupKey])counts.set(key,(counts.get(key)||0)+1);const data=catalogs.get(view),paged=isPagedCatalog(data);const groups=(data?.categories || []).map(group=>({...group,count:counts.get(group.id)||0,unloaded:paged&&[...group.ids].some(id=>!data.pagination.byCategory?.[id]?.loaded)})).filter(group=>group.count||paged&&[...group.ids].some(id=>settingsTools.isCategoryVisible(view,id)));const personal=settingsTools.getCustomGroups().filter(group=>group.type===view).map(group=>({id:`custom:${group.id}`,name:group.name,count:customGroupItems(group,items).length}));return [{id:'__all',name:'Todos',count:items.length},{id:'__favorites',name:'Favoritos',count:items.filter(item=>favorites.has(itemKey(item))).length},...personal,...groups];
}
function categoryButtons(groups,live=false) {
  return groups.map(group=>{const chip=button('',live?'live-category':'category-chip',()=>{if(category===group.id)return;category=group.id;visibleLimit=48;catalogPager.load(view,category,{initialOnly:true});render();window.scrollTo({top:0,behavior:'instant'});});chip.classList.toggle('active',category===group.id);chip.setAttribute('aria-pressed',String(category===group.id));chip.dataset.categoryId=group.id;chip.dataset.categorySearch=normalize(group.name);chip.append(node('span','',group.name));if(live)chip.append(node('span','category-total',group.unloaded?'—':formatNumber(group.count)));return chip;});
}
function updateCategorySidebar(sidebar,groups){
  if(!sidebar)return;const list=sidebar.querySelector('.category-sidebar-items'),search=normalize(sidebar.querySelector('.category-sidebar-search').value),existing=new Map([...list.children].map(element=>[element.dataset.categoryId,element]));
  const choices=groups.map(group=>{const chip=existing.get(group.id)||categoryButtons([group],true)[0];chip.classList.toggle('active',category===group.id);chip.setAttribute('aria-pressed',String(category===group.id));chip.dataset.categorySearch=normalize(group.name);chip.firstElementChild.textContent=group.name;chip.lastElementChild.textContent=group.unloaded?'—':formatNumber(group.count);chip.hidden=!chip.dataset.categorySearch.includes(search);return chip;});
  const scrollTop=list.scrollTop;reconcileChildren(list,choices);list.scrollTop=scrollTop;
}
function categorySidebar(groups){
  const sidebar=node('aside','live-categories catalog-sidebar');sidebar.setAttribute('aria-label','Categorias');
  const heading=node('div','category-sidebar-heading');heading.append(node('h2','','CATEGORIAS'));
  const toggle=button('Categorias','mobile-categories-toggle',()=>{sidebar.classList.toggle('mobile-expanded');toggle.setAttribute('aria-expanded',String(sidebar.classList.contains('mobile-expanded')));},'chevron-down');toggle.setAttribute('aria-expanded','false');heading.append(toggle);sidebar.append(heading);
  const search=node('input','category-sidebar-search');search.type='search';search.placeholder='Buscar categoria';search.setAttribute('aria-label','Buscar categoria');sidebar.append(search);
  const actions=node('div','category-sidebar-actions');actions.append(button('Criar categoria','category-create',()=>settingsTools.open('catalog',view),'plus'),button('Organizar','category-manage',()=>settingsTools.open('catalog',view),'settings'));sidebar.append(actions);
  const list=node('div','category-sidebar-items');list.append(...categoryButtons(groups,true));sidebar.append(list);
  search.addEventListener('input',()=>{const text=normalize(search.value);for(const option of list.children)option.hidden=!option.dataset.categorySearch.includes(text);});
  return sidebar;
}
function renderHome(container) {
  $('#category-bar').hidden=true;$('#result-count').textContent='';
  const films=visibleCatalog('movies'),series=visibleCatalog('series'),live=visibleCatalog('live');
  const sections=[],existing=new Map([...container.children].map(element=>[element.dataset.shelfKey,element]));
  const addShelf=(title,subtitle,items,type,key=`home:${type}:${title}`)=>{const section=shelf(title,subtitle,items,type,existing.get(key));section.dataset.shelfKey=key;sections.push(section);};
  for(const section of homeShelves({movies:films?.items||[],series:series?.items||[],live:live?.items||[],favorites,history}))addShelf(section.title,'',section.items,section.type,section.key);
  if(!sections.length&&loading.size){const skeleton=existing.get('__loading')||skeletons();skeleton.dataset.shelfKey='__loading';sections.push(skeleton);}
  for(const group of settingsTools.getCustomGroups()){const data=visibleCatalog(group.type);if(!data)continue;const items=customGroupItems(group,data.items).slice(0,16);if(items.length)addShelf(group.name,'SELECIONADO POR VOCÊ',items,group.type,`custom:${group.id}`);}
  if(!sections.length){const hiddenType=['movies','series','live'].find(catalogHiddenBySettings),error=[...failures.values()][0];sections.push(hiddenType?emptyState('Seu catálogo está oculto','Suas preferências ocultam os títulos carregados. Escolha o que mostrar em Configurações.',{label:'Organizar catálogo',run:()=>settingsTools.open('catalog',hiddenType)}):emptyState(error?'Seu catálogo está a um passo':'Seu universo está começando',error||'O serviço ainda não retornou conteúdo para explorar.',{label:'Tentar novamente',run:refreshCatalog}));}
  reconcileChildren(container,sections);
  updateHero();
}
function render() {
  if(!session?.connected)return;
  for(const element of document.querySelectorAll('[data-view]')){const active=element.dataset.view===view && !query;element.classList.toggle('active',active);active?element.setAttribute('aria-current','page'):element.removeAttribute('aria-current');}
  const home=view==='home' && !query;$('#hero').hidden=!home;$('#page-heading').classList.toggle('home-heading',home);$('#page-title').textContent=query?`Resultados para “${query}”`:viewLabels[view];$('#page-eyebrow').hidden=!home;$('#page-eyebrow').textContent='EXPLORE O SEU CATÁLOGO';
  if(!home){heroDurationController?.abort();heroDurationController=null;}
  if(!settingsTools.isOpen&&!contentPageOpen())document.title=`ARKHEN P2 IPTV · ${query?'Busca':{home:'Seu universo em cena',live:'Ao vivo',movies:'Filmes',series:'Séries',favorites:'Minha lista'}[view]}`;
  renderSort();$('#load-more-wrap').hidden=true;$('#load-more').disabled=false;$('#load-more').firstChild.textContent='Explorar mais';const container=$('#catalog-content'),mode=home?'home':query?'search':view==='favorites'&&category==='__all'?'favorite-groups':`catalog:${view}`;
  if(container.dataset.renderMode!==mode){container.dataset.renderMode=mode;container.replaceChildren();}
  if(home){renderHome(container);return;}
  const currentCatalog=catalogs.get(view);if(loading.has(view) && !currentCatalog && !query){$('#category-bar').hidden=true;$('#result-count').textContent='';if(!container.querySelector('.skeleton'))container.replaceChildren(skeletons(12));return;}
  const allItems=category==='__all'?matchedItems(false):matchedCategoryItems();
  const groups=categoriesFor(allItems),items=category==='__all'?sortItems(allItems):matchedItems(),partialSearch=query&&[...catalogs.values()].some(data=>isPagedCatalog(data)&&pageChoices(data).length),partialCatalog=!query&&catalogPager.choices(view,category).length>0;$('#result-count').textContent=`${formatNumber(items.length)} ${items.length===1?'título':'títulos'}${partialSearch||partialCatalog?' carregados':''}`;
  const live=view==='live'&&!query,categorized=['live','movies','series'].includes(view)&&!query;$('#category-bar').hidden=categorized;$('#category-bar').replaceChildren(...categoryButtons(groups));
  if(!items.length&&!categorized){const error=failures.get(view);container.replaceChildren(emptyState(error?'Não foi possível carregar o catálogo':query?partialSearch?'Nenhum título entre os carregados':'Nenhuma história com esse nome':view==='favorites'?'Guarde a próxima descoberta':'Esta categoria está vazia',error || (query?partialSearch?'Abra uma categoria em Filmes ou Séries para carregar mais títulos e ampliar a busca.':'Tente outro título, canal ou categoria.':view==='favorites'?'Toque na estrela de um filme, série ou canal. Você encontra tudo que escolher por aqui.':'Escolha outra categoria para continuar explorando.'),error?{label:'Tentar novamente',run:()=>loadCatalog(view,true)}:null));return;}
  if(view==='favorites'&&!query&&category==='__all'){renderFavoriteGroups(container,items);return;}
  if(categorized){
    let layout=container.querySelector('.catalog-layout');
    if(!layout){layout=node('div','live-layout catalog-layout');const body=node('div','category-results'),heading=node('div','live-grid-title');heading.append(node('h2'),node('span'));body.append(heading);layout.append(categorySidebar(groups),body);container.replaceChildren(layout);}
    updateCategorySidebar(layout.querySelector('.catalog-sidebar'),groups);
    const body=layout.querySelector('.category-results'),heading=body.firstElementChild;heading.firstElementChild.textContent=groups.find(group=>group.id===category)?.name || (live?'Todos os canais':'Todos os títulos');heading.lastElementChild.textContent=`${formatNumber(items.length)} ${live?'canais':'títulos'}${partialCatalog?' carregados':''}`;
    const pageError=catalogPager.errorFor(view,category),pageLoading=catalogPager.pendingFor(view,category),error=pageError||failures.get(view);let grid=body.querySelector('.live-grid,.poster-grid');
    if(items.length){if(!grid)grid=node('div',live?'live-grid':'poster-grid');renderCards(grid,items.slice(0,visibleLimit));}
    else grid=pageLoading?skeletons(8):error?emptyState('Não foi possível carregar o catálogo',error,{label:'Tentar novamente',run:()=>{pageError?catalogPager.load(view,category):loadCatalog(view,true);render();}}):catalogHiddenBySettings(view)?emptyState('Este catálogo está oculto','Suas preferências ocultam os títulos carregados. Escolha o que mostrar em Configurações.',{label:'Organizar catálogo',run:()=>settingsTools.open('catalog',view)}):category==='__favorites'?emptyState('Seus favoritos ficam aqui','Toque na estrela de um canal, filme ou série para guardar sua próxima sessão.'):emptyState('Esta categoria está vazia','Escolha outra categoria ou organize o que aparece no seu catálogo.',{label:'Organizar catálogo',run:()=>settingsTools.open('catalog',view)});
    reconcileChildren(body,[heading,grid]);
  }
  else{let grid=container.querySelector(':scope>.poster-grid');if(!grid){grid=node('div','poster-grid');container.replaceChildren(grid);}renderCards(grid,items.slice(0,visibleLimit));}
  const remoteMore=!query&&catalogPager.choices(view,category).length>0,pageLoading=catalogPager.pendingFor(view,category),pageError=catalogPager.errorFor(view,category);
  if(items.length>visibleLimit||remoteMore||pageLoading){$('#load-more-wrap').hidden=false;$('#load-more').disabled=pageLoading;$('#load-more').firstChild.textContent=pageLoading?'Carregando…':pageError?'Tentar novamente':'Explorar mais';$('#page-progress').textContent=pageError||`${formatNumber(Math.min(visibleLimit,items.length))} ${remoteMore?'títulos carregados':`de ${formatNumber(items.length)} ${live?'canais':'títulos'}`}`;}
}
function updateHero() {
  featured=featuredMovies(visibleCatalog('movies')?.items||[],3);$('#hero').hidden=!featured.length&&!loading.has('movies');
  $('#hero').classList.toggle('loading',!featured.length);if(!featured.length){heroItem=null;heroRequest++;heroDurationController?.abort();heroDurationController=null;$('#hero-title').textContent='Seu universo em cena.';$('#hero-meta').replaceChildren();$('#hero-plot').textContent='Escolha as categorias que quer explorar em Configurações.';setHeroArtwork($('#hero-art'),{});$('#hero-picker').replaceChildren();return;}
  if(!heroItem || !featured.some(item=>itemKey(item)===itemKey(heroItem)))setHero(featured[0]);
  const picker=$('#hero-picker');picker.replaceChildren(...featured.map(item=>{const select=button('',itemKey(item)===itemKey(heroItem)?'active':'',()=>setHero(item));select.setAttribute('aria-label',`Destacar ${item.name}`);select.setAttribute('aria-pressed',String(itemKey(item)===itemKey(heroItem)));return select;}));
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
  heroItem=item;const token=++heroRequest,previousDuration=history.get(itemKey(item))?.duration;
  const facts=(value,durationPending=false)=>renderHeroFacts($('#hero-meta'),value,{previousDuration,durationPending},node);
  $('#hero-title').textContent=cleanTitle(item.name);$('#hero-plot').textContent=metadataText(item.plot)||'';$('#hero-watch').disabled=false;$('#hero-details').disabled=false;
  facts(item,true);setHeroArtwork($('#hero-art'),item);
  $('#hero-picker').querySelectorAll('button').forEach((element,index)=>{const featuredItem=featured[index],selected=Boolean(featuredItem&&itemKey(featuredItem)===itemKey(item));element.classList.toggle('active',selected);element.setAttribute('aria-pressed',String(selected));});
  let current=item;
  try{
    const details=await getDetails(item);if(token!==heroRequest)return;current={...item,...details};
    const needsDuration=!metadataText(movieWithPlaybackDuration(current,previousDuration).duration);
    facts(current,needsDuration);$('#hero-plot').textContent=metadataText(current.plot);setHeroArtwork($('#hero-art'),current);
    if(!needsDuration||view!=='home'||query||contentPageOpen()||settingsTools.isOpen)return;
    const controller=new AbortController();heroDurationController=controller;
    const deadline=setTimeout(()=>controller.abort(),7000);
    try{const measured=await getDetails(item,{duration:true,signal:controller.signal});if(token===heroRequest&&!controller.signal.aborted)current={...current,...measured};}
    finally{clearTimeout(deadline);if(heroDurationController===controller)heroDurationController=null;}
  }catch{/* Keep real catalog fields when optional metadata cannot be loaded. */}
  finally{if(token===heroRequest)facts(current);}
}
async function getDetails(item,{duration=false,signal}={}) {
  duration=Boolean(duration&&item.kind==='movie');
  const baseKey=itemKey(item),key=baseKey+(duration?':duration':'');if(detailsCache.has(key))return detailsCache.get(key);
  const generation=connectionGeneration;
  const pending=api(`/api/details?type=${item.kind}&id=${encodeURIComponent(item.id)}${duration?'&duration=1':''}`,{signal}).then(data=>{
    if(generation!==connectionGeneration || detailsCache.get(key)!==pending)throw new DOMException('A conexão foi alterada.','AbortError');
    detailsCache.set(key,data);if(duration)detailsCache.set(baseKey,data);return data;
  }).catch(error=>{
    if(generation===connectionGeneration && detailsCache.get(key)===pending)detailsCache.delete(key);
    throw error;
  });
  detailsCache.set(key,pending);return pending;
}
const previewTools=new PreviewTools({root:$('#detail-content'),background:$('#detail-art'),setArt,icon:iconNode,onWatch:watchDetail,onFavorite:()=>toggleFavorite(detailItem),onRetry:()=>{if(detailItem)openDetails(detailItem,false,{route:false});},onCatalog:()=>setView(typeFor(detailItem?.kind||'movie'))});
function refreshDetailFavorite(){if(detailItem)previewTools.favorite(favorites.has(itemKey(detailItem)));}
async function openDetails(item,watch=false,pageOptions={}) {
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
  if(detailItem?.kind==='movie'&&detailData&&!$('#detail-dialog').hidden)updateMovieDuration(previewTools,{...detailItem,...detailData,kind:'movie'},{previousDuration:history.get(itemKey(detailItem))?.duration,durationPending:previewDurationPending});
}
function renderDetails() {
  if(!detailItem||!detailData)return;
  const item={...detailItem,...detailData,kind:detailItem.kind},continuing=playbackProgress(history.get(itemKey(item))).resumable;
  if(item.kind==='series')activeSeason=renderSeriesPreview(previewTools,item,{continuing,activeSeason,onSeason:selectPreviewSeason,onEpisode:episode=>openPlayer(detailItem,episode)});
  else renderMoviePreview(previewTools,item,{continuing,previousDuration:history.get(itemKey(item))?.duration,durationPending:previewDurationPending,relatedItems:visibleCatalog('movies')?.items||[],renderCards});
  refreshDetailFavorite();
}
function selectPreviewSeason(index){if(activeSeason===index)return;activeSeason=index;renderDetails();$('#detail-content').querySelector(`.season-tab[data-season-index="${index}"]`)?.focus({preventScroll:true});}
function watchDetail() {if(!detailItem)return;if(detailItem.kind==='series'){const episodes=allEpisodes(detailData||{}),previous=history.get(itemKey(detailItem));const next=episodes.find(episode=>String(episode.id)===String(previous?.episode?.id)) || episodes[0];if(next)openPlayer(detailItem,next);else toast('Nenhum episódio está disponível para esta série.');}else openPlayer(detailItem);}
function playerURL(item,episode) {if(item.kind==='live')return `/api/play/live/${encodeURIComponent(item.id)}/index.m3u8`;const container=String(episode?.container||item.container||'mp4').replace(/[^a-z0-9]/gi,'').toLowerCase() || 'mp4';return `/api/play/${item.kind}/${encodeURIComponent(episode?.id||item.id)}.${container}`;}
function refreshPlayerFavorite(){if(!player)return;const selected=favorites.has(itemKey(player.item));replaceIcon($('#player-favorite'),'star');$('#player-favorite').classList.toggle('selected',selected);$('#player-favorite').setAttribute('aria-label',selected?'Remover dos favoritos':'Adicionar aos favoritos');$('#player-favorite').setAttribute('aria-pressed',String(selected));}
function persistHistory(){const entries=[...history.values()].sort((first,second)=>Number(second.updated||0)-Number(first.updated||0)).slice(0,40);history.clear();for(const entry of entries)history.set(itemKey(entry.item),entry);mediaLibrary.saveHistory();}
function saveLiveWatch(){if(player?.item.kind!=='live'||!player.nativeSourceStarted&&!hls||video.readyState<2||video.paused)return;history.set(itemKey(player.item),{item:snapshot(player.item),time:0,duration:0,episode:null,updated:Date.now()});persistHistory();}
function saveProgress(force=false){if(!player || player.item.kind==='live' || !Number.isFinite(video.currentTime)||video.currentTime<3)return;const now=Date.now();if(!force&&now-progressLastSaved<5000)return;progressLastSaved=now;history.set(itemKey(player.item),{item:snapshot(player.item),time:video.currentTime,duration:Number.isFinite(video.duration)?video.duration:0,episode:player.episode?{id:String(player.episode.id),title:player.episode.title,number:player.episode.number,season:player.episode.season,container:player.episode.container}:null,updated:now});persistHistory();}
function stopPlayback(){const wasPlaying=Boolean(player);saveProgress(true);++playbackSerial;liveProgramFeed?.stop();immersivePlayer?.reset();playerTools.reset();if(hls){hls.destroy();hls=null;}player=null;video.pause();video.removeAttribute('src');video.load();$('#player-loading').hidden=true;if(wasPlaying)pendingStop=api('/api/stop',{method:'POST',body:'{}',keepalive:true}).catch(()=>{});return pendingStop;}
function playbackFailure(message){hls?.stopLoad();playerTools.fail();immersivePlayer?.setFailure?.(message);$('#player-loading').hidden=true;$('#player-status').textContent=message;$('#player-retry').hidden=false;}
async function openPlayer(item,episode=null,playOptions={}) {
  if(item.kind==='series'&&!episode){await openDetails(item);return;}
  channelGuide?.pause();
  const wasPlayerPage=!$('#player-dialog').hidden;
  if(playOptions.route!==false)setContentRoute('watch',item,episode,wasPlayerPage);
  const channelNumber=item.kind==='live'?(playOptions.channelNumber ?? (playOptions.automatic?player?.channelNumber:null) ?? settingsTools.getChannelNumber(item.id,null)):null;
  const openRequest=++playOpenRequest,stopped=stopPlayback();detailRequest++;player={item,episode,channelNumber,playOptions,usingNativeHLS:false};const serial=playbackSerial;
  previewDurationController?.abort();previewDurationController=null;previewDurationPending=false;
  showContentPage('watch');document.title=`ARKHEN P2 IPTV · Assistindo ${cleanTitle(item.name)}`;
  $('#player-title').textContent=episode?`${cleanTitle(item.name)} · T${episode.season} E${episode.number}`:item.name;$('#player-kind').textContent=item.kind==='live'?'ARKHEN P2 IPTV · TV AO VIVO':item.kind==='series'?'ARKHEN P2 IPTV · SÉRIES':'ARKHEN P2 IPTV · CINEMA';$('#player-status').textContent='Conectando ao vídeo…';$('#player-program').hidden=true;$('#player-program').replaceChildren();$('#player-loading').hidden=false;$('#player-retry').hidden=true;video.preload='auto';refreshPlayerFavorite();
  const episodes=allEpisodes(detailsCache.get(itemKey(item))||{});const index=episodes.findIndex(value=>String(value.id)===String(episode?.id));player.next=index>=0?episodes[index+1]||null:null;$('#player-next').hidden=!player.next;
  immersivePlayer?.attach({item,episode,channelNumber});
  if(playOptions.route!==false&&!playOptions.automatic)tryNativeFullscreen();
  await stopped;if(openRequest!==playOpenRequest||serial!==playbackSerial)return;
  if(!session?.connected){playbackFailure('Sua conexão precisa ser restabelecida. Entre novamente para assistir.');return;}
  const url=playerURL(item,episode),isHLS=/\.m3u8(?:[?#]|$)/i.test(url);
  const playNow=()=>{if(serial!==playbackSerial)return;video.play().catch(error=>{if(serial!==playbackSerial||error.name==='AbortError'||playerTools.current?.failed)return;if(error.name==='NotAllowedError'){$('#player-loading').hidden=true;$('#player-status').textContent='Pronto. Pressione play para assistir.';}else if(!video.error)playbackFailure('O vídeo não pôde iniciar. Tente novamente ou escolha outra fonte.');});};
  const start=()=>{if(serial!==playbackSerial)return;const previous=history.get(itemKey(item));if(previous?.time>5 && (!episode||String(episode.id)===String(previous.episode?.id)) && (!previous.duration||previous.time/previous.duration<.95)){try{video.currentTime=previous.time;}catch{/* this source may not expose seeking yet */}}playNow();};
  video.addEventListener('loadedmetadata',start,{once:true});
  const variants=findChannelVariants(item,catalogs.get('live')?.items || []);
  const nativeHLS=Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
  if(isHLS&&!playOptions.preferNative&&(playOptions.preferHls||!nativeHLS)&&window.Hls?.isSupported()){
    hls=new window.Hls(playerTools.configFor(item.kind));playerTools.attach({item,hls,variants,automatic:playOptions.automatic,adaptiveState:playOptions.adaptiveState,errorEvents:playOptions.errorEvents});
    hls.on(window.Hls.Events.MANIFEST_PARSED,playNow);
    hls.on(window.Hls.Events.ERROR,(_,data)=>{
      if(serial!==playbackSerial)return;
      const responseStatus=Number(data.response?.code ?? data.response?.status ?? data.networkDetails?.status);
      if(responseStatus===401||responseStatus===403){playerTools.recordError(data);playbackFailure('Sua conexão precisa ser restabelecida. Entre novamente ou tente retomar a sessão.');return;}
      if(!data.fatal)return;
      playerTools.recordError(data);if(playerTools.recoverError(data))return;
      const codecFailure=['manifestIncompatibleCodecsError','bufferAddCodecError','bufferAppendError','fragParsingError'].includes(data.details);
      const interruptedAfterStart=data.type==='networkError'&&(playerTools.current?.segments || 0)>=1&&video.videoWidth>0;
      if((data.type==='mediaError'||codecFailure||interruptedAfterStart)&&!playOptions.nativeFallback&&video.canPlayType('application/vnd.apple.mpegurl')){
        toast(interruptedAfterStart?'Tentando reprodução nativa após a interrupção.':'Usando a reprodução nativa para esta fonte.');
        openPlayer(item,episode,{...playOptions,preferNative:true,nativeFallback:true,automatic:true,adaptiveState:playerTools.adaptiveState,errorEvents:playerTools.getErrorEvents()});return;
      }
      const playlistFailure=['manifestLoadError','manifestLoadTimeOut','levelLoadError','levelLoadTimeOut'].includes(data.details);
      const segmentFailure=['fragLoadError','fragLoadTimeOut'].includes(data.details);
      playbackFailure(data.type==='networkError'&&!codecFailure?(playlistFailure?'A lista de reprodução não respondeu após as tentativas de recuperação.':segmentFailure?'O próximo trecho do vídeo não respondeu após as tentativas de recuperação.':'A transmissão não respondeu após as tentativas de recuperação.')+' Tente novamente ou escolha outra fonte disponível.':'O navegador não conseguiu decodificar esta transmissão. Tente outra fonte disponível ou confira a compatibilidade do formato.');
    });
    hls.loadSource(url);hls.attachMedia(video);
  }else{player.usingNativeHLS=isHLS&&nativeHLS;playerTools.attach({item,variants,automatic:playOptions.automatic,adaptiveState:playOptions.adaptiveState,errorEvents:playOptions.errorEvents});player.nativeSourceStarted=true;video.src=url;video.load();playNow();}
  if(item.kind==='live')liveProgramFeed?.start(item.id);
}
function updateProgram(data){
  if(player?.item.kind!=='live')return;
  immersivePlayer?.setProgram(data);
  const element=$('#player-program'),now=Date.now(),program=programWindow(data.list,now).current;
  element.replaceChildren();element.hidden=!program;if(!program)return;
  const time=value=>new Intl.DateTimeFormat('pt-BR',{hour:'2-digit',minute:'2-digit'}).format(value);
  element.append(node('strong','',`${time(program.start)} — ${time(program.end)} · ${program.title}`));
  if(program.description)element.append(node('p','',program.description));
  const progress=node('div','program-progress'),fill=node('span');
  fill.style.width=`${Math.min(100,Math.max(0,(now-program.start)/(program.end-program.start)*100))}%`;
  progress.append(fill);element.append(progress);
}
async function refreshCatalog(){
  const request=++refreshRequest,generation=connectionGeneration,types=['live','movies','series'],labels={live:'TV ao vivo',movies:'Filmes',series:'Séries'};
  detailsCache.clear();failures.clear();heroItem=null;heroRequest++;$('#account-dialog').close();$('#refresh-catalog').disabled=true;
  const panel=$('#catalog-refresh'),progress=$('#catalog-refresh-progress'),status=$('#catalog-refresh-status'),stages=$('#catalog-refresh-stages');panel.hidden=false;progress.value=0;status.textContent='Conectando ao serviço · 0 de 3 etapas concluídas';stages.replaceChildren();
  const rows=new Map(types.map(type=>{const row=node('div','refresh-stage');row.dataset.state='loading';row.append(node('span','spinner'),node('span','',labels[type]),node('small','','Atualizando'));stages.append(row);return[type,row];}));
  let completed=0,succeeded=0;
  await Promise.allSettled(types.map(async type=>{
    const result=await loadCatalog(type,true);if(request!==refreshRequest||generation!==connectionGeneration)return;
    completed++;if(result)succeeded++;const row=rows.get(type);row.dataset.state=result?'done':'error';row.firstElementChild.replaceWith(iconNode(result?'check':'info'));row.querySelector('small').textContent=result?'Concluído':'Falha na atualização';progress.value=completed;status.textContent=`${completed} de 3 etapas concluídas`;
  }));
  if(request!==refreshRequest||generation!==connectionGeneration)return;$('#refresh-catalog').disabled=false;
  if(succeeded===3){status.textContent='Tudo atualizado. Seu catálogo está pronto.';toast('TV ao vivo, filmes e séries atualizados');setTimeout(()=>{if(request===refreshRequest)panel.hidden=true;},6500);}
  else{status.textContent=`${succeeded} de 3 catálogos atualizados. Tente novamente para completar.`;toast(succeeded?'Atualização parcial. Confira as etapas.':'Não foi possível atualizar. Confira a conexão.');}
}
function showAccount(){const info=$('#account-information');info.replaceChildren();const account=session?.account||{};for(const [label,value,active] of [['Usuário',account.usernameMasked||'Conexão local'],['Status',account.status==='Active'?'Ativa':account.status||'Conectada',true],['Validade',account.expiresAt?new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'long',year:'numeric'}).format(new Date(account.expiresAt)):'Não informada'],['Conexões',`${account.activeConnections ?? 0} de ${account.maxConnections ?? '—'}`]]){const row=node('div','account-row');row.append(node('span','',label),node('strong',active?'account-active':'',value));info.append(row);}$('#account-dialog').showModal();}

const playerTools=new PlayerTools({video,api,toast,connectionGeneration:()=>connectionGeneration,switchChannel:(item,options)=>openPlayer(item,null,options)});
const settingsTools=new SettingsTools({api,toast,getSession:()=>session,getCatalogs:()=>catalogs,loadCatalog:type=>loadCatalog(type),getFavorites:()=>favorites,playerTools,onLogout:()=>logout(),onRefresh:()=>{settingsTools.close();refreshCatalog();},onOpen:()=>{$('#account-dialog').close();closeContentPages();$('#open-settings').setAttribute('aria-current','page');},onClose:()=>{$('#open-settings').removeAttribute('aria-current');render();},onChange:()=>{category='__all';visibleLimit=48;heroItem=null;render();immersivePlayer?.setChannels(getChannels());}});
const accountMenu=new AccountMenu({trigger:$('#account-button'),getSession:()=>session,onProfile:()=>settingsTools.open('profile'),onSettings:()=>settingsTools.open(),onRefresh:()=>{settingsTools.close();refreshCatalog();},onLogout:()=>logout()});
immersivePlayer=new ImmersivePlayer({video,stage:$('.video-stage'),api,toast,getPlayer:()=>player,getSourceNamespace:()=>`${session?.account?.provider || 'xtream'}:${session?.account?.usernameMasked || ''}`,getChannels,onSwitchChannel:item=>openPlayer(item),onClose:backFromContentPage,onNextEpisode:()=>{if(player?.next)openPlayer(player.item,player.next);},onRetry:()=>{if(player)openPlayer(player.item,player.episode);}});
const playerToolsPanel=node('div','player-page-tools');playerToolsPanel.append($('.player-controls'),$('#player-telemetry'));immersivePlayer.setTools(playerToolsPanel);
$('#player-favorite').classList.add('ip-button');$('.ip-controls-row').insertBefore($('#player-favorite'),immersivePlayer.settingsButton);
channelGuide=new ChannelGuide({api,connectionGeneration:()=>connectionGeneration});
liveProgramFeed=new LiveProgramFeed({request:api,onUpdate:updateProgram});

mountIcons();
const loginScreen=new LoginScreen({root:$('#connection-screen'),onSubmit:connect});
const sessionLoader=new SessionLoader($('#startup'));
$('#navigation').addEventListener('click',event=>{const target=event.target.closest('[data-view]');if(target)setView(target.dataset.view);});
$('.topbar .brand').addEventListener('click',event=>{event.preventDefault();setView('home');});
function openSearch(){settingsTools.close();$('#search-panel').hidden=false;$('#search-input').focus();}
$('#open-search').addEventListener('click',openSearch);$('#close-search').addEventListener('click',()=>{query='';category='__all';$('#search-input').value='';$('#search-panel').hidden=true;render();});
$('#search-input').addEventListener('input',event=>{clearTimeout(queryTimer);queryTimer=setTimeout(()=>{query=event.target.value.trim();category='__all';visibleLimit=48;render();},160);});
$('#load-more').addEventListener('click',async()=>{const scrollY=window.scrollY,type=view,selected=category,generation=connectionGeneration;visibleLimit+=48;
  const pending=!query&&matchedItems().length<visibleLimit?catalogPager.load(type,selected):null;render();
  if(pending)await pending;if(generation===connectionGeneration&&view===type&&category===selected){render();window.scrollTo({top:scrollY,behavior:'instant'});}
});
$('#hero-watch').addEventListener('click',()=>{if(heroItem)openDetails(heroItem);});$('#hero-details').addEventListener('click',()=>{if(heroItem)openDetails(heroItem);});
$('#open-settings').addEventListener('click',()=>settingsTools.open());$('#open-settings-account').addEventListener('click',()=>settingsTools.open());
$('#catalog-refresh-close').addEventListener('click',()=>{$('#catalog-refresh').hidden=true;});
$('#refresh-catalog').addEventListener('click',refreshCatalog);
async function logout(){accountMenu.close(false);closeContentPages();window.history.replaceState(null,'','#home');catalogReturn=null;contentReturnFocus=null;const generation=resetConnectionData();try{await api('/api/logout',{method:'POST',body:'{}'});if(generation!==connectionGeneration)return;session=null;showConnection();}catch(error){if(generation!==connectionGeneration)return;render();['movies','series','live'].forEach(type=>loadCatalog(type));toast(error.message);}}
$('#change-connection').addEventListener('click',logout);
for(const dialog of document.querySelectorAll('dialog')){dialog.querySelector('[data-close]')?.addEventListener('click',()=>dialog.close());dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();});}
$('#detail-back').addEventListener('click',backFromContentPage);$('#player-back').addEventListener('click',backFromContentPage);$('#detail-start').addEventListener('click',()=>setView('home'));$('#detail-home').addEventListener('click',event=>{event.preventDefault();setView('home');});
window.addEventListener('popstate',handleContentRouteChange);window.addEventListener('hashchange',handleContentRouteChange);
$('#player-retry').addEventListener('click',()=>{if(player)openPlayer(player.item,player.episode);});
$('#player-favorite').addEventListener('click',()=>{if(player)toggleFavorite(player.item);});$('#player-next').addEventListener('click',()=>{if(player?.next)openPlayer(player.item,player.next);});$('#player-fullscreen').addEventListener('click',()=>immersivePlayer.toggleFullscreen());
video.addEventListener('playing',()=>{if(!player)return;saveLiveWatch();$('#player-loading').hidden=true;$('#player-status').textContent=player.item.kind==='live'?'Ao vivo · Reprodução em andamento':'Reprodução em andamento';});video.addEventListener('waiting',()=>{if(player)$('#player-status').textContent='Carregando vídeo…';});video.addEventListener('pause',()=>{if(player&&!video.ended){$('#player-status').textContent='Pausado';saveProgress(true);}});video.addEventListener('timeupdate',()=>saveProgress());video.addEventListener('ended',()=>{if(player){saveProgress(true);$('#player-status').textContent=player.next?'Episódio concluído. O próximo está pronto para você.':'Sua sessão chegou ao fim.';}});video.addEventListener('error',()=>{
  if(!player||hls||!player.nativeSourceStarted)return;
  if(player.usingNativeHLS&&!player.playOptions.hlsFallback&&window.Hls?.isSupported()){
    const {item,episode,playOptions}=player;openPlayer(item,episode,{...playOptions,preferHls:true,preferNative:false,hlsFallback:true,nativeFallback:true,automatic:true});return;
  }
  playbackFailure('Não foi possível reproduzir este vídeo. Tente novamente; o formato ou o canal pode estar indisponível no navegador.');
});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&!document.querySelector('dialog[open]')&&contentPageOpen()){
    event.preventDefault();if((document.fullscreenElement||document.webkitFullscreenElement)===$('.video-stage'))leaveNativeFullscreen();else backFromContentPage();return;
  }
  if(event.key==='/'&&!contentPageOpen()&&!['INPUT','TEXTAREA','VIDEO'].includes(document.activeElement.tagName)&&!document.querySelector('dialog[open]')&&session?.connected){event.preventDefault();openSearch();}
  if(event.key==='Escape'&&!document.querySelector('dialog[open]')&&!$('#search-panel').hidden)$('#close-search').click();
});
window.addEventListener('pagehide',()=>stopPlayback());
window.addEventListener('pageshow',event=>{if(event.persisted&&session?.connected){lastPageRouteKey=null;pageRouteRequest++;handleContentRouteChange();}});
(async()=>{sessionLoader.start('Reconhecendo sua sessão');try{session=await api('/api/session');loginScreen.configure(session.login);session.connected?await enterApplication():showConnection(session.error||'');}catch(error){loginScreen.configure();showConnection(error.message);}})();

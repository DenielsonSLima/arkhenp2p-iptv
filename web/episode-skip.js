import {normalizeSeriesPlaybackPreferences, SERIES_COUNTDOWN_SECONDS} from './series-playback-preferences.js';

const STORAGE_KEY = 'arkhen.episode-skips.v2';
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const MARKS = ['openingStart', 'openingEnd', 'creditsStart'];
const MAX_EPISODES = 200;
const durationValid = value => Number.isFinite(value) && value > 0 && value <= 86400;
let memoryScope = 0;

function browserStorage() { try { return globalThis.localStorage; } catch { return null; } }
function validID(value) { const id = String(value ?? ''); return ID.test(id) ? id : ''; }

export function fingerprintSource(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) return '';
  let hash = 14695981039346656037n;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    hash = BigInt.asUintN(64, (hash ^ BigInt(code & 255)) * 1099511628211n);
    hash = BigInt.asUintN(64, (hash ^ BigInt(code >>> 8)) * 1099511628211n);
  }
  return hash.toString(16).padStart(16, '0');
}

function identity(context, namespace = '', session = '') {
  const seriesId = validID(context?.seriesId), episodeId = validID(context?.episodeId);
  const source = fingerprintSource(context?.sourceFingerprint);
  const scope = String(context?.namespace ?? namespace ?? '').trim();
  return seriesId && episodeId && source ? {seriesId, episodeId, source, namespace:fingerprintSource(scope || session), persistent:/^[a-f0-9]{64}$/i.test(scope)} : null;
}

export function validateSkipMarkers(markers, duration) {
  if (!durationValid(duration) || !markers || typeof markers !== 'object' || Array.isArray(markers)) return null;
  const result = {};
  for (const key of MARKS) {
    if (!Object.hasOwn(markers, key)) continue;
    const value = markers[key];
    if (!Number.isFinite(value) || value < 0 || value >= duration || key !== 'openingStart' && value === 0) return null;
    result[key] = value;
  }
  if (result.openingEnd !== undefined && (result.openingStart === undefined || result.openingEnd <= result.openingStart)) return null;
  if (result.creditsStart !== undefined && result.creditsStart < (result.openingEnd ?? result.openingStart ?? 0)) return null;
  return result;
}

export function activeSkipActions(markers, currentTime, duration) {
  const safe = validateSkipMarkers(markers, duration);
  if (!safe || !Number.isFinite(currentTime) || currentTime < 0 || currentTime >= duration) return {opening: false, credits: false};
  return {
    opening: safe.openingStart !== undefined && safe.openingEnd !== undefined && currentTime >= safe.openingStart && currentTime < safe.openingEnd,
    credits: safe.creditsStart !== undefined && currentTime >= safe.creditsStart
  };
}

export function nextEpisodeTrigger(markers, duration, preferences, {blockEarlyNext=false}={}) {
  const settings=normalizeSeriesPlaybackPreferences(preferences);
  if(!settings.autoNext || !durationValid(duration))return null;
  if(blockEarlyNext)return {at:duration,reason:'ended',approximate:false};
  const marks=validateSkipMarkers(markers,duration) || {};
  if(settings.nextMode!=='ended' && marks.creditsStart!==undefined)return {at:marks.creditsStart,reason:'credits',approximate:false};
  // A short clip must not be skipped almost in its entirety by the default.
  if(settings.nextMode==='offset' && duration>settings.endOffsetSeconds+SERIES_COUNTDOWN_SECONDS)
    return {at:duration-settings.endOffsetSeconds,reason:'offset',approximate:true};
  return {at:duration,reason:'ended',approximate:false};
}

export class EpisodeSkipStore {
  constructor(storage = browserStorage(), now = Date.now, {getNamespace = () => ''} = {}) {
    this.storage = storage; this.now = now; this.getNamespace=getNamespace;this.sessionScope=`unscoped-session-${++memoryScope}`;this.records = new Map();
    try {
      const text = storage?.getItem(STORAGE_KEY);
      if (!text || text.length > 262144) return;
      const saved = JSON.parse(text);
      // Version 1 had no account namespace. Never adopt those marks for a user.
      if (saved?.version !== 2 || !Array.isArray(saved.episodes)) return;
      for (const record of saved.episodes.slice(0, MAX_EPISODES)) {
        if (!record || typeof record.seriesId !== 'string' || typeof record.episodeId !== 'string' ||
            !ID.test(record.seriesId) || !ID.test(record.episodeId) || typeof record.source !== 'string' || !/^[a-f0-9]{16}$/.test(record.source) ||
            typeof record.namespace!=='string' || !/^[a-f0-9]{16}$/.test(record.namespace) ||
            !Number.isFinite(record.updatedAt) || record.updatedAt < 0) continue;
        const marks = validateSkipMarkers(record.marks, record.duration);
        if (marks && Object.keys(marks).length) this.records.set(`${record.namespace}:${record.seriesId}:${record.episodeId}`, {namespace:record.namespace,seriesId: record.seriesId, episodeId: record.episodeId, source: record.source, duration: record.duration, marks, updatedAt: record.updatedAt,persistent:true});
      }
    } catch { /* Marking still works in the current session. */ }
  }
  identity(context) {return identity(context,this.getNamespace(),this.sessionScope);}
  key(context) {const value=this.identity(context);return value?`${value.namespace}:${value.seriesId}:${value.episodeId}`:null;}
  has(context) {return this.records.has(this.key(context));}
  clearTransient() {for(const [key,record]of this.records)if(!record.persistent)this.records.delete(key);}
  read(context, duration) {
    const current = this.identity(context);
    if (!current || !durationValid(duration)) return {marks: {}, incompatible: false};
    const record = this.records.get(this.key(context));
    const matches = record && record.source === current.source && Math.round(record.duration * 1000) === Math.round(duration * 1000);
    return {marks: matches ? {...record.marks} : {}, incompatible: Boolean(record && !matches)};
  }
  save(context, duration, marks) {
    const current = this.identity(context), safe = validateSkipMarkers(marks, duration);
    if (!current || !safe || !Object.keys(safe).length) return false;
    const key = this.key(context);
    this.records.set(key, {...current, duration, marks: safe, updatedAt: this.now()});
    const ordered = [...this.records.entries()].sort((first, second) => Number(second[0] === key) - Number(first[0] === key) || second[1].updatedAt - first[1].updatedAt);
    this.records = new Map(ordered.slice(0, MAX_EPISODES));
    return current.persistent && this.persist();
  }
  clear(context) {
    const key=this.key(context);if(!key)return false;
    const persistent=this.records.get(key)?.persistent;this.records.delete(key);return persistent!==false && this.persist();
  }
  persist() {
    try {
      if (typeof this.storage?.setItem !== 'function') return false;
      const episodes=[...this.records.values()].filter(record=>record.persistent).map(({persistent,...record})=>record);
      this.storage.setItem(STORAGE_KEY, JSON.stringify({version: 2, episodes})); return true;
    } catch { return false; }
  }
}

function timeLabel(value) {
  if (!Number.isFinite(value)) return 'Não marcado';
  const seconds = Math.floor(value), hours = Math.floor(seconds / 3600);
  const minutes = String(Math.floor(seconds / 60) % 60).padStart(2, '0'), remainder = String(seconds % 60).padStart(2, '0');
  return hours ? `${hours}:${minutes}:${remainder}` : `${minutes}:${remainder}`;
}

export class EpisodeSkipController {
  constructor({video, storage, document = globalThis.document, preferences, getNamespace = () => '', getEpisodeMarkers, onSeek,
    onNextEpisode, hasNextEpisode = () => false, notify = () => {}, onAction = () => {}, now = Date.now,
    schedule = (callback, delay) => globalThis.setTimeout(callback,delay), cancel = timer => globalThis.clearTimeout(timer)}) {
    this.video = video; this.document = document; this.getNamespace=getNamespace;this.preferences=preferences;
    this.now=now;this.schedule=schedule;this.cancel=cancel;this.timer=null;this.generation=0;
    this.store = new EpisodeSkipStore(storage,now,{getNamespace});
    this.options = {onNextEpisode, hasNextEpisode, notify, onAction,onSeek,getEpisodeMarkers}; this.context = null; this.disposers = [];
    this.build();
    for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'seeked', 'seeking', 'playing', 'pause', 'waiting', 'stalled', 'ended', 'error']) this.listen(video, event, () => {
      if(event==='loadedmetadata')this.metadataReady=true;
      if(event==='playing')this.playing=true;
      if(['pause','waiting','stalled','seeking','ended','error'].includes(event))this.playing=false;
      if(event==='ended')this.ended=true;
      // A completed seek can still be waiting for decoded frames. Only the
      // subsequent playing event resumes automatic actions and their clock.
      this.update();
    });
    this.unsubscribePreferences=preferences?.subscribe?.(()=>this.update());
    this.reset();
  }
  node(tag, className, text) {
    const node = this.document.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text; return node;
  }
  listen(target, event, callback) { target.addEventListener(event, callback); this.disposers.push(() => target.removeEventListener(event, callback)); }
  button(label, callback, className) {
    const button = this.node('button', className, label); button.type = 'button'; this.listen(button, 'click', callback); return button;
  }
  build() {
    this.panel = this.node('section', 'episode-skip-panel'); this.panel.setAttribute('aria-label', 'Marcar abertura e créditos');
    const heading = this.node('div', 'episode-skip-heading');
    heading.append(this.node('h3', '', 'Marcar abertura e créditos'));
    this.panel.append(heading, this.node('p', 'episode-skip-description', 'Use o tempo atual para marcar os trechos deste episódio. As marcações ficam salvas neste navegador.'));
    const grid = this.node('div', 'episode-skip-markers'); this.markerValues = new Map(); this.markerButtons = new Map();
    for (const [key, label] of [['openingStart', 'Início da abertura'], ['openingEnd', 'Fim da abertura'], ['creditsStart', 'Início dos créditos']]) {
      const row = this.node('div', 'episode-skip-marker'), copy = this.node('div', 'episode-skip-marker-copy'), value = this.node('strong', 'episode-skip-value', 'Não marcado');
      const button = this.button('Marcar agora', () => this.mark(key), 'episode-skip-mark'); button.setAttribute('aria-label', `Marcar ${label.toLowerCase()} no tempo atual`);
      copy.append(this.node('span', '', label), value); row.append(copy, button); grid.append(row);
      this.markerValues.set(key, value); this.markerButtons.set(key, button);
    }
    this.clearButton = this.button('Apagar marcações', () => this.clear(), 'episode-skip-clear');
    this.catalogSource=this.node('p','episode-skip-description episode-marker-source');this.catalogSource.hidden=true;
    this.status = this.node('p', 'episode-skip-status'); this.status.setAttribute('role', 'status');
    this.panel.append(grid,this.catalogSource, this.status, this.clearButton);
    this.overlay = this.node('div', 'episode-skip-actions'); this.overlay.setAttribute('role', 'group'); this.overlay.setAttribute('aria-label', 'Pular trechos marcados');
    this.openingButton = this.button('Pular abertura', () => this.skipOpening(), 'episode-skip-action');
    this.creditsButton = this.button('Pular final', () => this.skipCredits(), 'episode-skip-action');
    this.openingCountdownPanel=this.node('section','episode-next-countdown episode-opening-countdown');this.openingCountdownPanel.hidden=true;this.openingCountdownPanel.setAttribute('aria-label','Pular abertura');
    this.openingCountdownTitle=this.node('strong','episode-next-title');this.openingCountdownTitle.setAttribute('role','status');this.openingCountdownTitle.setAttribute('aria-live','polite');
    const openingActions=this.node('div','episode-next-buttons');
    this.skipOpeningNowButton=this.button('Pular agora',()=>this.skipOpening(),'episode-skip-action episode-next-now');
    this.cancelOpeningButton=this.button('Cancelar',()=>this.cancelAutoOpening(),'episode-skip-action episode-next-cancel');openingActions.append(this.skipOpeningNowButton,this.cancelOpeningButton);
    this.openingCountdownDetail=this.node('span','episode-next-detail','Você pode cancelar para assistir à abertura.');
    this.openingCountdownPanel.append(this.openingCountdownTitle,this.openingCountdownDetail,openingActions);
    this.countdownPanel=this.node('section','episode-next-countdown');this.countdownPanel.hidden=true;this.countdownPanel.setAttribute('aria-label','Próximo episódio');
    this.countdownTitle=this.node('strong','episode-next-title');this.countdownTitle.setAttribute('role','status');this.countdownTitle.setAttribute('aria-live','polite');
    this.countdownDetail=this.node('span','episode-next-detail');
    const actions=this.node('div','episode-next-buttons');
    this.playNextButton=this.button('Reproduzir agora',()=>this.advanceNext({automatic:false}),'episode-skip-action episode-next-now');
    this.cancelNextButton=this.button('Cancelar',()=>this.cancelAutoNext(),'episode-skip-action episode-next-cancel');actions.append(this.playNextButton,this.cancelNextButton);
    this.countdownPanel.append(this.countdownTitle,this.countdownDetail,actions);
    this.overlay.append(this.openingButton, this.creditsButton,this.openingCountdownPanel,this.countdownPanel);
  }
  attach({item, episode, sourceFingerprint} = {}) {
    this.reset();
    const context = {seriesId: item?.id, episodeId: episode?.id, sourceFingerprint,namespace:String(this.getNamespace()||'')};
    if (item?.kind !== 'series' || !this.store.identity(context)) return;
    this.context = context;this.episodeContext={item,episode,sourceFingerprint};this.metadataReady=this.video.readyState===undefined || this.video.readyState>=1;
    this.playing=this.video.paused===false && (this.video.readyState===undefined || this.video.readyState>=2);this.update();
  }
  reset() {
    this.externalController?.abort();this.externalController=null;this.externalKey=null;this.externalResult=null;
    this.generation++;this.stopCountdown();this.stopOpeningCountdown();this.metadataReady=false;this.playing=false;this.ended=false;
    this.openingSkipped=false;this.openingPending=false;this.openingCancelledStart=null;this.nextInvoked=false;this.cancelledThreshold=null;this.preferenceSignature='';
    this.context = null;this.episodeContext=null; this.panel.hidden = true; this.overlay.hidden = true;
    this.openingButton.hidden = true; this.creditsButton.hidden = true; this.setStatus('');
  }
  clearSessionMarkers(){this.store.clearTransient();this.update();}
  refreshExternalMarkers(){
    this.externalController?.abort();this.externalController=null;this.externalKey=null;this.externalResult=null;
    this.stopOpeningCountdown();this.stopCountdown();if(this.context)this.update();
  }
  setStatus(text) { if (this.status.textContent !== text) this.status.textContent = text; }
  loadExternalMarkers(duration){
    if(typeof this.options.getEpisodeMarkers!=='function')return;
    const key=Math.round(duration*1000);if(this.externalKey===key)return;
    this.externalController?.abort();const controller=new AbortController(),generation=this.generation,namespace=this.context.namespace;
    this.externalController=controller;this.externalKey=key;this.externalResult=null;
    const accept=(value,notify=false)=>{
      if(controller.signal.aborted||generation!==this.generation||namespace!==String(this.getNamespace()||'')||Math.round(this.video.duration*1000)!==key)return;
      const raw=value?.status===undefined?value?.marks:value.status==='matched'?value.markers:null;
      const marks=validateSkipMarkers(raw,duration);
      this.externalResult=marks?{marks,blockEarlyNext:value.blockEarlyNext===true,source:value.confidence==='community-reference'?'Tempos comunitários em teste':value.confidence==='edition-verified'?'Tempos conferidos para esta edição':typeof value.source==='string'?value.source:'Tempos do catálogo',confidence:value.confidence}:null;
      if(notify)this.update();
    };
    try{
      const input={...this.episodeContext,duration};
      // Non-enumerable signal preserves the existing synchronous callback
      // contract while supplying cancellation to asynchronous adapters.
      Object.defineProperty(input,'signal',{value:controller.signal,enumerable:false});
      const supplied=this.options.getEpisodeMarkers(input);
      if(supplied?.then)Promise.resolve(supplied).then(value=>accept(value,true),()=>{});else accept(supplied);
    }catch{/* Optional markers never interrupt the video or manual markings. */}
  }
  state() {
    const duration = this.video.duration, currentTime = this.video.currentTime;
    const ready = Boolean(this.context) && this.metadataReady && durationValid(duration) && Number.isFinite(currentTime) && currentTime >= 0 && currentTime < duration && !this.video.error;
    const manual=this.store.read(this.context,duration);
    if(this.context && this.metadataReady && durationValid(duration))this.loadExternalMarkers(duration);
    const supplied=this.externalResult;let external=validateSkipMarkers(supplied?.marks,duration)||{};
    if(supplied?.blockEarlyNext===true){external={...external};delete external.creditsStart;}
    // An incomplete manual opening intentionally suppresses the imported pair
    // until the user finishes marking it. Never mix two different windows.
    if(manual.marks.openingStart!==undefined || manual.marks.openingEnd!==undefined){external={...external};delete external.openingStart;delete external.openingEnd;}
    const marks=validateSkipMarkers({...external,...manual.marks},duration)||manual.marks;
    const blockEarlyNext=supplied?.blockEarlyNext===true&&manual.marks.creditsStart===undefined;
    return {duration,currentTime,ready,...manual,marks,manualMarks:manual.marks,blockEarlyNext,markerSource:(Object.keys(external).length||blockEarlyNext)&&typeof supplied?.source==='string'?supplied.source:null};
  }
  isPlaying(){return this.playing && this.video.paused===false && !this.video.seeking && this.video.readyState>=2;}
  update() {
    if (!this.context) return;
    if(this.context.namespace!==String(this.getNamespace()||'')){this.reset();return;}
    const state = this.state(), active = state.ready ? activeSkipActions(state.marks, state.currentTime, state.duration) : {opening: false, credits: false};
    const preferences=normalizeSeriesPlaybackPreferences(this.preferences?.getPreferences?.());
    const signature=JSON.stringify(preferences);if(this.preferenceSignature && signature!==this.preferenceSignature){this.stopCountdown();this.stopOpeningCountdown();}this.preferenceSignature=signature;
    if(state.currentTime<state.duration-.5)this.ended=false;
    if(this.cancelledThreshold!==null && state.currentTime<this.cancelledThreshold-1)this.cancelledThreshold=null;
    if(this.openingCancelledStart!==null && state.currentTime<this.openingCancelledStart-1)this.openingCancelledStart=null;
    this.panel.hidden = false; this.openingButton.hidden = !active.opening; this.creditsButton.hidden = !active.credits;
    for (const [key, value] of this.markerValues) { const text = timeLabel(state.marks[key]); if (value.textContent !== text) value.textContent = text; }
    for (const button of this.markerButtons.values()) button.disabled = !state.ready;
    this.markerButtons.get('openingEnd').disabled = !state.ready || state.marks.openingStart === undefined || state.currentTime <= state.marks.openingStart;
    this.markerButtons.get('creditsStart').disabled = !state.ready || state.currentTime <= 0;
    this.clearButton.disabled = !this.store.has(this.context);
    this.catalogSource.hidden=!state.markerSource;this.catalogSource.textContent=state.markerSource?state.markerSource+(state.blockEarlyNext?' · preservar conteúdo final':''):'';
    this.openingCountdownDetail.textContent=`${state.markerSource?state.markerSource+' · ':''}Você pode cancelar para assistir à abertura.`;
    if (state.incompatible) this.setStatus('As marcações salvas pertencem a outra versão deste episódio. Marque os trechos novamente.');
    else if (!state.ready && !durationValid(state.duration)) this.setStatus('Aguarde o vídeo carregar para marcar os trechos.');
    else if (this.status.textContent === 'Aguarde o vídeo carregar para marcar os trechos.') this.setStatus('');
    this.updateOpeningCountdown(state,active,preferences);
    if(!this.openingCountdownPanel.hidden)this.openingButton.hidden=true;
    const trigger=nextEpisodeTrigger(state.marks,state.duration,preferences,{blockEarlyNext:state.blockEarlyNext});
    if(!this.openingCountdownPanel.hidden)this.stopCountdown();else this.updateCountdown(trigger,state,preferences);
    if(!this.countdownPanel.hidden)this.creditsButton.hidden=true;
    this.overlay.hidden=this.openingButton.hidden && this.creditsButton.hidden && this.openingCountdownPanel.hidden && this.countdownPanel.hidden;
  }
  stopOpeningCountdown(){
    if(this.openingTimer!==null && this.openingTimer!==undefined)this.cancel(this.openingTimer);this.openingTimer=null;this.openingCountdown=null;
    if(this.openingCountdownPanel)this.openingCountdownPanel.hidden=true;
  }
  updateOpeningCountdown(state,active,preferences){
    if(!state.ready || !active.opening || !preferences.autoSkipOpening || this.openingSkipped || this.openingPending || this.openingCancelledStart!==null){this.stopOpeningCountdown();return;}
    const start=state.marks.openingStart,end=state.marks.openingEnd;
    if(this.openingCountdown && (this.openingCountdown.start!==start || this.openingCountdown.end!==end))this.stopOpeningCountdown();
    // Do not rush or flash an automatic offer after entering the last seconds
    // of an opening. The explicit manual action remains available instead.
    if(!this.openingCountdown && end-state.currentTime<SERIES_COUNTDOWN_SECONDS){this.stopOpeningCountdown();return;}
    if(this.openingTimer!==null)this.cancel(this.openingTimer);this.openingTimer=null;
    if(!this.openingCountdown)this.openingCountdown={start,end,remaining:SERIES_COUNTDOWN_SECONDS*1000,deadline:null};
    const countdown=this.openingCountdown,canRun=this.isPlaying();
    if(canRun){
      if(countdown.deadline===null)countdown.deadline=this.now()+countdown.remaining;
      countdown.remaining=Math.max(0,countdown.deadline-this.now());
    }else if(countdown.deadline!==null){countdown.remaining=Math.max(0,countdown.deadline-this.now());countdown.deadline=null;}
    if(end-state.currentTime+.35<countdown.remaining/1000){this.stopOpeningCountdown();return;}
    this.openingCountdownPanel.hidden=false;
    const seconds=Math.max(1,Math.ceil(countdown.remaining/1000));
    const title=canRun?`Pular abertura em ${seconds}s`:`Abertura · contagem pausada · ${seconds}s`;
    if(this.openingCountdownTitle.textContent!==title)this.openingCountdownTitle.textContent=title;
    if(canRun && countdown.remaining<=0){this.skipOpening();return;}
    if(canRun){const generation=this.generation;this.openingTimer=this.schedule(()=>{this.openingTimer=null;if(generation===this.generation)this.update();},Math.min(250,countdown.remaining));}
  }
  cancelAutoOpening(){
    if(!this.openingCountdown)return false;
    this.openingCancelledStart=this.openingCountdown.start;this.stopOpeningCountdown();this.setStatus('Abertura automática cancelada para este episódio.');this.update();return true;
  }
  stopCountdown(){
    if(this.timer!==null)this.cancel(this.timer);this.timer=null;this.countdown=null;
    if(this.countdownPanel)this.countdownPanel.hidden=true;
  }
  updateCountdown(trigger,state,preferences){
    const ended=this.ended || this.video.ended===true;
    if(!trigger || !this.metadataReady || this.video.error || !this.options.hasNextEpisode() || this.nextInvoked ||
      this.cancelledThreshold!==null || !Number.isFinite(state.currentTime) || (!ended && state.currentTime<trigger.at)){
      this.stopCountdown();return;
    }
    if(this.timer!==null)this.cancel(this.timer);this.timer=null;
    if(!this.countdown || this.countdown.at!==trigger.at || this.countdown.reason!==trigger.reason)
      this.countdown={...trigger,remaining:SERIES_COUNTDOWN_SECONDS*1000,deadline:null,generation:this.generation};
    const countdown=this.countdown,canRun=ended || this.isPlaying();
    if(canRun){
      if(countdown.deadline===null)countdown.deadline=this.now()+countdown.remaining;
      countdown.remaining=Math.max(0,countdown.deadline-this.now());
    }else if(countdown.deadline!==null){countdown.remaining=Math.max(0,countdown.deadline-this.now());countdown.deadline=null;}
    this.countdownPanel.hidden=false;
    const seconds=Math.max(1,Math.ceil(countdown.remaining/1000));
    const title=canRun?`Próximo episódio em ${seconds}s`:`Contagem pausada · ${seconds}s`;
    if(this.countdownTitle.textContent!==title)this.countdownTitle.textContent=title;
    this.countdownDetail.textContent=countdown.reason==='credits'?`${state.markerSource?state.markerSource+' · ':''}Créditos marcados neste episódio`:countdown.reason==='offset'?`Últimos ${preferences.endOffsetSeconds}s · horário aproximado`:state.blockEarlyNext?'Episódio concluído · preservar conteúdo final':'Episódio concluído';
    if(canRun && countdown.remaining<=0){this.advanceNext();return;}
    if(canRun){const generation=this.generation;this.timer=this.schedule(()=>{this.timer=null;if(generation===this.generation)this.update();},Math.min(250,countdown.remaining));}
  }
  cancelAutoNext(){
    if(!this.countdown)return false;
    this.cancelledThreshold=this.countdown.at;this.stopCountdown();this.setStatus('Reprodução automática cancelada para este episódio.');this.update();return true;
  }
  advanceNext({automatic=true,reason}={}){
    if(!this.context || this.nextInvoked || !this.options.hasNextEpisode() || typeof this.options.onNextEpisode!=='function')return false;
    const trigger=this.countdown;reason=reason || (trigger?.reason==='ended'?'ended':'credits');
    this.nextInvoked=true;this.stopCountdown();const generation=this.generation;
    try{Promise.resolve(this.options.onNextEpisode({automatic,reason,approximate:Boolean(trigger?.approximate)})).catch(()=>{if(generation===this.generation)this.options.notify('Não foi possível abrir o próximo episódio.');});this.options.onAction();return true;}
    catch{if(generation===this.generation)this.options.notify('Não foi possível abrir o próximo episódio.');return false;}
  }
  mark(key) {
    const state = this.state();
    if (!state.ready || !MARKS.includes(key)) return false;
    const baseline={...state.manualMarks};
    if(key==='openingEnd' && baseline.openingStart===undefined && state.marks.openingStart!==undefined)baseline.openingStart=state.marks.openingStart;
    const marks = validateSkipMarkers({...baseline, [key]: state.currentTime}, state.duration);
    if (!marks) { this.setStatus('O fim da abertura deve vir depois do início; os créditos devem vir depois da abertura.'); return false; }
    const saved = this.store.save(this.context, state.duration, marks);
    this.setStatus(saved ? 'Marcação salva para este episódio.' : 'Marcação aplicada nesta sessão; o navegador não permitiu salvar.'); this.update(); return true;
  }
  clear() {
    if (!this.context) return;
    const saved = this.store.clear(this.context);
    this.setStatus(saved ? 'Marcações deste episódio apagadas.' : 'Marcações apagadas nesta sessão; o navegador não permitiu salvar.'); this.update();
  }
  skipOpening() {
    const state = this.state();
    if (!state.ready || !activeSkipActions(state.marks, state.currentTime, state.duration).opening) return false;
    this.openingSkipped=true;this.stopOpeningCountdown();
    try {return this.seekTo(state.marks.openingEnd,'opening');}
    catch { this.options.notify('Este vídeo não permitiu avançar agora.'); return false; }
  }
  skipCredits() {
    const state = this.state();
    if (!state.ready || !activeSkipActions(state.marks, state.currentTime, state.duration).credits) return false;
    try {
      if (this.options.hasNextEpisode() && typeof this.options.onNextEpisode === 'function') {
        return this.advanceNext({automatic:false,reason:'credits'});
      } else return this.seekTo(state.duration,'credits');
    } catch { this.options.notify('Este vídeo não permitiu avançar agora.'); return false; }
  }
  seekTo(target,reason){
    const generation=this.generation;
    if(typeof this.options.onSeek==='function'){
      const result=this.options.onSeek(target,{reason});if(result===false)return false;
      if(result?.then){this.openingPending=reason==='opening';Promise.resolve(result).then(success=>{if(generation!==this.generation)return;this.openingPending=false;if(success===false)this.options.notify('Este vídeo não permitiu avançar agora.');this.update();},()=>{if(generation!==this.generation)return;this.openingPending=false;this.options.notify('Este vídeo não permitiu avançar agora.');});}
    }else this.video.currentTime=target;
    this.update();this.options.onAction();return true;
  }
  destroy() { this.reset();this.unsubscribePreferences?.();this.disposers.forEach(dispose => dispose()); this.disposers = []; this.panel.remove(); this.overlay.remove(); }
}

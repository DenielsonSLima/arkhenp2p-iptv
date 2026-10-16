import { EpisodeSkipController } from '../episode-skip.js';
import { programWindow } from '../program-guide.js';
import { PlaybackLoader } from '../playback-loader.js';
export { parseProgramTime, programWindow } from '../program-guide.js';

import {element, control} from './dom.js';
import {VolumeControl} from './controles/volume.js';
import {PlaybackControl} from './controles/reproducao.js';
import {TVPlayerNavigation} from '../tv/player/navegacao.js';
import {numberedChannels} from '../tv/player/canais.js';
import {TVPlayerGuide} from '../tv/player/grade.js';
import {handlePlayerKeydown} from './teclado.js';
export {numberedChannels, channelNeighbors} from '../tv/player/canais.js';

const text = value => String(value ?? '').trim();
export function formatMediaTime(value) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0) return '00:00';
  const seconds = Math.floor(Number(value)), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? hours + ':' : ''}${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
export function loadingEstimate(samples = []) {
  const usable = samples.filter(value => Number.isFinite(value) && value > 0 && value <= 120000).slice(-8).sort((a, b) => a - b);
  if (!usable.length) return null;
  const middle = Math.floor(usable.length / 2);
  return usable.length % 2 ? usable[middle] : (usable[middle - 1] + usable[middle]) / 2;
}

export class ImmersivePlayer {
  constructor(options) {
    this.options = options; this.video = options.video; this.stage = options.stage;
    if (!this.video || !this.stage) throw new Error('O player precisa do vídeo e de sua área de reprodução.');
    this.current = null; this.channels = null; this.programs = null; this.disposers = [];this.channelSwitchActive=false;
    this.hideTimer = null; this.digitTimer = null; this.tickTimer = null; this.digits = ''; this.hovering = false; this.seeking = false; this.keyboardMode = false;
    this.samples = {live: [], vod: []};
    try { const saved = JSON.parse(localStorage.getItem('arkehn.player-startup.v1') || '{}'); for (const key of ['live', 'vod']) if (Array.isArray(saved?.[key])) this.samples[key] = saved[key].filter(value => Number.isFinite(value) && value > 0 && value <= 120000).slice(-8); } catch {}
    this.video.controls = false; this.video.removeAttribute('controls');
    this.stage.classList.add('immersive-stage'); this.stage.tabIndex = 0; this.stage.setAttribute('aria-label', 'Área de reprodução');
    this.tvNavigation=new TVPlayerNavigation({getChannels:()=>this.channelEntries(),getCurrent:()=>this.current,
      onPreview:(_entry,detail)=>this.previewChanged(detail),onCommit:(entry,options)=>this.switchChannel(entry,options)});
    this.build();
    this.episodeSkip = new EpisodeSkipController({
      video:this.video, onNextEpisode:options => this.options.onNextEpisode?.(options),
      hasNextEpisode:() => Boolean(this.options.getPlayer?.()?.next),
      preferences:this.options.seriesPlaybackPreferences,
      getNamespace:this.options.getAccountNamespace || (()=>''),
      getEpisodeMarkers:context=>this.options.getEpisodeMarkers?.(context),
      onConfigureMarkers:()=>{this.tools.hidden=false;this.settingsButton.setAttribute('aria-expanded','true');this.settingsButton.setAttribute('aria-label','Fechar ajustes de reprodução');this.reveal();this.episodeSkip.markerButtons.get('openingStart')?.focus?.();},
      onSeek:(target,options)=>this.requestSeek(target,options),
      notify:message => this.options.toast?.(message), onAction:() => this.reveal()
    });
    this.root.append(this.episodeSkip.overlay);
    this.tools.append(this.episodeSkip.panel);
    this.bind();
  }
  listen(target, event, callback, options) { target.addEventListener(event, callback, options); this.disposers.push(() => target.removeEventListener(event, callback, options)); }
  build() {
    this.root = element('div', 'ip-root'); this.root.hidden = true;
    this.playbackLoader = new PlaybackLoader({video: this.video}); this.loading = this.playbackLoader.root;
    this.error = element('div', 'ip-error'); this.error.hidden = true; this.error.setAttribute('role', 'alert');
    this.errorMessage = element('p', 'ip-error-message'); this.retryButton = control('Tentar novamente', 'play', () => this.options.onRetry?.());
    this.retryButton.classList.add('ip-retry'); this.error.append(element('span', 'ip-error-title', 'Sua transmissão foi interrompida'), this.errorMessage, this.retryButton);

    this.info = element('section', 'ip-information'); this.info.setAttribute('aria-label', 'Informações da reprodução');
    this.vodHeading=element('div','ip-information-heading');
    const headingText=element('div','ip-information-copy');this.kind=element('span','ip-kind');this.title=element('h2','ip-title');
    headingText.append(this.kind,this.title);this.vodHeading.append(headingText);
    this.tvGuide=new TVPlayerGuide({navigation:this.tvNavigation,guide:this.options.programGuide,request:this.options.api,
      getNamespace:()=>this.options.getProgramNamespace?.() ?? this.options.getSourceNamespace?.() ?? ''});
    this.info.append(this.vodHeading,...this.tvGuide.nodes);
    this.closeButton = control('Fechar reprodução', 'close', () => this.close()); this.closeButton.classList.add('ip-close');
    this.typed = element('div', 'ip-number-entry'); this.typed.hidden = true; this.typed.setAttribute('role', 'status');
    this.typed.append(element('span', '', 'CANAL')); this.typedNumber = element('strong'); this.typed.append(this.typedNumber);

    this.controls = element('div', 'ip-controls'); this.controls.setAttribute('role', 'group'); this.controls.setAttribute('aria-label', 'Controles do vídeo');
    this.liveTimeline = element('div', 'ip-live-timeline'); this.liveTimeline.hidden = true;
    const programLine = element('div', 'ip-live-program-line'); this.liveProgramName = element('span'); this.liveProgramTime = element('span'); programLine.append(this.liveProgramName, this.liveProgramTime);
    this.liveProgress = element('progress', 'ip-live-progress'); this.liveProgress.max = 100; this.liveProgress.value = 0; this.liveProgress.setAttribute('aria-label', 'Tempo do programa atual');
    this.liveTimeline.append(programLine, this.liveProgress);
    this.seekRow = element('div', 'ip-seek-row'); this.seek = element('input', 'ip-seek'); this.seek.type = 'range'; this.seek.min = '0'; this.seek.max = '1'; this.seek.step = '.25'; this.seek.value = '0'; this.seek.disabled = true; this.seek.setAttribute('aria-label', 'Posição no vídeo');
    this.seekRow.append(this.seek);
    const bottom = element('div', 'ip-controls-row');
    this.playbackControl=new PlaybackControl({video:this.video,onAction:()=>this.reveal(),notify:message=>this.options.toast?.(message)});this.playButton=this.playbackControl.button;
    this.live = element('span', 'ip-live', 'AO VIVO'); this.live.hidden = true;
    this.time = element('span', 'ip-time', '00:00 / 00:00');
    this.volumeControl=new VolumeControl({video:this.video,onChange:value=>this.options.onVolumeChange?.(value),notify:message=>this.options.toast?.(message),onAction:()=>this.reveal()});
    this.volumeButton=this.volumeControl.button;this.volume=this.volumeControl.input;
    const spacer = element('span', 'ip-control-spacer');
    this.nextButton = control('Próximo episódio', 'next', () => this.options.onNextEpisode?.()); this.nextButton.hidden = true;
    this.settingsButton = control('Abrir ajustes de reprodução', 'settings', () => { this.tools.hidden = !this.tools.hidden; this.settingsButton.setAttribute('aria-expanded', String(!this.tools.hidden)); this.settingsButton.setAttribute('aria-label', this.tools.hidden ? 'Abrir ajustes de reprodução' : 'Fechar ajustes de reprodução'); this.reveal(); }); this.settingsButton.hidden = true; this.settingsButton.setAttribute('aria-expanded', 'false');
    this.fullscreenButton = control('Entrar em tela cheia', 'expand', () => this.toggleFullscreen());
    bottom.append(this.playButton, this.live, this.time, this.volumeControl.root, spacer, this.nextButton, this.settingsButton, this.fullscreenButton);
    this.controls.append(this.liveTimeline, this.seekRow, bottom);
    this.tools = element('div', 'ip-tools-slot'); this.tools.hidden = true;
    this.root.append(this.loading, this.error, this.info, this.closeButton, this.typed, this.tools, this.controls); this.stage.append(this.root);
  }
  bind() {
    for (const event of ['loadstart', 'waiting']) this.listen(this.video, event, () => { if (this.current && !(this.current.awaitingPlay && this.video.paused) && !(event === 'waiting' && this.video.paused)) this.setLoading(true, event === 'waiting' ? this.current.item.kind === 'live' ? 'Aguardando a transmissão' : 'Retomando seu vídeo' : 'Preparando sua sessão'); });
    for (const event of ['loadeddata', 'canplay']) this.listen(this.video, event, () => { if (this.current?.awaitingPlay && this.video.paused) this.setLoading(false); });
    this.listen(this.video, 'playing', () => { if (!this.current || this.current.failed) return; this.current.awaitingPlay = false; this.error.hidden = true; this.recordStart(); this.setLoading(false); this.updateControls(); });
    for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'progress', 'pause', 'play', 'ended']) this.listen(this.video, event, () => { if (this.current) { this.updateControls(); if (this.video.paused || this.video.ended) this.reveal(); } });
    // The transport controller owns retries and terminal failures. A media
    // element error during HLS recovery must not create a competing overlay.
    this.listen(this.video, 'error', () => { if(!this.options?.managedErrors)this.setFailure('Leitura do vídeo indisponível. Tente novamente ou escolha outra fonte.'); });
    this.listen(this.stage, 'pointermove', () => this.reveal()); this.listen(this.stage, 'pointerdown', event => { this.keyboardMode = false; if (event.target === this.stage || event.target === (this.video.element||this.video)) this.stage.focus({preventScroll: true}); this.reveal(); });
    this.listen(this.stage, 'focusin', () => this.reveal()); this.listen(this.stage, 'focusout', () => this.scheduleHide());
    for (const node of [this.controls, this.closeButton, this.tools, this.info]) {
      this.listen(node, 'pointerenter', () => { this.hovering = true; this.reveal(); });
      this.listen(node, 'pointerleave', () => { this.hovering = false; this.scheduleHide(); });
    }
    this.listen(this.seek, 'pointerdown', () => { this.seeking = true; });
    this.listen(this.seek, 'input', () => { this.seeking = true; this.time.textContent = `${formatMediaTime(this.seek.value)} / ${formatMediaTime(this.video.duration)}`; this.reveal(); });
    const commitSeek = () => { if (this.seeking && this.current?.item.kind !== 'live' && Number.isFinite(this.video.duration)) this.requestSeek(Number(this.seek.value),{reason:'user'}); this.seeking = false; this.updateControls(); this.scheduleHide(); };
    this.listen(this.seek, 'change', commitSeek); this.listen(this.seek, 'pointerup', commitSeek);
    this.listen(this.seek, 'pointercancel', () => { this.seeking = false; this.updateControls(); });
    this.listen(document, 'keydown', event => this.keydown(event));
    for (const event of ['fullscreenchange', 'webkitfullscreenchange']) this.listen(document, event, () => this.updateFullscreen());
  }
  attach({item, episode = null, channelNumber = null, initialProgram = null, continuation = null}) {
    this.reset(); this.video.controls = false; this.video.removeAttribute('controls');
    const source = this.channelEntries().find(entry => String(entry.item.id) === String(item.id));
    const startedAt = performance.now();
    const continuing=item.kind==='live'&&continuation&&Number.isFinite(continuation.startedAt)&&Number.isFinite(continuation.loadStartedAt);
    this.current = {item, episode, channelNumber: channelNumber ?? source?.number ?? null, loading: true, failed: false, startedAt:continuing?continuation.startedAt:startedAt, loadStartedAt:continuing?continuation.loadStartedAt:startedAt, recorded:continuing?Boolean(continuation.recorded):false};
    this.programs=initialProgram;
    this.playbackLoader.attach({item, episode});
    if(this.channelSwitchActive)this.playbackLoader.hide({immediate:true});
    this.episodeSkip.attach({item, episode, sourceFingerprint:`${this.options.getSourceNamespace?.() || 'iptv'}:${item.kind}:${item.id}:${episode?.id || ''}:${episode?.container || item.container || 'mp4'}`});
    this.root.hidden = false; this.root.classList.remove('ip-hidden'); this.stage.classList.add('ip-active'); this.error.hidden = true;
    this.stage.setAttribute('aria-label', `Reprodução de ${text(item.name)}`);
    this.kind.textContent = item.kind === 'live' ? 'TV AO VIVO' : item.kind === 'series' ? 'SÉRIE' : 'CINEMA';
    this.title.textContent = episode ? `${text(item.name)} · ${text(episode.title) || 'Episódio'}` : text(item.name);
    this.vodHeading.hidden=item.kind==='live';this.renderChannelNeighbors();this.renderProgram();this.updateControls();this.setLoading(true,continuing&&continuation.recorded?'Restabelecendo a transmissão':'Preparando sua sessão');
    this.tickTimer = setInterval(() => { if (!this.current) return; this.updateLoading(); this.updateControls(); }, 1000);
    this.reveal();
  }
  preparationContinuation(){
    const current=this.current;if(!current||current.item.kind!=='live')return null;
    return {startedAt:current.startedAt,loadStartedAt:current.loading?current.loadStartedAt:performance.now(),recorded:current.recorded};
  }
  reset() {
    this.playbackLoader?.reset();
    this.episodeSkip?.reset();
    this.tvNavigation?.reset();this.tvGuide?.reset();
    clearTimeout(this.hideTimer); clearTimeout(this.digitTimer); clearInterval(this.tickTimer);
    this.hideTimer = this.digitTimer = this.tickTimer = null; this.current = null; this.programs = null; this.digits = ''; this.hovering = false; this.seeking = false; this.keyboardMode = false;
    if (this.root) { this.root.hidden = true; this.root.classList.remove('ip-hidden'); this.typed.hidden = true; this.error.hidden = true; this.tools.hidden = true; this.settingsButton.setAttribute('aria-expanded', 'false'); this.settingsButton.setAttribute('aria-label', 'Abrir ajustes de reprodução'); this.stage.classList.remove('ip-active', 'ip-loading-active'); }
    if (this.info) this.renderChannelNeighbors();
  }
  setChannels(channels) {
    this.channels = numberedChannels(channels);
    if (this.current?.item.kind === 'live') { const found = this.channels.find(entry => String(entry.item.id) === String(this.current.item.id)); if (found) this.current.channelNumber = found.number; }
    this.tvNavigation.sync();this.renderChannelNeighbors();
  }
  setTools(node) { this.tools.replaceChildren(); if (node) this.tools.append(node); this.tools.append(this.episodeSkip.panel); this.tools.hidden = true; this.settingsButton.hidden = !node && !this.current?.episode; this.settingsButton.setAttribute('aria-expanded', 'false'); }
  setEpisodeSequence({episode}) {
    if(!this.current||this.current.item.kind!=='series'||String(this.current.episode?.id)!==String(episode?.id))return;
    const previous=this.current.episode;this.current.episode=episode;
    if(previous?.season!==episode.season||previous?.number!==episode.number){
      if(this.episodeSkip.episodeContext)this.episodeSkip.episodeContext.episode=episode;
      this.episodeSkip.refreshExternalMarkers();
    }
    this.updateControls();this.episodeSkip.update();
  }
  channelEntries() { try { return numberedChannels(this.options.getChannels ? this.options.getChannels() : this.channels || []); } catch { return this.channels || []; } }
  renderChannelNeighbors() {
    const live=this.current?.item.kind==='live';this.info.classList.toggle('ip-live-information',Boolean(live));
    this.tvGuide.setContext({current:this.current,programs:this.programs});
  }
  previewChanged({reason}={}) {
    const hadGuideFocus=this.tvGuide.nodes.some(node=>node.contains(document.activeElement));
    this.renderChannelNeighbors();
    if(hadGuideFocus&&(reason==='browse'||reason==='expired'))this.stage.focus({preventScroll:true});
    if(reason==='expired'){
      this.info.classList.add('ip-guide-dismissed');
    }else{if(reason==='browse')this.info.classList.remove('ip-guide-dismissed');this.reveal();}
  }
  navigateChannel(step) { this.reveal();this.tvNavigation.zap(step); }
  setProgram(data = {}) { this.programs = data; this.renderProgram(); }
  renderProgram() {
    if(!this.current)return;
    this.tvGuide.setContext({current:this.current,programs:this.programs});
    const program=this.current.item.kind==='live'?programWindow(this.programs).current:null;this.liveTimeline.hidden=!program;
    this.liveTimeline.dataset.stale=String(Boolean(this.programs?.stale));
    if(program){this.liveProgramName.textContent=program.title;this.liveProgramTime.textContent=[program.startLabel,program.endLabel].filter(Boolean).join(' — ');this.liveProgress.value=this.programs.progressPercent;}
  }
  setChannelSwitchActive(active) {
    this.channelSwitchActive=Boolean(active);this.root.classList.toggle('ip-channel-switching',this.channelSwitchActive);
    if(this.channelSwitchActive){
      this.tvNavigation.reset();clearTimeout(this.digitTimer);this.digitTimer=null;this.digits='';this.typed.hidden=true;
      const hadGuideFocus=this.tvGuide.nodes.some(node=>node.contains(document.activeElement));
      this.renderChannelNeighbors();if(hadGuideFocus)this.stage.focus({preventScroll:true});
      this.info.classList.add('ip-guide-dismissed');this.error.hidden=true;this.playbackLoader.hide({immediate:true});
    }else if(this.current?.loading)this.setLoading(true);
  }
  setLoading(loading, title) {
    if (!this.current) return;
    if (loading && this.current.failed) return;
    if (loading && !this.current.loading) this.current.loadStartedAt = performance.now();
    this.current.loading = loading;
    if(this.channelSwitchActive)this.playbackLoader.hide({immediate:true});
    else if (loading) this.playbackLoader.show({started: this.current.recorded, message: title});
    else this.playbackLoader.hide({immediate: this.current.failed});
    this.stage.classList.toggle('ip-loading-active', loading&&!this.channelSwitchActive);
    this.updateLoading(); this.reveal();
  }
  updateLoading() {
    if (!this.current?.loading||this.channelSwitchActive) return;
    const estimate = loadingEstimate(this.samples[this.current.item.kind === 'live' ? 'live' : 'vod']);
    this.playbackLoader.update({elapsed: (performance.now() - this.current.loadStartedAt) / 1000, estimateMs: estimate});
  }
  setLoadingSource(source) { this.playbackLoader.setSource(source); }
  acceptPreparedPlayback(){
    if(!this.current||this.current.failed||this.video.paused||this.video.readyState<2)return;
    this.current.awaitingPlay=false;this.error.hidden=true;this.recordStart();this.setLoading(false);this.updateControls();
  }
  waitForPlay({ready = true} = {}) {
    if (!this.current) return;
    this.current.awaitingPlay = true;
    if (ready || this.video.readyState >= 2) this.setLoading(false);
  }
  recordStart() {
    if (!this.current || this.current.recorded || this.current.failed) return;
    this.current.recorded = true; const time = performance.now() - this.current.startedAt, key = this.current.item.kind === 'live' ? 'live' : 'vod';
    if (time > 0 && time <= 120000) { this.samples[key].push(time); this.samples[key] = this.samples[key].slice(-8); try { localStorage.setItem('arkehn.player-startup.v1', JSON.stringify(this.samples)); } catch {} }
  }
  setFailure(message) {
    if (!this.current) return; this.current.failed = true; this.setLoading(false); this.error.hidden = false;
    this.errorMessage.textContent = text(message) || 'A fonte não respondeu. Tente novamente.'; this.retryButton.hidden = typeof this.options.onRetry !== 'function'; clearTimeout(this.hideTimer); this.hideTimer = null; this.reveal();
  }
  updateControls() {
    if (!this.current) return;
    this.playbackControl.update();
    const live = this.current.item.kind === 'live', duration = this.video.duration;
    this.live.hidden = !live; this.time.hidden = live; this.seekRow.hidden = live;
    const canSeek = !live && Number.isFinite(duration) && duration > 0; this.seek.disabled = !canSeek;
    if (canSeek && !this.seeking) { this.seek.max = String(duration); this.seek.value = String(Math.min(duration, this.video.currentTime || 0)); this.seek.style.setProperty('--ip-played', `${Math.min(100, Math.max(0, this.video.currentTime / duration * 100))}%`); this.seek.setAttribute('aria-valuetext', `${formatMediaTime(this.video.currentTime)} de ${formatMediaTime(duration)}`); }
    if (!this.seeking) this.time.textContent = `${formatMediaTime(this.video.currentTime)} / ${Number.isFinite(duration) ? formatMediaTime(duration) : '—'}`;
    this.nextButton.hidden = !this.options.getPlayer?.()?.next; this.updateVolume();
  }
  updateVolume() { this.volumeControl.update(); }
  togglePlayback() { if(this.current)this.playbackControl.toggle(); }
  fullscreenElement() { return document.fullscreenElement || document.webkitFullscreenElement; }
  async toggleFullscreen() {
    try { if (this.fullscreenElement() === this.stage) await (document.exitFullscreen?.() || document.webkitExitFullscreen?.()); else { const request = this.stage.requestFullscreen || this.stage.webkitRequestFullscreen; if (!request) throw new Error('unsupported'); await request.call(this.stage); } } catch { this.options.toast?.('A tela cheia com controles não está disponível neste navegador.'); }
    this.reveal();
  }
  updateFullscreen() { const full = this.fullscreenElement() === this.stage; this.fullscreenButton.setAttribute('aria-label', full ? 'Sair da tela cheia' : 'Entrar em tela cheia'); this.fullscreenButton.title = full ? 'Sair da tela cheia' : 'Entrar em tela cheia'; this.fullscreenButton.setAttribute('aria-pressed', String(full)); this.reveal(); }
  async close() { if (this.fullscreenElement() === this.stage) { try { await (document.exitFullscreen?.() || document.webkitExitFullscreen?.()); } catch {} } this.options.onClose?.(); }
  reveal() { if (!this.current) return; if(!this.channelSwitchActive)this.info.classList.remove('ip-guide-dismissed');this.root.classList.remove('ip-hidden'); this.scheduleHide(); }
  shouldStayVisible() { return !this.current || this.current.loading || this.current.failed || this.video.paused || this.video.ended || this.hovering || this.seeking || this.digits || !this.tools.hidden || (this.keyboardMode && this.root.contains(document.activeElement)); }
  scheduleHide() {
    clearTimeout(this.hideTimer); this.hideTimer = null; if (!this.current || this.shouldStayVisible()) return;
    this.hideTimer = setTimeout(() => { this.hideTimer = null; if (!this.shouldStayVisible()) {this.tvNavigation.cancel({notify:false});this.renderChannelNeighbors();this.root.classList.add('ip-hidden');} }, 4000);
  }
  switchChannel(entry,options={origin:'preview'}) { if (!entry) return; Promise.resolve(this.options.onSwitchChannel?.(entry.item,options)).catch(() => this.options.toast?.('Não foi possível trocar o canal. Tente novamente.')); }
  commitDigits() {
    const digits = this.digits; this.digits = ''; clearTimeout(this.digitTimer); this.digitTimer = null; this.typed.hidden = true;
    if (!this.current || this.blockedByDialog()) return;
    const match = this.channelEntries().find(entry => entry.number === Number(digits));
    if (match) this.switchChannel(match,{origin:'number'}); else this.options.toast?.(`Canal ${digits} não encontrado na sua lista numerada.`); this.reveal();
  }
  blockedByDialog() { const playerDialog = this.stage.closest('dialog'); return [...document.querySelectorAll('dialog[open]')].some(dialog => dialog !== playerDialog && !dialog.contains(this.stage)); }
  requestSeek(target,options={}) {
    if(!this.current || this.current.item.kind==='live' || !Number.isFinite(target))return false;
    if(typeof this.options.onSeek==='function')return this.options.onSeek(target,options);
    try{this.video.currentTime=Math.max(0,Math.min(this.video.duration || target,target));return true;}
    catch{this.options.toast?.('Não foi possível avançar este vídeo agora.');return false;}
  }
  keydown(event) { handlePlayerKeydown(this,event); }
  destroy() { this.reset(); this.tvGuide.destroy();this.volumeControl.destroy();this.playbackControl.destroy(); this.episodeSkip.destroy(); this.disposers.forEach(dispose => dispose()); this.disposers = []; this.root.remove(); this.stage.classList.remove('immersive-stage'); }
}

import { EpisodeSkipController } from './episode-skip.js';
import { programWindow } from './program-guide.js';
import { NeighborProgramFeeds } from './neighbor-program-feeds.js';
import { renderPlayerChannelLogo } from './player-channel-logos.js';
import { PlaybackLoader } from './playback-loader.js';
export { parseProgramTime, programWindow } from './program-guide.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  play: ['M9 5l10 7-10 7V5'], pause: ['M8 5v14M16 5v14'],
  close: ['M6 6l12 12M6 18L18 6'], volume: ['M11 5L6 9H3v6h3l5 4V5', 'M15 8a6 6 0 010 8M18 5a10 10 0 010 14'],
  muted: ['M11 5L6 9H3v6h3l5 4V5', 'M16 9l5 6M16 15l5-6'],
  expand: ['M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5'],
  next: ['M5 5l10 7-10 7V5M19 5v14'],
  'chevron-left': ['M15 5l-7 7 7 7'], 'chevron-right': ['M9 5l7 7-7 7'],
  settings: ['M9 3l-.7 2.1-2 .9-2-.5-2 3.5 1.4 1.6v2.3L2.3 14.5l2 3.5 2-.5 2 .9L9 21h4l.7-2.1 2-.9 2 .5 2-3.5-1.4-1.6v-2.3l1.4-1.6-2-3.5-2 .5-2-.9L13 3H9', 'M14 12a3 3 0 11-6 0 3 3 0 016 0']
};
const text = value => String(value ?? '').trim();
function element(tag, className = '', value) {
  const node = document.createElement(tag); node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}
function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name] || ICONS.play) { const path = document.createElementNS(SVG_NS, 'path'); path.setAttribute('d', d); svg.append(path); }
  return svg;
}
function control(label, name, action) {
  const button = element('button', 'ip-button'); button.type = 'button';
  button.setAttribute('aria-label', label); button.title = label; button.append(icon(name)); button.addEventListener('click', action);
  return button;
}
export function formatMediaTime(value) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0) return '00:00';
  const seconds = Math.floor(Number(value)), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? hours + ':' : ''}${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
export function numberedChannels(entries = []) {
  const seen = new Set(), identities = new Set();
  return (Array.isArray(entries) ? entries : []).filter(entry => {
    const number = Number(entry?.number), id = String(entry?.item?.id ?? '').trim();
    if (!entry?.item || entry.item.kind !== 'live' || !id || !Number.isSafeInteger(number) || number < 1 || number > 999999 || seen.has(number) || identities.has(id)) return false;
    seen.add(number); identities.add(id); return true;
  }).map(entry => ({ item: entry.item, number: Number(entry.number) }));
}
export function channelNeighbors(entries, current) {
  const channels = numberedChannels(entries);
  const identity = String(current?.item?.id ?? '');
  let index = channels.findIndex(entry => String(entry.item.id) === identity);
  if (index < 0) index = channels.findIndex(entry => entry.number === Number(current?.channelNumber));
  const selected = channels[index] || null;
  if (!channels.length || channels.length===1 && selected) return {previous:null, current:selected, next:null};
  return {
    previous:channels[index < 0 ? channels.length-1 : (index-1+channels.length)%channels.length],
    current:selected,
    next:channels[index < 0 ? 0 : (index+1)%channels.length]
  };
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
    this.current = null; this.channels = null; this.programs = []; this.disposers = [];
    this.neighborPrograms = {previous:null,next:null};
    this.hideTimer = null; this.digitTimer = null; this.tickTimer = null; this.digits = ''; this.hovering = false; this.seeking = false; this.keyboardMode = false;
    this.samples = {live: [], vod: []};
    try { const saved = JSON.parse(localStorage.getItem('arkehn.player-startup.v1') || '{}'); for (const key of ['live', 'vod']) if (Array.isArray(saved?.[key])) this.samples[key] = saved[key].filter(value => Number.isFinite(value) && value > 0 && value <= 120000).slice(-8); } catch {}
    this.video.controls = false; this.video.removeAttribute('controls');
    this.stage.classList.add('immersive-stage'); this.stage.tabIndex = 0; this.stage.setAttribute('aria-label', 'Área de reprodução');
    this.build();
    this.neighborFeeds = typeof options.api==='function' ? new NeighborProgramFeeds({request:options.api,
      getNamespace:()=>this.options.getProgramNamespace?.() ?? this.options.getSourceNamespace?.() ?? '',
      onUpdate:data=>this.setNeighborProgram(data)}) : null;
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
    const heading = element('div', 'ip-information-heading'); this.number = element('span', 'ip-channel-number'); this.number.hidden = true;
    const headingText = element('div', 'ip-information-copy'); this.kind = element('span', 'ip-kind'); this.title = element('h2', 'ip-title'); headingText.append(this.kind, this.title); heading.append(this.number, headingText);
    this.schedule = element('div', 'ip-schedule'); this.programNodes = {};
    for (const [key, label] of [['previous', 'Anterior'], ['current', 'Agora'], ['next', 'Próximo']]) {
      const row = element('div', `ip-program ip-program-${key}`), name = element('strong', 'ip-program-title', 'Não informada'), time = element('span', 'ip-program-time');
      row.append(element('span', 'ip-program-label', label), name, time); this.programNodes[key] = {name, time}; this.schedule.append(row);
    }
    this.channelLogo=element('span','ip-channel-logo ip-channel-logo-current');this.channelLogo.hidden=true;
    this.channelCurrent = element('div', 'ip-channel-current'); this.channelCurrent.append(this.channelLogo,heading, this.schedule);
    this.channelNeighborNodes = {};
    for (const [key, label, step] of [['previous', 'Canal anterior', -1], ['next', 'Próximo canal', 1]]) {
      const button = element('button', `ip-channel-neighbor ip-channel-${key}`);button.type = 'button';button.hidden = true;button.disabled = true;
      const labelNode = element('span', 'ip-neighbor-label', label), number = element('span', 'ip-neighbor-number'), name = element('span', 'ip-neighbor-name');
      const logo=element('span','ip-channel-logo ip-channel-logo-neighbor');logo.hidden=true;
      const arrow = icon(key === 'previous' ? 'chevron-left' : 'chevron-right');arrow.classList.add('ip-neighbor-arrow');
      const schedule = element('div', 'ip-neighbor-schedule'), status = element('span', 'ip-neighbor-schedule-status', 'Programação não informada'), programs = {};
      schedule.id = `ip-neighbor-schedule-${key}`;schedule.setAttribute('aria-label',`Programação do ${label.toLowerCase()}`);
      button.setAttribute('aria-describedby',schedule.id);schedule.append(status);
      for (const [period,caption] of [['previous','Anterior'],['current','Agora'],['next','Próximo']]) {
        const row = element('div', `ip-program ip-neighbor-program ip-neighbor-program-${period}`), title = element('strong', 'ip-program-title'), time = element('span', 'ip-program-time');
        row.hidden = true;row.append(element('span', 'ip-program-label', caption),title,time);schedule.append(row);programs[period] = {row,name:title,time};
      }
      button.append(logo,labelNode, number, name, arrow, schedule);button.addEventListener('click', () => this.navigateChannel(step));
      this.channelNeighborNodes[key] = {button, number, name, label, logo, schedule, status, programs, id:null};
    }
    this.info.append(this.channelNeighborNodes.previous.button, this.channelCurrent, this.channelNeighborNodes.next.button);
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
    this.playButton = control('Reproduzir', 'play', () => this.togglePlayback()); this.playButton.classList.add('ip-play');
    this.live = element('span', 'ip-live', 'AO VIVO'); this.live.hidden = true;
    this.time = element('span', 'ip-time', '00:00 / 00:00');
    this.volumeButton = control('Silenciar', 'volume', () => { this.video.muted = !this.video.muted; this.updateVolume(); });
    this.volume = element('input', 'ip-volume'); this.volume.type = 'range'; this.volume.min = '0'; this.volume.max = '1'; this.volume.step = '.05'; this.volume.value = String(this.video.volume); this.volume.setAttribute('aria-label', 'Volume');
    const volume = element('div', 'ip-volume-group'); volume.append(this.volumeButton, this.volume);
    const spacer = element('span', 'ip-control-spacer');
    this.nextButton = control('Próximo episódio', 'next', () => this.options.onNextEpisode?.()); this.nextButton.hidden = true;
    this.settingsButton = control('Abrir ajustes de reprodução', 'settings', () => { this.tools.hidden = !this.tools.hidden; this.settingsButton.setAttribute('aria-expanded', String(!this.tools.hidden)); this.settingsButton.setAttribute('aria-label', this.tools.hidden ? 'Abrir ajustes de reprodução' : 'Fechar ajustes de reprodução'); this.reveal(); }); this.settingsButton.hidden = true; this.settingsButton.setAttribute('aria-expanded', 'false');
    this.fullscreenButton = control('Entrar em tela cheia', 'expand', () => this.toggleFullscreen());
    bottom.append(this.playButton, this.live, this.time, volume, spacer, this.nextButton, this.settingsButton, this.fullscreenButton);
    this.controls.append(this.liveTimeline, this.seekRow, bottom);
    this.tools = element('div', 'ip-tools-slot'); this.tools.hidden = true;
    this.root.append(this.loading, this.error, this.info, this.closeButton, this.typed, this.tools, this.controls); this.stage.append(this.root);
  }
  bind() {
    for (const event of ['loadstart', 'waiting']) this.listen(this.video, event, () => { if (this.current && !(this.current.awaitingPlay && this.video.paused) && !(event === 'waiting' && this.video.paused)) this.setLoading(true, event === 'waiting' ? this.current.item.kind === 'live' ? 'Aguardando a transmissão' : 'Retomando seu vídeo' : 'Preparando sua sessão'); });
    for (const event of ['loadeddata', 'canplay']) this.listen(this.video, event, () => { if (this.current?.awaitingPlay && this.video.paused) this.setLoading(false); });
    this.listen(this.video, 'playing', () => { if (!this.current || this.current.failed) return; this.current.awaitingPlay = false; this.error.hidden = true; this.recordStart(); this.setLoading(false); this.updateControls(); });
    for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'progress', 'pause', 'play', 'ended']) this.listen(this.video, event, () => { if (this.current) { this.updateControls(); if (this.video.paused || this.video.ended) this.reveal(); } });
    this.listen(this.video, 'volumechange', () => this.updateVolume());
    // The transport controller owns retries and terminal failures. A media
    // element error during HLS recovery must not create a competing overlay.
    this.listen(this.video, 'error', () => { if(!this.options?.managedErrors)this.setFailure('Leitura do vídeo indisponível. Tente novamente ou escolha outra fonte.'); });
    this.listen(this.stage, 'pointermove', () => this.reveal()); this.listen(this.stage, 'pointerdown', event => { this.keyboardMode = false; if (event.target === this.stage || event.target === this.video) this.stage.focus({preventScroll: true}); this.reveal(); });
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
    this.listen(this.volume, 'input', () => { try { this.video.volume = Number(this.volume.value); this.video.muted = false; this.options.onVolumeChange?.(this.video.volume); } catch { this.options.toast?.('O navegador gerencia o volume deste dispositivo.'); } this.updateVolume(); this.reveal(); });
    this.listen(document, 'keydown', event => this.keydown(event));
    for (const event of ['fullscreenchange', 'webkitfullscreenchange']) this.listen(document, event, () => this.updateFullscreen());
  }
  attach({item, episode = null, channelNumber = null, initialProgram = null, continuation = null}) {
    this.reset(); this.video.controls = false; this.video.removeAttribute('controls');
    const source = this.channelEntries().find(entry => String(entry.item.id) === String(item.id));
    const startedAt = performance.now();
    const continuing=item.kind==='live'&&continuation&&Number.isFinite(continuation.startedAt)&&Number.isFinite(continuation.loadStartedAt);
    this.current = {item, episode, channelNumber: channelNumber ?? source?.number ?? null, loading: true, failed: false, startedAt:continuing?continuation.startedAt:startedAt, loadStartedAt:continuing?continuation.loadStartedAt:startedAt, recorded:continuing?Boolean(continuation.recorded):false};
    this.programs=Array.isArray(initialProgram?.list)?initialProgram.list:[];
    this.playbackLoader.attach({item, episode});
    this.episodeSkip.attach({item, episode, sourceFingerprint:`${this.options.getSourceNamespace?.() || 'iptv'}:${item.kind}:${item.id}:${episode?.id || ''}:${episode?.container || item.container || 'mp4'}`});
    this.root.hidden = false; this.root.classList.remove('ip-hidden'); this.stage.classList.add('ip-active'); this.error.hidden = true;
    this.stage.setAttribute('aria-label', `Reprodução de ${text(item.name)}`);
    this.kind.textContent = item.kind === 'live' ? 'TV AO VIVO' : item.kind === 'series' ? 'SÉRIE' : 'CINEMA';
    this.title.textContent = episode ? `${text(item.name)} · ${text(episode.title) || 'Episódio'}` : text(item.name);
    this.number.hidden = item.kind !== 'live' || !Number.isSafeInteger(Number(this.current.channelNumber)) || Number(this.current.channelNumber) < 1;
    this.number.textContent = this.number.hidden ? '' : String(this.current.channelNumber).padStart(3, '0');
    this.schedule.hidden = item.kind !== 'live'; this.renderChannelNeighbors(); this.renderProgram(); this.updateControls(); this.setLoading(true, continuing&&continuation.recorded?'Restabelecendo a transmissão':'Preparando sua sessão');
    this.tickTimer = setInterval(() => { if (!this.current) return; this.updateLoading(); this.renderProgram(); this.updateControls(); }, 1000);
    this.reveal();
  }
  preparationContinuation(){
    const current=this.current;if(!current||current.item.kind!=='live')return null;
    return {startedAt:current.startedAt,loadStartedAt:current.loading?current.loadStartedAt:performance.now(),recorded:current.recorded};
  }
  reset() {
    this.playbackLoader?.reset();
    this.episodeSkip?.reset();
    this.neighborFeeds?.stop();this.neighborPrograms = {previous:null,next:null};
    clearTimeout(this.hideTimer); clearTimeout(this.digitTimer); clearInterval(this.tickTimer);
    this.hideTimer = this.digitTimer = this.tickTimer = null; this.current = null; this.programs = []; this.digits = ''; this.hovering = false; this.seeking = false; this.keyboardMode = false;
    if (this.root) { this.root.hidden = true; this.root.classList.remove('ip-hidden'); this.typed.hidden = true; this.error.hidden = true; this.tools.hidden = true; this.settingsButton.setAttribute('aria-expanded', 'false'); this.settingsButton.setAttribute('aria-label', 'Abrir ajustes de reprodução'); this.stage.classList.remove('ip-active', 'ip-loading-active'); }
    if (this.info) this.renderChannelNeighbors();
  }
  setChannels(channels) {
    this.channels = numberedChannels(channels);
    if (this.current?.item.kind === 'live') { const found = this.channels.find(entry => String(entry.item.id) === String(this.current.item.id)); if (found) { this.current.channelNumber = found.number; this.number.textContent = String(found.number).padStart(3, '0'); this.number.hidden = false; } }
    this.renderChannelNeighbors();
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
    const live = this.current?.item.kind === 'live';this.info.classList.toggle('ip-live-information', live);
    renderPlayerChannelLogo(this.channelLogo,live?this.current.item:null);
    const neighbors = live ? channelNeighbors(this.channelEntries(), this.current) : {previous:null, next:null};
    for (const [key, nodes] of Object.entries(this.channelNeighborNodes)) {
      const entry = neighbors[key];nodes.button.hidden = !live;nodes.button.disabled = !entry;
      nodes.id = entry ? String(entry.item.id) : null;
      renderPlayerChannelLogo(nodes.logo,entry?.item);
      nodes.number.hidden = !entry;nodes.number.textContent = entry ? String(entry.number).padStart(3, '0') : '';
      nodes.name.textContent = entry ? text(entry.item.name) : 'Sem outro canal';
      const label = entry ? `${nodes.label}: ${String(entry.number).padStart(3, '0')}, ${text(entry.item.name)}` : `${nodes.label} indisponível`;
      nodes.button.setAttribute('aria-label', label);nodes.button.title = label;
    }
    this.neighborFeeds?.select({previous:neighbors.previous?.item.id,next:neighbors.next?.item.id});
    this.renderNeighborPrograms?.();
  }
  navigateChannel(step) {
    if (this.current?.item.kind !== 'live') return;
    const neighbors = channelNeighbors(this.channelEntries(), this.current), entry = step > 0 ? neighbors.next : neighbors.previous;
    this.reveal();if (entry) this.switchChannel(entry);
  }
  setProgram(data = {}) { this.programs = Array.isArray(data.list) ? data.list : []; this.renderProgram(); }
  setNeighborProgram(data) {
    if (this.current?.item.kind!=='live' || this.channelNeighborNodes[data.slot]?.id!==data.id) return;
    this.neighborPrograms[data.slot]=data;this.renderNeighborPrograms();
  }
  renderNeighborPrograms() {
    for (const [slot,nodes] of Object.entries(this.channelNeighborNodes)) {
      if (!nodes.schedule) continue;
      const data=this.neighborPrograms[slot],matching=Boolean(nodes.id && data?.id===nodes.id),programs=programWindow(matching ? data.list : []);
      const hasPrograms=Object.values(programs).some(Boolean);
      nodes.schedule.hidden=!nodes.id;nodes.status.hidden=hasPrograms;
      const loading=matching && data.status==='loading' || nodes.id && !matching && Boolean(this.neighborFeeds);
      nodes.status.textContent=loading ? 'Carregando programação…' : 'Programação não informada';
      for (const [key,period] of Object.entries(nodes.programs)) {
        const program=programs[key];period.row.hidden=!hasPrograms;period.name.textContent=program?.title || 'Não informada';
        period.name.title=program?.title || '';
        period.time.textContent=program ? new Date(program.start).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}) : '';
      }
    }
  }
  renderProgram() {
    if (!this.current) return; const programs = programWindow(this.programs);
    for (const [key, nodes] of Object.entries(this.programNodes)) {
      const program = programs[key]; nodes.name.textContent = program?.title || 'Não informada';
      nodes.time.textContent = program ? new Date(program.start).toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'}) : '';
    }
    const program = this.current.item.kind === 'live' ? programs.current : null; this.liveTimeline.hidden = !program;
    if (program) { const time = value => new Date(value).toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'}); this.liveProgramName.textContent = program.title; this.liveProgramTime.textContent = `${time(program.start)} — ${time(program.end)}`; this.liveProgress.value = Math.max(0, Math.min(100, (Date.now() - program.start) / (program.end - program.start) * 100)); }
    this.renderNeighborPrograms();
  }
  setLoading(loading, title) {
    if (!this.current) return;
    if (loading && this.current.failed) return;
    if (loading && !this.current.loading) this.current.loadStartedAt = performance.now();
    this.current.loading = loading;
    if (loading) this.playbackLoader.show({started: this.current.recorded, message: title});
    else this.playbackLoader.hide({immediate: this.current.failed});
    this.stage.classList.toggle('ip-loading-active', loading);
    this.updateLoading(); this.reveal();
  }
  updateLoading() {
    if (!this.current?.loading) return;
    const estimate = loadingEstimate(this.samples[this.current.item.kind === 'live' ? 'live' : 'vod']);
    this.playbackLoader.update({elapsed: (performance.now() - this.current.loadStartedAt) / 1000, estimateMs: estimate});
  }
  setLoadingSource(source) { this.playbackLoader.setSource(source); }
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
    const paused = this.video.paused || this.video.ended, playLabel = paused ? 'Reproduzir' : 'Pausar';
    if (this.playButton.getAttribute('aria-label') !== playLabel) { this.playButton.replaceChildren(icon(paused ? 'play' : 'pause')); this.playButton.setAttribute('aria-label', playLabel); this.playButton.title = playLabel; }
    const live = this.current.item.kind === 'live', duration = this.video.duration;
    this.live.hidden = !live; this.time.hidden = live; this.seekRow.hidden = live;
    const canSeek = !live && Number.isFinite(duration) && duration > 0; this.seek.disabled = !canSeek;
    if (canSeek && !this.seeking) { this.seek.max = String(duration); this.seek.value = String(Math.min(duration, this.video.currentTime || 0)); this.seek.style.setProperty('--ip-played', `${Math.min(100, Math.max(0, this.video.currentTime / duration * 100))}%`); this.seek.setAttribute('aria-valuetext', `${formatMediaTime(this.video.currentTime)} de ${formatMediaTime(duration)}`); }
    if (!this.seeking) this.time.textContent = `${formatMediaTime(this.video.currentTime)} / ${Number.isFinite(duration) ? formatMediaTime(duration) : '—'}`;
    this.nextButton.hidden = !this.options.getPlayer?.()?.next; this.updateVolume();
  }
  updateVolume() {
    const muted = this.video.muted || this.video.volume === 0, label = muted ? 'Ativar áudio' : 'Silenciar';
    if (this.volumeButton.getAttribute('aria-label') !== label) { this.volumeButton.replaceChildren(icon(muted ? 'muted' : 'volume')); this.volumeButton.setAttribute('aria-label', label); this.volumeButton.title = label; }
    this.volumeButton.setAttribute('aria-pressed', String(muted)); this.volume.value = String(muted ? 0 : this.video.volume);
  }
  togglePlayback() { if (!this.current) return; this.reveal(); if (this.video.paused || this.video.ended) this.video.play().catch(() => this.options.toast?.('Pressione reproduzir novamente para iniciar o vídeo.')); else this.video.pause(); }
  fullscreenElement() { return document.fullscreenElement || document.webkitFullscreenElement; }
  async toggleFullscreen() {
    try { if (this.fullscreenElement() === this.stage) await (document.exitFullscreen?.() || document.webkitExitFullscreen?.()); else { const request = this.stage.requestFullscreen || this.stage.webkitRequestFullscreen; if (!request) throw new Error('unsupported'); await request.call(this.stage); } } catch { this.options.toast?.('A tela cheia com controles não está disponível neste navegador.'); }
    this.reveal();
  }
  updateFullscreen() { const full = this.fullscreenElement() === this.stage; this.fullscreenButton.setAttribute('aria-label', full ? 'Sair da tela cheia' : 'Entrar em tela cheia'); this.fullscreenButton.title = full ? 'Sair da tela cheia' : 'Entrar em tela cheia'; this.fullscreenButton.setAttribute('aria-pressed', String(full)); this.reveal(); }
  async close() { if (this.fullscreenElement() === this.stage) { try { await (document.exitFullscreen?.() || document.webkitExitFullscreen?.()); } catch {} } this.options.onClose?.(); }
  reveal() { if (!this.current) return; this.root.classList.remove('ip-hidden'); this.scheduleHide(); }
  shouldStayVisible() { return !this.current || this.current.loading || this.current.failed || this.video.paused || this.video.ended || this.hovering || this.seeking || this.digits || !this.tools.hidden || (this.keyboardMode && this.root.contains(document.activeElement)); }
  scheduleHide() {
    clearTimeout(this.hideTimer); this.hideTimer = null; if (!this.current || this.shouldStayVisible()) return;
    this.hideTimer = setTimeout(() => { this.hideTimer = null; if (!this.shouldStayVisible()) this.root.classList.add('ip-hidden'); }, 4000);
  }
  switchChannel(entry) { if (!entry) return; Promise.resolve(this.options.onSwitchChannel?.(entry.item)).catch(() => this.options.toast?.('Não foi possível trocar o canal. Tente novamente.')); }
  commitDigits() {
    const digits = this.digits; this.digits = ''; clearTimeout(this.digitTimer); this.digitTimer = null; this.typed.hidden = true;
    if (!this.current || this.blockedByDialog()) return;
    const match = this.channelEntries().find(entry => entry.number === Number(digits));
    if (match) this.switchChannel(match); else this.options.toast?.(`Canal ${digits} não encontrado na sua lista numerada.`); this.reveal();
  }
  blockedByDialog() { const playerDialog = this.stage.closest('dialog'); return [...document.querySelectorAll('dialog[open]')].some(dialog => dialog !== playerDialog && !dialog.contains(this.stage)); }
  requestSeek(target,options={}) {
    if(!this.current || this.current.item.kind==='live' || !Number.isFinite(target))return false;
    if(typeof this.options.onSeek==='function')return this.options.onSeek(target,options);
    try{this.video.currentTime=Math.max(0,Math.min(this.video.duration || target,target));return true;}
    catch{this.options.toast?.('Não foi possível avançar este vídeo agora.');return false;}
  }
  keydown(event) {
    if (!this.current) return; this.keyboardMode = true;
    if (this.blockedByDialog()) return;
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey ||
        event.target?.closest?.('input, textarea, select, [contenteditable], details[open], [role="menu"], [role="menuitem"], [role="listbox"], [role="option"], [role="combobox"]') ||
        !this.tools.hidden && this.tools.contains(event.target)) return;
    const live = this.current.item.kind === 'live';
    if (live && /^\d$/.test(event.key)) { event.preventDefault(); this.digits = (this.digits + event.key).slice(-6); this.typedNumber.textContent = this.digits; this.typed.hidden = false; clearTimeout(this.digitTimer); this.digitTimer = setTimeout(() => this.commitDigits(), 1000); this.reveal(); return; }
    if (live && ['ArrowUp', 'ArrowDown', 'ChannelUp', 'ChannelDown', 'PageUp', 'PageDown'].includes(event.key)) {
      if (!this.tools.hidden) return;
      event.preventDefault();this.navigateChannel(['ArrowUp', 'ChannelUp', 'PageUp'].includes(event.key) ? 1 : -1);return;
    }
    if (event.key === ' ' && !event.target?.closest?.('button, summary, a')) { event.preventDefault(); this.togglePlayback(); }
    else if (event.key.toLowerCase() === 'f') { event.preventDefault(); this.toggleFullscreen(); }
    else if (event.key.toLowerCase() === 'm') { event.preventDefault(); this.video.muted = !this.video.muted; this.reveal(); }
    else if (!live && ['ArrowLeft', 'ArrowRight'].includes(event.key) && Number.isFinite(this.video.duration)) { event.preventDefault(); this.requestSeek(Math.max(0, Math.min(this.video.duration, this.video.currentTime + (event.key === 'ArrowLeft' ? -10 : 10))),{reason:'user'}); this.reveal(); }
    else this.reveal();
  }
  destroy() { this.reset(); this.neighborFeeds?.destroy(); this.episodeSkip.destroy(); this.disposers.forEach(dispose => dispose()); this.disposers = []; this.root.remove(); this.stage.classList.remove('immersive-stage'); }
}

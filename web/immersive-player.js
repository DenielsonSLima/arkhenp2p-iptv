import { EpisodeSkipController } from './episode-skip.js';
import { programWindow } from './program-guide.js';
export { parseProgramTime, programWindow } from './program-guide.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  play: ['M9 5l10 7-10 7V5'], pause: ['M8 5v14M16 5v14'],
  close: ['M6 6l12 12M6 18L18 6'], volume: ['M11 5L6 9H3v6h3l5 4V5', 'M15 8a6 6 0 010 8M18 5a10 10 0 010 14'],
  muted: ['M11 5L6 9H3v6h3l5 4V5', 'M16 9l5 6M16 15l5-6'],
  expand: ['M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5'],
  next: ['M5 5l10 7-10 7V5M19 5v14'],
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
  const seen = new Set();
  return (Array.isArray(entries) ? entries : []).filter(entry => {
    const number = Number(entry?.number);
    if (!entry?.item || entry.item.kind !== 'live' || !Number.isSafeInteger(number) || number < 1 || number > 999999 || seen.has(number)) return false;
    seen.add(number); return true;
  }).map(entry => ({ item: entry.item, number: Number(entry.number) }));
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
    this.hideTimer = null; this.digitTimer = null; this.tickTimer = null; this.digits = ''; this.hovering = false; this.seeking = false; this.keyboardMode = false;
    this.samples = {live: [], vod: []};
    try { const saved = JSON.parse(localStorage.getItem('arkehn.player-startup.v1') || '{}'); for (const key of ['live', 'vod']) if (Array.isArray(saved?.[key])) this.samples[key] = saved[key].filter(value => Number.isFinite(value) && value > 0 && value <= 120000).slice(-8); } catch {}
    this.video.controls = false; this.video.removeAttribute('controls');
    this.stage.classList.add('immersive-stage'); this.stage.tabIndex = 0; this.stage.setAttribute('aria-label', 'Área de reprodução');
    this.build();
    this.episodeSkip = new EpisodeSkipController({
      video:this.video, onNextEpisode:() => this.options.onNextEpisode?.(),
      hasNextEpisode:() => Boolean(this.options.getPlayer?.()?.next),
      notify:message => this.options.toast?.(message), onAction:() => this.reveal()
    });
    this.root.append(this.episodeSkip.overlay);
    this.tools.append(this.episodeSkip.panel);
    this.bind();
  }
  listen(target, event, callback, options) { target.addEventListener(event, callback, options); this.disposers.push(() => target.removeEventListener(event, callback, options)); }
  build() {
    this.root = element('div', 'ip-root'); this.root.hidden = true;
    this.loading = element('div', 'ip-loading');
    const brand = element('div', 'ip-loading-brand'), symbol = element('img', 'ip-loading-symbol'), wordmark = element('img', 'ip-loading-wordmark');
    symbol.src = '/assets/brand/symbol.svg'; symbol.alt = ''; wordmark.src = '/assets/brand/wordmark.svg'; wordmark.alt = 'ARKHEN';
    brand.append(symbol, wordmark, element('span', 'ip-loading-product', 'P2 IPTV'));
    this.loadingTitle = element('p', 'ip-loading-title', 'Preparando sua sessão'); this.loadingTitle.setAttribute('role', 'status');
    this.loadingElapsed = element('span', 'ip-loading-elapsed'); this.loadingEstimate = element('span', 'ip-loading-estimate');
    const bar = element('div', 'ip-loading-bar'); bar.setAttribute('aria-hidden', 'true');
    const details = element('div', 'ip-loading-details'); details.append(this.loadingElapsed, this.loadingEstimate);
    this.loading.append(brand, this.loadingTitle, bar, details);
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
    this.info.append(heading, this.schedule);
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
    for (const event of ['loadstart', 'waiting']) this.listen(this.video, event, () => { if (this.current) this.setLoading(true, event === 'waiting' ? 'Aguardando a transmissão' : 'Preparando sua sessão'); });
    for (const event of ['loadeddata', 'playing']) this.listen(this.video, event, () => { if (!this.current) return; this.current.failed = false; this.error.hidden = true; this.recordStart(); this.setLoading(false); this.updateControls(); });
    for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'progress', 'pause', 'play', 'ended']) this.listen(this.video, event, () => { if (this.current) { this.updateControls(); if (this.video.paused || this.video.ended) this.reveal(); } });
    this.listen(this.video, 'volumechange', () => this.updateVolume());
    this.listen(this.video, 'error', () => this.setFailure('Leitura do vídeo indisponível. Tente novamente ou escolha outra fonte.'));
    this.listen(this.stage, 'pointermove', () => this.reveal()); this.listen(this.stage, 'pointerdown', event => { this.keyboardMode = false; if (event.target === this.stage || event.target === this.video) this.stage.focus({preventScroll: true}); this.reveal(); });
    this.listen(this.stage, 'focusin', () => this.reveal()); this.listen(this.stage, 'focusout', () => this.scheduleHide());
    for (const node of [this.controls, this.closeButton, this.tools]) {
      this.listen(node, 'pointerenter', () => { this.hovering = true; this.reveal(); });
      this.listen(node, 'pointerleave', () => { this.hovering = false; this.scheduleHide(); });
    }
    this.listen(this.seek, 'pointerdown', () => { this.seeking = true; });
    this.listen(this.seek, 'input', () => { this.seeking = true; this.time.textContent = `${formatMediaTime(this.seek.value)} / ${formatMediaTime(this.video.duration)}`; this.reveal(); });
    const commitSeek = () => { if (this.seeking && this.current?.item.kind !== 'live' && Number.isFinite(this.video.duration)) this.video.currentTime = Number(this.seek.value); this.seeking = false; this.updateControls(); this.scheduleHide(); };
    this.listen(this.seek, 'change', commitSeek); this.listen(this.seek, 'pointerup', commitSeek);
    this.listen(this.seek, 'pointercancel', () => { this.seeking = false; this.updateControls(); });
    this.listen(this.volume, 'input', () => { try { this.video.volume = Number(this.volume.value); this.video.muted = false; } catch { this.options.toast?.('O navegador gerencia o volume deste dispositivo.'); } this.updateVolume(); this.reveal(); });
    this.listen(document, 'keydown', event => this.keydown(event));
    for (const event of ['fullscreenchange', 'webkitfullscreenchange']) this.listen(document, event, () => this.updateFullscreen());
  }
  attach({item, episode = null, channelNumber = null}) {
    this.reset(); this.video.controls = false; this.video.removeAttribute('controls');
    const source = this.channelEntries().find(entry => String(entry.item.id) === String(item.id));
    const startedAt = performance.now();
    this.current = {item, episode, channelNumber: channelNumber ?? source?.number ?? null, loading: true, failed: false, startedAt, loadStartedAt: startedAt, recorded: false};
    this.episodeSkip.attach({item, episode, sourceFingerprint:`${this.options.getSourceNamespace?.() || 'iptv'}:${item.kind}:${item.id}:${episode?.id || ''}:${episode?.container || item.container || 'mp4'}`});
    this.root.hidden = false; this.root.classList.remove('ip-hidden'); this.stage.classList.add('ip-active'); this.error.hidden = true;
    this.stage.setAttribute('aria-label', `Reprodução de ${text(item.name)}`);
    this.kind.textContent = item.kind === 'live' ? 'TV AO VIVO' : item.kind === 'series' ? 'SÉRIE' : 'CINEMA';
    this.title.textContent = episode ? `${text(item.name)} · ${text(episode.title) || 'Episódio'}` : text(item.name);
    this.number.hidden = item.kind !== 'live' || !Number.isSafeInteger(Number(this.current.channelNumber)) || Number(this.current.channelNumber) < 1;
    this.number.textContent = this.number.hidden ? '' : String(this.current.channelNumber).padStart(3, '0');
    this.schedule.hidden = item.kind !== 'live'; this.renderProgram(); this.updateControls(); this.setLoading(true, 'Preparando sua sessão');
    this.tickTimer = setInterval(() => { if (!this.current) return; this.updateLoading(); this.renderProgram(); this.updateControls(); }, 1000);
    this.reveal();
  }
  reset() {
    this.episodeSkip?.reset();
    clearTimeout(this.hideTimer); clearTimeout(this.digitTimer); clearInterval(this.tickTimer);
    this.hideTimer = this.digitTimer = this.tickTimer = null; this.current = null; this.programs = []; this.digits = ''; this.hovering = false; this.seeking = false; this.keyboardMode = false;
    if (this.root) { this.root.hidden = true; this.root.classList.remove('ip-hidden'); this.typed.hidden = true; this.error.hidden = true; this.tools.hidden = true; this.settingsButton.setAttribute('aria-expanded', 'false'); this.settingsButton.setAttribute('aria-label', 'Abrir ajustes de reprodução'); this.stage.classList.remove('ip-active', 'ip-loading-active'); }
  }
  setChannels(channels) {
    this.channels = numberedChannels(channels);
    if (this.current?.item.kind === 'live') { const found = this.channels.find(entry => String(entry.item.id) === String(this.current.item.id)); if (found) { this.current.channelNumber = found.number; this.number.textContent = String(found.number).padStart(3, '0'); this.number.hidden = false; } }
  }
  setTools(node) { this.tools.replaceChildren(); if (node) this.tools.append(node); this.tools.append(this.episodeSkip.panel); this.tools.hidden = true; this.settingsButton.hidden = !node && !this.current?.episode; this.settingsButton.setAttribute('aria-expanded', 'false'); }
  channelEntries() { try { return numberedChannels(this.options.getChannels ? this.options.getChannels() : this.channels || []); } catch { return this.channels || []; } }
  setProgram(data = {}) { this.programs = Array.isArray(data.list) ? data.list : []; this.renderProgram(); }
  renderProgram() {
    if (!this.current) return; const programs = programWindow(this.programs);
    for (const [key, nodes] of Object.entries(this.programNodes)) {
      const program = programs[key]; nodes.name.textContent = program?.title || 'Não informada';
      nodes.time.textContent = program ? new Date(program.start).toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'}) : '';
    }
    const program = this.current.item.kind === 'live' ? programs.current : null; this.liveTimeline.hidden = !program;
    if (program) { const time = value => new Date(value).toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'}); this.liveProgramName.textContent = program.title; this.liveProgramTime.textContent = `${time(program.start)} — ${time(program.end)}`; this.liveProgress.value = Math.max(0, Math.min(100, (Date.now() - program.start) / (program.end - program.start) * 100)); }
  }
  setLoading(loading, title) {
    if (!this.current) return;
    if (loading && this.current.failed) return;
    if (loading && !this.current.loading) this.current.loadStartedAt = performance.now();
    this.current.loading = loading; this.loading.hidden = !loading;
    this.stage.classList.toggle('ip-loading-active', loading); if (title) this.loadingTitle.textContent = title;
    this.updateLoading(); this.reveal();
  }
  updateLoading() {
    if (!this.current?.loading) return;
    this.loadingElapsed.textContent = `Tempo decorrido: ${Math.max(0, Math.floor((performance.now() - this.current.loadStartedAt) / 1000))} s`;
    const estimate = loadingEstimate(this.samples[this.current.item.kind === 'live' ? 'live' : 'vod']);
    this.loadingEstimate.textContent = this.current.recorded ? 'Sem estimativa para esta interrupção' : estimate === null ? 'Estimativa ainda indisponível' : `Início observado: aproximadamente ${Math.max(1, Math.round(estimate / 1000))} s`;
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
  keydown(event) {
    if (!this.current) return; this.keyboardMode = true;
    if (this.blockedByDialog()) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.target?.closest?.('input, textarea, select, [contenteditable], details[open]')) return;
    const live = this.current.item.kind === 'live';
    if (live && /^\d$/.test(event.key)) { event.preventDefault(); this.digits = (this.digits + event.key).slice(-6); this.typedNumber.textContent = this.digits; this.typed.hidden = false; clearTimeout(this.digitTimer); this.digitTimer = setTimeout(() => this.commitDigits(), 1000); this.reveal(); return; }
    if (live && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
      const channels = this.channelEntries(); if (!channels.length) return; event.preventDefault();
      const index = channels.findIndex(entry => String(entry.item.id) === String(this.current.item.id) || entry.number === Number(this.current.channelNumber)), step = event.key === 'ArrowUp' ? 1 : -1;
      const next = index < 0 ? (step > 0 ? 0 : channels.length - 1) : (index + step + channels.length) % channels.length;
      this.reveal(); this.switchChannel(channels[next]); return;
    }
    if (event.key === ' ' && !event.target?.closest?.('button, summary, a')) { event.preventDefault(); this.togglePlayback(); }
    else if (event.key.toLowerCase() === 'f') { event.preventDefault(); this.toggleFullscreen(); }
    else if (event.key.toLowerCase() === 'm') { event.preventDefault(); this.video.muted = !this.video.muted; this.reveal(); }
    else if (!live && ['ArrowLeft', 'ArrowRight'].includes(event.key) && Number.isFinite(this.video.duration)) { event.preventDefault(); this.video.currentTime = Math.max(0, Math.min(this.video.duration, this.video.currentTime + (event.key === 'ArrowLeft' ? -10 : 10))); this.reveal(); }
    else this.reveal();
  }
  destroy() { this.reset(); this.episodeSkip.destroy(); this.disposers.forEach(dispose => dispose()); this.disposers = []; this.root.remove(); this.stage.classList.remove('immersive-stage'); }
}

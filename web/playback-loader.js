const PHASES = ['Buscando seu vídeo', 'Identificando a fonte', 'Carregando seu vídeo'];
const number = value => value.toLocaleString('pt-BR', {maximumFractionDigits: 1});
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

// A completed, uncached transfer measures delivery of this video, not the
// subscriber's internet plan. Never turn a missing measurement into zero.
export function transferMbps(bytes, start, end) {
  if (!positive(bytes) || bytes < 1024 || !Number.isFinite(start) || !Number.isFinite(end) || end - start < 50) return null;
  return bytes * 8 / (end - start) / 1000;
}

function node(tag, className, text) {
  const result = document.createElement(tag); result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}
function bufferedSeconds(video) {
  const time = video.currentTime || 0;
  for (let index = 0; index < video.buffered.length; index++) {
    if (video.buffered.start(index) <= time + .15 && video.buffered.end(index) >= time) return Math.max(0, video.buffered.end(index) - time);
  }
  return 0;
}

export class PlaybackLoader {
  constructor({video, connection = globalThis.navigator?.connection, online = () => globalThis.navigator?.onLine !== false,
    now = () => performance.now(), observe = callback => typeof PerformanceObserver === 'function' ? new PerformanceObserver(callback) : null} = {}) {
    this.video = video; this.connection = connection; this.online = online; this.now = now; this.observe = observe;
    this.current = null; this.cleanup = []; this.hideTimer = null;
    this.root = node('div', 'ip-loading ip-intro'); this.root.hidden = true;
    const atmosphere = node('div', 'ip-intro-atmosphere'); atmosphere.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < 3; index++) atmosphere.append(node('span', 'ip-intro-light'));
    const content = node('div', 'ip-intro-content'), brand = node('div', 'ip-loading-brand');
    const emblem = node('div', 'ip-intro-emblem'), symbol = node('img', 'ip-loading-symbol'), shine = node('span', 'ip-intro-shine');
    symbol.src = '/assets/brand/symbol.svg'; symbol.alt = ''; shine.setAttribute('aria-hidden', 'true'); emblem.append(symbol, shine);
    const wordmark = node('img', 'ip-loading-wordmark'); wordmark.src = '/assets/brand/wordmark.svg'; wordmark.alt = 'ARKHEN';
    brand.append(emblem, wordmark, node('span', 'ip-loading-product', 'SEU UNIVERSO EM CENA'));
    this.media = node('p', 'ip-intro-media'); this.episode = node('p', 'ip-intro-episode');
    this.title = node('p', 'ip-loading-title', PHASES[0]); this.title.setAttribute('role', 'status'); this.title.setAttribute('aria-live', 'polite');
    this.bar = node('div', 'ip-loading-bar'); this.bar.setAttribute('role', 'progressbar');
    this.bar.setAttribute('aria-label', 'Etapas de preparação do vídeo'); this.bar.setAttribute('aria-valuemin', '0'); this.bar.setAttribute('aria-valuemax', '3');
    this.bar.append(node('span', 'ip-intro-progress'));
    const steps = node('ol', 'ip-intro-steps'); steps.setAttribute('aria-label', 'Preparação do vídeo');
    this.steps = ['Buscando', 'Identificando', 'Carregando'].map(label => { const step = node('li', '', label); steps.append(step); return step; });
    const metrics = node('div', 'ip-intro-metrics');
    this.speedLabel = node('span', 'ip-intro-metric-label'); this.speed = node('strong', 'ip-intro-speed'); this.speedNote = node('small', 'ip-intro-metric-note');
    this.buffer = node('strong', 'ip-intro-buffer');
    const connectionMetric = node('div', 'ip-intro-metric ip-intro-connection'), available = node('div', 'ip-intro-metric');
    connectionMetric.append(this.speedLabel, this.speed, this.speedNote);
    available.append(node('span', 'ip-intro-metric-label', 'Vídeo disponível'), this.buffer, node('small', 'ip-intro-metric-note', 'Preparação para assistir'));
    metrics.append(connectionMetric, available);
    const details = node('div', 'ip-loading-details'); this.elapsed = node('span', 'ip-loading-elapsed'); this.note = node('span', 'ip-loading-estimate'); details.append(this.elapsed, this.note);
    content.append(brand, this.media, this.episode, this.title, this.bar, steps, metrics, details);
    this.root.append(atmosphere, content);
  }
  attach({item, episode}) {
    this.reset();
    this.current = {phase: 0, active: true, started: false, latestRate: null};
    this.root.dataset.kind = item.kind; this.root.dataset.mode = 'initial'; this.root.dataset.state = 'loading';
    this.media.textContent = String(item.name || 'Sua próxima sessão');
    this.episode.textContent = episode ? [episode.season ? `Temporada ${episode.season}` : '', episode.number ? `Episódio ${episode.number}` : episode.title || ''].filter(Boolean).join(' · ') : '';
    this.episode.hidden = !this.episode.textContent;
    const current = this.current;
    const metadata = () => { if (this.current === current && this.video.readyState >= 1) this.setPhase(2); };
    for (const event of ['loadedmetadata', 'loadeddata', 'canplay', 'progress']) {
      this.video.addEventListener(event, metadata); this.cleanup.push(() => this.video.removeEventListener(event, metadata));
    }
    this.renderPhase(); this.show();
  }
  setSource({url, hls = null}) {
    if (!this.current) return;
    const current = this.current, requestedAt = this.now();
    this.setPhase(1);
    const sample = rate => {
      if (this.current !== current || !positive(rate)) return;
      current.latestRate = {mbps: rate, at: this.now()}; this.update();
    };
    if (hls) {
      const events = globalThis.Hls?.Events || globalThis.window?.Hls?.Events;
      const onFragment = () => { if (this.current === current) this.setPhase(2); };
      const onLoaded = (_, data) => {
        if (data?.frag?.type && data.frag.type !== 'main') return;
        const stats = data?.stats || data?.frag?.stats;
        sample(transferMbps(stats?.loaded, stats?.loading?.start, stats?.loading?.end));
      };
      if (events?.FRAG_LOADING) { hls.on(events.FRAG_LOADING, onFragment); this.cleanup.push(() => hls.off(events.FRAG_LOADING, onFragment)); }
      if (events?.FRAG_LOADED) { hls.on(events.FRAG_LOADED, onLoaded); this.cleanup.push(() => hls.off(events.FRAG_LOADED, onLoaded)); }
    } else {
      // Native MP4/HLS can expose completed byte ranges through Resource Timing.
      // Cache hits and a previous source's pending responses are excluded.
      const source = new URL(url, globalThis.location?.href || 'http://localhost');
      const observer = this.observe(entries => {
        for (const entry of entries.getEntries()) {
          if (entry.name === source.href && entry.startTime >= requestedAt && entry.transferSize > 0) sample(transferMbps(entry.encodedBodySize, entry.responseStart, entry.responseEnd));
        }
      });
      if (observer) { try { observer.observe({type: 'resource'}); this.cleanup.push(() => observer.disconnect()); } catch { observer.disconnect(); } }
    }
  }
  setPhase(phase) {
    if (!this.current || phase <= this.current.phase) return;
    this.current.phase = Math.min(3, phase); this.renderPhase();
  }
  renderPhase() {
    if (!this.current) return;
    const {phase, started} = this.current;
    this.title.textContent = started ? this.current.message || 'Retomando seu vídeo' : phase === 3 ? 'Pronto para assistir' : PHASES[phase];
    this.bar.style.setProperty('--intro-progress', `${phase / 3 * 100}%`);
    if (started) this.bar.removeAttribute('aria-valuenow'); else this.bar.setAttribute('aria-valuenow', String(phase));
    this.bar.setAttribute('aria-valuetext', started ? this.title.textContent : `${phase} de 3 etapas concluídas`);
    for (const [index, step] of this.steps.entries()) {
      step.dataset.state = index < phase ? 'done' : index === phase ? 'active' : 'waiting';
      if (index === phase) step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current');
    }
  }
  show({started = false, message} = {}) {
    if (!this.current) return;
    clearTimeout(this.hideTimer); this.hideTimer = null;
    this.current.active = true; this.current.started = started; this.current.message = message;
    this.root.dataset.mode = started ? 'buffering' : 'initial'; this.root.dataset.state = 'loading';
    this.root.hidden = false; this.root.setAttribute('aria-busy', 'true'); this.renderPhase(); this.update();
  }
  hide({immediate = false} = {}) {
    if (!this.current) return;
    this.current.active = false; if (!immediate) this.setPhase(3); this.root.setAttribute('aria-busy', 'false');
    clearTimeout(this.hideTimer);
    if (immediate || this.root.hidden || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) { this.root.hidden = true; this.hideTimer = null; return; }
    this.root.dataset.state = 'ready';
    // Only the overlay fades. Playback has already started and never waits for it.
    const current = this.current;
    this.hideTimer = setTimeout(() => { if (this.current === current && !current.active) this.root.hidden = true; this.hideTimer = null; }, 360);
  }
  update({elapsed, estimateMs} = {}) {
    if (!this.current?.active) return;
    if (elapsed !== undefined) this.current.elapsed = elapsed;
    if (estimateMs !== undefined) this.current.estimateMs = estimateMs;
    const {latestRate, elapsed: seconds = 0, estimateMs: estimate, started, phase} = this.current;
    const measured = latestRate && this.now() - latestRate.at <= 10000;
    const estimated = positive(this.connection?.downlink) ? this.connection.downlink : null;
    const online = this.online();
    this.speedLabel.textContent = measured ? 'Recebendo vídeo' : 'Conexão estimada';
    this.speed.textContent = !online ? 'Sem conexão' : measured ? `${number(latestRate.mbps)} Mb/s` : estimated ? `${number(estimated)} Mb/s` : '—';
    this.speedNote.textContent = measured ? 'Taxa desta reprodução' : estimated ? 'Estimativa do navegador' : 'Aguardando dados da rede';
    this.buffer.textContent = `${number(bufferedSeconds(this.video))} s`;
    this.elapsed.textContent = `${Math.max(0, Math.floor(seconds))} s de preparação`;
    this.note.textContent = !online ? 'Verifique sua conexão com a internet.' : seconds >= 12 ? phase < 2 ? 'Aguardando a resposta do servidor…' : 'Preparando os primeiros quadros…' : !started && positive(estimate) ? `Início habitual: cerca de ${Math.max(1, Math.round(estimate / 1000))} s` : 'Seu vídeo começa assim que estiver pronto';
  }
  reset() {
    clearTimeout(this.hideTimer); this.hideTimer = null;
    for (const dispose of this.cleanup) dispose(); this.cleanup = [];
    this.current = null; this.root.hidden = true; this.root.setAttribute('aria-busy', 'false');
  }
}

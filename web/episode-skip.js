const STORAGE_KEY = 'arkhen.episode-skips.v1';
const ID = /^\d{1,12}$/;
const MARKS = ['openingStart', 'openingEnd', 'creditsStart'];
const MAX_EPISODES = 200;
const durationValid = value => Number.isFinite(value) && value > 0 && value <= 86400;

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

function identity(context) {
  const seriesId = validID(context?.seriesId), episodeId = validID(context?.episodeId);
  const source = fingerprintSource(context?.sourceFingerprint);
  return seriesId && episodeId && source ? {seriesId, episodeId, source} : null;
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

export class EpisodeSkipStore {
  constructor(storage = browserStorage(), now = Date.now) {
    this.storage = storage; this.now = now; this.records = new Map();
    try {
      const text = storage?.getItem(STORAGE_KEY);
      if (!text || text.length > 262144) return;
      const saved = JSON.parse(text);
      if (saved?.version !== 1 || !Array.isArray(saved.episodes)) return;
      for (const record of saved.episodes.slice(0, MAX_EPISODES)) {
        if (!record || typeof record.seriesId !== 'string' || typeof record.episodeId !== 'string' ||
            !ID.test(record.seriesId) || !ID.test(record.episodeId) || typeof record.source !== 'string' || !/^[a-f0-9]{16}$/.test(record.source) ||
            !Number.isFinite(record.updatedAt) || record.updatedAt < 0) continue;
        const marks = validateSkipMarkers(record.marks, record.duration);
        if (marks && Object.keys(marks).length) this.records.set(`${record.seriesId}:${record.episodeId}`, {seriesId: record.seriesId, episodeId: record.episodeId, source: record.source, duration: record.duration, marks, updatedAt: record.updatedAt});
      }
    } catch { /* Marking still works in the current session. */ }
  }
  read(context, duration) {
    const current = identity(context);
    if (!current || !durationValid(duration)) return {marks: {}, incompatible: false};
    const record = this.records.get(`${current.seriesId}:${current.episodeId}`);
    const matches = record && record.source === current.source && Math.round(record.duration * 1000) === Math.round(duration * 1000);
    return {marks: matches ? {...record.marks} : {}, incompatible: Boolean(record && !matches)};
  }
  save(context, duration, marks) {
    const current = identity(context), safe = validateSkipMarkers(marks, duration);
    if (!current || !safe || !Object.keys(safe).length) return false;
    const key = `${current.seriesId}:${current.episodeId}`;
    this.records.set(key, {...current, duration, marks: safe, updatedAt: this.now()});
    const ordered = [...this.records.entries()].sort((first, second) => Number(second[0] === key) - Number(first[0] === key) || second[1].updatedAt - first[1].updatedAt);
    this.records = new Map(ordered.slice(0, MAX_EPISODES));
    return this.persist();
  }
  clear(context) {
    const seriesId = validID(context?.seriesId), episodeId = validID(context?.episodeId);
    if (!seriesId || !episodeId) return false;
    this.records.delete(`${seriesId}:${episodeId}`); return this.persist();
  }
  persist() {
    try {
      if (typeof this.storage?.setItem !== 'function') return false;
      this.storage.setItem(STORAGE_KEY, JSON.stringify({version: 1, episodes: [...this.records.values()]})); return true;
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
  constructor({video, storage, document = globalThis.document, onNextEpisode, hasNextEpisode = () => false, notify = () => {}, onAction = () => {}}) {
    this.video = video; this.document = document; this.store = new EpisodeSkipStore(storage);
    this.options = {onNextEpisode, hasNextEpisode, notify, onAction}; this.context = null; this.disposers = [];
    this.build();
    for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'seeked', 'ended', 'error']) this.listen(video, event, () => this.update());
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
    this.status = this.node('p', 'episode-skip-status'); this.status.setAttribute('role', 'status');
    this.panel.append(grid, this.status, this.clearButton);
    this.overlay = this.node('div', 'episode-skip-actions'); this.overlay.setAttribute('role', 'group'); this.overlay.setAttribute('aria-label', 'Pular trechos marcados');
    this.openingButton = this.button('Pular abertura', () => this.skipOpening(), 'episode-skip-action');
    this.creditsButton = this.button('Pular final', () => this.skipCredits(), 'episode-skip-action');
    this.overlay.append(this.openingButton, this.creditsButton);
  }
  attach({item, episode, sourceFingerprint} = {}) {
    this.reset();
    const context = {seriesId: item?.id, episodeId: episode?.id, sourceFingerprint};
    if (item?.kind !== 'series' || !identity(context)) return;
    this.context = context; this.update();
  }
  reset() {
    this.context = null; this.panel.hidden = true; this.overlay.hidden = true;
    this.openingButton.hidden = true; this.creditsButton.hidden = true; this.setStatus('');
  }
  setStatus(text) { if (this.status.textContent !== text) this.status.textContent = text; }
  state() {
    const duration = this.video.duration, currentTime = this.video.currentTime;
    const ready = Boolean(this.context) && durationValid(duration) && Number.isFinite(currentTime) && currentTime >= 0 && currentTime < duration && !this.video.error;
    return {duration, currentTime, ready, ...this.store.read(this.context, duration)};
  }
  update() {
    if (!this.context) return;
    const state = this.state(), active = state.ready ? activeSkipActions(state.marks, state.currentTime, state.duration) : {opening: false, credits: false};
    this.panel.hidden = false; this.openingButton.hidden = !active.opening; this.creditsButton.hidden = !active.credits; this.overlay.hidden = !active.opening && !active.credits;
    for (const [key, value] of this.markerValues) { const text = timeLabel(state.marks[key]); if (value.textContent !== text) value.textContent = text; }
    for (const button of this.markerButtons.values()) button.disabled = !state.ready;
    this.markerButtons.get('openingEnd').disabled = !state.ready || state.marks.openingStart === undefined || state.currentTime <= state.marks.openingStart;
    this.markerButtons.get('creditsStart').disabled = !state.ready || state.currentTime <= 0;
    this.clearButton.disabled = !this.store.records.has(`${this.context.seriesId}:${this.context.episodeId}`);
    if (state.incompatible) this.setStatus('As marcações salvas pertencem a outra versão deste episódio. Marque os trechos novamente.');
    else if (!state.ready && !durationValid(state.duration)) this.setStatus('Aguarde o vídeo carregar para marcar os trechos.');
    else if (this.status.textContent === 'Aguarde o vídeo carregar para marcar os trechos.') this.setStatus('');
  }
  mark(key) {
    const state = this.state();
    if (!state.ready || !MARKS.includes(key)) return false;
    const marks = validateSkipMarkers({...state.marks, [key]: state.currentTime}, state.duration);
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
    try { this.video.currentTime = state.marks.openingEnd; this.update(); this.options.onAction(); return true; }
    catch { this.options.notify('Este vídeo não permitiu avançar agora.'); return false; }
  }
  skipCredits() {
    const state = this.state();
    if (!state.ready || !activeSkipActions(state.marks, state.currentTime, state.duration).credits) return false;
    try {
      if (this.options.hasNextEpisode() && typeof this.options.onNextEpisode === 'function') {
        Promise.resolve(this.options.onNextEpisode()).catch(() => this.options.notify('Não foi possível abrir o próximo episódio.'));
      } else { this.video.currentTime = state.duration; this.update(); }
      this.options.onAction(); return true;
    } catch { this.options.notify('Este vídeo não permitiu avançar agora.'); return false; }
  }
  destroy() { this.reset(); this.disposers.forEach(dispose => dispose()); this.disposers = []; this.panel.remove(); this.overlay.remove(); }
}

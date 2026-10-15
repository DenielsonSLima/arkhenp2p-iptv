import { artworkURL } from './channel-artwork.js';

const list = value => Array.isArray(value) ? value : [];

// Prioritize the banner, then give movies, series and channels equal turns.
// Only current visible shelf items can contribute artwork to preparation.
export function openingArtwork({hero = [], shelves = [], perType = 30, resolveArtwork = item => item.poster} = {}) {
  const limit = Number.isInteger(perType) && perType >= 0 ? perType : 30;
  const urls = [...new Set(list(hero).map(artworkURL).filter(Boolean))], seen = new Set(urls);
  const queues = new Map(['movie', 'series', 'live'].map(kind => [kind, []]));
  for (const shelf of list(shelves)) for (const item of list(shelf?.items)) {
    const queue = queues.get(item?.kind);
    if (!queue) continue;
    const url = artworkURL(resolveArtwork(item));
    if (url) queue.push(url);
  }
  const positions = new Map([...queues.keys()].map(kind => [kind, 0]));
  for (let index = 0; index < limit; index++) for (const [kind, queue] of queues) {
    let position = positions.get(kind);
    while (position < queue.length && seen.has(queue[position])) position++;
    if (position < queue.length) { const url = queue[position++]; seen.add(url); urls.push(url); }
    positions.set(kind, position);
  }
  return urls;
}

// Warm opening artwork without starting media; deadlines keep login bounded.
export async function preloadArtwork(values, {signal, maxItems = 96, concurrency = 4, timeoutMs = 4000, deadlineMs = 8000, createImage = () => new Image(), onProgress = () => {}} = {}) {
  const limit = Number.isInteger(maxItems) && maxItems >= 0 ? maxItems : 96;
  const urls = [...new Set(list(values).filter(artworkURL))].slice(0, limit);
  const externalSignal = signal, controller = new AbortController(), cancelAll = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener('abort', cancelAll, {once:true});
  signal = controller.signal;
  const deadline = setTimeout(cancelAll, deadlineMs);
  let cursor = 0, completed = 0, loaded = 0;
  const warm = url => new Promise(resolve => {
    if (signal?.aborted) { resolve(false); return; }
    const picture = createImage(); let settled = false;
    const settle = success => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      picture.onload = null; picture.onerror = null;
      if (!success) picture.removeAttribute?.('src');
      resolve(success);
    };
    const cancel = () => settle(false);
    const timer = setTimeout(cancel, timeoutMs);
    signal?.addEventListener('abort', cancel, {once:true});
    picture.onload = async () => {
      try { await picture.decode?.(); } catch { /* A loaded image can still be displayed. */ }
      settle(!signal?.aborted);
    };
    picture.onerror = () => settle(false);
    picture.decoding = 'async'; picture.loading = 'eager'; picture.src = url;
  });
  const worker = async () => {
    while (!signal?.aborted && cursor < urls.length) {
      const url = urls[cursor++], success = await warm(url);
      completed++; if (success) loaded++;
      onProgress({completed, loaded, total:urls.length});
    }
  };
  try {
    await Promise.all(Array.from({length:Math.min(Math.max(1, concurrency), urls.length)}, worker));
    return {completed, loaded, total:urls.length};
  } finally { clearTimeout(deadline); externalSignal?.removeEventListener('abort', cancelAll); }
}

const STEPS = [
  ['auth', 'Autenticando seu acesso'],
  ['movies', 'Organizando filmes'],
  ['series', 'Organizando séries'],
  ['live', 'Preparando a TV ao vivo'],
  ['artwork', 'Carregando as primeiras capas']
];
const STEP_NAMES = {auth:'Acesso', movies:'Filmes', series:'Séries', live:'TV ao vivo', artwork:'Capas'};
function node(tag, className, text) {
  const result = document.createElement(tag); result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}
export class SessionLoader {
  constructor(root) {
    this.root = root; this.root.classList.add('session-loader'); this.root.setAttribute('aria-label', 'Preparação do seu catálogo');
    const atmosphere = node('div', 'session-loader-atmosphere'); atmosphere.setAttribute('aria-hidden', 'true');
    atmosphere.append(node('span', 'session-loader-light'), node('span', 'session-loader-light'));
    const content = node('div', 'session-loader-content'), brand = node('div', 'session-loader-brand');
    const emblem = node('div', 'session-loader-emblem'), shine = node('span', 'session-loader-shine'); shine.setAttribute('aria-hidden', 'true');
    const symbol = node('img', 'session-loader-symbol'), wordmark = node('img', 'session-loader-wordmark');
    symbol.src = '/assets/brand/symbol.svg'; symbol.alt = ''; wordmark.src = '/assets/brand/wordmark.svg'; wordmark.alt = 'ARKHEN';
    emblem.append(symbol, shine); brand.append(emblem, wordmark, node('span', 'session-loader-product', 'P2 IPTV'));
    this.message = node('h1', 'session-loader-message', 'Reconhecendo sua sessão'); this.message.setAttribute('role', 'status');
    const status = node('div', 'session-loader-status');
    this.phase = node('span', 'session-loader-phase', 'Acesso');
    this.count = node('span', 'session-loader-count', `0 / ${STEPS.length}`); this.count.setAttribute('aria-hidden', 'true');
    status.append(this.phase, this.count);
    const track = node('div', 'session-loader-track'), sweep = node('span', 'session-loader-sweep'); sweep.setAttribute('aria-hidden', 'true');
    this.progress = node('progress', 'session-loader-progress'); this.progress.max = STEPS.length; this.progress.value = 0;
    this.progress.setAttribute('aria-label', 'Etapas de preparação verificadas'); track.append(this.progress, sweep);
    this.caption = node('p', 'session-loader-caption'); this.caption.setAttribute('aria-live', 'polite');
    const list = node('ol', 'session-loader-steps'); this.steps = new Map();
    for (const [key, label] of STEPS) {
      const row = node('li', 'session-loader-step'), dot = node('span', 'session-loader-dot'); dot.setAttribute('aria-hidden', 'true');
      row.append(dot, node('span', 'session-loader-step-label', label)); row.dataset.state = 'waiting'; list.append(row); this.steps.set(key, row);
    }
    content.append(brand, this.message, status, track, this.caption, list); this.root.replaceChildren(atmosphere, content);
    this.controller = null;
  }
  start(message = 'Autenticando seu acesso') {
    this.controller?.abort(); this.controller = new AbortController();
    for (const row of this.steps.values()) row.dataset.state = 'waiting';
    this.message.textContent = message; this.progress.value = 0; this.caption.textContent = 'Preparando seu universo';
    this.root.hidden = false; this.root.setAttribute('aria-busy', 'true'); document.body.classList.add('session-preparing');
    this.mark('auth', 'loading'); return this.controller.signal;
  }
  mark(key, state = 'done') {
    const row = this.steps.get(key); if (!row || !['waiting','loading','done','partial'].includes(state)) return; row.dataset.state = state;
    this.progress.value = [...this.steps.values()].filter(row => ['done', 'partial'].includes(row.dataset.state)).length;
    const loading = [...this.steps].filter(([,row]) => row.dataset.state === 'loading').map(([key]) => STEP_NAMES[key]);
    this.phase.textContent = loading.join(' · ') || (this.progress.value === STEPS.length ? 'Preparação finalizada' : 'Preparando a próxima etapa');
    this.count.textContent = `${this.progress.value} / ${STEPS.length}`;
    this.root.dataset.working = String(loading.length > 0);
    this.caption.textContent = `${this.progress.value} de ${STEPS.length} etapas verificadas`;
  }
  text(value) { this.message.textContent = value; }
  finish() {
    this.controller?.abort(); this.controller = null;
    this.root.hidden = true; this.root.setAttribute('aria-busy', 'false'); document.body.classList.remove('session-preparing');
  }
}

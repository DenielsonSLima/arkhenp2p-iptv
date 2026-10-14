import { artworkURL } from './channel-artwork.js';

// Warm only the artwork used by the opening screen, without starting media.
export async function preloadArtwork(values, {signal, concurrency = 4, timeoutMs = 4000, deadlineMs = 8000, createImage = () => new Image(), onProgress = () => {}} = {}) {
  const urls = [...new Set(values.filter(artworkURL))].slice(0, 24);
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
function node(tag, className, text) {
  const result = document.createElement(tag); result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}
export class SessionLoader {
  constructor(root) {
    this.root = root; this.root.classList.add('session-loader'); this.root.setAttribute('aria-label', 'Preparação do seu catálogo');
    const content = node('div', 'session-loader-content'), brand = node('div', 'session-loader-brand');
    const symbol = node('img', 'session-loader-symbol'), wordmark = node('img', 'session-loader-wordmark');
    symbol.src = '/assets/brand/symbol.svg'; symbol.alt = ''; wordmark.src = '/assets/brand/wordmark.svg'; wordmark.alt = 'ARKHEN';
    brand.append(symbol, wordmark, node('span', 'session-loader-product', 'P2 IPTV'));
    this.message = node('h1', 'session-loader-message', 'Reconhecendo sua sessão'); this.message.setAttribute('role', 'status');
    this.progress = node('progress', 'session-loader-progress'); this.progress.max = STEPS.length; this.progress.value = 0;
    this.progress.setAttribute('aria-label', 'Etapas de preparação concluídas');
    this.caption = node('p', 'session-loader-caption'); this.caption.setAttribute('aria-live', 'polite');
    const list = node('ol', 'session-loader-steps'); this.steps = new Map();
    for (const [key, label] of STEPS) {
      const row = node('li', 'session-loader-step'), dot = node('span', 'session-loader-dot'); dot.setAttribute('aria-hidden', 'true');
      row.append(dot, node('span', '', label)); row.dataset.state = 'waiting'; list.append(row); this.steps.set(key, row);
    }
    content.append(brand, this.message, this.progress, this.caption, list); this.root.replaceChildren(content);
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
    const row = this.steps.get(key); if (!row) return; row.dataset.state = state;
    this.progress.value = [...this.steps.values()].filter(row => ['done', 'partial'].includes(row.dataset.state)).length;
    this.caption.textContent = `${this.progress.value} de ${STEPS.length} etapas concluídas`;
  }
  text(value) { this.message.textContent = value; }
  finish() {
    this.controller?.abort(); this.controller = null;
    this.root.hidden = true; this.root.setAttribute('aria-busy', 'false'); document.body.classList.remove('session-preparing');
  }
}

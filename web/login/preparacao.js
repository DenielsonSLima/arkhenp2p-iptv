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
  dispose(){this.finish();this.root.replaceChildren();}
  finish() {
    this.controller?.abort(); this.controller = null;
    this.root.hidden = true; this.root.setAttribute('aria-busy', 'false'); document.body.classList.remove('session-preparing');
  }
}

import {isAdultItem} from '../../parental-classification.js';
import {homeChannelFeedback} from './estado.js';
import {programWindow} from '../../tv/canais/programacao.js';

/** Five server-ordered channel cards. UI filtering never ranks or fills slots. */
export class HomeChannelShelf {
  constructor({getScope = () => null, isActive = () => false, isVisible = () => true,
    createLogo, createFavorite, refreshFavorite = () => {}, onWatch = () => {}, onMore, onRetry,
    environment = globalThis} = {}) {
    Object.assign(this, {getScope, isActive, isVisible, createLogo, createFavorite,
      refreshFavorite, onWatch, onMore, onRetry, environment});
    this.document = environment.document;
    this.records = new Map();
    this.section = null;
    this.featuredId = null;
    this.items = [];

  }

  #node(tag, className = '', text) {
    const element = this.document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  #createSection() {
    const section = this.#node('section', 'shelf home-channel-shelf');
    section.dataset.shelfKey = 'home:live';
    section.setAttribute('aria-label', 'Seus canais mais assistidos e recentes');
    const header = this.#node('div', 'shelf-header'), titles = this.#node('div');
    titles.append(this.#node('span', 'eyebrow', 'SUA TV'), this.#node('h2', '', 'Seus canais mais assistidos e recentes'));
    header.append(titles);
    if (typeof this.onMore === 'function') {
      const more = this.#node('button', 'shelf-more', 'VER TUDO');
      more.type = 'button';
      more.addEventListener('click', () => {
        const stopped = this.pause('navigate');
        this.onMore({stopped});
        void stopped.catch(() => {});
      });
      header.append(more);
    }
    this.row = this.#node('div', 'home-channel-grid');
    this.feedback = this.#node('div', 'home-channel-feedback');
    this.feedback.hidden = true;
    this.feedback.setAttribute('role', 'status');
    this.feedback.setAttribute('aria-live', 'polite');
    this.feedbackCopy = this.#node('p');
    this.feedback.append(this.feedbackCopy);
    if (typeof this.onRetry === 'function') {
      this.retry = this.#node('button', 'button secondary small home-channel-retry', 'Tentar novamente');
      this.retry.type = 'button';
      this.retry.addEventListener('click', () => {
        try { void Promise.resolve(this.onRetry()).catch(() => {}); } catch { /* The model owns its visible error state. */ }
      });
      this.feedback.append(this.retry);
    }
    section.append(header, this.feedback, this.row);
    return section;
  }

  #createRecord(entry) {
    const record = {item: entry.item};
    record.card = this.#node('article', 'home-channel-card');
    record.play = this.#node('button', 'home-channel-open');
    record.play.type = 'button';
    record.frame = this.#node('div', 'home-channel-frame');
    record.logo = this.#node('div', 'home-channel-art');
    record.live = this.#node('span', 'home-channel-live', 'AO VIVO');
    record.playMark = this.#node('span', 'home-channel-play');
    record.playMark.setAttribute('aria-hidden', 'true');
    record.frame.append(record.logo, record.live, record.playMark);
    const copy = this.#node('div', 'home-channel-copy');
    record.reason = this.#node('span', 'home-channel-reason');
    record.title = this.#node('h3');
    copy.append(record.reason, record.title);
    record.program = this.#node('div', 'home-channel-program');
    record.programPlaceholder = this.#node('span', 'home-channel-program-placeholder');
    record.programRows = this.#node('div', 'home-channel-program-rows');
    record.programNodes = {};
    for (const [key, label] of [['current', 'Agora']]) {
      const row = this.#node('div', `home-channel-program-row home-channel-program-${key}`);
      const title = this.#node('strong', 'home-channel-program-title');
      const time = this.#node('span', 'home-channel-program-time');
      row.append(this.#node('span', 'home-channel-program-label', label), title, time);
      record.programRows.append(row);
      record.programNodes[key] = {row, title, time};
    }
    record.programProgress = this.#node('progress', 'home-channel-program-progress');
    record.programProgress.max = 100;
    record.programProgress.setAttribute('aria-label', 'Tempo do programa atual');
    record.programNotice = this.#node('span', 'home-channel-program-notice');
    record.program.append(record.programPlaceholder, record.programRows, record.programProgress, record.programNotice);
    copy.append(record.program);
    this.#updateProgram(record, null);
    record.play.append(record.frame, copy);
    record.play.addEventListener('click', () => {
      const stopped = this.pause('watch');
      // Keep activation in this click: the app can show/request fullscreen now,
      // then await stopped before preflight or a new provider generation.
      try {
        const opened = this.onWatch(record.item, {stopped, fullscreen: true});
        void Promise.resolve(opened).catch(() => {});
      } catch { /* The owner presents its playback error. */ }
      void stopped.catch(() => {});
    });
    record.card.append(record.play);
    const favorite = this.createFavorite?.(record.item);
    if (favorite?.nodeType === 1) {
      favorite.classList.add('card-favorite');
      record.favorite = favorite;
      record.card.append(favorite);
    }
    return record;
  }

  #updateRecord(record, entry, featured) {
    record.item = entry.item;
    record.card.dataset.channelId = String(entry.item.id);
    record.card.classList.toggle('is-featured', featured);
    record.card.classList.toggle('is-most-watched', featured && entry.reason === 'most-watched');
    record.play.setAttribute('aria-label', `Assistir ${entry.item.name} em tela cheia`);
    record.title.textContent = entry.item.name;
    record.title.title = entry.item.name;
    record.reason.textContent = featured ? entry.reason === 'most-watched'
      ? 'Mais assistido · 7 dias' : 'Seu canal ao vivo' : 'Assistido recentemente';
    const signature = JSON.stringify([entry.item.name, entry.item.poster, entry.item.posterOriginal]);
    if (signature !== record.artSignature) {
      record.artSignature = signature;
      const logo = this.createLogo?.(entry.item);
      record.logo.replaceChildren(logo?.nodeType === 1 ? logo : this.#node('span',
        'home-channel-initial', String(entry.item.name).replace(/^(?:CANAL|TV)\s*/i, '').slice(0, 2).toUpperCase()));
    }
    if (record.favorite) this.refreshFavorite(record.favorite, entry.item);
  }

  #updateProgram(record, data, state = {}) {
    const programs = programWindow(data), available = Boolean(programs.current);
    const loading = !available && Boolean(state.loading), failed = !available && Boolean(state.error);
    const stale = Boolean(data?.stale || state.stale || available && state.error);
    record.program.dataset.state = available ? 'ready' : loading ? 'loading' : failed ? 'error' : 'unavailable';
    record.program.dataset.stale = String(stale);
    record.programPlaceholder.hidden = available;
    record.programPlaceholder.textContent = loading ? 'Carregando programação…'
      : failed ? 'Programação indisponível agora' : 'Programação não informada';
    record.programRows.hidden = !available;
    for (const key of ['current']) {
      const program = programs[key], nodes = record.programNodes[key];
      nodes.row.hidden = !program;
      nodes.title.textContent = program?.title || '';
      nodes.title.title = program?.title || '';
      nodes.time.textContent = program ? key === 'current'
        ? [program.startLabel, program.endLabel].filter(Boolean).join(' — ') : program.startLabel : '';
    }
    record.programProgress.hidden = !programs.current;
    record.programProgress.value = programs.current && Number.isFinite(data?.progressPercent)
      ? Math.min(100, Math.max(0, data.progressPercent)) : 0;
    record.programNotice.textContent = available && stale ? 'Última programação disponível'
      : available && state.loading ? 'Atualizando programação…' : '';
    record.programNotice.hidden = !record.programNotice.textContent;
  }

  /** Present the existing shared guide. No request, local clock or playback
   * change or shelf render is triggered by a programme/progress update. */
  updatePrograms(dataById, state = {}) {
    for (const [id, record] of this.records) this.#updateProgram(record,
      dataById instanceof Map ? dataById.get(id) : dataById?.[id], state);
  }

  getItems() { return this.items.slice(); }

  render(existing, dto = {}, state) {
    if (!this.section) this.section = this.#createSection();
    // Only this class owns its DOM; a previous generic shelf is replaced by the
    // caller instead of moving its carousel/buttons into this five-card grid.
    const entries = [], seen = new Set();
    for (const entry of Array.isArray(dto.items) ? dto.items : []) {
      const item = entry?.item, id = String(item?.id ?? '');
      if (item?.kind !== 'live' || !/^\d{1,12}$/.test(id) || typeof item.name !== 'string'
        || !item.name.trim() || isAdultItem(item) || !this.isVisible(item) || seen.has(id)
        || !['most-watched', 'default-globo', 'recent'].includes(entry.reason)) continue;
      seen.add(id);
      entries.push({...entry, item: {...item, id}});
      if (entries.length === 5) break;
    }
    const featuredId = dto.featuredId === undefined ? dto.mostWatchedId : dto.featuredId;
    const featured = entries.find((entry, index) => index === 0
      && ['most-watched', 'default-globo'].includes(entry.reason)
      && String(featuredId ?? '') === entry.item.id);
    const nextFeaturedId = featured?.item.id || null;
    this.featuredId = nextFeaturedId;
    this.items = entries.map(entry => entry.item);
    this.row.dataset.featured = String(Boolean(nextFeaturedId));
    const activeIds = new Set(entries.map(entry => entry.item.id));
    for (const [id, record] of this.records) if (!activeIds.has(id)) {
      record.card.remove();
      this.records.delete(id);
    }
    entries.forEach((entry, index) => {
      let record = this.records.get(entry.item.id);
      if (!record) { record = this.#createRecord(entry); this.records.set(entry.item.id, record); }
      this.#updateRecord(record, entry, entry.item.id === this.featuredId);
      if (this.row.children[index] !== record.card) this.row.insertBefore(record.card, this.row.children[index] || null);
    });
    const loading = state?.loading === true, feedback = homeChannelFeedback(state, entries.length > 0);
    this.feedback.hidden = feedback.phase === 'ready' || feedback.phase === 'loading' && entries.length > 0;
    this.feedback.classList.toggle('is-compact', entries.length > 0);
    this.feedback.classList.toggle('is-error', feedback.phase === 'error' || feedback.phase === 'waiting');
    this.feedbackCopy.textContent = feedback.message;
    if (this.retry) {
      this.retry.hidden = !feedback.retry;
      this.retry.disabled = loading;
    }
    this.row.hidden = entries.length === 0;
    this.section.setAttribute('aria-busy', String(loading));
    this.section.hidden = false;
    return this.section;
  }

  sync() {}
  pause() { return Promise.resolve(); }
  reset() {
    const stopped = this.pause('reset');
    this.featuredId = null;
    this.items = [];
    this.records.clear();
    this.row?.replaceChildren();
    if (this.section) this.section.hidden = true;
    return stopped;
  }
  dispose() {
    this.items = [];
    this.records.clear();
    return this.reset();
  }
}

import {HomeChannelPreview} from './previa.js';
import {isAdultItem} from '../../parental-classification.js';

/** Four server-ordered channel cards. UI filtering never ranks or fills slots. */
export class HomeChannelShelf {
  constructor({getScope = () => null, isActive = () => false, isVisible = () => true,
    createLogo, createFavorite, refreshFavorite = () => {}, onWatch = () => {}, onMore, onRetry,
    preview = {}, environment = globalThis, HlsClass = environment.Hls} = {}) {
    Object.assign(this, {getScope, isActive, isVisible, createLogo, createFavorite,
      refreshFavorite, onWatch, onMore, onRetry, environment});
    this.document = environment.document;
    this.records = new Map();
    this.section = null;
    this.featuredId = null;
    this.video = this.#node('video', 'home-channel-video');
    this.video.muted = this.video.defaultMuted = true;
    this.video.volume = 0;
    this.video.playsInline = true;
    this.video.controls = false;
    this.video.hidden = true;
    this.video.setAttribute('aria-hidden', 'true');
    this.video.setAttribute('tabindex', '-1');
    this.preview = new HomeChannelPreview({...preview, getScope, isActive, environment, HlsClass,
      onState: state => this.#previewState(state)});
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
    section.setAttribute('aria-label', 'Seus canais');
    const header = this.#node('div', 'shelf-header'), titles = this.#node('div');
    titles.append(this.#node('span', 'eyebrow', 'SUA TV'), this.#node('h2', '', 'Seus canais'));
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
    record.status = this.#node('span', 'home-channel-status');
    record.status.setAttribute('aria-live', 'polite');
    copy.append(record.reason, record.title, record.status);
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
    record.card.classList.toggle('is-most-watched', featured);
    record.play.setAttribute('aria-label', `Assistir ${entry.item.name} em tela cheia`);
    record.title.textContent = entry.item.name;
    record.title.title = entry.item.name;
    record.reason.textContent = featured ? 'Mais assistido' : 'Assistido recentemente';
    if (!featured) record.status.textContent = 'Abrir canal';
    const signature = JSON.stringify([entry.item.name, entry.item.poster, entry.item.posterOriginal]);
    if (signature !== record.artSignature) {
      record.artSignature = signature;
      const logo = this.createLogo?.(entry.item);
      record.logo.replaceChildren(logo?.nodeType === 1 ? logo : this.#node('span',
        'home-channel-initial', String(entry.item.name).replace(/^(?:CANAL|TV)\s*/i, '').slice(0, 2).toUpperCase()));
    }
    if (record.favorite) this.refreshFavorite(record.favorite, entry.item);
  }

  #previewState({state, channelId}) {
    if (channelId && String(channelId) !== this.featuredId) return;
    const record = this.records.get(this.featuredId);
    this.video.hidden = state !== 'playing';
    if (!record) return;
    record.frame.dataset.previewState = state;
    record.status.textContent = state === 'playing' ? 'Prévia sem áudio'
      : state === 'preparing' ? 'Preparando prévia…' : 'Abrir canal';
  }

  render(existing, dto = {}, state) {
    if (!this.section) this.section = this.#createSection();
    // Only this class owns its DOM; a previous generic shelf is replaced by the
    // caller instead of moving its carousel/buttons into this four-card grid.
    const entries = [], seen = new Set();
    for (const entry of Array.isArray(dto.items) ? dto.items : []) {
      const item = entry?.item, id = String(item?.id ?? '');
      if (item?.kind !== 'live' || !/^\d{1,12}$/.test(id) || typeof item.name !== 'string'
        || !item.name.trim() || isAdultItem(item) || !this.isVisible(item) || seen.has(id)
        || !['most-watched', 'recent'].includes(entry.reason)) continue;
      seen.add(id);
      entries.push({...entry, item: {...item, id}});
      if (entries.length === 4) break;
    }
    const featured = entries.find(entry => entry.reason === 'most-watched'
      && String(dto.mostWatchedId ?? '') === entry.item.id);
    const nextFeaturedId = featured?.item.id || null;
    if (nextFeaturedId !== this.featuredId) {
      this.preview.setTarget(null, null);
      this.video.remove();
      this.video.hidden = true;
    }
    this.featuredId = nextFeaturedId;
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
    const record = this.records.get(this.featuredId);
    if (record) {
      if (this.video.parentNode !== record.frame) record.frame.prepend(this.video);
      this.preview.setTarget(this.video, record.item, {host: record.frame});
    } else this.preview.setTarget(null, null);
    const loading = state?.loading === true, error = Boolean(state?.error);
    const empty = Boolean(state?.data) && entries.length === 0;
    this.feedback.hidden = !loading && !error && !empty;
    this.feedback.classList.toggle('is-error', error);
    this.feedbackCopy.textContent = loading ? entries.length ? 'Atualizando seus canais…' : 'Carregando seus canais…'
      : error ? entries.length ? 'Não foi possível atualizar seus canais. A última seleção continua disponível.'
        : 'Não foi possível carregar seus canais agora.'
        : empty ? 'Assista aos seus canais para vê-los aqui.' : '';
    if (this.retry) {
      this.retry.hidden = !error;
      this.retry.disabled = loading;
    }
    this.row.hidden = entries.length === 0;
    this.section.setAttribute('aria-busy', String(loading));
    this.section.hidden = entries.length === 0 && this.feedback.hidden;
    return this.section;
  }

  sync() { this.preview.sync(); }
  pause(reason = 'owner', options) { return this.preview.pause(reason, options); }
  reset() {
    const stopped = this.pause('reset');
    this.preview.setTarget(null, null);
    this.video.remove();
    this.video.hidden = true;
    this.featuredId = null;
    this.records.clear();
    this.row?.replaceChildren();
    if (this.section) this.section.hidden = true;
    return stopped;
  }
  dispose() {
    this.records.clear();
    return this.preview.dispose();
  }
}

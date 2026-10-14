import { withoutSessionArtwork } from './stored-artwork.js';

const entries = value => value && typeof value === 'object' ? Object.entries(value) : [];
export const isPagedCatalog = catalog => catalog?.pagination?.mode === 'category';

// Responses are snapshots. Merge them because separate category pages can finish out of order.
export function mergeCatalogPage(previous, incoming) {
  const categories = new Map((previous?.sourceCategories || []).map(item => [String(item.id), item]));
  for (const item of incoming.categories || []) categories.set(String(item.id), item);
  const items = new Map((previous?.items || []).map(item => [String(item.id), item]));
  for (const item of incoming.items || []) {
    const old = items.get(String(item.id));
    const categoryIds = [...new Set([...(old?.categoryIds || [old?.categoryId]), ...(item.categoryIds || [item.categoryId])].filter(value => value !== undefined && value !== null).map(String))];
    items.set(String(item.id), {...old, ...item, categoryIds});
  }
  const byCategory = {...previous?.pagination?.byCategory};
  for (const [id, incomingPage] of entries(incoming.pagination?.byCategory)) {
    const old = byCategory[id];
    if (!old || Number(incomingPage.nextPage) >= Number(old.nextPage)) byCategory[id] = {...incomingPage};
    if (old?.loaded && old.hasMore === false) byCategory[id] = {...old};
  }
  return {...incoming, categories:[...categories.values()], items:[...items.values()], pagination:{...incoming.pagination, byCategory}};
}

export function pageChoices(catalog, category = '__all', initialOnly = false) {
  if (!isPagedCatalog(catalog) || category === '__favorites' || category.startsWith('custom:')) return [];
  const states = catalog.pagination.byCategory || {};
  const ids = category === '__all' ? Object.keys(states) : [...(catalog.categories.find(group => group.id === category)?.ids || [])].map(String);
  return ids.map(id => ({id, ...states[id]})).filter(state => states[state.id] && state.hasMore !== false && (!initialOnly || !state.loaded))
    .sort((first, second) => Number(first.nextPage || 1) - Number(second.nextPage || 1));
}

export function rememberedTitles(catalogFor, favorites, history, limit = 16) {
  const recent = [...history.values()].sort((a, b) => Number(b.updated || 0) - Number(a.updated || 0)).map(entry => entry.item);
  const seen = new Set();
  return [...recent, ...favorites.values()].filter(item => {
    if (!item || !['movie', 'series'].includes(item.kind) || !/^\d+$/.test(String(item.id))) return false;
    const type = item.kind === 'movie' ? 'movies' : 'series', catalog = catalogFor(type), key = `${type}:${item.id}`;
    if (!isPagedCatalog(catalog) || catalog.itemMap?.has(String(item.id)) || seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, limit);
}

// Fetch at most four category pages per action. Unvisited categories stay visible and load on demand.
export class CatalogPager {
  constructor({request, getCatalog, onData, onChange, isCategoryAllowed = () => true, limit = 4}) {
    Object.assign(this, {request, getCatalog, onData, onChange, isCategoryAllowed, limit});
    this.pending = new Map(); this.errors = new Map(); this.epochs = new Map();
  }
  reset(type) {
    const types = type ? [type] : ['movies', 'series', 'live'];
    for (const name of types) this.epochs.set(name, (this.epochs.get(name) || 0) + 1);
    for (const key of this.pending.keys()) if (types.some(name => key.startsWith(`${name}:`))) this.pending.delete(key);
    for (const key of this.errors.keys()) if (types.some(name => key.startsWith(`${name}:`))) this.errors.delete(key);
  }
  choices(type, category, initialOnly = false) {
    return pageChoices(this.getCatalog(type), category, initialOnly).filter(state => this.isCategoryAllowed(type,state.id));
  }
  pendingFor(type, category) {
    const ids = new Set(this.choices(type, category).map(state => state.id));
    return [...this.pending.keys()].some(key => key.startsWith(`${type}:`) && ids.has(key.slice(type.length + 1)));
  }
  errorFor(type, category) {
    for (const state of this.choices(type, category)) {
      const error = this.errors.get(`${type}:${state.id}`); if (error) return error;
    }
    return '';
  }
  async load(type, category = '__all', {initialOnly = false} = {}) {
    const epoch = this.epochs.get(type) || 0;
    const choices = this.choices(type, category, initialOnly).slice(0, this.limit);
    const results = await Promise.allSettled(choices.map(state => {
      const key = `${type}:${state.id}`;
      if (this.pending.has(key)) return this.pending.get(key);
      this.errors.delete(key);
      const pending = Promise.resolve().then(async () => {
        const response = await this.request(`/api/catalog?type=${encodeURIComponent(type)}&category=${encodeURIComponent(state.id)}&page=${Math.max(1, Number(state.nextPage) || 1)}`);
        if ((this.epochs.get(type) || 0) === epoch) this.onData(type, mergeCatalogPage(this.getCatalog(type), response));
        return response;
      }).catch(error => {
        if ((this.epochs.get(type) || 0) === epoch) this.errors.set(key, error.message || 'Não foi possível carregar os próximos títulos.');
        throw error;
      }).finally(() => {
        if (this.pending.get(key) === pending) this.pending.delete(key);
        if ((this.epochs.get(type) || 0) === epoch) this.onChange(type);
      });
      this.pending.set(key, pending); return pending;
    }));
    return results;
  }
  async hydrateRemembered(favorites, history) {
    const items = rememberedTitles(this.getCatalog, favorites, history);
    const epochs = new Map(this.epochs);
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 6000);
    const worker = async () => {
      while (items.length && !controller.signal.aborted) {
        const item = items.shift(), type = item.kind === 'movie' ? 'movies' : 'series';
        if ((this.epochs.get(type) || 0) !== (epochs.get(type) || 0)) continue;
        try {
          const details = await this.request(`/api/details?type=${item.kind}&id=${encodeURIComponent(item.id)}`, {signal:controller.signal});
          if (!details?.name || (this.epochs.get(type) || 0) !== (epochs.get(type) || 0)) continue;
          const catalog = this.getCatalog(type);
          this.onData(type, mergeCatalogPage(catalog, {categories:[], items:[{...withoutSessionArtwork(item),...details,id:item.id,kind:item.kind}],pagination:catalog.pagination}));
          this.onChange(type);
        } catch { /* A removed title must not prevent the rest of the account from opening. */ }
      }
    };
    try { await Promise.all(Array.from({length:Math.min(this.limit,items.length)}, worker)); }
    finally { clearTimeout(deadline); }
  }
}

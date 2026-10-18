import { withoutSessionArtwork } from './stored-artwork.js';

const entries = value => value && typeof value === 'object' ? Object.entries(value) : [];
export const isPagedCatalog = catalog => catalog?.pagination?.mode === 'category';
export const isCompleteCatalog = catalog => catalog?.catalogComplete === true && catalog.preparing!==true && catalog.pagination?.preparing!==true && catalog.pagination?.complete!==false && Array.isArray(catalog.categories) && Array.isArray(catalog.items);

// Responses are snapshots. Merge them because separate category pages can finish out of order.
export function mergeCatalogPage(previous, incoming) {
  if(isCompleteCatalog(previous)&&!isCompleteCatalog(incoming))return previous.sourceCategories?{...previous,categories:previous.sourceCategories}:previous;
  const shared=incoming?.pagination?.source==='supabase',revision=incoming?.pagination?.snapshotId;
  if(shared&&revision&&previous?.pagination?.snapshotId&&previous.pagination.snapshotId!==revision){
    const oldTime=Date.parse(previous.pagination.revisionAt),newTime=Date.parse(incoming.pagination.revisionAt);
    if(incoming.pagination.snapshotChanged!==true||Number.isFinite(oldTime)&&Number.isFinite(newTime)&&newTime<oldTime)return previous.sourceCategories?{...previous,categories:previous.sourceCategories}:previous;
    previous=null;
  }
  if(isCompleteCatalog(incoming))return {...incoming,pagination:{...incoming.pagination,mode:'complete',byCategory:Object.fromEntries(incoming.categories.map(category=>[String(category.id),{loaded:true,nextPage:1,hasMore:false}]))}};
  // A late first-page response must not reintroduce a title omitted from the
  // authoritative shared snapshot that completed this catalog generation.
  if(isCompleteCatalog(previous))return previous.sourceCategories?{...previous,categories:previous.sourceCategories}:previous;
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
  const complete=shared&&incoming.pagination.complete===true;
  if(complete)for(const state of Object.values(byCategory)){state.loaded=true;state.hasMore=false;}
  return {...incoming,catalogComplete:complete, categories:[...categories.values()], items:[...items.values()], pagination:{...previous?.pagination, ...incoming.pagination, byCategory}};
}

export function pageChoices(catalog, category = '__all', initialOnly = false) {
  if (!isPagedCatalog(catalog) || category === '__favorites' || category.startsWith('custom:')) return [];
  const states = catalog.pagination.byCategory || {};
  const ids = category === '__all' ? catalog.pagination.source==='supabase'?[catalog.pagination.globalCategory||'__all']:Object.keys(states) : [...(catalog.categories.find(group => group.id === category)?.ids || [])].map(String);
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

const abortError = () => new DOMException('Carregamento do catálogo cancelado.', 'AbortError');
const bounded = (value, fallback) => Math.max(1, Math.min(4, Math.floor(Number(value) || fallback)));

// A shared task stays alive while another view or completion still needs it.
function subscribe(task, signal, cancelledValue) {
  const token = {};
  task.consumers.add(token);
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (settle, value) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', cancel);
      task.consumers.delete(token);
      if (!task.settled && !task.consumers.size) task.controller.abort();
      settle(value);
    };
    const cancel = () => cancelledValue ? finish(resolve, cancelledValue()) : finish(reject, abortError());
    task.promise.then(value => finish(resolve, value), error => finish(reject, error));
    signal?.addEventListener('abort', cancel, {once:true});
    if (signal?.aborted) cancel();
  });
}

// Interactive pages and background completion share requests and one concurrency budget.
export class CatalogPager {
  constructor({request, getCatalog, onData, onChange = () => {}, onProgress = () => {}, isCategoryAllowed = () => true, isActive = () => true, limit = 4}) {
    Object.assign(this, {request, getCatalog, onData, onChange, onProgress, isCategoryAllowed, isActive, limit:bounded(limit,4)});
    this.pending = new Map(); this.errors = new Map(); this.epochs = new Map();
    this.completions = new Map(); this.progress = new Map();
    this.metadataPending = new Set();
    this.activeRequests = 0; this.requestQueue = [];
  }
  reset(type) {
    const types = type ? [type] : ['movies', 'series', 'live'];
    for (const name of types) this.epochs.set(name, (this.epochs.get(name) || 0) + 1);
    for (const [key, task] of this.pending) if (types.some(name => key.startsWith(`${name}:`))) {task.controller.abort(); this.pending.delete(key);}
    for (const key of this.errors.keys()) if (types.some(name => key.startsWith(`${name}:`))) this.errors.delete(key);
    for (const task of this.metadataPending) if (types.includes(task.type)) task.controller.abort();
    for (const name of types) {
      this.completions.get(name)?.controller.abort();
      this.completions.delete(name); this.progress.delete(name);
    }
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
  async load(type, category = '__all', {initialOnly = false, signal} = {}) {
    if(!this.isActive())return [];
    const choices = this.choices(type, category, initialOnly).slice(0, this.limit);
    return Promise.allSettled(choices.map(state => this.#page(type, state, signal)));
  }
  #acquire(signal) {
    if (signal.aborted) throw abortError();
    if (this.activeRequests < this.limit) {this.activeRequests++; return;}
    return new Promise((resolve, reject) => {
      const entry = {signal, resolve:() => {signal.removeEventListener('abort', cancel); resolve();}};
      const cancel = () => {
        const index = this.requestQueue.indexOf(entry);
        if (index >= 0) this.requestQueue.splice(index,1);
        reject(abortError());
      };
      signal.addEventListener('abort', cancel, {once:true});
      this.requestQueue.push(entry);
    });
  }
  #release() {
    this.activeRequests--;
    while (this.requestQueue.length) {
      const entry = this.requestQueue.shift();
      if (entry.signal.aborted) continue;
      this.activeRequests++; entry.resolve(); break;
    }
  }
  #page(type, state, signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    const epoch = this.epochs.get(type) || 0;
    const key = `${type}:${state.id}`;
    let task = this.pending.get(key);
    if (task && !task.controller.signal.aborted) return subscribe(task, signal);
    // A different request may have completed while this choice was waiting.
    const current = this.getCatalog(type)?.pagination?.byCategory?.[state.id];
    if (!current || current.hasMore === false) return Promise.resolve(this.getCatalog(type));
    const page = Math.max(1, Number(current.nextPage) || 1);
    task = {controller:new AbortController(), consumers:new Set(), settled:false};
    this.errors.delete(key);
    task.promise = Promise.resolve().then(async () => {
      const activeSignal = task.controller.signal;
      if(!this.isActive()){task.controller.abort();throw abortError();}
      const queued = this.#acquire(activeSignal);
      if (queued) await queued;
      try {
        if (activeSignal.aborted||!this.isActive()) throw abortError();
        if(isCompleteCatalog(this.getCatalog(type)))return this.getCatalog(type);
        const pagination=this.getCatalog(type)?.pagination;
        const shared=pagination?.source==='supabase';
        const extra=shared?`&paged=1&snapshot=${encodeURIComponent(pagination.snapshotId)}&cursor=${Number(current.nextCursor??-1)}`:'';
        const response = await this.request(`/api/catalog?type=${encodeURIComponent(type)}&category=${encodeURIComponent(state.id)}&page=${page}${extra}`, {signal:activeSignal});
        if ((this.epochs.get(type) || 0) === epoch && !activeSignal.aborted&&this.isActive()) this.onData(type, mergeCatalogPage(this.getCatalog(type), response));
        return response;
      } finally {this.#release();}
    }).catch(error => {
      if((this.epochs.get(type)||0)===epoch&&!task.controller.signal.aborted&&isCompleteCatalog(this.getCatalog(type)))return this.getCatalog(type);
      if ((this.epochs.get(type) || 0) === epoch && !task.controller.signal.aborted) this.errors.set(key, error.message || 'Não foi possível carregar os próximos títulos.');
      throw error;
    }).finally(() => {
      task.settled = true;
      if (this.pending.get(key) === task) this.pending.delete(key);
      if ((this.epochs.get(type) || 0) === epoch) this.onChange(type);
    });
    this.pending.set(key,task);
    return subscribe(task,signal);
  }
  progressFor(type) {return this.progress.get(type) || null;}
  #report(type, task, status) {
    const catalog = this.getCatalog(type), states = Object.values(catalog?.pagination?.source==='supabase'?{global:catalog.pagination.byCategory?.__all}:catalog?.pagination?.byCategory || {}).filter(Boolean);
    const failedCategories = [...task.failures].map(([id,error]) => ({id,error}));
    const value = {
      status, categoriesTotal:states.length,
      categoriesComplete:states.filter(state => state.loaded && state.hasMore === false).length,
      pagesLoaded:states.reduce((sum,state) => sum + (state.loaded ? Math.max(0,(Number(state.nextPage) || 1)-1) : 0),0),
      itemsLoaded:catalog?.items?.length || 0, failedCategories,
      error:!catalog ? 'O catálogo ainda não foi carregado.' : failedCategories[0]?.error || ''
    };
    task.latest = value;
    if ((this.epochs.get(type) || 0) === task.epoch && this.completions.get(type) === task) {
      this.progress.set(type,value); this.onProgress(type,value);
    }
    return value;
  }
  /** Complete metadata for every source category, including categories hidden in the UI. */
  complete(type, {signal, retries = 1, concurrency = 3} = {}) {
    if(!this.isActive())return Promise.resolve({status:'cancelled'});
    let task = this.completions.get(type);
    if (task && !task.controller.signal.aborted) return subscribe(task,signal,() => ({...task.latest,status:'cancelled'}));
    task = {controller:new AbortController(), consumers:new Set(), settled:false, epoch:this.epochs.get(type) || 0, failures:new Map(), latest:null};
    this.completions.set(type,task);
    this.#report(type,task,'loading');
    task.promise = Promise.resolve().then(async () => {
      const working = new Set(), activeSignal = task.controller.signal;
      const active = () => !activeSignal.aborted && this.isActive() && (this.epochs.get(type) || 0) === task.epoch;
      const maxRetries = Math.max(0,Math.min(2,Math.floor(Number(retries) || 0)));
      const worker = async () => {
        while (active()) {
          const state = pageChoices(this.getCatalog(type)).find(state => !working.has(state.id) && !task.failures.has(state.id));
          if (!state) return;
          working.add(state.id);
          try {
            for (let attempt=0; active(); attempt++) {
              try {
                const previousRevision=this.getCatalog(type)?.pagination?.snapshotId;
                await this.#page(type,state,activeSignal);
                if (!active()) return;
                if(isCompleteCatalog(this.getCatalog(type)))break;
                if(previousRevision&&previousRevision!==this.getCatalog(type)?.pagination?.snapshotId)break;
                const current = this.getCatalog(type)?.pagination?.byCategory?.[state.id];
                if (!current || current.hasMore !== false && Number(current.nextPage || 1) <= Number(state.nextPage || 1)) throw new Error('O serviço não avançou a página do catálogo.');
                break;
              } catch (error) {
                if (!active()) return;
                if (attempt < maxRetries) continue;
                const message = error.message || 'Não foi possível carregar os próximos títulos.';
                task.failures.set(state.id,message); this.errors.set(`${type}:${state.id}`,message); break;
              }
            }
          } finally {
            working.delete(state.id);
            if (active()) this.#report(type,task,'loading');
          }
        }
      };
      await Promise.all(Array.from({length:bounded(concurrency,3)},worker));
      if(active()&&isCompleteCatalog(this.getCatalog(type))){task.failures.clear();for(const key of this.errors.keys())if(key.startsWith(`${type}:`))this.errors.delete(key);}
      const incomplete = !this.getCatalog(type) || task.failures.size > 0 || pageChoices(this.getCatalog(type)).length > 0;
      return this.#report(type,task,!active() ? 'cancelled' : incomplete ? 'partial' : 'complete');
    }).finally(() => {
      task.settled = true;
      if (this.completions.get(type) === task) this.completions.delete(type);
    });
    return subscribe(task,signal,() => ({...task.latest,status:'cancelled'}));
  }
  async hydrateRemembered(favorites, history) {
    if(!this.isActive())return;
    const items = rememberedTitles(this.getCatalog, favorites, history);
    const epochs = new Map(this.epochs);
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 6000);
    const worker = async () => {
      while (items.length && !controller.signal.aborted&&this.isActive()) {
        const item = items.shift(), type = item.kind === 'movie' ? 'movies' : 'series';
        if ((this.epochs.get(type) || 0) !== (epochs.get(type) || 0)) continue;
        const task = {type,controller:new AbortController()}, cancel = () => task.controller.abort();
        controller.signal.addEventListener('abort',cancel,{once:true});
        this.metadataPending.add(task);
        let acquired = false;
        try {
          const queued = this.#acquire(task.controller.signal);
          if (queued) await queued;
          acquired = true;
          if (task.controller.signal.aborted||!this.isActive()) throw abortError();
          const details = await this.request(`/api/details?type=${item.kind}&id=${encodeURIComponent(item.id)}`, {signal:task.controller.signal});
          if (!details?.name || task.controller.signal.aborted||!this.isActive()||(this.epochs.get(type) || 0) !== (epochs.get(type) || 0)) continue;
          const catalog = this.getCatalog(type);
          this.onData(type, mergeCatalogPage(catalog, {categories:[], items:[{...withoutSessionArtwork(item),...details,id:item.id,kind:item.kind}],pagination:catalog.pagination}));
          this.onChange(type);
        } catch { /* A removed title must not prevent the rest of the account from opening. */ }
        finally {
          controller.signal.removeEventListener('abort',cancel); this.metadataPending.delete(task);
          if (acquired) this.#release();
        }
      }
    };
    try { await Promise.all(Array.from({length:Math.min(this.limit,items.length)}, worker)); }
    finally { clearTimeout(deadline); }
  }
}

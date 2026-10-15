const text = value => String(value ?? '').trim();

export function parseProgramTime(value) {
  if (value === null || value === undefined || value === '') return NaN;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value))) {
    const number = Number(value); return number > 0 ? (number < 1e12 ? number * 1000 : number) : NaN;
  }
  return Date.parse(String(value).replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T'));
}

export function programWindow(list = [], now = Date.now()) {
  const programs = (Array.isArray(list) ? list : []).filter(value => value && typeof value === 'object').map(value => ({
    title:text(value.title) || 'Não informada', description:text(value.description),
    start:parseProgramTime(value.start ?? value.start_timestamp),
    end:parseProgramTime(value.end ?? value.stop_timestamp ?? value.end_timestamp)
  })).filter(value => Number.isFinite(value.start) && Number.isFinite(value.end) && value.end > value.start).sort((a, b) => a.start - b.start);
  return {
    previous:programs.filter(value => value.end <= now).at(-1) || null,
    current:programs.filter(value => value.start <= now && value.end > now).at(-1) || null,
    next:programs.find(value => value.start > now) || null
  };
}

// A provider can briefly answer with an empty/invalid schedule while refreshing.
// Retain only a guide with a genuinely current programme; wall-clock expiry is
// still authoritative, and a valid replacement wins immediately.
export function retainCurrentProgramList(previous, incoming, now = Date.now()) {
  const list = Array.isArray(incoming) ? incoming : [];
  const window = programWindow(list, now);
  return !window.current && !window.next && !window.previous && programWindow(previous, now).current
    ? previous : list;
}

const PROGRAM_CACHE_MS = 60000;

// Only the selected live channel is refreshed. Timers and late responses belong
// to one selection, so a channel switch/logout cannot repaint the next session.
export class LiveProgramFeed {
  constructor({request, onUpdate, now = Date.now, getNamespace = () => '',
    schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
    cancel = timer => globalThis.clearTimeout(timer)}) {
    Object.assign(this, {request, onUpdate, now, getNamespace, schedule, cancel}); this.current = null;
    this.namespace = String(this.getNamespace()); this.cache = new Map();
  }
  ensureNamespace() {
    const namespace = String(this.getNamespace());
    if (namespace !== this.namespace) { this.stop({clearCache:true}); this.namespace = namespace; }
  }
  peek(id) {
    this.ensureNamespace();
    const cached = this.cache.get(String(id));
    if (!cached) return null;
    const now = this.now(), programs = programWindow(cached.list, now);
    if (cached.expiresAt <= now && !programs.current) { this.cache.delete(String(id)); return null; }
    return programs.current || programs.next ? {list:cached.list} : null;
  }
  remember(selection) {
    this.cache.delete(selection.id); this.cache.set(selection.id, {list:selection.list, expiresAt:this.now()+PROGRAM_CACHE_MS});
    while (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
  }
  active(selection) { return selection === this.current && selection.namespace === String(this.getNamespace()); }
  start(id, {initialData} = {}) {
    this.stop();
    this.ensureNamespace();
    if (!/^\d{1,12}$/.test(String(id))) return;
    const cached = this.peek(id), seed = cached || initialData;
    const programs = programWindow(seed?.list, this.now());
    const list = programs.current || programs.next ? seed.list : [];
    const selection = {id:String(id), namespace:this.namespace, list, refreshAt:0, pending:false, controller:null, timer:null, deadline:null};
    this.current = selection; this.tick(selection);
  }
  stop({clearCache=false} = {}) {
    const selection = this.current; this.current = null;
    if (clearCache) this.cache.clear();
    if (!selection) return;
    this.cancel(selection.timer); this.cancel(selection.deadline); selection.controller?.abort();
  }
  tick(selection) {
    if (!this.active(selection)) { if (selection === this.current) this.ensureNamespace(); return; }
    this.onUpdate({list:selection.list});
    if (!selection.pending && this.now() >= selection.refreshAt) void this.refresh(selection);
    selection.timer = this.schedule(() => this.tick(selection), 15000);
  }
  async refresh(selection) {
    selection.pending = true; const controller = new AbortController(); selection.controller = controller;
    selection.deadline = this.schedule(() => controller.abort(), 10000);
    try {
      const data = await this.request(`/api/epg?id=${encodeURIComponent(selection.id)}`, {signal:controller.signal});
      if (!this.active(selection) || controller.signal.aborted) return;
      selection.list = retainCurrentProgramList(selection.list, data?.list, this.now());
      this.remember(selection);
      const now = this.now(), programs = programWindow(selection.list, now);
      const boundary = programs.current?.end ?? programs.next?.start;
      selection.refreshAt = now + (boundary ? Math.min(60000, Math.max(15000, boundary - now + 1000)) : 60000);
      this.onUpdate({list:selection.list});
    } catch {
      // A temporary outage must not erase a still-current schedule. Selection
      // by wall clock naturally expires old entries while the next retry waits.
      if (this.active(selection)) selection.refreshAt = this.now() + 30000;
    } finally {
      this.cancel(selection.deadline); selection.deadline = null; selection.pending = false;
      if (this.active(selection) && controller.signal.aborted) selection.refreshAt = this.now() + 30000;
    }
  }
}

import { programWindow } from './program-guide.js';

const CACHE_MS = 60000;
const text = value => String(value ?? '').trim();
function element(tag, className = '', value) {
  const node = document.createElement(tag); node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}
function clock(value) { return new Date(value).toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'}); }

export class ChannelGuide {
  constructor({api, connectionGeneration}) {
    this.api = api; this.connectionGeneration = connectionGeneration;
    this.generation = this.readGeneration(); this.epoch = 0; this.paused = false;
    this.cache = new Map(); this.records = new Map(); this.byKey = new Map(); this.queue = new Map(); this.active = new Map(); this.interval = null; this.frame = null;
    this.observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
      for (const entry of entries) {
        const record = this.records.get(entry.target); if (!record) continue;
        if (record.card.isConnected) record.connectedOnce = true;
        record.visible = entry.isIntersecting && entry.intersectionRatio > 0 && record.card.isConnected;
        if (record.visible) this.enqueue(record);
      }
      this.prune(); this.pump();
    }, {threshold:0.01, rootMargin:'0px'}) : null;
    this.onViewport = () => {
      if (this.frame !== null) return;
      this.frame = requestAnimationFrame(() => { this.frame = null; this.scanViewport(); });
    };
    this.onVisibility = () => { if (document.hidden) { for (const job of this.active.values()) job.controller.abort(); } else this.tick(); };
    document.addEventListener('visibilitychange', this.onVisibility);
    if (!this.observer) { window.addEventListener('scroll', this.onViewport, {passive:true}); window.addEventListener('resize', this.onViewport, {passive:true}); }
  }
  readGeneration() { return String(typeof this.connectionGeneration === 'function' ? this.connectionGeneration() : 0); }
  ensureGeneration() { if (this.readGeneration() !== this.generation) this.reset(); }
  observe(card, item) {
    if (!card || item?.kind !== 'live' || !/^\d{1,12}$/.test(String(item.id))) return;
    this.ensureGeneration(); this.prune();
    const existing = this.records.get(card);
    if (existing && existing.id === String(item.id)) return;
    if (existing) this.remove(existing);
    const root = element('div', 'channel-guide'); root.dataset.state = 'unavailable';
    const placeholder = element('span', 'channel-guide-placeholder', 'Programação não informada');
    const rows = element('div', 'channel-guide-rows'), nodes = {};
    for (const [key, label] of [['current','Agora'], ['next','Próximo']]) {
      const row = element('div', `channel-guide-row channel-guide-${key}`), title = element('strong', 'channel-guide-title'), time = element('span', 'channel-guide-time');
      row.append(element('span', 'channel-guide-label', label), title, time); rows.append(row); nodes[key] = {title, time};
    }
    const progress = element('progress', 'channel-guide-progress'); progress.max = 100; progress.value = 0; progress.setAttribute('aria-label', 'Tempo do programa atual'); progress.hidden = true; rows.hidden = true;
    root.append(placeholder, rows, progress); (card.querySelector('.channel-copy') || card).append(root);
    const id = String(item.id), key = `${this.generation}:${id}`;
    const record = {card, id, key, root, placeholder, rows, nodes, progress, visible:false, connectedOnce:card.isConnected, createdAt:Date.now()};
    this.records.set(card, record); if (!this.byKey.has(key)) this.byKey.set(key, new Set()); this.byKey.get(key).add(record);
    const cached = this.cache.get(key); if (cached) this.render(record, cached.list);
    if (this.observer) this.observer.observe(card); else this.onViewport();
    if (this.interval === null) this.interval = setInterval(() => this.tick(), 15000);
  }
  enqueue(record) {
    if (!record.visible || !record.card.isConnected) return;
    const cached = this.cache.get(record.key);
    if (cached && cached.expiresAt > Date.now()) { this.render(record, cached.list); return; }
    if (!this.queue.has(record.key) && !this.active.has(record.key)) this.queue.set(record.key, {id:record.id, key:record.key, generation:this.generation, epoch:this.epoch});
  }
  hasVisible(key) { return [...(this.byKey.get(key) || [])].some(record => record.visible && record.card.isConnected); }
  pump() {
    if (this.paused || globalThis.document?.hidden) return;
    this.ensureGeneration();
    while (this.active.size < 2 && this.queue.size) {
      const [key, queued] = this.queue.entries().next().value; this.queue.delete(key);
      if (!this.hasVisible(key) || queued.epoch !== this.epoch || queued.generation !== this.generation) continue;
      const job = {...queued, controller:new AbortController()}; this.active.set(key, job);
      for (const record of this.byKey.get(key) || []) {
        if (!this.cache.has(key)) { record.placeholder.textContent = 'Carregando programação…'; record.root.dataset.state = 'loading'; }
      }
      this.fetch(job);
    }
  }
  async fetch(job) {
    try {
      const data = await this.api(`/api/epg?id=${encodeURIComponent(job.id)}`, {signal:job.controller.signal});
      if (!this.isCurrent(job)) return;
      this.store(job.key, Array.isArray(data?.list) ? data.list : []);
    } catch (error) {
      if (this.isCurrent(job) && !job.controller.signal.aborted) this.store(job.key, this.cache.get(job.key)?.list || []);
    } finally {
      if (this.active.get(job.key) === job) this.active.delete(job.key);
      if (job.controller.signal.aborted && !this.paused && job.epoch === this.epoch && job.generation === this.generation) {
        const record = [...(this.byKey.get(job.key) || [])].find(value => value.visible && value.card.isConnected);
        if (record) this.enqueue(record);
      }
      this.pump();
    }
  }
  isCurrent(job) { return !job.controller.signal.aborted && job.epoch === this.epoch && job.generation === this.generation && job.generation === this.readGeneration(); }
  store(key, list) {
    this.cache.set(key, {list, expiresAt:Date.now() + CACHE_MS});
    for (const record of this.byKey.get(key) || []) if (record.card.isConnected) this.render(record, list);
    while (this.cache.size > 400) this.cache.delete(this.cache.keys().next().value);
  }
  render(record, list) {
    const programs = programWindow(list), available = Boolean(programs.current || programs.next);
    record.root.dataset.state = available ? 'ready' : 'unavailable'; record.placeholder.hidden = available; record.placeholder.textContent = 'Programação não informada'; record.rows.hidden = !available;
    for (const key of ['current','next']) {
      const program = programs[key], node = record.nodes[key]; node.title.textContent = program?.title || 'Não informada'; node.title.title = program?.title || '';
      node.time.textContent = program ? key === 'current' ? `${clock(program.start)} — ${clock(program.end)}` : clock(program.start) : '';
    }
    record.progress.hidden = !programs.current;
    if (programs.current) { const program = programs.current; record.progress.value = Math.max(0, Math.min(100, (Date.now() - program.start) / (program.end - program.start) * 100)); }
  }
  tick() {
    this.ensureGeneration(); this.prune(); if (this.paused) return;
    for (const record of this.records.values()) if (record.visible && record.card.isConnected) {
      const cached = this.cache.get(record.key); if (cached) this.render(record, cached.list); this.enqueue(record);
    }
    this.pump();
  }
  scanViewport() {
    this.ensureGeneration();
    for (const record of this.records.values()) {
      if (!record.card.isConnected) { record.visible = false; continue; }
      record.connectedOnce = true; const bounds = record.card.getBoundingClientRect();
      record.visible = bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.right > 0 && bounds.top < window.innerHeight && bounds.left < window.innerWidth;
      if (record.visible) this.enqueue(record);
    }
    this.prune(); this.pump();
  }
  remove(record) {
    this.observer?.unobserve(record.card); this.records.delete(record.card);
    const records = this.byKey.get(record.key); records?.delete(record);
    if (!records?.size) { this.byKey.delete(record.key); this.queue.delete(record.key); }
    record.root.remove();
  }
  prune() {
    const now = Date.now();
    for (const record of this.records.values()) {
      if (record.card.isConnected) record.connectedOnce = true;
      else if (record.connectedOnce || now - record.createdAt > 1000) this.remove(record);
    }
  }
  pause() {
    this.paused = true;
    for (const job of this.active.values()) job.controller.abort();
  }
  resume() {
    this.ensureGeneration(); this.paused = false;
    if (!this.observer) this.scanViewport();
    else { this.prune(); for (const record of this.records.values()) if (record.visible) this.enqueue(record); this.pump(); }
  }
  reset() {
    this.epoch++; this.generation = this.readGeneration();
    for (const job of this.active.values()) job.controller.abort();
    this.queue.clear(); this.cache.clear(); this.observer?.disconnect();
    for (const record of this.records.values()) record.root.remove();
    this.records.clear(); this.byKey.clear();
    clearInterval(this.interval); this.interval = null;
    if (this.frame !== null) cancelAnimationFrame(this.frame); this.frame = null;
  }
  destroy() {
    this.pause(); this.reset();
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (!this.observer) { window.removeEventListener('scroll', this.onViewport); window.removeEventListener('resize', this.onViewport); }
  }
}

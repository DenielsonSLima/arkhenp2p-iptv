import {isAdultItem} from './parental-classification.js';

const prefix = 'orbit.episode-progress.v1.';
const maxSeconds = Number.MAX_SAFE_INTEGER;
const validNamespace = value => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,200}$/.test(value) ? value : null;
const identifier = value => {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) return null;
  const id = String(value);
  return /^[\p{L}\p{N}_-][\p{L}\p{N}_.:-]{0,127}$/u.test(id) ? id : null;
};
const seconds = (value, zero = false) => typeof value === 'number' && Number.isFinite(value) && value <= maxSeconds && (zero ? value >= 0 : value > 0) ? value : null;
const ordinal = value => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  return Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
};
const recordKey = (itemId, episodeId) => JSON.stringify([itemId, episodeId]);

function browserRead(key, fallback) {
  try { return JSON.parse(globalThis.localStorage?.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
}
function browserSave(key, value) {
  try { globalThis.localStorage?.setItem(key, JSON.stringify(value)); } catch { /* Local storage is optional. */ }
}
function identity(item, episode) {
  const itemId = item?.kind === 'series' ? identifier(item.id) : null, episodeId = identifier(episode?.id);
  return itemId !== null && episodeId !== null ? {itemId, episodeId} : null;
}
function normalizeRecord(value) {
  const itemId = identifier(value?.itemId), episodeId = identifier(value?.episodeId), time = seconds(value?.time, true);
  const duration = seconds(value?.duration), updated = seconds(value?.updated, true);
  if (itemId === null || episodeId === null || time === null || updated === null) return null;
  const boundedTime = duration === null ? time : Math.min(time, duration);
  const result = {itemId, episodeId, time:boundedTime, duration, completed:value.completed === true || duration !== null && boundedTime / duration >= .95, updated};
  const season = ordinal(value.season), number = ordinal(value.number);
  if (season !== null) result.season = season;
  if (number !== null) result.number = number;
  return result;
}

/** Keep each episode independent; persistence requires a stable account scope. */
export class EpisodeProgressStore {
  constructor({read = browserRead, save = browserSave, limit = 1500, now = () => Date.now(), canRemember = () => true} = {}) {
    this.readStorage = read;this.saveStorage = save;this.now = now;
    this.canRemember = canRemember;this.blockedItems = new Set();
    this.limit = Number.isFinite(limit) ? Math.max(1, Math.min(5000, Math.floor(limit))) : 1500;
    this.namespace = null;this.records = new Map();
  }
  setNamespace(namespace) {
    const next = validNamespace(namespace);
    if (next !== null && next === this.namespace) return true;
    this.namespace = next;this.records.clear();this.blockedItems.clear();
    if (next === null) return false;
    let stored;
    try { stored = this.readStorage(prefix + next, null); } catch { return true; }
    // Checking the envelope as well as the key rejects data from another account.
    if (stored?.version !== 1 || stored.namespace !== next || !Array.isArray(stored.entries)) return true;
    let rejected = false;
    for (const raw of stored.entries.slice(0, 5000)) {
      if (isAdultItem(raw) || isAdultItem(raw?.item) || isAdultItem(raw?.episode)) {const blocked = identifier(raw?.itemId);if (blocked !== null) this.blockedItems.add(blocked);rejected = true;continue;}
      const record = normalizeRecord(raw);if (!record) continue;
      const key = recordKey(record.itemId, record.episodeId), old = this.records.get(key);
      if (!old || old.updated <= record.updated) this.records.set(key, record);
    }
    this.trim();if (rejected) {for (const [key,record] of this.records) if (this.blockedItems.has(record.itemId)) this.records.delete(key);this.persist();}return true;
  }
  #allowed(item, episode) {
    if (!item || this.blockedItems.has(String(item.id)) || isAdultItem(item) || isAdultItem(episode)) return false;
    try { return this.canRemember(item) !== false; } catch { return false; }
  }
  /** Classification can arrive after legacy ID-only progress has been loaded. */
  reconcileCatalog(data, type = 'series') {
    if (type !== 'series' || !Array.isArray(data?.items)) return 0;
    const categories = [...(data.categories || []), ...(data.sourceCategories || [])];
    for (const raw of data.items) {
      const item = {...raw, kind:'series'};
      if (isAdultItem(item, categories) || !this.#allowed(item)) this.blockedItems.add(String(item.id));
    }
    let removed = 0;
    for (const [key, record] of this.records) if (!this.#allowed({kind:'series', id:record.itemId})) {this.records.delete(key);removed++;}
    if (removed) this.persist();
    return removed;
  }
  purge(item) {
    if (item?.kind !== 'series' || identifier(item.id) === null) return 0;
    this.blockedItems.add(String(item.id));
    let removed = 0;
    for (const [key, record] of this.records) if (record.itemId === String(item.id)) {this.records.delete(key);removed++;}
    if (removed) this.persist();
    return removed;
  }
  trim() {
    if (this.records.size <= this.limit) return;
    const ordered = [...this.records.entries()].sort((a, b) => b[1].updated - a[1].updated);
    this.records = new Map(ordered.slice(0, this.limit));
  }
  persist() {
    this.trim();
    if (this.namespace === null) return;
    try { this.saveStorage(prefix + this.namespace, {version:1, namespace:this.namespace, entries:this.list()}); } catch { /* Playback survives full or blocked storage. */ }
  }
  save(value = {}) {
    const {item, episode, time, duration, completed = false, updated = this.now()} = value;
    if (isAdultItem(value) || !this.#allowed(item, episode)) {this.purge(item);return null;}
    const ids = identity(item, episode);if (!ids) return null;
    const key = recordKey(ids.itemId, ids.episodeId), old = this.records.get(key);
    const record = normalizeRecord({...ids, time, duration:seconds(duration) ?? old?.duration, completed, updated, season:episode.season, number:episode.number});
    if (!record) return null;
    if (old && old.updated > record.updated) return {...old};
    this.records.set(key, record);this.persist();return {...record};
  }
  read(item, episode) {
    if (!this.#allowed(item, episode)) {this.purge(item);return null;}
    const ids = identity(item, episode);if (!ids) return null;
    const record = this.records.get(recordKey(ids.itemId, ids.episodeId));
    return record ? {...record} : null;
  }
  list(item) {
    if (item && (item.kind !== 'series' || identifier(item.id) === null)) return [];
    if (item && !this.#allowed(item)) {this.purge(item);return [];}
    return [...this.records.values()].filter(record => (!item || record.itemId === String(item.id)) && this.#allowed({kind:'series', id:record.itemId}))
      .sort((a, b) => b.updated - a.updated).map(record => ({...record}));
  }
  // The caller must prove that legacy entries belong to this exact account.
  // Provider-only history has no such proof and must never be seeded blindly.
  seed(entries, {namespace} = {}) {
    if (this.namespace === null || namespace !== this.namespace) return 0;
    const source = entries instanceof Map ? entries.values() : Array.isArray(entries) ? entries : [];
    const candidates = new Map();
    for (const entry of source) {
      if (isAdultItem(entry) || !this.#allowed(entry?.item, entry?.episode)) {this.purge(entry?.item);continue;}
      const ids = identity(entry?.item, entry?.episode);if (!ids) continue;
      const key = recordKey(ids.itemId, ids.episodeId);if (this.records.has(key)) continue;
      const record = normalizeRecord({...ids, time:entry.time, duration:entry.duration, completed:entry.completed, updated:entry.updated, season:entry.episode.season, number:entry.episode.number});
      if (!record) continue;
      const old = candidates.get(key);
      if (!old || old.updated <= record.updated) candidates.set(key, record);
    }
    let added = 0;
    for (const [key, record] of candidates) if (this.#allowed({kind:'series', id:record.itemId})) {this.records.set(key, record);added++;}
    if (added) this.persist();return added;
  }
}

function explicitDuration(episode) {
  const value = episode?.durationSeconds;
  const numeric = typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : value;
  if (seconds(numeric) !== null) return numeric;
  // A bare provider number such as "45" has no unit. Only explicit clocks or
  // units may be interpreted here, never a series-level runtime.
  const text = typeof episode?.duration === 'string' ? episode.duration.trim() : '';
  const clock = /^(\d+):([0-5]\d):([0-5]\d)$/.exec(text);
  if (clock) return seconds(Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]));
  const units = /^(?:(\d+(?:\.\d+)?)\s*(?:h|horas?)\s*)?(?:(\d+(?:\.\d+)?)\s*(?:m|min|minutos?)\s*)?(?:(\d+(?:\.\d+)?)\s*(?:s|seg|segundos?)\s*)?$/i.exec(text);
  return units ? seconds(Number(units[1] || 0) * 3600 + Number(units[2] || 0) * 60 + Number(units[3] || 0)) : null;
}
function formatTime(value) {
  const total = Math.floor(value), hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), tail = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${tail}` : `${minutes}:${tail}`;
}

/** Data for a row, using only the exact episode's measured or explicit total. */
export function episodePlaybackProgress(item, episode, entry, {categories = []} = {}) {
  if (isAdultItem(item, categories) || isAdultItem(episode, categories) || isAdultItem(entry, categories) || isAdultItem(entry?.item, categories)) return null;
  const ids = identity(item, episode);if (!ids) return null;
  let saved = null;
  if (entry?.itemId === ids.itemId && entry.episodeId === ids.episodeId) saved = normalizeRecord(entry);
  else if (entry?.item?.kind === 'series' && String(entry.item.id) === ids.itemId && String(entry.episode?.id) === ids.episodeId) {
    saved = normalizeRecord({...ids, time:entry.time, duration:entry.duration, updated:entry.updated ?? 0, completed:entry.completed});
  }
  const duration = saved?.duration ?? explicitDuration(episode), time = duration === null ? saved?.time ?? 0 : Math.min(saved?.time ?? 0, duration);
  const completed = saved?.completed === true || duration !== null && time / duration >= .95;
  const state = completed ? 'completed' : time > 0 ? 'in-progress' : 'unwatched';
  return {time, duration, percent:duration === null ? null : time / duration * 100, completed, state,
    label:completed ? 'Assistido' : time > 0 ? 'Continuar assistindo' : 'Não iniciado',
    elapsed:formatTime(time), total:duration === null ? '' : formatTime(duration)};
}

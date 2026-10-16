import {numberedChannels, channelNeighbors} from './canais.js';

const identity = entry => entry?.item ? String(entry.item.id) : null;

/** Browsing changes only a temporary channel ID. Only an explicit commit or
 * zap reaches the playback callback; the preview timeout never tunes media. */
export class TVPlayerNavigation {
  constructor({getChannels = () => [], getCurrent = () => null, onPreview = () => {}, onCommit = () => {}, previewDuration = 4000} = {}) {
    Object.assign(this, {getChannels, getCurrent, onPreview, onCommit});
    this.previewDuration = Number.isFinite(previewDuration) && previewDuration > 0 ? previewDuration : 4000;
    this.previewId = null;
    this.previewTimer = null;
    this.previewGeneration = 0;
  }

  entries() {
    try { return numberedChannels(this.getChannels()); }
    catch { return []; }
  }

  context() {
    let current;
    try { current = this.getCurrent(); } catch { current = null; }
    const entries = this.entries();
    if (current?.item?.kind !== 'live') return {entries, current: null, active: null};
    const active = entries.find(entry => identity(entry) === identity(current)) || null;
    // A number may be reassigned when favourites change. It is not evidence
    // that another channel is the one still playing.
    const selected = {...current, channelNumber: active ? active.number : null};
    return {entries, current: selected, active};
  }

  selected() {
    const {entries, current, active} = this.context();
    if (!current) return null;
    return (this.previewId === null ? null : entries.find(entry => identity(entry) === this.previewId)) || active;
  }

  neighbors() {
    const {entries, current, active} = this.context();
    if (!current) return {previous: null, current: null, next: null};
    const preview = this.previewId === null ? null : entries.find(entry => identity(entry) === this.previewId);
    const selected = preview || active;
    return channelNeighbors(entries, selected ? {item: selected.item, channelNumber: selected.number} : current);
  }

  isPreviewing() {
    if (this.previewId === null) return false;
    const {entries, current, active} = this.context();
    return Boolean(current && entries.some(entry => identity(entry) === this.previewId) && this.previewId !== (identity(active) ?? identity(current)));
  }

  clearTimer() {
    this.previewGeneration++;
    clearTimeout(this.previewTimer);
    this.previewTimer = null;
  }

  notify(reason) {
    this.onPreview(this.selected(), {reason});
  }

  clearPreview(reason, {notify = true} = {}) {
    const changed = this.previewId !== null;
    this.clearTimer();
    this.previewId = null;
    if (changed && notify) this.notify(reason);
    return changed;
  }

  armPreview() {
    this.clearTimer();
    if (this.previewId === null) return;
    const generation = this.previewGeneration;
    this.previewTimer = setTimeout(() => {
      if (generation !== this.previewGeneration) return;
      this.previewTimer = null;
      this.clearPreview('expired');
    }, this.previewDuration);
  }

  browse(step) {
    if (!Number.isFinite(step) || step === 0 || !this.context().current) return null;
    const neighbors = this.neighbors(), entry = step > 0 ? neighbors.next : neighbors.previous;
    if (!entry) return this.selected();
    const {active, current} = this.context();
    this.previewId = identity(entry) === (identity(active) ?? identity(current)) ? null : identity(entry);
    this.armPreview();
    this.notify('browse');
    return entry;
  }

  commit(entry = this.selected(), {origin = 'preview'} = {}) {
    const {entries, current, active} = this.context();
    if (!current) return false;
    const id = identity(entry);
    if (id !== null && (id === identity(active) || id === identity(current))) {
      this.clearPreview('cancel');
      return false;
    }
    const target = id === null ? null : entries.find(candidate => identity(candidate) === id);
    if (!target) {
      this.clearPreview('sync');
      return false;
    }
    this.clearPreview('cancel', {notify: false});
    this.onCommit(target, {origin});
    return true;
  }

  zap(step) {
    if (!Number.isFinite(step) || step === 0) return false;
    const {entries, current} = this.context();
    if (!current) return false;
    const neighbors = channelNeighbors(entries, current), entry = step > 0 ? neighbors.next : neighbors.previous;
    if (!entry) { this.cancel(); return false; }
    return this.commit(entry, {origin: 'zap'});
  }

  cancel({notify = true} = {}) {
    return this.clearPreview('cancel', {notify});
  }

  sync() {
    const {entries, current, active} = this.context();
    if (this.previewId === null) return active;
    const preview = current ? entries.find(entry => identity(entry) === this.previewId) : null;
    if (!preview || identity(preview) === (identity(active) ?? identity(current))) {
      this.clearPreview('sync');
      return active;
    }
    return preview;
  }

  reset() {
    this.clearPreview('cancel', {notify: false});
  }
}

const channelID = value => /^\d{1,12}$/.test(String(value ?? '')) ? String(value) : null;

/** Home joins the existing TV guide for its visible cards only. The shared
 * guide owns requests, current/next selection, clocks and refresh cadence. */
export class HomeChannelPrograms {
  constructor({guide, getItems = () => [], getScope = () => null,
    isActive = () => false, onUpdate = () => {}} = {}) {
    Object.assign(this, {guide, getItems, getScope, isActive, onUpdate});
    this.scope = null;
    this.ids = [];
    this.unsubscribe = null;
    this.epoch = 0;
    this.disposed = false;
  }

  sync() {
    if (this.disposed) return;
    const scope = this.getScope();
    if (scope !== this.scope) {
      this.reset();
      this.scope = scope;
    }
    const ids = [...new Set(this.getItems().map(item => channelID(item?.id)).filter(Boolean))].slice(0, 5);
    if (!scope || !this.isActive() || !ids.length || !this.guide) {
      this.pause();
      return;
    }
    const changed = JSON.stringify(ids) !== JSON.stringify(this.ids);
    this.ids = ids;
    if (!this.unsubscribe) {
      const epoch = ++this.epoch;
      this.unsubscribe = this.guide.subscribe(state => {
        if (this.disposed || epoch !== this.epoch || scope !== this.getScope() || !this.isActive()) return;
        this.emit(state);
      }, {ids});
    } else {
      if (changed) this.unsubscribe.updateIds?.(ids);
      this.emit(this.guide.state);
    }
  }

  emit(state = {}) {
    const programs = new Map(this.ids.map(id => [id, this.guide.peek(id)]));
    this.onUpdate(programs, state);
  }

  pause() {
    this.epoch++;
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = null;
    unsubscribe?.();
  }

  reset() {
    this.pause();
    this.scope = null;
    this.ids = [];
    this.onUpdate(new Map(), {});
  }

  dispose() {
    this.reset();
    this.disposed = true;
  }
}

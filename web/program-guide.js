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

// Only the selected live channel is refreshed. Timers and late responses belong
// to one selection, so a channel switch/logout cannot repaint the next session.
export class LiveProgramFeed {
  constructor({request, onUpdate, now = Date.now, schedule = setTimeout, cancel = clearTimeout}) {
    Object.assign(this, {request, onUpdate, now, schedule, cancel}); this.current = null;
  }
  start(id) {
    this.stop();
    if (!/^\d{1,12}$/.test(String(id))) return;
    const selection = {id:String(id), list:[], refreshAt:0, pending:false, controller:null, timer:null, deadline:null};
    this.current = selection; this.tick(selection);
  }
  stop() {
    const selection = this.current; this.current = null;
    if (!selection) return;
    this.cancel(selection.timer); this.cancel(selection.deadline); selection.controller?.abort();
  }
  tick(selection) {
    if (selection !== this.current) return;
    this.onUpdate({list:selection.list});
    if (!selection.pending && this.now() >= selection.refreshAt) void this.refresh(selection);
    selection.timer = this.schedule(() => this.tick(selection), 15000);
  }
  async refresh(selection) {
    selection.pending = true; const controller = new AbortController(); selection.controller = controller;
    selection.deadline = this.schedule(() => controller.abort(), 10000);
    try {
      const data = await this.request(`/api/epg?id=${encodeURIComponent(selection.id)}`, {signal:controller.signal});
      if (selection !== this.current || controller.signal.aborted) return;
      selection.list = Array.isArray(data?.list) ? data.list : [];
      const now = this.now(), programs = programWindow(selection.list, now);
      const boundary = programs.current?.end ?? programs.next?.start;
      selection.refreshAt = now + (boundary ? Math.min(60000, Math.max(15000, boundary - now + 1000)) : 60000);
      this.onUpdate({list:selection.list});
    } catch {
      // A temporary outage must not erase a still-current schedule. Selection
      // by wall clock naturally expires old entries while the next retry waits.
      if (selection === this.current) selection.refreshAt = this.now() + 30000;
    } finally {
      this.cancel(selection.deadline); selection.deadline = null; selection.pending = false;
      if (selection === this.current && controller.signal.aborted) selection.refreshAt = this.now() + 30000;
    }
  }
}

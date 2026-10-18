import {element} from '../../player/dom.js';

const MINUTE_MS = 60000;

// Display-only clock: it never selects EPG windows or changes playback state.
export class TVPlayerClock {
  constructor() {
    this.root = element('time', 'ip-player-clock');
    this.root.hidden = true;
    this.root.title = 'Hora local';
    this.document = this.root.ownerDocument;
    this.formatter = new Intl.DateTimeFormat('pt-BR', {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
    this.active = false;
    this.destroyed = false;
    this.timer = null;
    this.visibilityChanged = () => this.refresh();
  }

  setActive(active) {
    if (this.destroyed) return;
    const next = Boolean(active);
    if (this.active === next) return;
    this.active = next;
    this.root.hidden = !next;
    if (next) this.document.addEventListener('visibilitychange', this.visibilityChanged);
    else this.document.removeEventListener('visibilitychange', this.visibilityChanged);
    this.refresh();
  }

  refresh() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.active || this.destroyed || this.document.hidden) return;
    const now = new Date();
    const value = this.formatter.format(now);
    this.root.textContent = value;
    this.root.dateTime = now.toISOString();
    this.root.setAttribute('aria-label', `Hora atual: ${value}`);
    // Align the next update with the minute boundary, including after tab resume.
    this.timer = setTimeout(() => this.refresh(), MINUTE_MS - now.getTime() % MINUTE_MS + 20);
  }

  reset() { this.setActive(false); }

  destroy() {
    if (this.destroyed) return;
    this.reset();
    this.destroyed = true;
    this.root.remove();
  }
}

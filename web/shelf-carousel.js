const DEFAULT_INTERVAL = 5000;
const DEFAULT_STEP = 3;
const MANUAL_COOLDOWN = 4000;
const SCROLL_DURATION = 900;
const WRAP_DURATION = 600;
const easeInOut = progress => progress < .5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;

/** Select actual card positions so responsive widths, gaps and a partial final
 * group never leave the last covers out of reach. No cards are cloned. */
export function shelfScrollTarget(offsets, current, maximum, direction = 1, step = DEFAULT_STEP) {
  if (!offsets.length || maximum <= 1) return 0;
  const position = Math.max(0, Math.min(maximum, Number(current) || 0));
  const forward = direction >= 0;
  if (forward && position >= maximum - 1) return 0;
  if (!forward && position <= 1) return maximum;
  let nearest = 0;
  for (let index = 1; index < offsets.length; index++) {
    if (Math.abs(offsets[index] - position) < Math.abs(offsets[nearest] - position)) nearest = index;
  }
  const index = Math.max(0, Math.min(offsets.length - 1, nearest + (forward ? step : -step)));
  return Math.max(0, Math.min(maximum, offsets[index]));
}

/** Home carousel motion owns DOM geometry and a single clock per visible row.
 * Catalog loading, history, card rendering and navigation remain in the app. */
export class ShelfCarousels {
  constructor({isActive = () => true, interval = DEFAULT_INTERVAL, step = DEFAULT_STEP, environment = globalThis} = {}) {
    this.isActive = isActive;
    this.interval = Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL;
    this.step = Number.isInteger(step) && step > 0 ? step : DEFAULT_STEP;
    this.environment = environment;
    this.document = environment.document;
    this.container = null;
    this.records = new Map();
    this.cleanup = [];
    this.destroyed = false;
    this.motion = environment.matchMedia?.('(prefers-reduced-motion: reduce)');
    this.intersectionObserver = typeof environment.IntersectionObserver === 'function' ? new environment.IntersectionObserver(entries => {
      for (const entry of entries) {
        const record = this.records.get(entry.target);
        if (!record) continue;
        record.inViewport = entry.isIntersecting && entry.intersectionRatio >= .15;
        this.#refresh(record);
      }
    }, {threshold: [0, .15]}) : null;
    this.resizeObserver = typeof environment.ResizeObserver === 'function' ? new environment.ResizeObserver(entries => {
      for (const record of this.records.values()) {
        if (entries.some(entry => entry.target === record.row || entry.target === record.wrapper)) this.#refresh(record);
      }
    }) : null;
    const refresh = () => this.sync();
    this.#listen(this.document, 'visibilitychange', refresh, undefined, this.cleanup);
    this.#listen(environment, 'resize', refresh, {passive: true}, this.cleanup);
    if (!this.intersectionObserver) this.#listen(environment, 'scroll', refresh, {passive: true}, this.cleanup);
    for (const name of ['pointerup', 'pointercancel']) this.#listen(this.document, name, event => {
      for (const record of this.records.values()) {
        if (!record.pointers.delete(event.pointerId ?? 0)) continue;
        record.manualUntil = this.#now() + MANUAL_COOLDOWN;
        this.#refresh(record);
      }
    }, undefined, this.cleanup);
    if (this.motion?.addEventListener) this.#listen(this.motion, 'change', refresh, undefined, this.cleanup);
    else if (this.motion?.addListener) {
      this.motion.addListener(refresh);
      this.cleanup.push(() => this.motion.removeListener(refresh));
    }
  }

  #now() { return this.environment.Date?.now() ?? Date.now(); }

  #listen(target, name, listener, options, cleanup) {
    target?.addEventListener?.(name, listener, options);
    cleanup.push(() => target?.removeEventListener?.(name, listener, options));
  }

  #cancelClock(record) {
    record.epoch++;
    if (record.timer !== null) this.environment.clearTimeout(record.timer);
    record.timer = null;
  }

  #cancelAnimation(record) {
    const animation = record.animation;
    if (!animation) return;
    record.animation = null;
    if (animation.frame !== null) this.environment.cancelAnimationFrame(animation.frame);
    for (const [property, {value, priority}] of animation.styles) {
      if (value) record.row.style.setProperty(property, value, priority);
      else record.row.style.removeProperty(property);
    }
  }

  #cancel(record) { this.#cancelClock(record); this.#cancelAnimation(record); }

  #withinViewport(wrapper) {
    const rect = wrapper.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < (this.environment.innerHeight || this.document?.documentElement?.clientHeight || 0);
  }

  #measure(record) {
    const {row, wrapper, previous, next} = record;
    const cards = [...row.children];
    const first = cards[0];
    const origin = first?.getBoundingClientRect().left || 0;
    record.offsets = cards.map(card => card.getBoundingClientRect().left - origin);
    record.maximum = Math.max(0, row.scrollWidth - row.clientWidth);
    record.overflow = row.clientWidth > 0 && record.maximum > 1 && cards.length > 1;
    for (const control of [previous, next]) {
      if (!control) continue;
      control.hidden = !record.overflow;
      control.disabled = !record.overflow;
    }
    const artwork = first?.querySelector('.poster,.channel-logo') || first;
    if (artwork) {
      const rect = artwork.getBoundingClientRect();
      const top = rect.top - wrapper.getBoundingClientRect().top + rect.height / 2;
      wrapper.style.setProperty('--shelf-nav-top', `${Math.max(0, top)}px`);
    }
    if (!this.intersectionObserver) record.inViewport = this.#withinViewport(wrapper);
  }

  #allowed(record) {
    return !this.destroyed && record.wrapper.isConnected && record.row.classList.contains('poster-shelf') && record.overflow && record.inViewport && !this.document?.hidden && !this.motion?.matches && !record.hovered && !record.focused && !record.pointers.size && this.isActive();
  }

  #canAnimate(record, manual) {
    return !this.destroyed && record.wrapper.isConnected && record.overflow && record.inViewport && !this.document?.hidden && !this.motion?.matches && !record.pointers.size && this.isActive() && (manual || this.#allowed(record));
  }

  #refresh(record) {
    this.#measure(record);
    if (record.animation && !this.#canAnimate(record, record.animation.manual)) this.#cancelAnimation(record);
    if (!this.#allowed(record)) { this.#cancelClock(record); return; }
    // Reconciliation and resize callbacks preserve an already running clock.
    if (record.timer !== null) return;
    const epoch = record.epoch;
    record.timer = this.environment.setTimeout(() => {
      if (epoch !== record.epoch || !this.records.has(record.wrapper)) return;
      record.timer = null;
      this.#measure(record);
      if (this.#allowed(record) && this.#now() >= record.manualUntil) this.#move(record, 1, false);
      this.#refresh(record);
    }, Math.max(this.interval, record.manualUntil - this.#now()));
  }

  #manual(record) {
    record.manualUntil = this.#now() + MANUAL_COOLDOWN;
    this.#cancel(record);
    this.#refresh(record);
  }

  #move(record, direction, manual) {
    this.#measure(record);
    if (manual) this.#manual(record);
    if (!record.overflow) return;
    const from = record.row.scrollLeft;
    const left = shelfScrollTarget(record.offsets, from, record.maximum, direction, this.step);
    this.#cancelAnimation(record);
    if (this.motion?.matches || typeof this.environment.requestAnimationFrame !== 'function' || typeof this.environment.cancelAnimationFrame !== 'function') {
      record.row.scrollTo({left, behavior: this.motion?.matches ? 'auto' : 'smooth'});
      return;
    }
    if (!this.#canAnimate(record, manual) || Math.abs(left - from) < 1) return;
    const wraps = direction >= 0 ? from >= record.maximum - 1 && left === 0 : from <= 1 && left === record.maximum;
    const style = record.row.style;
    const styles = new Map(['scroll-snap-type', 'scroll-behavior', 'opacity'].map(property => [property, {value: style.getPropertyValue(property), priority: style.getPropertyPriority(property)}]));
    // Native smooth scrolling can finish abruptly or compete with Safari's snap.
    // Frame positions stay immediate while our clock owns the full easing curve.
    style.setProperty('scroll-snap-type', 'none', 'important');
    style.setProperty('scroll-behavior', 'auto', 'important');
    const suppliedOpacity = Number(this.environment.getComputedStyle?.(record.row)?.opacity || style.getPropertyValue('opacity') || '1');
    const opacity = Number.isFinite(suppliedOpacity) ? suppliedOpacity : 1;
    const animation = {frame: null, startedAt: null, styles, manual, reset: false};
    record.animation = animation;
    const frame = timestamp => {
      if (record.animation !== animation) return;
      animation.frame = null;
      if (!this.#canAnimate(record, manual)) { this.#cancelAnimation(record); return; }
      animation.startedAt ??= timestamp;
      const progress = Math.max(0, Math.min(1, (timestamp - animation.startedAt) / (wraps ? WRAP_DURATION : SCROLL_DURATION)));
      if (wraps) {
        // Hide one frame at the reset instead of sweeping back across every cover.
        if (progress >= .5 && !animation.reset) {
          style.setProperty('opacity', '0');
          record.row.scrollTo({left, behavior: 'instant'});
          animation.reset = true;
        } else style.setProperty('opacity', String(opacity * (progress < .5 ? 1 - easeInOut(progress * 2) : easeInOut((progress - .5) * 2))));
      } else record.row.scrollTo({left: Math.max(0, Math.min(record.maximum, from + (left - from) * easeInOut(progress))), behavior: 'instant'});
      if (progress < 1) animation.frame = this.environment.requestAnimationFrame(frame);
      else this.#cancelAnimation(record);
    };
    animation.frame = this.environment.requestAnimationFrame(frame);
  }

  #attach(wrapper) {
    const row = wrapper.querySelector('.poster-shelf,.live-shelf');
    if (!row) return;
    const record = {wrapper, row, previous: wrapper.querySelector('.shelf-nav-prev'), next: wrapper.querySelector('.shelf-nav-next'), timer: null, animation: null, epoch: 0, offsets: [], maximum: 0, overflow: false, inViewport: false, hovered: false, focused: wrapper.contains(this.document?.activeElement), pointers: new Set(), manualUntil: 0, cleanup: []};
    this.records.set(wrapper, record);
    this.#listen(record.previous, 'click', () => this.#move(record, -1, true), undefined, record.cleanup);
    this.#listen(record.next, 'click', () => this.#move(record, 1, true), undefined, record.cleanup);
    this.#listen(wrapper, 'pointerenter', event => {
      if (event.pointerType === 'touch') return;
      record.hovered = true; this.#refresh(record);
    }, undefined, record.cleanup);
    this.#listen(wrapper, 'pointerleave', event => {
      if (event.pointerType === 'touch') return;
      record.hovered = false; this.#refresh(record);
    }, undefined, record.cleanup);
    this.#listen(wrapper, 'focusin', () => { record.focused = true; this.#refresh(record); }, undefined, record.cleanup);
    this.#listen(wrapper, 'focusout', () => {
      Promise.resolve().then(() => {
        if (!this.records.has(wrapper)) return;
        record.focused = wrapper.contains(this.document?.activeElement); this.#refresh(record);
      });
    }, undefined, record.cleanup);
    this.#listen(wrapper, 'pointerdown', event => {
      record.pointers.add(event.pointerId ?? 0); this.#manual(record);
    }, {passive: true}, record.cleanup);
    for (const name of ['wheel', 'keydown']) this.#listen(wrapper, name, () => this.#manual(record), {passive: true}, record.cleanup);
    this.intersectionObserver?.observe(wrapper);
    this.resizeObserver?.observe(wrapper);
    this.resizeObserver?.observe(row);
    this.#refresh(record);
  }

  #remove(record) {
    this.#cancel(record);
    this.intersectionObserver?.unobserve(record.wrapper);
    this.resizeObserver?.unobserve(record.wrapper);
    this.resizeObserver?.unobserve(record.row);
    record.cleanup.forEach(cleanup => cleanup());
    this.records.delete(record.wrapper);
  }

  /** Pass null when leaving home; omit the argument to refresh its context. */
  sync(container = this.container) {
    if (this.destroyed) return;
    this.container = container;
    const wrappers = new Set(container?.querySelectorAll('.shelf-carousel') || []);
    for (const record of this.records.values()) {
      if (!wrappers.has(record.wrapper) || !record.wrapper.isConnected) this.#remove(record);
    }
    for (const wrapper of wrappers) {
      if (!wrapper.isConnected) continue;
      const record = this.records.get(wrapper);
      if (record) this.#refresh(record);
      else this.#attach(wrapper);
    }
  }

  destroy() {
    if (this.destroyed) return;
    for (const record of this.records.values()) this.#remove(record);
    this.intersectionObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.cleanup.forEach(cleanup => cleanup());
    this.container = null;
    this.destroyed = true;
  }
}

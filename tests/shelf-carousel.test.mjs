import test from 'node:test';
import assert from 'node:assert/strict';
import {ShelfCarousels, shelfScrollTarget} from '../web/shelf-carousel.js';

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
  emit(name, event = {}) { for (const listener of this.listeners.get(name) || []) listener(event); }
  get listenerCount() { return [...this.listeners.values()].reduce((sum, values) => sum + values.size, 0); }
}

function clock() {
  let now = 0, serial = 0;
  const pending = new Map(), frames = new Map();
  return {
    pending, frames, now: () => now,
    schedule(callback, delay) { const id = ++serial; pending.set(id, {callback, time: now + delay}); return id; },
    cancel(id) { pending.delete(id); },
    frame(callback) { const id = ++serial; frames.set(id, {callback, time: now + 16}); return id; },
    cancelFrame(id) { frames.delete(id); },
    advance(duration) {
      const end = now + duration;
      for (;;) {
        const next = [...pending].map(([id, job]) => ({id, job, source: pending})).concat([...frames].map(([id, job]) => ({id, job, source: frames})))
          .filter(({job}) => job.time <= end).sort((a, b) => a.job.time - b.job.time)[0];
        if (!next) break;
        next.source.delete(next.id); now = next.job.time; next.job.callback(now);
      }
      now = end;
    }
  };
}

class Style {
  constructor() { this.values = new Map(); this.priorities = new Map(); }
  setProperty(name, value, priority = '') { this.values.set(name, String(value)); this.priorities.set(name, priority); }
  getPropertyValue(name) { return this.values.get(name) || ''; }
  getPropertyPriority(name) { return this.priorities.get(name) || ''; }
  removeProperty(name) { const old = this.getPropertyValue(name); this.values.delete(name); this.priorities.delete(name); return old; }
}

function fixture({count = 8, live = false, observers = true, raf = false} = {}) {
  const time = clock(), environment = new Target(), document = new Target(), motion = new Target();
  Object.assign(document, {hidden: false, activeElement: null});
  Object.assign(motion, {matches: false});
  Object.assign(environment, {document, Date: {now: time.now}, innerHeight: 900, matchMedia: () => motion});
  environment.setTimeout = function(callback, delay) { assert.equal(this, environment); return time.schedule(callback, delay); };
  environment.clearTimeout = function(id) { assert.equal(this, environment); time.cancel(id); };
  if (raf) {
    environment.requestAnimationFrame = function(callback) { assert.equal(this, environment); return time.frame(callback); };
    environment.cancelAnimationFrame = function(id) { assert.equal(this, environment); time.cancelFrame(id); };
  }
  environment.getComputedStyle = element => ({opacity: element.style.getPropertyValue('opacity') || '1'});
  const observersCreated = [];
  class Observer {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observersCreated.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
    emit(entries) { this.callback(entries); }
  }
  if (observers) Object.assign(environment, {IntersectionObserver: Observer, ResizeObserver: Observer});
  const wrapper = new Target(), previous = new Target(), next = new Target(), row = new Target();
  const moves = [], styles = new Map();
  Object.assign(wrapper, {isConnected: true, top: 100, style: {setProperty: (name, value) => styles.set(name, value)}});
  wrapper.getBoundingClientRect = () => ({left: 20, top: wrapper.top, bottom: wrapper.top + 220, width: row.clientWidth, height: 220});
  Object.assign(row, {style: new Style(), clientWidth: 320, scrollWidth: count * 110 - 10, scrollLeft: 0, classList: {contains: name => name === (live ? 'live-shelf' : 'poster-shelf')}});
  row.scrollTo = options => { moves.push(options); row.scrollLeft = options.left; };
  row.children = Array.from({length: count}, (_, index) => ({
    progress: {value: 47},
    getBoundingClientRect: () => ({left: 22 + index * 110 - row.scrollLeft, top: wrapper.top, height: 210}),
    querySelector: () => ({getBoundingClientRect: () => ({top: wrapper.top + 2, height: 150})})
  }));
  wrapper.querySelector = selector => selector === '.poster-shelf,.live-shelf' ? row : selector === '.shelf-nav-prev' ? previous : selector === '.shelf-nav-next' ? next : null;
  wrapper.contains = target => [wrapper, row, previous, next, ...row.children].includes(target);
  const container = {querySelectorAll: () => [wrapper]};
  let active = true;
  const manager = new ShelfCarousels({isActive: () => active, environment});
  manager.sync(container);
  const intersection = observersCreated[0], resize = observersCreated[1];
  const visible = value => intersection?.emit([{target: wrapper, isIntersecting: value, intersectionRatio: value ? 1 : 0}]);
  visible(true);
  return {time, environment, document, motion, manager, container, wrapper, row, previous, next, moves, styles, intersection, resize, visible, setActive: value => {active = value;}};
}

test('targets use real card offsets, reveal the final group and wrap only at an edge', () => {
  const offsets = [0, 110, 220, 330, 440, 550, 660, 770];
  assert.equal(shelfScrollTarget(offsets, 0, 550), 330);
  assert.equal(shelfScrollTarget(offsets, 330, 550), 550);
  assert.equal(shelfScrollTarget(offsets, 550, 550), 0);
  assert.equal(shelfScrollTarget(offsets, 0, 550, -1), 550);
  assert.equal(shelfScrollTarget(offsets, 550, 550, -1), 220);
  assert.equal(shelfScrollTarget([0, 98, 241, 389, 520], 98, 520, 1, 3), 520);
  assert.equal(shelfScrollTarget([], 0, 0), 0);
});

test('visible posters advance exactly three covers every five seconds with one stable timer', () => {
  const f = fixture(), cards = [...f.row.children];
  f.time.advance(4999); assert.deepEqual(f.moves, []);
  for (let index = 0; index < 20; index++) f.manager.sync(f.container);
  assert.equal(f.time.pending.size, 1);
  f.time.advance(1); assert.deepEqual(f.moves, [{left: 330, behavior: 'smooth'}]);
  f.time.advance(5000); assert.equal(f.moves.at(-1).left, 550);
  f.time.advance(5000); assert.equal(f.moves.at(-1).left, 0);
  assert.deepEqual(f.row.children, cards);
  assert.equal(cards[0].progress.value, 47);
  assert.equal(f.styles.get('--shelf-nav-top'), '77px');
  f.manager.destroy();
});

test('pointer hover and keyboard focus pause until a full fresh interval after leaving', async () => {
  const f = fixture();
  f.time.advance(900); f.wrapper.emit('pointerenter', {pointerType: 'mouse'});
  f.time.advance(5000); assert.equal(f.moves.length, 0); assert.equal(f.time.pending.size, 0);
  f.wrapper.emit('pointerleave', {pointerType: 'mouse'});
  f.time.advance(4999); assert.equal(f.moves.length, 0);
  f.time.advance(1); assert.equal(f.moves.length, 1);
  f.document.activeElement = f.next; f.wrapper.emit('focusin');
  f.time.advance(5000); assert.equal(f.moves.length, 1);
  // Moving between controls must keep the collection paused.
  f.document.activeElement = f.previous; f.wrapper.emit('focusout'); await Promise.resolve();
  assert.equal(f.time.pending.size, 0);
  f.document.activeElement = null; f.wrapper.emit('focusout'); await Promise.resolve();
  f.time.advance(4999); assert.equal(f.moves.length, 1);
  f.time.advance(1); assert.equal(f.moves.length, 2);
  f.manager.destroy();
});

test('touch and manual movement have a cooldown; release outside the row resumes safely', () => {
  const f = fixture();
  f.wrapper.emit('pointerenter', {pointerType: 'touch'});
  f.wrapper.emit('pointerdown', {pointerId: 9, pointerType: 'touch'});
  f.time.advance(5000); assert.equal(f.moves.length, 0);
  f.document.emit('pointercancel', {pointerId: 9});
  f.time.advance(4999); assert.equal(f.moves.length, 0);
  f.time.advance(1); assert.equal(f.moves.at(-1).left, 330);
  f.previous.emit('click'); assert.equal(f.moves.at(-1).left, 0);
  f.time.advance(4999); assert.equal(f.moves.length, 2);
  f.time.advance(1); assert.equal(f.moves.length, 3);
  f.manager.destroy();
});

test('hidden tabs, viewport exits and inactive app contexts cancel even queued work', () => {
  const f = fixture();
  const queued = [...f.time.pending.values()][0].callback;
  f.setActive(false); f.time.advance(5000);
  assert.equal(f.moves.length, 0); assert.equal(f.time.pending.size, 0);
  f.setActive(true); f.manager.sync();
  f.document.hidden = true; f.document.emit('visibilitychange');
  f.time.advance(5000); assert.equal(f.moves.length, 0);
  f.document.hidden = false; f.document.emit('visibilitychange');
  f.visible(false); f.time.advance(5000); assert.equal(f.moves.length, 0);
  f.intersection.emit([{target: f.wrapper, isIntersecting: true, intersectionRatio: .1}]);
  assert.equal(f.time.pending.size, 0);
  f.visible(true); f.time.advance(4999); assert.equal(f.moves.length, 0);
  f.time.advance(1); assert.equal(f.moves.length, 1);
  f.manager.sync(null); queued();
  assert.equal(f.moves.length, 1); assert.equal(f.time.pending.size, 0);
  f.manager.destroy();
});

test('reduced motion stops autoplay while preserving immediate manual controls', () => {
  const f = fixture();
  f.motion.matches = true; f.motion.emit('change');
  f.time.advance(5000); assert.equal(f.moves.length, 0); assert.equal(f.time.pending.size, 0);
  f.next.emit('click'); assert.deepEqual(f.moves, [{left: 330, behavior: 'auto'}]);
  f.motion.matches = false; f.motion.emit('change');
  f.time.advance(5000); assert.equal(f.moves.length, 2);
  f.manager.destroy();
});

test('live collections remain manual and short rows hide both navigation controls', () => {
  const live = fixture({live: true});
  live.time.advance(10000); assert.equal(live.time.pending.size, 0); assert.equal(live.moves.length, 0);
  live.next.emit('click'); assert.equal(live.moves.at(-1).left, 330); live.manager.destroy();
  const short = fixture({count: 2});
  assert.equal(short.previous.hidden, true); assert.equal(short.next.disabled, true);
  short.next.emit('click'); short.time.advance(5000); assert.equal(short.moves.length, 0);
  short.manager.destroy();
});

test('resize recalculates geometry; disconnect and destroy remove timers, observers and listeners', () => {
  const f = fixture();
  f.row.clientWidth = 900; f.resize.emit([{target: f.row}]);
  assert.equal(f.next.hidden, true); assert.equal(f.time.pending.size, 0);
  f.row.clientWidth = 320; f.resize.emit([{target: f.row}]);
  assert.equal(f.next.hidden, false); assert.equal(f.time.pending.size, 1);
  const queued = [...f.time.pending.values()][0].callback;
  f.wrapper.isConnected = false; f.manager.sync(); queued();
  assert.equal(f.moves.length, 0); assert.equal(f.time.pending.size, 0);
  assert.equal(f.wrapper.listenerCount + f.previous.listenerCount + f.next.listenerCount, 0);
  assert.equal(f.intersection.targets.size + f.resize.targets.size, 0);
  f.wrapper.isConnected = true; f.manager.sync(); f.visible(true);
  assert.equal(f.time.pending.size, 1);
  f.manager.destroy(); f.manager.destroy();
  assert.equal(f.time.pending.size, 0);
  assert.equal(f.environment.listenerCount + f.document.listenerCount + f.motion.listenerCount + f.wrapper.listenerCount + f.previous.listenerCount + f.next.listenerCount, 0);
  assert.equal(f.intersection.targets.size + f.resize.targets.size, 0);
});

test('the viewport fallback also pauses offscreen collections without browser observers', () => {
  const f = fixture({observers: false});
  f.time.advance(5000); assert.equal(f.moves.length, 1);
  f.wrapper.top = 1000; f.environment.emit('scroll');
  f.time.advance(5000); assert.equal(f.moves.length, 1);
  f.wrapper.top = 100; f.environment.emit('scroll');
  f.time.advance(5000); assert.equal(f.moves.length, 2);
  f.manager.destroy();
});

test('RAF eases three covers over 0.9 seconds, preserves the five-second clock and restores snap styles', () => {
  const f = fixture({count: 30, raf: true}), style = f.row.style;
  style.setProperty('scroll-snap-type', 'x mandatory', 'important');
  style.setProperty('scroll-behavior', 'smooth');
  f.time.advance(4999); assert.equal(f.moves.length, 0);
  f.time.advance(1);
  assert.equal(f.time.frames.size, 1);
  assert.equal(style.getPropertyValue('scroll-snap-type'), 'none');
  assert.equal(style.getPropertyValue('scroll-behavior'), 'auto');
  f.time.advance(241); const early = f.row.scrollLeft;
  assert.ok(early > 0 && early < 330 * .2);
  f.manager.sync(); assert.equal(f.time.frames.size, 1);
  f.time.advance(225); assert.ok(f.row.scrollLeft > 140 && f.row.scrollLeft < 190);
  f.time.advance(225); assert.ok(f.row.scrollLeft > 330 * .8 && f.row.scrollLeft < 330);
  f.time.advance(250);
  assert.equal(f.row.scrollLeft, 330); assert.equal(f.time.frames.size, 0);
  assert.equal(style.getPropertyValue('scroll-snap-type'), 'x mandatory');
  assert.equal(style.getPropertyPriority('scroll-snap-type'), 'important');
  assert.equal(style.getPropertyValue('scroll-behavior'), 'smooth');
  assert.ok(f.moves.every(move => move.behavior === 'instant'));
  f.time.advance(4059); assert.equal(f.time.now(), 10000); assert.equal(f.time.frames.size, 1);
  f.manager.destroy();
});

test('wrapping thirty covers fades, resets once while invisible and never sweeps across the row', () => {
  const f = fixture({count: 30, raf: true}), style = f.row.style;
  style.setProperty('opacity', '.8');
  f.row.scrollLeft = f.row.scrollWidth - f.row.clientWidth;
  f.time.advance(5160);
  assert.ok(Number(style.getPropertyValue('opacity')) > 0 && Number(style.getPropertyValue('opacity')) < .8);
  assert.equal(f.moves.length, 0);
  f.time.advance(160);
  assert.deepEqual(f.moves, [{left: 0, behavior: 'instant'}]);
  assert.equal(style.getPropertyValue('opacity'), '0');
  f.time.advance(144);
  assert.ok(Number(style.getPropertyValue('opacity')) > 0 && Number(style.getPropertyValue('opacity')) < .8);
  f.time.advance(200);
  assert.equal(f.moves.length, 1); assert.equal(f.time.frames.size, 0);
  assert.equal(style.getPropertyValue('opacity'), '.8');
  assert.equal(style.getPropertyValue('scroll-snap-type'), '');
  f.manager.destroy();
  const interrupted = fixture({count: 30, raf: true});
  interrupted.row.scrollLeft = interrupted.row.scrollWidth - interrupted.row.clientWidth;
  interrupted.time.advance(5320); assert.equal(interrupted.row.style.getPropertyValue('opacity'), '0');
  interrupted.wrapper.emit('pointerenter', {pointerType: 'mouse'});
  assert.equal(interrupted.row.style.getPropertyValue('opacity'), '');
  assert.equal(interrupted.time.frames.size, 0);
  interrupted.manager.destroy();
});

test('interaction, hidden contexts and cleanup cancel RAF without queued frames moving the row', () => {
  const interrupt = [
    f => f.wrapper.emit('pointerenter', {pointerType: 'mouse'}),
    f => { f.document.activeElement = f.next; f.wrapper.emit('focusin'); },
    f => f.wrapper.emit('pointerdown', {pointerId: 1}),
    f => f.wrapper.emit('wheel'), f => f.wrapper.emit('keydown'),
    f => f.visible(false),
    f => { f.document.hidden = true; f.document.emit('visibilitychange'); },
    f => { f.setActive(false); f.manager.sync(); },
    f => { f.motion.matches = true; f.motion.emit('change'); },
    f => f.manager.sync(null), f => f.manager.destroy()
  ];
  for (const cancel of interrupt) {
    const f = fixture({count: 30, raf: true});
    f.time.advance(5320); assert.ok(f.row.scrollLeft > 0);
    const queued = [...f.time.frames.values()][0].callback, position = f.row.scrollLeft;
    cancel(f); queued(9000); f.time.advance(2000);
    assert.equal(f.time.frames.size, 0); assert.equal(f.row.scrollLeft, position);
    assert.equal(f.row.style.getPropertyValue('scroll-snap-type'), '');
    assert.equal(f.row.style.getPropertyValue('scroll-behavior'), '');
    assert.equal(f.row.style.getPropertyValue('opacity'), '');
    f.manager.destroy();
  }
});

test('manual RAF movement works with hovered or focused controls and reduced motion remains immediate', () => {
  const f = fixture({live: true, raf: true});
  f.wrapper.emit('pointerenter', {pointerType: 'mouse'});
  f.document.activeElement = f.next; f.wrapper.emit('focusin');
  f.next.emit('click'); f.manager.sync(); f.time.advance(932);
  assert.equal(f.row.scrollLeft, 330); assert.equal(f.time.frames.size, 0);
  f.motion.matches = true; f.motion.emit('change'); f.next.emit('click');
  assert.equal(f.row.scrollLeft, 550); assert.equal(f.moves.at(-1).behavior, 'auto');
  assert.equal(f.time.frames.size, 0);
  f.manager.destroy();
});

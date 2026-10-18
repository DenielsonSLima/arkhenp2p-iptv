import test from 'node:test';
import assert from 'node:assert/strict';
import {PlaybackLoader, transferMbps} from '../web/playback-loader.js';
import {ImmersivePlayer} from '../web/player/orquestrador.js';

class Node extends EventTarget {
  constructor() { super(); this.dataset = {}; this.attributes = new Map(); this.children = []; this.hidden = false; this.style = {setProperty() {}}; }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  removeAttribute(key) { this.attributes.delete(key); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
}
function setup(t) {
  const oldDocument = globalThis.document;
  globalThis.document = {createElement: () => new Node()};
  t.after(() => { if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument; });
  const video = Object.assign(new Node(), {readyState: 0, currentTime: 0, buffered: {length: 0}});
  const observers = [], connection = {downlink: 8.5}; let clock = 100, online = true;
  const loader = new PlaybackLoader({video, connection, online: () => online, now: () => clock, observe: callback => {
    const observer = {callback, observe() {}, disconnect() { this.disconnected = true; }}; observers.push(observer); return observer;
  }});
  const item = {kind: 'movie', id: '1', name: 'Um filme'};
  loader.attach({item}); t.after(() => loader.reset());
  return {loader, video, item, connection, observers, advance: value => { clock += value; }, offline: () => { online = false; }};
}

test('intro advances from real source and metadata events and never finishes on elapsed time or loadeddata', t => {
  const {loader, video} = setup(t);
  assert.equal(loader.bar.getAttribute('aria-valuenow'), '0');
  loader.update({elapsed: 90});
  assert.equal(loader.bar.getAttribute('aria-valuenow'), '0');
  assert.match(loader.note.textContent, /servidor/);
  loader.setSource({url: '/api/play/movie/1.mp4'});
  assert.equal(loader.bar.getAttribute('aria-valuenow'), '1');
  video.readyState = 2; video.dispatchEvent(new Event('loadeddata'));
  assert.equal(loader.bar.getAttribute('aria-valuenow'), '2');
  assert.equal(loader.root.hidden, false);
  assert.equal(loader.current.active, true);
  loader.hide();
  assert.equal(loader.bar.getAttribute('aria-valuenow'), '3');
  assert.equal(loader.current.active, false);
});

test('real transfer rate is distinct from browser estimates and missing or stale samples stay honest', t => {
  const {loader, observers, advance, connection, offline} = setup(t);
  loader.setSource({url: '/api/play/movie/1.mp4'});
  assert.equal(loader.speed.textContent, '8,5 Mb/s');
  assert.match(loader.speedNote.textContent, /Estimativa/);
  const deliver = entry => observers[0].callback({getEntries: () => [entry]});
  const entry = {name: 'http://localhost/api/play/movie/1.mp4', startTime: 100, transferSize: 1000300, encodedBodySize: 1000000, responseStart: 200, responseEnd: 1200};
  deliver({...entry, transferSize: 0});
  assert.match(loader.speedLabel.textContent, /estimada/);
  deliver({...entry, name: 'http://localhost/api/image?ref=poster'});
  deliver({...entry, startTime: 99});
  assert.equal(loader.current.latestRate, null);
  deliver(entry);
  assert.equal(loader.speed.textContent, '8 Mb/s'); assert.match(loader.speedNote.textContent, /reprodução/);
  advance(10001); loader.update();
  assert.equal(loader.speed.textContent, '8,5 Mb/s');
  delete connection.downlink; loader.update(); assert.equal(loader.speed.textContent, '—');
  offline(); loader.update(); assert.equal(loader.speed.textContent, 'Sem conexão');
});

test('HLS video fragments supply delivery samples; audio and obsolete sources cannot affect a new episode', t => {
  const {loader, video} = setup(t), oldHls = globalThis.Hls;
  globalThis.Hls = {Events: {FRAG_LOADING: 'fragment-loading', FRAG_LOADED: 'fragment-loaded'}};
  t.after(() => { if (oldHls === undefined) delete globalThis.Hls; else globalThis.Hls = oldHls; });
  const handlers = new Map(), removed = [];
  const hls = {on: (event, fn) => handlers.set(event, fn), off: (event, fn) => removed.push([event, fn])};
  loader.setSource({url: '/api/play/live/1/index.m3u8', hls});
  handlers.get('fragment-loading')();
  assert.equal(loader.current.phase, 2);
  const onLoaded = handlers.get('fragment-loaded');
  const stats = {loaded: 1000000, loading: {start: 100, end: 1100}};
  onLoaded(null, {frag: {type: 'audio', stats}});
  assert.equal(loader.current.latestRate, null);
  onLoaded(null, {frag: {type: 'main', stats}});
  assert.equal(loader.speed.textContent, '8 Mb/s');
  loader.attach({item: {kind: 'series', name: 'Uma série'}, episode: {season: 2, number: 3}});
  assert.equal(removed.length, 2);
  assert.equal(loader.episode.textContent, 'Temporada 2 · Episódio 3');
  onLoaded(null, {frag: {type: 'main', stats}});
  assert.equal(loader.current.latestRate, null);
  video.readyState = 1; video.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(loader.current.phase, 2);
});

test('closing cancels fade and observers, and a delayed response cannot reopen or mutate a new source', t => {
  const {loader, observers, item} = setup(t);
  loader.setSource({url: '/api/play/movie/1.mp4'});
  loader.hide(); assert.equal(loader.current.active, false);
  loader.attach({item: {...item, id: '2', name: 'Outro filme'}});
  assert.equal(loader.hideTimer, null); assert.equal(observers[0].disconnected, true);
  observers[0].callback({getEntries: () => [{name: 'http://localhost/api/play/movie/1.mp4', startTime: 101, transferSize: 100, encodedBodySize: 1000000, responseStart: 200, responseEnd: 1200}]});
  assert.equal(loader.current.latestRate, null);
  assert.equal(loader.root.hidden, false);
  loader.reset(); assert.equal(loader.current, null); assert.equal(loader.root.hidden, true);
});

test('a failed source hides immediately without announcing successful preparation', t => {
  const {loader} = setup(t);
  loader.setSource({url: '/api/play/movie/1.mp4'});
  loader.hide({immediate: true});
  assert.equal(loader.root.hidden, true);
  assert.equal(loader.current.phase, 1);
  assert.equal(loader.hideTimer, null);
});

test('buffering uses an indeterminate compact treatment and measures only video available at the current position', t => {
  const {loader, video} = setup(t);
  video.currentTime = 20;
  video.buffered = {length: 2, start: index => [0, 19][index], end: index => [10, 24.5][index]};
  loader.show({started: true, message: 'Retomando seu vídeo'});
  assert.equal(loader.root.dataset.mode, 'buffering');
  assert.equal(loader.title.textContent, 'Retomando seu vídeo');
  assert.equal(loader.bar.getAttribute('aria-valuenow'), null);
  assert.equal(loader.buffer.textContent, '4,5 s');
});

test('delivery units reject missing, partial, too-short or non-finite measurements', () => {
  assert.equal(transferMbps(1000000, 0, 1000), 8);
  for (const values of [[null, 0, 1000], [0, 0, 1000], [100, 0, 1000], [1000000, undefined, 1000], [1000000, 10, 10], [1000000, 100, 10], [1000000, 0, 49], [Infinity, 0, 1000]]) assert.equal(transferMbps(...values), null);
});

test('immersive integration waits for playing and permits manual play after browser blocking', t => {
  const {video} = setup(t), transitions = [];
  const player = {video, current: {item: {kind: 'movie'}, loading: true}, error: {},
    listen: (target, event, callback) => { if (target === video) target.addEventListener(event, callback); },
    setLoading: value => transitions.push(value), recordStart() { this.recorded = true; }, updateControls() {},
    waitForPlay: ImmersivePlayer.prototype.waitForPlay};
  ImmersivePlayer.prototype.bind.call(player);
  video.paused = true; video.readyState = 2; video.dispatchEvent(new Event('loadeddata'));
  assert.deepEqual(transitions, [], 'The first decoded frame must not prematurely end the intro.');
  player.waitForPlay(); assert.equal(transitions.at(-1), false);
  transitions.length = 0; video.dispatchEvent(new Event('loadstart')); video.dispatchEvent(new Event('waiting'));
  assert.deepEqual(transitions, [], 'A late loading event must not cover the manual play control.');
  video.paused = false; video.dispatchEvent(new Event('playing'));
  assert.equal(player.recorded, true); assert.equal(player.current.awaitingPlay, false); assert.equal(transitions.at(-1), false);
});

test('transport-managed media errors do not interrupt recovery and a terminal failure stays visible until a new attempt',t=>{
  const {video}=setup(t);let failures=0,loads=0;
  Object.assign(video,{paused:false,ended:false,readyState:3,videoWidth:1920,videoHeight:1080});
  const player={video,options:{managedErrors:true},current:{item:{kind:'live'},loading:true},error:{hidden:false},
    listen:(target,event,callback)=>{if(target===video)target.addEventListener(event,callback);},
    setFailure:()=>{failures++;},setLoading:()=>{loads++;},recordStart(){},updateControls(){}};
  ImmersivePlayer.prototype.bind.call(player);
  video.dispatchEvent(new Event('error'));assert.equal(failures,0);
  video.dispatchEvent(new Event('playing'));assert.equal(player.error.hidden,true);assert.equal(loads,1);
  video.paused=true;video.dispatchEvent(new Event('waiting'));assert.equal(loads,1,'A late waiting event after user pause must not cover the controls.');
  player.current.failed=true;player.error.hidden=false;
  video.dispatchEvent(new Event('playing'));assert.equal(player.error.hidden,false);assert.equal(loads,1);
});

test('automatic same-channel continuation keeps the preparation clock or switches to compact buffering after playback',()=>{
  const view={current:{item:{kind:'live'},startedAt:100,loadStartedAt:200,recorded:false,loading:true}};
  assert.deepEqual(ImmersivePlayer.prototype.preparationContinuation.call(view),{startedAt:100,loadStartedAt:200,recorded:false});
  view.current.recorded=true;view.current.loading=false;
  const continuation=ImmersivePlayer.prototype.preparationContinuation.call(view);
  assert.equal(continuation.recorded,true);assert.ok(continuation.loadStartedAt>=0);
  view.current.item.kind='movie';assert.equal(ImmersivePlayer.prototype.preparationContinuation.call(view),null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EpisodeSkipStore, EpisodeSkipController, validateSkipMarkers, activeSkipActions } from '../web/episode-skip.js';

const context = (seriesId = '100', episodeId = '200', sourceFingerprint = '/api/play/series/200.mp4') => ({seriesId, episodeId, sourceFingerprint,namespace:'a'.repeat(64)});
const memoryStorage = () => {
  const values = new Map();
  return {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values};
};

test('skip actions use only complete, valid manual windows at their exact boundaries', () => {
  const marks = {openingStart: 12.5, openingEnd: 60.25, creditsStart: 540};
  for (const time of [0, 12.49, 60.25, 90]) assert.equal(activeSkipActions(marks, time, 600).opening, false);
  for (const time of [12.5, 40, 60.249]) assert.equal(activeSkipActions(marks, time, 600).opening, true);
  assert.deepEqual(activeSkipActions(marks, 539.99, 600), {opening: false, credits: false});
  assert.deepEqual(activeSkipActions(marks, 540, 600), {opening: false, credits: true});
  assert.deepEqual(activeSkipActions(marks, 600, 600), {opening: false, credits: false});
  assert.equal(activeSkipActions({openingStart: 0}, 0, 600).opening, false);
  assert.equal(activeSkipActions({openingStart: 0, openingEnd: 20}, 0, 600).opening, true);
});

test('invalid, unordered, out-of-bounds and unknown-duration markers cannot produce skip actions', () => {
  for (const marks of [{openingStart: -1}, {openingStart: NaN}, {openingEnd: 20}, {openingStart: 30, openingEnd: 20},
    {openingStart: 10, openingEnd: 10}, {creditsStart: 0}, {creditsStart: 600}, {creditsStart: Infinity},
    {openingStart: 10, openingEnd: 60, creditsStart: 50}, {openingStart: '10'}, []]) {
    assert.equal(validateSkipMarkers(marks, 600), null);
    assert.deepEqual(activeSkipActions(marks, 20, 600), {opening: false, credits: false});
  }
  for (const duration of [0, NaN, Infinity, -1, 90000, '600']) assert.equal(validateSkipMarkers({openingStart: 10}, duration), null);
  for (const time of [-1, NaN, Infinity]) assert.deepEqual(activeSkipActions({creditsStart: 10}, time, 600), {opening: false, credits: false});
});

test('markers persist per exact series and episode without sharing across a series', () => {
  const storage = memoryStorage(), store = new EpisodeSkipStore(storage);
  assert.equal(store.save(context(), 600, {openingStart: 10, openingEnd: 40}), true);
  const restored = new EpisodeSkipStore(storage);
  assert.deepEqual(restored.read(context(), 600).marks, {openingStart: 10, openingEnd: 40});
  assert.deepEqual(restored.read(context('100', '201'), 600).marks, {});
  assert.deepEqual(restored.read(context('101', '200'), 600).marks, {});
  assert.equal(restored.clear(context()), true);
  assert.deepEqual(new EpisodeSkipStore(storage).read(context(), 600).marks, {});
});

test('changed source or duration suppresses old markers until the new edition is marked', () => {
  const store = new EpisodeSkipStore(memoryStorage());
  store.save(context(), 600, {openingStart: 10, openingEnd: 40, creditsStart: 560});
  for (const changed of [context('100', '200', '/api/play/series/200.mkv'), context('100', '200', '/api/play/series/200.mp4?edition=2')]) {
    assert.deepEqual(store.read(changed, 600), {marks: {}, incompatible: true});
  }
  assert.deepEqual(store.read(context(), 605), {marks: {}, incompatible: true});
  assert.deepEqual(store.read(context(), 599.9), {marks: {}, incompatible: true});
  assert.equal(store.save(context(), 605, {openingStart: 15}), true);
  assert.deepEqual(store.read(context(), 605), {marks: {openingStart: 15}, incompatible: false});
  const privateSource = context('100', '202', '/api/play/series/202.mp4?token=private');
  const storage = memoryStorage(); new EpisodeSkipStore(storage).save(privateSource, 600, {openingStart: 10});
  assert.equal([...storage.values.values()][0].includes('private'), false);
});

test('the bounded store retains the latest 200 episodes even when clock values coincide', () => {
  const storage = memoryStorage(), store = new EpisodeSkipStore(storage, () => 1000);
  for (let episode = 1; episode <= 205; episode++) store.save(context('100', String(episode)), 600, {creditsStart: 550});
  assert.equal(store.records.size, 200);
  assert.deepEqual(store.read(context('100', '1'), 600).marks, {});
  assert.deepEqual(store.read(context('100', '205'), 600).marks, {creditsStart: 550});
  assert.equal(new EpisodeSkipStore(storage).records.size, 200);
});

test('corrupt or unavailable browser storage leaves manual marking usable in the current session', () => {
  for (const value of ['invalid JSON', JSON.stringify({version: 2, episodes: []}), JSON.stringify({version: 1, episodes: [{seriesId: '../1', episodeId: '2', source: 'bad', duration: 600, marks: {creditsStart: 20}, updatedAt: 0}]})]) {
    const store = new EpisodeSkipStore({getItem: () => value, setItem() {}}); assert.equal(store.records.size, 0);
  }
  const store = new EpisodeSkipStore({getItem() {throw new Error('blocked');}, setItem() {throw new Error('blocked');}});
  assert.equal(store.save(context(), 600, {openingStart: 5, openingEnd: 40}), false);
  assert.deepEqual(store.read(context(), 600).marks, {openingStart: 5, openingEnd: 40});
  assert.equal(store.clear(context()), false);
  assert.deepEqual(store.read(context(), 600).marks, {});
});

class Element extends EventTarget {
  constructor(tag) {super(); this.tagName = tag; this.children = []; this.textContent = ''; this.hidden = false; this.attributes = new Map();}
  append(...children) {this.children.push(...children);}
  setAttribute(key, value) {this.attributes.set(key, value);}
  remove() {this.removed = true;}
}
const document = {createElement: tag => new Element(tag)};
function controllerFixture(options = {}) {
  const video = new EventTarget(); Object.assign(video, {duration: 600, currentTime: 0, error: null});
  const controller = new EpisodeSkipController({video, document, storage: memoryStorage(), preferences:{getPreferences:()=>({autoSkipOpening:false})}, ...options});
  return {video, controller, attach: () => controller.attach({item: {kind: 'series', id: '100'}, episode: {id: '200'}, sourceFingerprint: '/api/play/series/200.mp4'})};
}

test('community records do not prompt calibration over the video; advanced local marking remains available',()=>{
  let opened=0;
  const f=controllerFixture({getEpisodeMarkers:()=>({status:'matched',markers:{creditsStart:550},confidence:'community-reference'}),onConfigureMarkers:()=>opened++});
  f.attach();assert.equal(f.controller.openingButton.hidden,true);assert.equal(f.controller.configureMarkersButton.hidden,true);
  assert.match(f.controller.catalogAvailability.textContent,/sem marcação conferida/);
  assert.equal(opened,0);assert.equal(f.video.currentTime,0);assert.equal(f.controller.overlay.hidden,true);
  f.video.currentTime=10;f.controller.mark('openingStart');f.video.currentTime=40;f.controller.mark('openingEnd');
  assert.equal(f.controller.configureMarkersButton.hidden,true);assert.equal(f.controller.catalogAvailability.hidden,true);
  f.video.currentTime=20;f.controller.update();assert.equal(f.controller.openingButton.hidden,false);f.controller.destroy();
});

test('incompatible runtimes and failed lookups explain the fallback without making timestamps eligible',async()=>{
  const f=controllerFixture({getEpisodeMarkers:()=>({status:'edition-mismatch',markers:null}),onConfigureMarkers:()=>{}});f.attach();
  assert.match(f.controller.catalogAvailability.textContent,/outra edição/);assert.equal(f.controller.skipOpening(),false);f.controller.destroy();
  const offline=controllerFixture({getEpisodeMarkers:()=>Promise.reject(new Error('Offline')),onConfigureMarkers:()=>{}});offline.attach();
  assert.match(offline.controller.catalogAvailability.textContent,/Buscando/);await Promise.resolve();await Promise.resolve();
  assert.equal(offline.controller.configureMarkersButton.hidden,true);assert.match(offline.controller.catalogAvailability.textContent,/sem marcação conferida/);
  assert.equal(offline.controller.skipOpening(),false);offline.controller.destroy();
});

test('controller requires a series episode, actual metadata and manual marks before exposing actions', () => {
  const {video, controller, attach} = controllerFixture();
  assert.equal(controller.panel.hidden, true);
  controller.attach({item: {kind: 'movie', id: '100'}, episode: {id: '200'}, sourceFingerprint: 'source'});
  assert.equal(controller.panel.hidden, true);
  video.duration = Infinity; attach();
  assert.equal(controller.markerButtons.get('openingStart').disabled, true);
  assert.equal(controller.overlay.hidden, true);
  video.duration = 600; video.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(controller.markerButtons.get('openingStart').disabled, false);
  assert.equal(controller.status.textContent, '');
  video.currentTime = 10; assert.equal(controller.mark('openingStart'), true);
  assert.equal(controller.openingButton.hidden, true);
  video.currentTime = 40; assert.equal(controller.mark('openingEnd'), true);
  video.currentTime = 20; video.dispatchEvent(new Event('timeupdate'));
  assert.equal(controller.openingButton.hidden, false);
  assert.equal(controller.skipOpening(), true); assert.equal(video.currentTime, 40); assert.equal(controller.openingButton.hidden, true);
  video.currentTime = 5; assert.equal(controller.skipOpening(), false); assert.equal(video.currentTime, 5);
  controller.destroy();
});

test('credits go to the next episode only after the marked credits start; last episode seeks its actual end', () => {
  let next = 0;
  const fixture = controllerFixture({hasNextEpisode: () => true, onNextEpisode: () => next++}); fixture.attach();
  fixture.video.currentTime = 550; fixture.controller.mark('creditsStart');
  fixture.video.currentTime = 500; assert.equal(fixture.controller.skipCredits(), false); assert.equal(next, 0);
  fixture.video.currentTime = 551; assert.equal(fixture.controller.skipCredits(), true); assert.equal(next, 1);
  fixture.controller.destroy();
  const last = controllerFixture(); last.attach(); last.video.currentTime = 550; last.controller.mark('creditsStart');
  assert.equal(last.controller.skipCredits(), true); assert.equal(last.video.currentTime, 600); assert.equal(last.controller.overlay.hidden, true);
  last.controller.destroy();
});

test('controller resets stale episode actions, ignores changed editions and removes event handlers when destroyed', () => {
  const {video, controller, attach} = controllerFixture(); attach();
  video.currentTime = 10; controller.mark('openingStart'); video.currentTime = 40; controller.mark('openingEnd');
  video.currentTime = 20; controller.update(); assert.equal(controller.openingButton.hidden, false);
  video.duration = 620; video.dispatchEvent(new Event('durationchange'));
  assert.equal(controller.overlay.hidden, true); assert.equal(controller.skipOpening(), false);
  controller.reset(); assert.equal(controller.panel.hidden, true); assert.equal(controller.overlay.hidden, true);
  let updates = 0; controller.update = () => updates++;
  controller.destroy(); video.dispatchEvent(new Event('timeupdate')); assert.equal(updates, 0);
  assert.equal(controller.panel.removed, true); assert.equal(controller.overlay.removed, true);
});

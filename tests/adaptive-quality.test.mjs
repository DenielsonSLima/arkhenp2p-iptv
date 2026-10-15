import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdaptiveState, decideAdaptiveSource } from '../web/adaptive-quality.js';

const sources = [
  { id: 'sd', name: 'Canal Sergipe SD', kind: 'live' },
  { id: 'hd', name: 'Canal Sergipe HD', kind: 'live' },
  { id: 'fhd', name: 'Canal Sergipe FHD', kind: 'live' },
  { id: '4k', name: 'Canal Sergipe 4K', kind: 'live' },
  { id: 'other-region', name: 'Canal Alagoas SD', kind: 'live' }
];

function session(currentItem = sources[2], overrides = {}) {
  let state = createAdaptiveState({ now: 0, currentId: currentItem.id });
  return {
    get state() { return state; },
    tick(now, changes = {}) {
      const decision = decideAdaptiveSource({ state, now, enabled: true, bufferSeconds: 20, stalls: 0, bandwidthBps: 9_000_000, currentBitrateBps: 3_000_000, variants: sources, currentItem, ...overrides, ...changes });
      state = decision.state;
      return decision;
    }
  };
}

test('two recent stalls with low buffer choose only the next lower source and retain cooldown after switching', () => {
  const playback = session();
  assert.equal(playback.tick(0, { bufferSeconds: 1 }).target, null);
  assert.equal(playback.tick(1000, { stalls: 1, bufferSeconds: 1 }).target, null);
  const down = playback.tick(2100, { stalls: 2, bufferSeconds: 1 });
  assert.equal(down.target, sources[1]);
  assert.equal(down.reason, 'repeated-stalls');
  assert.equal(down.state.higherAttempts, 0);
  assert.equal(playback.tick(2500, { stalls: 3, bufferSeconds: 1 }).reason, 'switch-pending');
  assert.equal(playback.tick(3000, { currentItem: sources[1] }).reason, 'source-changed');
  assert.equal(playback.tick(4000, { currentItem: sources[1], stalls: 1, bufferSeconds: 1 }).target, null);
  assert.equal(playback.tick(5000, { currentItem: sources[1], stalls: 2, bufferSeconds: 1 }).reason, 'cooldown');
  assert.equal(playback.tick(61_000, { currentItem: sources[1], stalls: 2, bufferSeconds: 1 }).target, null);
  assert.equal(playback.tick(62_000, { currentItem: sources[1], stalls: 3, bufferSeconds: 1 }).target, null);
  assert.equal(playback.tick(63_000, { currentItem: sources[1], stalls: 4, bufferSeconds: 1 }).target, sources[0]);
});

test('old counters and a healthy buffer do not trigger a downgrade', () => {
  const playback = session();
  playback.tick(0, { bufferSeconds: 1 });
  playback.tick(1000, { stalls: 1, bufferSeconds: 1 });
  assert.equal(playback.tick(31_001, { stalls: 2, bufferSeconds: 1 }).target, null);
  assert.equal(playback.tick(32_000, { stalls: 3, bufferSeconds: 1 }).target, null);
  const comfortable = session();
  comfortable.tick(0);
  comfortable.tick(1000, { stalls: 1 });
  assert.equal(comfortable.tick(2100, { stalls: 2, bufferSeconds: 10 }).target, null);
});

test('upgrading needs ninety observed healthy seconds and real headroom, then advances only one source', () => {
  const playback = session(sources[0]);
  for (const now of [0, 15_000, 30_000, 45_000, 60_000, 75_000, 89_999]) assert.equal(playback.tick(now).target, null);
  assert.equal(playback.tick(90_000, { currentBitrateBps: null }).target, null);
  assert.equal(playback.tick(90_001, { bandwidthBps: null }).target, null);
  assert.equal(playback.tick(90_002, { bandwidthBps: 7_499_999 }).target, null);
  const up = playback.tick(90_003, { bandwidthBps: 7_500_000 });
  assert.equal(up.target, sources[1]);
  assert.equal(up.reason, 'measured-headroom');
  assert.equal(up.state.higherAttempts, 1);
});

test('a low buffer or an observation gap restarts the uninterrupted upgrade period', () => {
  const playback = session(sources[0]);
  playback.tick(0);
  playback.tick(30_000);
  playback.tick(45_000, { bufferSeconds: 14.9 });
  for (const now of [46_000, 61_000, 76_000, 91_000, 106_000, 121_000, 135_999]) assert.equal(playback.tick(now).target, null);
  assert.equal(playback.tick(136_000).target, sources[1]);
  const suspended = session(sources[0]);
  suspended.tick(0);
  assert.equal(suspended.tick(120_000).target, null, 'An unobserved background period is not evidence of uninterrupted delivery.');
});

test('at most two higher-source attempts are allowed across automatic source changes', () => {
  const playback = session(sources[0]);
  for (const now of [0, 15_000, 30_000, 45_000, 60_000, 75_000]) playback.tick(now);
  assert.equal(playback.tick(90_000).target, sources[1]);
  playback.tick(90_001, { currentItem: sources[1] });
  for (const now of [90_002, 105_002, 120_002, 135_002, 150_002, 165_002]) playback.tick(now, { currentItem: sources[1] });
  assert.equal(playback.tick(180_002, { currentItem: sources[1] }).target, sources[2]);
  playback.tick(180_003, { currentItem: sources[2] });
  for (const now of [180_004, 195_004, 210_004, 225_004, 240_004, 255_004, 270_004]) assert.equal(playback.tick(now, { currentItem: sources[2] }).target, null);
  assert.equal(playback.state.higherAttempts, 2);
});

test('source adaptation does not mix regional channels or guess unknown quality labels', () => {
  for (const [currentItem, variants] of [
    [sources[2], [sources[2], sources[4]]],
    [{ id: 'original', name: 'Canal Sergipe Original', kind: 'live' }, sources],
    [{ id: 'ambiguous', name: 'Canal Sergipe HD FHD', kind: 'live' }, sources]
  ]) {
    const playback = session(currentItem, { variants });
    playback.tick(0, { bufferSeconds: 1 });
    playback.tick(1000, { bufferSeconds: 1, stalls: 1 });
    assert.equal(playback.tick(2100, { bufferSeconds: 1, stalls: 2 }).target, null);
  }
});

test('numeric resolution names rank actual catalog sources without changing the selected item', () => {
  const variants = [480, 720, 1080, 2160].map(pixels => ({ id: String(pixels), name: `Canal Sergipe ${pixels}p`, kind: 'live' }));
  const playback = session(variants[2], { variants });
  playback.tick(0, { bufferSeconds: 1 });
  playback.tick(1000, { bufferSeconds: 1, stalls: 1 });
  assert.equal(playback.tick(2100, { bufferSeconds: 1, stalls: 2 }).target, variants[1]);
});

test('disabling adaptation clears old stall evidence, and movies and series never switch sources', () => {
  const playback = session();
  playback.tick(0, { enabled: false, stalls: 2, bufferSeconds: 1 });
  assert.equal(playback.tick(5000, { enabled: false, stalls: 3, bufferSeconds: 1 }).reason, 'disabled');
  assert.equal(playback.tick(6000, { enabled: true, stalls: 3, bufferSeconds: 1 }).target, null);
  for (const kind of ['movie', 'series']) {
    const vod = session({ ...sources[2], kind });
    assert.equal(vod.tick(100_000, { stalls: 5, bufferSeconds: 0 }).reason, 'on-demand');
    assert.equal(vod.tick(200_000).target, null);
  }
});

test('policy decisions do not mutate the caller state or catalog items', () => {
  const state = createAdaptiveState({ now: 0, currentId: sources[2].id });
  Object.freeze(state.stallTimes);
  Object.freeze(state);
  const currentItem = Object.freeze({ ...sources[2] });
  const variants = Object.freeze(sources.map(item => Object.freeze({ ...item })));
  const result = decideAdaptiveSource({ state, now: 3000, enabled: true, bufferSeconds: 1, stalls: 2, variants, currentItem });
  assert.equal(result.target.id, 'hd');
  assert.notEqual(result.state, state);
  assert.deepEqual(state.stallTimes, []);
  assert.equal(state.pendingId, null);
});

test('nominal 4K and HEVC do not trigger blind upgrades; measured compatibility and target bandwidth are required',()=>{
  const current=sources[2],target={...sources[3],name:'Canal Sergipe 4K HEVC',bitrateBps:20_000_000};
  const healthy=options=>{const playback=session(current,{variants:[current,target],...options});let decision;for(const now of [0,15000,30000,45000,60000,75000,90000])decision=playback.tick(now);return decision;};
  assert.equal(healthy({bandwidthBps:50_000_000}).target,null);
  assert.equal(healthy({bandwidthBps:29_999_999,sourceCapabilities:new Map([[target.id,true]])}).target,null);
  assert.equal(healthy({bandwidthBps:30_000_000,sourceCapabilities:new Map([[target.id,true]])}).target,target);
  assert.equal(healthy({bandwidthBps:50_000_000,sourceCapabilities:new Map([[target.id,false]])}).target,null);
});

test('recovery never mixes time-shifted sources with otherwise matching names',()=>{
  const current={id:'shifted',name:'Canal Sergipe +2 FHD',kind:'live'},variants=[current,...sources];
  const playback=session(current,{variants});playback.tick(0,{bufferSeconds:1});playback.tick(1000,{bufferSeconds:1,stalls:1});
  assert.equal(playback.tick(2100,{bufferSeconds:1,stalls:2}).target,null);
});

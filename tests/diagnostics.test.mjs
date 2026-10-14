import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeConnection, summarizeTransfers } from '../lib/diagnostics.mjs';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const account = { auth: '1', status: 'Active', max_connections: '1', active_cons: '1', username: 'private-user', password: 'private-password' };
function fakeClient({ responses = [account, account, account], delays = [20, 40, 30], transfers = [], active = true } = {}) {
  let elapsed = 0;
  let inFlight = 0;
  let peak = 0;
  const calls = [];
  const client = {
    config: { server: 'https://provider.example:8443/', username: 'private-user', password: 'private-password' },
    session: { connected: true, account: { maxConnections: 1, activeConnections: 0 } },
    playback: active ? { key: 'live:123', controller: { signal: { aborted: false }, abort() { throw new Error('Diagnostics must not stop playback.'); } } } : null,
    transfers,
    async api(...args) {
      const index = calls.length;
      calls.push(args);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      elapsed += delays[index];
      inFlight--;
      if (responses[index] instanceof Error) throw responses[index];
      return { user_info: responses[index] };
    },
    playbackURL() { throw new Error('Diagnostics must not open a media stream.'); },
    connect() { throw new Error('Diagnostics must measure the API instead of returning cached authentication.'); }
  };
  return { client, calls, get peak() { return peak; }, clock: { now: () => NOW, measureNow: () => elapsed } };
}
function segment(overrides = {}) {
  return { key: 'live:123', kind: 'segment', bytes: 1_000_000, durationMs: 250, ttfbMs: 50, mediaDurationSeconds: 4, ok: true, time: NOW - 1000, ...overrides };
}

test('diagnostics measure metadata sequentially and do not invent video bandwidth', async () => {
  const fixture = fakeClient({ active: false });
  const report = await analyzeConnection(fixture.client, fixture.clock);
  assert.equal(fixture.calls.length, 3);
  assert.ok(fixture.calls.every(args => args[0] === undefined && Object.keys(args[1]).length === 0 && args[2].timeout === 8000));
  assert.equal(fixture.peak, 1);
  assert.deepEqual(report.server, { host: 'provider.example', reachable: true, latencyMs: 30, jitterMs: 20, successRate: 1 });
  assert.deepEqual(report.playback, { active: false, kind: null, throughputMbps: null, requiredMbps: null, deliveryRatio: null, segmentSamples: 0, upstreamTtfbMs: null });
  assert.equal(report.assessment.status, 'insufficient');
  assert.deepEqual(report.account, { maxConnections: 1, activeConnections: 1 });
  assert.equal(report.checkedAt, new Date(NOW).toISOString());
  const text = JSON.stringify(report);
  assert.ok(!text.includes('private-user') && !text.includes('private-password') && !text.includes(':8443'));
  assert.match(report.limits.join(' '), /metadados/);
  assert.match(report.limits.join(' '), /estabilidade futura/);
});

test('real segment bytes and timings estimate delivery margin while ignoring playlists and stale samples', async () => {
  const transfers = [
    segment(), segment({ durationMs: 500, ttfbMs: 90 }), segment({ durationMs: 250, ttfbMs: 70 }),
    segment({ bytes: 999_000_000, time: NOW - 120_001 }),
    segment({ bytes: 999_000_000, time: NOW + 1 }),
    segment({ kind: 'playlist', bytes: 999_000_000 }),
    segment({ kind: 'video', bytes: 999_000_000 }),
    segment({ bytes: 999_000_000, durationMs: 0 }),
    segment({ bytes: NaN })
  ];
  const fixture = fakeClient({ transfers });
  const report = await analyzeConnection(fixture.client, fixture.clock);
  assert.equal(report.playback.active, true);
  assert.equal(report.playback.kind, 'live');
  assert.equal(report.playback.segmentSamples, 3);
  assert.equal(report.playback.throughputMbps, 24);
  assert.equal(report.playback.requiredMbps, 2);
  assert.equal(report.playback.deliveryRatio, 0.083);
  assert.equal(report.playback.upstreamTtfbMs, 70);
  assert.equal(report.assessment.status, 'good');
});

test('download performance cannot imply adequate playback without media duration', async () => {
  const fixture = fakeClient({ transfers: [segment({ mediaDurationSeconds: undefined }), segment({ mediaDurationSeconds: 0 }), segment({ mediaDurationSeconds: undefined })] });
  const report = await analyzeConnection(fixture.client, fixture.clock);
  assert.equal(report.playback.throughputMbps, 32);
  assert.equal(report.playback.requiredMbps, null);
  assert.equal(report.playback.deliveryRatio, null);
  assert.equal(report.assessment.status, 'insufficient');
});

test('segments slower than their playback duration produce a practical warning', async () => {
  const fixture = fakeClient({ transfers: [segment({ durationMs: 5000 }), segment({ durationMs: 4500 }), segment({ durationMs: 6000 })] });
  const report = await analyzeConnection(fixture.client, fixture.clock);
  assert.ok(report.playback.deliveryRatio > 1);
  assert.equal(report.assessment.status, 'poor');
  assert.ok(report.recommendations.some(text => /HD ou SD/.test(text)));
});

test('a failed metadata probe lowers API success without misclassifying healthy video delivery', async () => {
  const fixture = fakeClient({ responses: [account, new Error('Failed https://private-user:private-password@provider.example'), account], transfers: [segment(), segment(), segment()] });
  const report = await analyzeConnection(fixture.client, fixture.clock);
  assert.equal(report.server.reachable, true);
  assert.equal(report.server.successRate, 2 / 3);
  assert.equal(report.server.latencyMs, 25);
  assert.equal(report.server.jitterMs, 10);
  assert.equal(report.assessment.status, 'good');
  assert.match(report.assessment.detail, /consultas da conta falhou/);
  assert.ok(!JSON.stringify(report).includes('private-password'));
});

test('unreachable and rejected accounts remain distinct from a measured video speed', async () => {
  const unreachable = fakeClient({ responses: [new Error('timeout'), new Error('timeout'), new Error('timeout')], active: false });
  const failed = await analyzeConnection(unreachable.client, unreachable.clock);
  assert.equal(failed.server.reachable, false);
  assert.equal(failed.server.latencyMs, null);
  assert.equal(failed.server.jitterMs, null);
  assert.equal(failed.server.successRate, 0);
  assert.equal(failed.playback.throughputMbps, null);
  assert.equal(failed.assessment.status, 'poor');
  const rejected = fakeClient({ responses: [{ auth: 0 }, { ...account, status: 'Expired' }, { ...account, exp_date: String(NOW / 1000 - 1) }] });
  const denied = await analyzeConnection(rejected.client, rejected.clock);
  assert.equal(denied.server.reachable, true);
  assert.equal(denied.server.successRate, 0);
  assert.equal(denied.assessment.title, 'Acesso não validado');
});

test('failed segments are counted but never inflate measured throughput', () => {
  const measurements = summarizeTransfers([segment(), segment({ bytes: 10_000_000, ok: false }), segment({ ok: false })], NOW);
  assert.equal(measurements.throughputMbps, 32);
  assert.equal(measurements.segmentSamples, 1);
  assert.equal(measurements.failedSegments, 2);
});

test('slow catalog responses remain separate from healthy media delivery', async () => {
  const fixture = fakeClient({ delays: [1800, 3200, 2500], transfers: [segment(), segment(), segment()] });
  const report = await analyzeConnection(fixture.client, fixture.clock);
  assert.equal(report.server.latencyMs, 2500);
  assert.equal(report.server.jitterMs, 1400);
  assert.equal(report.assessment.status, 'good');
  assert.match(report.assessment.detail, /catálogo demoraram/);
  assert.ok(!report.recommendations.some(text => /HD ou SD/.test(text)));
});

test('stopped playback and samples from previous channels cannot claim current throughput', async () => {
  const stopped = fakeClient({ active: false, transfers: [segment(), segment(), segment()] });
  const inactive = await analyzeConnection(stopped.client, stopped.clock);
  assert.equal(inactive.playback.active, false);
  assert.equal(inactive.playback.segmentSamples, 0);
  assert.equal(inactive.playback.throughputMbps, null);
  assert.equal(inactive.assessment.status, 'insufficient');
  const changed = fakeClient({ transfers: [segment({ key: 'live:999' }), segment({ key: 'movie:123' }), segment()] });
  const current = await analyzeConnection(changed.client, changed.clock);
  assert.equal(current.playback.segmentSamples, 1);
  assert.equal(current.assessment.status, 'insufficient');
});

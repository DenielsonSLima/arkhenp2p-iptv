import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaDuration } from '../lib/media-duration.mjs';

test('media runtime preserves explicit units and formats real time codes', () => {
  for (const [source, seconds, display] of [
    [{ durationSeconds: 9960 }, 9960, '2 h 46 min'],
    [{ duration_seconds: '2400' }, 2400, '40 min'],
    [{ runtimeMinutes: 106 }, 6360, '1 h 46 min'],
    [{ duration: '01:42:10' }, 6130, '1 h 42 min'],
    [{ runtime: 'PT2H3M' }, 7380, '2 h 3 min'],
    [{ runTime: '1h 30min' }, 5400, '1 h 30 min'],
    [{ duration: '45 minutos' }, 2700, '45 min'],
    [{ runtime_seconds: 35 }, 35, '35 s']
  ]) assert.deepEqual(mediaDuration(source), { duration: display, durationSeconds: seconds });
});

test('media duration stays unknown when the provider supplies no trustworthy unit', () => {
  for (const source of [undefined, {}, { duration: 7200 }, { runtime: 120 }, { duration: '120' }, { duration: '1:30' }, { duration: '01:99:00' }, { durationSeconds: -5 }, { durationMinutes: 0 }, { runtimeMinutes: Infinity }, { duration: 'unknown' }]) {
    assert.deepEqual(mediaDuration(source), { duration: '', durationSeconds: null });
  }
  assert.deepEqual(mediaDuration({ duration: 'unknown' }, { durationSeconds: 120 }), { duration: '2 min', durationSeconds: 120 });
});

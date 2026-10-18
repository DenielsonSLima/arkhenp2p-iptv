import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionGuard} from '../web/login/session-guard.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
const failure = (status, code) => Object.assign(new Error('synthetic failure'), {status, code});
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function fixture(request) {
  let scope = 'generation-1:account-a', now = 0;
  const lost = [], calls = [];
  const guard = new SessionGuard({request: (path, options) => {calls.push({path, options}); return request(path, options);},
    getScope: () => scope, onLost: value => lost.push(value), now: () => now});
  return {guard, lost, calls, scope: value => {scope = value;}, clock: value => {now = value;}};
}

test('definitive protected 401 invalidates once and preserves the API error', async () => {
  const error = failure(401, 'SESSION_REQUIRED'), f = fixture(async () => {throw error;});
  await Promise.all(Array.from({length: 4}, () => assert.rejects(f.guard.request('/api/catalog?type=live'), value => value === error)));
  assert.equal(f.lost.length, 1); assert.equal(f.lost[0].reason, 'session-required');
  assert.equal(f.calls.filter(call => call.path === '/api/session').length, 0);
});

test('a successful disconnected session response invalidates the current scope once', async () => {
  const body = {connected: false}, f = fixture(async () => body);
  assert.equal(await f.guard.request('/api/session?cloud=refresh'), body);
  await f.guard.request('/api/session');
  assert.equal(f.lost.length, 1); assert.equal(f.lost[0].reason, 'session-disconnected');
});

test('login and explicit logout errors never invalidate the existing scope', async () => {
  const f = fixture(async () => {throw failure(401, 'SESSION_REQUIRED');});
  for (const path of ['/api/login', '/api/login?retry=1', '/api/logout']) await assert.rejects(f.guard.request(path), {status: 401});
  assert.equal(f.lost.length, 0); assert.equal(f.calls.length, 3);
});

test('concurrent ambiguous 401 responses share one raw session verification', async () => {
  const read = deferred(), error = failure(401, 'UPSTREAM_AUTH');
  const f = fixture(path => path === '/api/session' ? read.promise : Promise.reject(error));
  const requests = Array.from({length: 8}, () => assert.rejects(f.guard.request('/api/catalog?type=live'), value => value === error));
  await flush(); assert.equal(f.calls.filter(call => call.path === '/api/session').length, 1);
  read.resolve({connected: false}); await Promise.all(requests);
  assert.equal(f.lost.length, 1);
});

test('upstream 401 does not log out a locally authenticated session', async () => {
  const f = fixture(async path => {if (path === '/api/session') return {connected: true}; throw failure(401, 'UPSTREAM_AUTH');});
  await assert.rejects(f.guard.request('/api/catalog'), {status: 401});
  assert.equal(f.lost.length, 0); assert.equal(f.calls.length, 2);
});

test('503, network, and session error responses never prove loss of authentication', async () => {
  for (const result of [{connected: false, error: 'temporary upstream failure'}, failure(503, 'UNAVAILABLE'), new TypeError('synthetic offline')]) {
    const f = fixture(async path => {if (path !== '/api/session') throw failure(401, 'UPSTREAM_AUTH'); if (result instanceof Error) throw result; return result;});
    await assert.rejects(f.guard.request('/api/catalog'), {status: 401});
    assert.equal(f.lost.length, 0);
  }
  for (const error of [failure(503, 'UNAVAILABLE'), new TypeError('synthetic offline')]) {
    const f = fixture(async () => {throw error;});
    await assert.rejects(f.guard.request('/api/catalog'), value => value === error);
    assert.equal(f.calls.length, 1); assert.equal(f.lost.length, 0);
  }
  const f = fixture(async () => ({connected: false, error: 'temporary upstream failure'}));
  await f.guard.request('/api/session'); assert.equal(f.lost.length, 0);
});

test('session verification itself can return a definitive SESSION_REQUIRED', async () => {
  const f = fixture(async path => {throw failure(401, path === '/api/session' ? 'SESSION_REQUIRED' : 'UPSTREAM_AUTH');});
  await assert.rejects(f.guard.request('/api/catalog'), {code: 'UPSTREAM_AUTH'});
  assert.equal(f.lost.length, 1); assert.equal(f.calls.length, 2);
});

test('an old request cannot invalidate a newer login or launch its check', async () => {
  const read = deferred(), f = fixture(() => read.promise);
  const pending = assert.rejects(f.guard.request('/api/catalog'), {status: 401});
  f.scope('generation-2:account-a'); read.reject(failure(401, 'SESSION_REQUIRED')); await pending;
  assert.equal(f.lost.length, 0); assert.equal(f.calls.length, 1);
  const session = deferred(), g = fixture(() => session.promise), refresh = g.guard.request('/api/session');
  g.scope('generation-2:account-b'); session.resolve({connected: false}); await refresh;
  assert.equal(g.lost.length, 0);
});

test('checks coalesce, throttle for five seconds, and reset for a new scope', async () => {
  const read = deferred(), f = fixture(() => f.calls.length === 1 ? read.promise : Promise.resolve({connected: true}));
  const first = f.guard.check(), second = f.guard.check(); assert.equal(first, second);
  await flush(); assert.equal(f.calls.length, 1); read.resolve({connected: true}); await first;
  f.clock(4999); await f.guard.check(); assert.equal(f.calls.length, 1);
  f.clock(5000); await f.guard.check(); assert.equal(f.calls.length, 2);
  f.scope('generation-2:account-a'); await f.guard.check(); assert.equal(f.calls.length, 3);
});

test('a new scope aborts an old check and ignores an eventual old response', async () => {
  const old = deferred(), f = fixture(() => f.calls.length === 1 ? old.promise : Promise.resolve({connected: true}));
  const first = f.guard.check(); await flush(); const signal = f.calls[0].options.signal;
  f.scope('generation-2:account-b'); await f.guard.check();
  assert.equal(signal.aborted, true); assert.equal(await first, null);
  old.resolve({connected: false}); await flush(); assert.equal(f.lost.length, 0);
});

test('reset aborts in-flight checks, ignores stale results, and clears the throttle', async () => {
  const old = deferred(), f = fixture(() => f.calls.length === 1 ? old.promise : Promise.resolve({connected: true}));
  const pending = f.guard.check(); await flush(); const signal = f.calls[0].options.signal;
  f.guard.reset(); assert.equal(signal.aborted, true); assert.equal(await pending, null);
  await f.guard.check(); assert.equal(f.calls.length, 2);
  old.resolve({connected: false}); await flush(); assert.equal(f.lost.length, 0);
});

test('onLost may synchronously reset without duplicated stale callbacks', async () => {
  const read = deferred(), lost = []; let guard;
  guard = new SessionGuard({request: () => read.promise, getScope: () => 'generation-1:account-a', onLost: value => {lost.push(value); guard.reset();}});
  const requests = Array.from({length: 5}, () => assert.rejects(guard.request('/api/catalog'), {status: 401}));
  read.reject(failure(401, 'SESSION_REQUIRED')); await Promise.all(requests);
  assert.equal(lost.length, 1);
});

test('verification deadline aborts even a transport that ignores cancellation', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = fixture(() => new Promise(() => {}));
  const pending = f.guard.check(); await flush();
  t.mock.timers.tick(5000); assert.equal(await pending, null);
  assert.equal(f.calls[0].options.signal.aborted, true);
  assert.equal(f.calls[0].options.signal.reason.name, 'TimeoutError');
  assert.equal(f.lost.length, 0); assert.equal(f.guard.pending, null);
});

test('anonymous scope and non-401 denial do not verify or invalidate a session', async () => {
  const f = fixture(async () => {throw failure(401, 'SESSION_REQUIRED');}); f.scope(null);
  await assert.rejects(f.guard.request('/api/catalog'), {status: 401}); await f.guard.check();
  assert.equal(f.calls.length, 1); assert.equal(f.lost.length, 0);
  const g = fixture(async () => {throw failure(403, 'PARENTAL_LOCKED');});
  await assert.rejects(g.guard.request('/api/catalog'), {status: 403});
  assert.equal(g.calls.length, 1); assert.equal(g.lost.length, 0);
});

test('a definitive account change in another tab invalidates the current UI once', async () => {
  const lost = [], guard = new SessionGuard({request: async () => ({connected: true, account: {libraryId: 'account-b'}}),
    getScope: () => 'generation-1:account-a', getAccountId: () => 'account-a', onLost: value => lost.push(value)});
  await guard.check(); await guard.request('/api/session?cloud=refresh');
  assert.equal(lost.length, 1); assert.equal(lost[0].reason, 'session-changed');
});

test('matching, missing, empty, or indeterminate account identity does not invalidate', async () => {
  for (const [expectedAccount, reply] of [
    ['account-a', {connected: true, account: {libraryId: 'account-a'}}],
    ['account-a', {connected: true}],
    ['account-a', {connected: true, account: {libraryId: ' '}}],
    [null, {connected: true, account: {libraryId: 'account-b'}}],
    ['', {connected: true, account: {libraryId: 'account-b'}}],
    ['account-a', {connected: true, account: {libraryId: 'account-b'}, error: 'temporary failure'}],
    ['account-a', {account: {libraryId: 'account-b'}}]
  ]) {
    const lost = [], guard = new SessionGuard({request: async () => reply,
      getScope: () => 'generation-1:account-a', getAccountId: () => expectedAccount, onLost: value => lost.push(value)});
    await guard.request('/api/session'); assert.equal(lost.length, 0);
  }
});

test('an account mismatch from an old response cannot invalidate a newer login', async () => {
  const old = deferred(), lost = [];
  let scope = 'generation-1:account-a', account = 'account-a';
  const guard = new SessionGuard({request: () => old.promise, getScope: () => scope,
    getAccountId: () => account, onLost: value => lost.push(value)});
  const pending = guard.request('/api/session');
  scope = 'generation-2:account-b'; account = 'account-b';
  old.resolve({connected: true, account: {libraryId: 'account-b'}}); await pending;
  assert.equal(lost.length, 0);
});

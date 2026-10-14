import test from 'node:test';
import assert from 'node:assert/strict';
import { createOriginalLogin, javaField, normalizedCredentials } from './login.mjs';

function fixture({ code = 0, ready = true, automatic = true, version = 1190, deviceType = -1,
  dialogCount = 1, callbackPublishes = true } = {}) {
  const calls = [], preferences = new Map();
  let originalCalls = 0, main = false;
  const User = { d: { value: null } };
  const publishAuth = (username = 'example') => {
    const auth = { code: { value: code }, service: { value: {} },
      user: { value: { user_name: { value: username } } },
      equals: other => other === auth, $dispose() {} };
    User.d.value = auth;
    return auth;
  };
  const method = {
    implementation: null,
    call(_self, _status, _username, _body) {
      originalCalls++;
      if (callbackPublishes) publishAuth();
      return 7;
    },
  };
  const callback = () => method.implementation.call(User, 200,
    preferences.get('username'), 'sensitive-response-token');
  User.k = { overload: () => method };
  const put = { call(_self, key, value) { assert.ok(main); calls.push(key); preferences.set(key, value); } };
  const setMode = { call(_self, value, key) { assert.ok(main); calls.push(key); preferences.set(key, value); } };
  const activity = { _U: { value: null }, equals: other => other === activity,
    _D0: { value: { setDeviceType(value) { assert.ok(main); deviceType = value; calls.push(`device:${value}`); } } },
    v() { assert.ok(main); calls.push('initialize'); activity._U.value = {}; } };
  const dialog = { isShowing: () => true, getContext: () => ({ equals: () => false, getBaseContext: () => activity }),
    findViewById: id => [0x7f0b02cc, 0x7f0b02cb, 0x7f0b00a2].includes(id) ? {} : null,
    dismiss() { assert.ok(main); calls.push('dismiss'); }, $dispose() {} };
  const classes = {
    'org.bitspark.android.SpkApplication': { m: { value: {
      getPackageName: () => 'io.wareztv.android.one',
      getPackageManager: () => ({ getPackageInfo: () => ({ versionCode: { value: version } }) }),
    } } },
    'org.bitspark.android.Spark': { g3: { value: ready ? { a: { value: { get: () => activity } }, sendEmptyMessage(value) {
      assert.ok(main); assert.equal(value, 13); calls.push('submit');
      if (automatic) queueMicrotask(callback);
      return true;
    } } : null } },
    'td.m': User,
    'org.bitspark.android.utils.i0': { t: { overload: () => setMode }, u: { overload: () => put },
      j: { overload: () => ({ call: () => ({ intValue: () => deviceType }) }) } },
    'org.bitspark.android.g': { b: { value: 'mode' }, e: { value: 'username' }, f: { value: 'password' } },
    'org.bitspark.android.h': { d: { value: '@wareztv.io' } },
    'com.tvbus.engine.TVCore': { inst: { value: null }, nativeHandle: { value: 0 } },
  };
  const Java = { available: true, perform: fn => fn(), use: name => classes[name],
    cast: x => x, retain: x => x, choose(_name, callbacks) {
      for (let i = 0; i < dialogCount; i++) callbacks.onMatch(dialog);
      callbacks.onComplete();
    },
    scheduleOnMainThread(fn) { main = true; try { fn(); } finally { main = false; } } };
  return { login: createOriginalLogin(Java), calls, preferences, callback, method,
    publishAuth,
    originalCalls: () => originalCalls };
}

test('normalizes exactly as the original login and rejects invalid inputs', () => {
  assert.deepEqual(normalizedCredentials({ username: ' example ', password: ' pass ' }, '@wareztv.io'),
    { username: 'example@wareztv.io', password: 'pass' });
  assert.equal(normalizedCredentials({ username: 'example@provider', password: 'pass' }, '@wareztv.io').username,
    'example@provider');
  assert.throws(() => normalizedCredentials({ username: 'example', password: '' }, '@wareztv.io'), /LOGIN_INVALID_INPUT/);
  assert.throws(() => normalizedCredentials({ username: 'example', password: 'pass' }, '@unknown'), /LOGIN_UNEXPECTED_SUFFIX/);
});

test('uses Frida field aliases when a method shares the obfuscated name', () => {
  const actual = { code: { value: 0 } };
  assert.equal(javaField({ d() {}, _d: { value: actual } }, 'd'), actual);
  assert.equal(javaField({ d: { value: null } }, 'd'), null);
  assert.throws(() => javaField({ d() {} }, 'd'), /LOGIN_FIELD_UNAVAILABLE/);
});

test('submits through original preferences and handler, retains callback and protects output', async () => {
  const f = fixture();
  await f.login.attach();
  const result = await f.login.login({ username: 'example', password: 'test-pass' });
  assert.deepEqual(result, { authenticated: true, code: 0 });
  assert.deepEqual(f.calls, ['mode', 'username', 'password', 'submit']);
  assert.equal(f.preferences.get('username'), 'example@wareztv.io');
  assert.equal(f.preferences.get('mode'), 1);
  assert.equal(f.originalCalls(), 1);
  const state = await f.login.status();
  assert.equal(state.engineCreated, false);
  assert.doesNotMatch(JSON.stringify(state), /example|test-pass|sensitive|token/);
  await assert.rejects(f.login.login({ username: 'example', password: 'test-pass' }), /LOGIN_ALREADY_SUBMITTED/);
  await f.login.detach();
  assert.equal(f.method.implementation, null);
});

test('business rejection remains a rejection after the original callback executes', async () => {
  const f = fixture({ code: -10 });
  await f.login.attach();
  assert.deepEqual(await f.login.login({ username: 'example', password: 'test' }), { authenticated: false, code: -10 });
  assert.equal(f.originalCalls(), 1);
  await f.login.detach();
});

test('observes a fresh real AuthInfo when the protected VM does not traverse the Java hook', async () => {
  const f = fixture({ automatic: false });
  f.publishAuth(); // A previous valid session must not satisfy the new submit.
  await f.login.attach();
  let resolved = false;
  const pending = f.login.login({ username: 'example', password: 'test' }).then(result => {
    resolved = true; return result;
  });
  await new Promise(resolve => setTimeout(resolve, 320));
  assert.equal(resolved, false);
  f.publishAuth(); // A distinct response object, matching the submitted account.
  assert.deepEqual(await pending, { authenticated: true, code: 0 });
  assert.equal(f.originalCalls(), 0);
  await f.login.detach();
});

test('does not write credentials until the original Activity handler is ready', async () => {
  const f = fixture({ ready: false });
  await f.login.attach();
  await assert.rejects(f.login.login({ username: 'example', password: 'test' }), /LOGIN_ACTIVITY_NOT_READY/);
  assert.deepEqual(f.calls, []);
  await f.login.detach();
});

test('callback cannot accept an unchanged old success and polling cannot accept another account', async () => {
  const f = fixture({ callbackPublishes: false });
  f.publishAuth();
  await f.login.attach();
  let resolved = false;
  const pending = f.login.login({ username: 'example', password: 'test' }).then(result => {
    resolved = true; return result;
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.originalCalls(), 1);
  assert.equal(resolved, false);
  f.publishAuth('different-account');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(resolved, false);
  f.publishAuth();
  assert.deepEqual(await pending, { authenticated: true, code: 0 });
  await f.login.detach();
});

test('rejects concurrent submits and detached pending results cannot become success', async () => {
  const f = fixture({ automatic: false });
  await f.login.attach();
  const pending = f.login.login({ username: 'example', password: 'test' });
  await assert.rejects(f.login.login({ username: 'example', password: 'test' }), /LOGIN_BUSY/);
  await f.login.detach();
  assert.deepEqual(await pending, { authenticated: false, error: 'LOGIN_AGENT_DETACHED' });
});

test('refuses an unsupported original APK version before instrumenting anything', async () => {
  const f = fixture({ version: 1203 });
  await assert.rejects(f.login.attach(), /LOGIN_UNSUPPORTED_VERSION/);
  assert.equal(f.method.implementation, null);
});

test('TV first-run setup uses the original order and recognizes themed dialog context', async () => {
  const f = fixture();
  await f.login.attach();
  assert.deepEqual(await f.login.setuptv(), { configured: true, deviceType: 'tv', loginFragmentReady: true });
  assert.deepEqual(f.calls, ['device:0', 'dismiss', 'initialize']);
  await assert.rejects(f.login.setuptv(), /LOGIN_DEVICE_ALREADY_CONFIGURED/);
  assert.equal(f.calls.length, 3);
  await f.login.detach();
});

test('TV setup refuses ambiguous dialogs or an existing device configuration without mutations', async () => {
  for (const options of [{ dialogCount: 0 }, { dialogCount: 2 }, { deviceType: 1 }]) {
    const f = fixture(options);
    await f.login.attach();
    await assert.rejects(f.login.setuptv(), /LOGIN_SETUP_DIALOG_UNAVAILABLE|LOGIN_DEVICE_ALREADY_CONFIGURED/);
    assert.deepEqual(f.calls, []);
    await f.login.detach();
  }
});

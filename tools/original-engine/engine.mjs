const CALLBACKS = ['onInfo', 'onInited', 'onPrepared', 'onQuit', 'onStart', 'onStop'];
const NUMERIC = ['auth', 'tvcore', 'extra_errno', 'errno', 'peers'];
const ID = /^[a-zA-Z0-9_-]{1,80}$/;

export function numericDiagnostics(value) {
  const result = {};
  for (const key of NUMERIC) {
    const v = value?.[key];
    if (typeof v !== 'number' && !(typeof v === 'string' && /^-?\d{1,12}$/.test(v))) continue;
    const n = Number(v);
    if (Number.isSafeInteger(n)) result[key] = n;
  }
  return result;
}

export function localPlaylist(value) {
  if (typeof value !== 'string') return null;
  // Fixed original playback port; no query, userinfo, traversal or arbitrary files.
  const match = /^http:\/\/127\.0\.0\.1:8902\/(\d{1,10})\/(main|index)\.m3u8$/.exec(value);
  if (!match || Number(match[1]) > 0xffffffff) return null;
  return { hls: value, channelId: Number(match[1]) };
}

function failure(code) { const e = new Error(code); e.code = code; return e; }
function step(code, action) { try { return action(); } catch { throw failure(code); } }

export function createOriginalEngine(Java, { idleObserverFactory } = {}) {
  let core, Core, listenerClass, hooked = false, closed = false;
  let ownCallDepth = 0, operation = null, ownedRequestId = null, phase = 'detached', lastCode = null;
  let diagnostics = {}, generation = 0, prepared = null;
  const callbackCounts = {}, callbackShapes = {};
  const hooks = [];
  let idleObserver = null;

  const status = () => ({
    attached: hooked && !closed, state: phase, requestId: operation?.id ?? ownedRequestId,
    generation, diagnostics: { ...diagnostics }, errorCode: lastCode,
    channelId: prepared?.channelId ?? null,
    identity: prepared ? 'serialized-start-callback' : null,
    callbackCounts: { ...callbackCounts }, callbackShapes: { ...callbackShapes },
    nativeState: idleObserver?.status() ?? null,
  });

  function discard(code, next = 'invalidated', revokeOwnership = false) {
    idleObserver?.cancel();
    prepared = null; phase = next; lastCode = code;
    if (revokeOwnership) ownedRequestId = null;
    const current = operation; operation = null;
    if (current?.timer) clearTimeout(current.timer);
    current?.reject?.(failure(code));
  }

  function javaTask(task) {
    return new Promise((resolve, reject) => {
      if (!Java.available) return reject(failure('JAVA_UNAVAILABLE'));
      Java.perform(() => {
        try { resolve(task()); }
        catch (e) { reject(failure(/^ARKHEN_|^[A-Z_]+$/.test(e?.code ?? '') ? e.code : 'JAVA_CALL_FAILED')); }
      });
    });
  }

  function callOwned(method, ...args) {
    ownCallDepth++;
    try { return method.call(core, ...args); }
    finally { ownCallDepth--; }
  }

  function stopped() {
    if (phase !== 'stopping' || !operation) return;
    const current = operation;
    idleObserver?.cancel(); clearTimeout(current.timer);
    operation = null; ownedRequestId = null; prepared = null; phase = 'idle';
    current.resolve({ stopped: true });
  }

  function observe(name, raw) {
    callbackCounts[name] = (callbackCounts[name] || 0) + 1;
    let body = {}, parsed, format = 'invalid-json';
    try {
      const value = raw === null ? '' : String(raw);
      if (value.length <= 65536) {
        parsed = JSON.parse(value);
        format = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
        if (format === 'object') body = parsed;
      } else format = 'oversize';
    } catch { /* Callback event identity remains valid even with an empty body. */ }
    const shape = { format, fields: Object.fromEntries(Object.entries(body)
      .filter(([key]) => /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(key)).slice(0, 32)
      .map(([key, value]) => [key, value === null ? 'null' : Array.isArray(value) ? 'array'
        : typeof value === 'string' && /^-?\d{1,12}$/.test(value) ? 'numeric-string' : typeof value])) };
    if (typeof parsed === 'number' && Number.isSafeInteger(parsed)) shape.scalarNumber = parsed;
    callbackShapes[name] = shape;
    const numbers = numericDiagnostics(body);
    diagnostics = { ...diagnostics, ...numbers };
    if (name === 'onQuit') { discard('ENGINE_QUIT', 'closed', true); return; }
    if (name === 'onStop') {
      if (phase === 'stopping' && operation) {
        stopped();
      } else if (phase === 'starting' || phase === 'playing') {
        discard(numbers.errno === -120 ? 'NATIVE_ENGINE_CERTIFICATION_REQUIRED' : 'ENGINE_STOPPED', 'idle', true);
      }
      return;
    }
    if (name === 'onStart' && phase === 'starting' && operation) {
      operation.started = true;
      return;
    }
    if (name !== 'onPrepared' || phase !== 'starting' || !operation?.started) return;
    // The original emits separate prepared events: direct TS becomes ready
    // first, then HLS. The fixed generic TS URL is not a channel identity and
    // is never exposed; keep waiting for the channel-bound HLS callback.
    if (!Object.hasOwn(body, 'hls') && body.http === 'http://127.0.0.1:8902/mpegts_live') return;
    const media = localPlaylist(body.hls);
    if (!media) { discard('LOCAL_HLS_UNAVAILABLE'); return; }
    // The stop callback is a fence before each request, and unsolicited Java
    // start/stop calls invalidate the ownership. This is callback association,
    // not independent attestation of the catalogue title.
    prepared = media; phase = 'playing'; lastCode = null;
    clearTimeout(operation.timer);
    operation.resolve({ requestId: operation.id, generation, ...media,
      identity: 'serialized-start-callback', diagnostics: { ...diagnostics } });
    operation.resolve = null; operation.reject = null; operation.timer = null;
  }

  function wrap(method, implementation) {
    const previous = method.implementation;
    if (previous) throw failure('METHOD_ALREADY_INSTRUMENTED');
    method.implementation = implementation;
    hooks.push({ method, previous });
  }

  async function attach() {
    if (closed) throw failure('AGENT_CLOSED');
    if (hooked) return status();
    await javaTask(() => {
      Core = step('ENGINE_CORE_CLASS_FAILED', () => Java.use('com.tvbus.engine.TVCore'));
      // Never initialize another engine or alter auth/session/listener settings.
      const instance = step('ENGINE_INSTANCE_FIELD_FAILED', () => Core.inst.value);
      const handle = step('ENGINE_HANDLE_FIELD_FAILED', () => Core.nativeHandle.value);
      if (!instance || String(handle) === '0') throw failure('ENGINE_NOT_INITIALIZED');
      core = step('ENGINE_RETAIN_FAILED', () => Java.retain(instance));
      const listener = step('LISTENER_FIELD_FAILED', () => core.tvListener.value);
      if (!listener) throw failure('LISTENER_UNAVAILABLE');
      const listenerObject = step('LISTENER_OBJECT_FAILED', () => Java.cast(listener, Java.use('java.lang.Object')));
      const listenerName = step('LISTENER_NAME_FAILED', () => listenerObject.getClass().getName().toString());
      listenerClass = step('LISTENER_CLASS_FAILED', () => Java.use(listenerName));
      try {
        if (idleObserverFactory) idleObserver = idleObserverFactory(String(handle), stopped,
          code => discard(code));
        for (const name of CALLBACKS) {
          const original = step('LISTENER_' + name.toUpperCase() + '_OVERLOAD_FAILED', () => listenerClass[name].overload('java.lang.String'));
          step('LISTENER_' + name.toUpperCase() + '_HOOK_FAILED', () => wrap(original, function (raw) {
            // Observe in a separate try block; always execute the original
            // listener and preserve its arguments, return value and exceptions.
            try { observe(name, raw); } catch { /* no raw data in diagnostics */ }
            return original.call(this, raw);
          }));
        }
        for (const signature of [['java.lang.String'], ['java.lang.String', 'java.lang.String']]) {
          const original = step('METHOD_START_OVERLOAD_FAILED', () => Core.start.overload(...signature));
          step('METHOD_START_HOOK_FAILED', () => wrap(original, function (...args) {
            if (!ownCallDepth) discard('EXTERNAL_CHANNEL_CHANGE', 'invalidated', true);
            return original.call(this, ...args);
          }));
        }
        for (const signature of [[], ['int']]) {
          const original = step('METHOD_STOP_OVERLOAD_FAILED', () => Core.stop.overload(...signature));
          step('METHOD_STOP_HOOK_FAILED', () => wrap(original, function (...args) {
            if (!ownCallDepth) discard('EXTERNAL_STOP', 'idle', true);
            return original.call(this, ...args);
          }));
        }
      } catch (e) {
        idleObserver?.close(); idleObserver = null;
        while (hooks.length) { const h = hooks.pop(); h.method.implementation = h.previous; }
        throw e;
      }
      hooked = true; phase = 'observing';
    });
    return status();
  }

  async function verifyAccount(expected) {
    if (!hooked || closed) throw failure('AGENT_NOT_ATTACHED');
    const normalize = value => {
      if (typeof value !== 'string' || value.length > 320) return null;
      const name = value.trim();
      if (!name || /[\x00-\x20\x7f]/.test(name)) return null;
      return name.includes('@') ? name : `${name}@wareztv.io`;
    };
    const wanted = normalize(expected);
    if (!wanted) throw failure('INVALID_ACCOUNT');
    return javaTask(() => {
      // td.m.d is the original authentication result. A saved login preference
      // could be an unsuccessful attempt, so it cannot establish account identity.
      // The obfuscated class has both d(String) and a field named d. Resolve
      // the exact declared field rather than Frida's ambiguous wrapper member.
      const field = step('ENGINE_ACCOUNT_FIELD_FAILED', () => Java.use('td.m').class.getDeclaredField('d'));
      const value = step('ENGINE_ACCOUNT_READ_FAILED', () => field.get(null));
      if (!value) return false;
      const auth = step('ENGINE_ACCOUNT_CAST_FAILED', () => Java.cast(value, Java.use('org.bitspark.android.beans.AuthInfo')));
      if (Number(auth.code.value) !== 0) return false;
      const user = auth.user.value;
      return !!user && normalize(String(user.user_name.value)) === wanted;
    });
  }

  function waitOperation(id, timeoutMs, run) {
    return new Promise((resolve, reject) => {
      operation = { id, resolve, reject, started: false, timer: setTimeout(() => {
        discard(phase === 'stopping' ? 'STOP_FENCE_TIMEOUT' : 'PLAYBACK_TIMEOUT');
      }, timeoutMs) };
      javaTask(run).catch(error => discard(error.code ?? 'JAVA_CALL_FAILED'));
    });
  }

  async function fence(id) {
    if (operation?.reject) throw failure('ENGINE_BUSY');
    prepared = null; phase = 'stopping'; lastCode = null;
    await waitOperation(id, 5000, () => {
      callOwned(Core.stop.overload());
      if (phase === 'stopping' && operation?.id === id) idleObserver?.arm();
    });
  }

  async function start(request) {
    if (!request || !ID.test(request.requestId ?? '') || typeof request.uri !== 'string'
      || !/^tvbus:\/\/[^\s\x00-\x1f]{1,8192}$/.test(request.uri)) throw failure('INVALID_START_REQUEST');
    if (!hooked || closed) throw failure('AGENT_NOT_ATTACHED');
    const timeoutMs = Math.max(1000, Math.min(60000, Number(request.timeoutMs) || 30000));
    await fence(request.requestId);
    ownedRequestId = request.requestId;
    generation++; diagnostics = {}; phase = 'starting';
    const result = await waitOperation(request.requestId, timeoutMs,
      () => callOwned(Core.start.overload('java.lang.String'), request.uri));
    return result;
  }

  async function stop(requestId) {
    if (!hooked || closed) throw failure('AGENT_NOT_ATTACHED');
    if (!ID.test(requestId ?? '') || requestId !== (operation?.id ?? ownedRequestId)) throw failure('REQUEST_NOT_OWNER');
    const id = requestId;
    if (operation?.reject) discard('PLAYBACK_CANCELLED');
    await fence(id);
    return status();
  }

  async function detach() {
    // Detach does not stop a playback started by the APK UI. The caller must
    // stop its own request before detaching when ownership is still valid.
    discard('AGENT_DETACHED', 'detached', true); closed = true;
    idleObserver?.close(); idleObserver = null;
    if (hooked) await javaTask(() => {
      while (hooks.length) { const h = hooks.pop(); h.method.implementation = h.previous; }
      core?.$dispose(); hooked = false;
    });
    return { detached: true };
  }

  return { attach, verifyAccount, status, start, stop, detach };
}

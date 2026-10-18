export const PROJECT_URL = 'https://wnicimkmzswksaqdtgdv.supabase.co';
const MAX_BYTES = 4 * 1024 * 1024, MAX_AGE_MS = 120000;
const HASH = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CIPHER = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const iso = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
const cipher = value => typeof value === 'string' && value.length <= MAX_BYTES && CIPHER.test(value);
const failure = (status, code) => Object.assign(new Error(code), {status, code});
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
}});

async function boundedBytes(message, limit) {
  const length = message.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw failure(413, 'GATEWAY_BODY_TOO_LARGE');
  if (!message.body) return new Uint8Array();
  const reader = message.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw failure(413, 'GATEWAY_BODY_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function adminKey(environment) {
  let key;
  try { key = JSON.parse(environment('SUPABASE_SECRET_KEYS') || 'null')?.default; } catch {}
  if (typeof key === 'string' && /^sb_secret_[A-Za-z0-9_-]{16,}$/.test(key)) return key;
  const legacy = environment('SUPABASE_SERVICE_ROLE_KEY');
  if (typeof legacy === 'string' && legacy.split('.').length === 3 && !/\s/.test(legacy)) {
    try {
      const payload = legacy.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      if (JSON.parse(atob(payload)).role === 'service_role') return legacy;
    } catch {}
  }
  throw failure(503, 'GATEWAY_NOT_CONFIGURED');
}

function operation(envelope) {
  if (!keys(envelope, ['rpc', 'args'])) throw failure(400, 'GATEWAY_OPERATION_REJECTED');
  const {rpc, args} = envelope;
  const common = ['p_session_hash', 'p_owner'];
  const allowed = {
    arkhen_runtime_session_acquire: [...common, 'p_create'],
    arkhen_runtime_session_renew: [...common, 'p_fence'],
    arkhen_runtime_session_commit: [...common, 'p_fence', 'p_revision', 'p_cipher', 'p_release', 'p_media_epoch'],
    arkhen_runtime_session_media: ['p_session_hash', 'p_media_epoch']
  };
  if (!Object.hasOwn(allowed, rpc) || !keys(args, allowed[rpc])
    || typeof args.p_session_hash !== 'string' || !HASH.test(args.p_session_hash)) throw failure(400, 'GATEWAY_ARGUMENTS_REJECTED');
  if (rpc === 'arkhen_runtime_session_media') {
    if (typeof args.p_media_epoch !== 'string' || !HASH.test(args.p_media_epoch)) throw failure(400, 'GATEWAY_ARGUMENTS_REJECTED');
    return {rpc, args};
  }
  if (typeof args.p_owner !== 'string' || !UUID.test(args.p_owner)) throw failure(400, 'GATEWAY_ARGUMENTS_REJECTED');
  if (rpc === 'arkhen_runtime_session_acquire') {
    if (args.p_create !== undefined && typeof args.p_create !== 'boolean') throw failure(400, 'GATEWAY_ARGUMENTS_REJECTED');
  } else if (!integer(args.p_fence, 1)) throw failure(400, 'GATEWAY_ARGUMENTS_REJECTED');
  if (rpc === 'arkhen_runtime_session_commit'
    && (!integer(args.p_revision) || (args.p_cipher !== undefined && args.p_cipher !== null && !cipher(args.p_cipher))
      || (args.p_release !== undefined && typeof args.p_release !== 'boolean')
      || (args.p_media_epoch !== undefined && args.p_media_epoch !== null
        && (typeof args.p_media_epoch !== 'string' || !HASH.test(args.p_media_epoch))))) throw failure(400, 'GATEWAY_ARGUMENTS_REJECTED');
  return {rpc, args};
}

function validResult(rpc, value) {
  if (rpc === 'arkhen_runtime_session_media') return keys(value, ['ok']) && typeof value.ok === 'boolean';
  if (rpc === 'arkhen_runtime_session_acquire') {
    if (keys(value, ['missing']) && value.missing === true) return true;
    if (keys(value, ['busy', 'retryAfterMs']) && value.busy === true && value.retryAfterMs === 250) return true;
    return keys(value, ['revision', 'fence', 'leaseUntil', 'expiresAt', 'cipher'])
      && integer(value.revision) && integer(value.fence, 1) && iso(value.leaseUntil) && iso(value.expiresAt)
      && (value.cipher === null || cipher(value.cipher));
  }
  if (keys(value, ['ok', 'conflict']) && value.ok === false && value.conflict === true) return true;
  if (rpc === 'arkhen_runtime_session_renew') return keys(value, ['ok', 'leaseUntil']) && value.ok === true && iso(value.leaseUntil);
  return keys(value, ['ok', 'revision', 'fence']) && value.ok === true && integer(value.revision) && integer(value.fence, 1);
}

/** Same server HMAC protocol as arkhen-backend. Nonces are bounded per isolate;
 * fencing/CAS prevents a replay from overwriting or releasing a newer lease.
 * @param {{environment?: (name: string) => string | undefined, fetch?: typeof globalThis.fetch,
 * now?: () => number, crypto?: Crypto, maxNonces?: number}} [options]
 */
export function createSessionGateway({environment = () => undefined, fetch: fetcher = (...args) => globalThis.fetch(...args),
  now = () => Date.now(), crypto: cryptography = globalThis.crypto, maxNonces = 10000} = {}) {
  const seen = new Map();
  return async request => {
    try {
      if (request.headers.has('origin')) throw failure(403, 'GATEWAY_BROWSER_FORBIDDEN');
      if (request.method !== 'POST') throw failure(405, 'GATEWAY_METHOD_REJECTED');
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') || '')) throw failure(415, 'GATEWAY_JSON_REQUIRED');
      const secret = environment('ARKHEN_BACKEND_SECRET');
      if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw failure(503, 'GATEWAY_NOT_CONFIGURED');
      const timestamp = request.headers.get('x-arkhen-timestamp') || '', nonce = request.headers.get('x-arkhen-nonce') || '', signature = request.headers.get('x-arkhen-signature') || '';
      if (!/^\d{13}$/.test(timestamp) || Math.abs(now() - Number(timestamp)) > MAX_AGE_MS
        || !/^[a-f0-9]{32}$/.test(nonce) || !HASH.test(signature)) throw failure(401, 'GATEWAY_SIGNATURE_INVALID');
      const bytes = await boundedBytes(request, MAX_BYTES), prefix = encoder.encode(`${timestamp}.${nonce}.`);
      const signed = new Uint8Array(prefix.byteLength + bytes.byteLength); signed.set(prefix); signed.set(bytes, prefix.byteLength);
      const key = await cryptography.subtle.importKey('raw', encoder.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['verify']);
      const signatureBytes = Uint8Array.from(signature.match(/../g), value => Number.parseInt(value, 16));
      if (!await cryptography.subtle.verify('HMAC', key, signatureBytes, signed)
        || Math.abs(now() - Number(timestamp)) > MAX_AGE_MS) throw failure(401, 'GATEWAY_SIGNATURE_INVALID');
      for (const [old, expires] of seen) if (expires < now()) seen.delete(old);
      if (seen.has(nonce)) throw failure(409, 'GATEWAY_REPLAY_REJECTED');
      if (seen.size >= maxNonces) throw failure(429, 'GATEWAY_CAPACITY_REACHED');
      seen.set(nonce, Number(timestamp) + MAX_AGE_MS);
      let envelope;
      try { envelope = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
      catch { throw failure(400, 'GATEWAY_JSON_INVALID'); }
      const {rpc, args} = operation(envelope), serviceKey = adminKey(environment);
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 7000); timer?.unref?.();
      let response, data;
      try {
        response = await fetcher(`${PROJECT_URL}/rest/v1/rpc/${rpc}`, {method: 'POST', redirect: 'error', signal: controller.signal,
          headers: {'Content-Type': 'application/json', apikey: serviceKey,
            ...(serviceKey.split('.').length === 3 ? {Authorization: `Bearer ${serviceKey}`} : {})}, body: JSON.stringify(args)});
        const raw = new TextDecoder('utf-8', {fatal: true}).decode(await boundedBytes(response, MAX_BYTES));
        if (raw.includes(serviceKey) || raw.includes(secret)) throw new Error('Invalid response');
        data = raw ? JSON.parse(raw) : null;
      } catch {
        throw failure(502, controller.signal.aborted ? 'GATEWAY_UPSTREAM_TIMEOUT' : response ? 'GATEWAY_RESPONSE_INVALID' : 'GATEWAY_UPSTREAM_UNAVAILABLE');
      } finally { clearTimeout(timer); }
      if (!response.ok) {
        const code = typeof data?.code === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(data.code) ? data.code : 'GATEWAY_UPSTREAM_REJECTED';
        return json({code}, response.status >= 400 && response.status <= 599 ? response.status : 502);
      }
      if (!validResult(rpc, data)) throw failure(502, 'GATEWAY_RESPONSE_INVALID');
      return json(data);
    } catch (error) {
      return json({code: /^GATEWAY_[A-Z_]{1,80}$/.test(error?.code || '') ? error.code : 'GATEWAY_REQUEST_FAILED'},
        Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500);
    }
  };
}

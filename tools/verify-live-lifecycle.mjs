// Exercise startup cancellation and two browser sessions without logging access data.
import { readWplayCredentials, safeCode } from './wplay-tool-input.mjs';

const credentials = await readWplayCredentials();
const base = 'http://127.0.0.1:4173';
const emit = value => console.log(JSON.stringify(value));
let cookie = '';
async function request(route, options = {}) {
  if (!route.startsWith('/api/')) throw Object.assign(new Error(), { code: 'INVALID_TEST_ROUTE' });
  return fetch(base + route, { ...options, headers: { Cookie: cookie, ...options.headers },
    signal: options.signal || AbortSignal.timeout(60000) });
}
async function login() {
  const response = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...credentials, provider: 'wplay' }) });
  cookie = response.headers.get('set-cookie')?.split(';')[0] || '';
  const result = await response.json();
  if (!response.ok || !result.connected) throw Object.assign(new Error(), { code: result.code || 'LOGIN_FAILED' });
}
async function logout() {
  if (cookie) {
    const response = await request('/api/logout', { method: 'POST', body: '{}' });
    if (!response.ok) throw Object.assign(new Error(), { code: 'LOGOUT_FAILED' });
  }
  cookie = '';
}
async function verifyMedia(item, session) {
  const started = Date.now();
  let route = `/api/play/live/${item.id}/index.m3u8`;
  for (let depth = 0; depth < 4; depth++) {
    const response = await request(route);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw Object.assign(new Error(), { code: data.code || 'MEDIA_HTTP_FAILED' });
    }
    if (/mpegurl/i.test(response.headers.get('content-type'))) {
      const manifest = await response.text();
      route = manifest.split(/\r?\n/).find(line => line && !line.startsWith('#'));
      if (!manifest.startsWith('#EXTM3U') || !route?.startsWith('/api/asset/')) throw Object.assign(new Error(), { code: 'INVALID_PLAYLIST' });
      continue;
    }
    const reader = response.body.getReader(), parts = [];
    let size = 0;
    try { while (size < 65536) { const { value, done } = await reader.read(); if (done) break; parts.push(value); size += value.length; } }
    finally { await reader.cancel(); }
    const bytes = Buffer.concat(parts);
    if (bytes[0] !== 0x47 || bytes[188] !== 0x47) throw Object.assign(new Error(), { code: 'INVALID_VIDEO_SEGMENT' });
    emit({ phase: 'media', session, channel: item.name, status: response.status, bytes: bytes.length, elapsedMs: Date.now() - started });
    return;
  }
  throw Object.assign(new Error(), { code: 'NO_MEDIA_SEGMENT' });
}
try {
  await login();
  const catalog = await (await request('/api/catalog?type=live')).json();
  const channels = [/^tv brasil(?:\s|$)/i, /^sbt(?:\s|$)/i].map(pattern => catalog.items?.find(item => pattern.test(item.name)));
  if (channels.some(item => !item)) throw Object.assign(new Error(), { code: 'TEST_CHANNEL_UNAVAILABLE' });
  // Warm the one control attachment so cancellation exercises native startup,
  // rather than only cancelling the initial Frida connection.
  await verifyMedia(channels[0], 'warmup');
  await request('/api/stop', { method: 'POST', body: '{}' });
  const controller = new AbortController();
  const pending = request(`/api/play/live/${channels[1].id}/index.m3u8`, { signal: controller.signal })
    .then(async response => { await response.body?.cancel(); return response.status; }, () => 'aborted');
  await new Promise(resolve => setTimeout(resolve, 150));
  controller.abort();
  const stopped = await request('/api/stop', { method: 'POST', body: '{}' });
  emit({ phase: 'cancelled-start', result: await pending, stopStatus: stopped.status });
  if (!stopped.ok) throw Object.assign(new Error(), { code: 'STOP_FAILED' });
  await verifyMedia(channels[1], 1);
  await logout();
  emit({ phase: 'logout', session: 1 });
  await login();
  await verifyMedia(channels[0], 2);
  await logout();
  emit({ phase: 'logout', session: 2 });
} catch (error) { emit({ phase: 'failed', code: safeCode(error) }); process.exitCode = 1; }
finally { await logout().catch(() => {}); credentials.username = ''; credentials.password = ''; cookie = ''; }

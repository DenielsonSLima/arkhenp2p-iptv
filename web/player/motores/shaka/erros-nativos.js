import {localMediaURL} from './erros.js';
import {localPlaybackMessage} from '../../../playback-api-error.js';

/** Native src= does not expose its HTTP status through Shaka's network filters.
 * Read the existing attempt's server diagnostic once; never probe/reopen media. */
export async function readNativePlaybackFailure(value, {signal, fetchRequest = globalThis.fetch} = {}) {
  const local = localMediaURL(value);
  if (!local || typeof fetchRequest !== 'function' || signal?.aborted) return null;
  const media = new URL(local);
  const route = /^\/api\/play\/(live|movie|series)\/(\d{1,12})(?:\/index\.m3u8|\.[a-z0-9]{2,6})$/.exec(media.pathname);
  const attempt = media.searchParams.get('attempt');
  if (!route || !/^[A-Za-z0-9_-]{1,100}$/.test(attempt || '')) return null;
  const params = new URLSearchParams({kind: route[1], id: route[2], attempt});
  const timeout = AbortSignal.timeout(1500);
  try {
    const response = await fetchRequest('/api/playback/status?' + params, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    if (!response.ok || signal?.aborted) return null;
    const text = await response.text();
    if (text.length > 16384 || signal?.aborted) return null;
    const failure = JSON.parse(text)?.failure;
    if (!failure || !Number.isInteger(failure.status) || ![401, 403, 404, 409, 429, 501, 502, 503, 504].includes(failure.status)) return null;
    const code = failure.status === 429 ? (route[1] === 'live' ? 'LIVE_RATE_LIMITED' : 'PLAYBACK_RATE_LIMITED')
      : localPlaybackMessage(failure.code) ? failure.code : null;
    if (!code && ![401, 403].includes(failure.status)) return null;
    return {status: failure.status, ...(code ? {code} : {}),
      ...(failure.status === 429 && Number.isFinite(failure.retryAfterSeconds) && failure.retryAfterSeconds > 0
        ? {retryAfterSeconds: failure.retryAfterSeconds} : {})};
  } catch { return null; }
}

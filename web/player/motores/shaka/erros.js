import {localPlaybackMessage} from '../../../playback-api-error.js';

const localBase = () => globalThis.location?.href || 'http://localhost/';
const route = /^\/api\/(?:play\/(?:live|movie|series)\/\d{1,12}(?:\/index\.m3u8|\.[a-z0-9]{2,6})|asset(?:\/[A-Za-z0-9_-]{1,100})?)$/;

export function localMediaURL(value) {
  try {
    const base = new URL(localBase()), url = new URL(value, base);
    return url.origin === base.origin && !url.username && !url.password && route.test(url.pathname) ? url.href : null;
  } catch { return null; }
}

function publicBody(value) {
  try {
    const parsed = typeof value === 'string' && value.length <= 16384 ? JSON.parse(value) : null;
    if (!parsed || !localPlaybackMessage(parsed.code)) return null;
    const body = {code: parsed.code};
    if (typeof parsed.retryAfterSeconds === 'number' && Number.isFinite(parsed.retryAfterSeconds) && parsed.retryAfterSeconds > 0) body.retryAfterSeconds = parsed.retryAfterSeconds;
    return body;
  } catch { return null; }
}

/** Shaka BAD_HTTP_STATUS documents [uri,status,text,headers,requestType].
 * Only local routes, known application codes and Retry-After reach the adapter.
 * Raw errors can contain upstream URLs and are deliberately not forwarded. */
export function hlsErrorFromShaka(error, {shaka, HlsClass, url, loaded = false} = {}) {
  const codes = shaka?.util?.Error?.Code || {}, categories = shaka?.util?.Error?.Category || {};
  const details = HlsClass.ErrorDetails, types = HlsClass.ErrorTypes;
  const data = Array.isArray(error?.data) ? error.data : [];
  const badHTTP = error?.code === codes.BAD_HTTP_STATUS;
  const stopFailure = error?.code === 'ENGINE_STOPPED';
  const status = stopFailure ? 409 : badHTTP && Number.isInteger(data[1]) && data[1] >= 400 && data[1] <= 599 ? data[1] : 0;
  const network = stopFailure || error?.category === categories.NETWORK;
  const local = localMediaURL(badHTTP ? data[0] : url) || localMediaURL(url);
  const body = stopFailure ? {code: 'ENGINE_STOPPED'} : badHTTP ? publicBody(data[2]) : null;
  const headers = {};
  if (badHTTP && data[3] && typeof data[3] === 'object') {
    for (const [key, value] of Object.entries(data[3])) if (key.toLowerCase() === 'retry-after' && typeof value === 'string' && value.length <= 128) headers['retry-after'] = value;
  }
  const requestType = badHTTP ? data[4] : undefined;
  const segment = requestType === shaka?.net?.NetworkingEngine?.RequestType?.SEGMENT;
  return {
    type: network ? types.NETWORK_ERROR : types.MEDIA_ERROR,
    details: network ? segment ? details.FRAG_LOAD_ERROR : loaded ? details.LEVEL_LOAD_ERROR : details.MANIFEST_LOAD_ERROR : details.BUFFER_APPEND_ERROR,
    fatal: error?.severity !== shaka?.util?.Error?.Severity?.RECOVERABLE || [401, 403, 409, 429].includes(status) || Boolean(body),
    url: local || '',
    response: {code: status, url: local || '', data: body ? JSON.stringify(body) : undefined, headers},
    networkDetails: {status, headers},
    error: new Error(network ? 'A transmissão não respondeu ao motor de reprodução.' : 'O motor não conseguiu processar esta transmissão.'),
    shakaCode: Number.isInteger(error?.code) ? error.code : null
  };
}

import { ProviderError } from './provider.mjs';
import { requestUpstream, readBody, validUpstreamURL } from './upstream.mjs';

const numericFields = ['auth', 'tvcore', 'extra_errno', 'errno', 'peers', 'initReturn', 'runReturn'];
const callbackEvents = ['inited', 'start', 'prepared', 'stop', 'quit', 'info'];
const fieldTypes = new Set(['object', 'array', 'number', 'boolean', 'null', 'string', 'numeric-string', 'other', 'invalid-json']);
function callbackShapes(value) {
  const result = {};
  for (const event of callbackEvents) {
    const shape = value?.[event];
    if (!shape || !fieldTypes.has(shape.format)) continue;
    result[event] = { format: shape.format, fields: Object.fromEntries(Object.entries(shape.fields || {}).filter(([key, type]) => /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(key) && fieldTypes.has(type)).slice(0, 32)) };
    if (Number.isSafeInteger(shape.scalarNumber)) result[event].scalarNumber = shape.scalarNumber;
  }
  return result;
}
const states = new Set(['awaiting_configuration', 'initializing', 'initialized', 'initialization_unknown', 'authentication_failed', 'initialization_failed', 'starting', 'prepared', 'stopped', 'playback_failed', 'closed', 'engine_error', 'control_error', 'configuration_missing']);
const failureStates = new Set(['authentication_failed', 'initialization_failed', 'playback_failed', 'engine_error', 'control_error', 'configuration_missing', 'closed']);
const error = (message, code = 'NATIVE_BRIDGE_UNAVAILABLE', status = 503) => new ProviderError(message, code, status);
const portNumber = value => Number.isInteger(value) && value >= 1024 && value <= 65535;
const abortError = () => error('A reprodução foi interrompida.', 'PLAYBACK_CANCELLED', 409);

// One local engine serves one playback at a time. The caller owns the session
// lease; credentials and the private control key never leave loopback here.
export class NativeBridgeClient {
  #key;
  #generation = 0;
  #prepared = null;
  #control;
  #mediaOrigin;
  constructor({ key, controlPort = 62731, playPort = 8902 } = {}) {
    if (typeof key !== 'string' || Buffer.byteLength(key) < 32 || Buffer.byteLength(key) > 256 || /[\x00-\x20\x7f]/.test(key)
      || !portNumber(controlPort) || !portNumber(playPort) || controlPort === playPort) {
      throw error('A ponte local P2P não está configurada.', 'NATIVE_BRIDGE_CONFIGURATION', 503);
    }
    this.#key = key;
    this.#control = `http://127.0.0.1:${controlPort}`;
    this.#mediaOrigin = `http://127.0.0.1:${playPort}`;
    this.playPort = playPort;
  }
  async #request(route, body, signal) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let response;
    try {
      response = await requestUpstream(this.#control + route, {
        allowPrivate: true, followRedirects: false, method: payload === undefined ? 'GET' : 'POST',
        timeout: 5000, signal, body: payload,
        headers: { 'X-Bridge-Key': this.#key, ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }) }
      });
      if (response.status !== 200) { response.body.destroy(); throw error('A ponte local P2P não aceitou a operação.'); }
      const data = JSON.parse((await readBody(response, 16384)).toString());
      const diagnostics = Object.fromEntries(numericFields.filter(field => Number.isSafeInteger(data.diagnostics?.[field])).map(field => [field, data.diagnostics[field]]));
      const shapes = callbackShapes(data.diagnostics?.callbackShapes);
      if (Object.keys(shapes).length) diagnostics.callbackShapes = shapes;
      if (typeof data.diagnostics?.errorClass === 'string' && /^[\w.$]{1,160}$/.test(data.diagnostics.errorClass)) diagnostics.errorClass = data.diagnostics.errorClass;
      return { state: states.has(data.state) ? data.state : 'initialization_unknown', diagnostics,
        preparedURL: this.#localPlaylist(data.playUrl), nativeLoaded: data.nativeLoaded === true };
    } catch (cause) {
      if (signal?.aborted) throw abortError();
      if (cause instanceof ProviderError) throw cause;
      throw error('Não foi possível conectar à ponte local P2P.');
    }
  }
  #localPlaylist(value) {
    if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f\\]/.test(value)) return null;
    try {
      const url = new URL(value);
      if (url.origin !== this.#mediaOrigin || url.username || url.password || url.hash || !/^\/\d+\/[^/]+\.m3u8$/.test(url.pathname)) return null;
      return url;
    } catch { return null; }
  }
  async status({ signal } = {}) {
    const result = await this.#request('/status', undefined, signal);
    // Public diagnostics deliberately omit engine-generated local paths.
    return { state: result.state, nativeLoaded: result.nativeLoaded, diagnostics: result.diagnostics, prepared: !!result.preparedURL };
  }
  async #wait(generation, desired, { signal, timeout = 20000 } = {}) {
    const deadline = Date.now() + Math.min(60000, Math.max(1000, timeout));
    while (Date.now() < deadline) {
      if (generation !== this.#generation || signal?.aborted) throw abortError();
      const state = await this.#request('/status', undefined, signal);
      if (generation !== this.#generation || signal?.aborted) throw abortError();
      if (failureStates.has(state.state)) {
        const errno = state.diagnostics.errno ?? state.diagnostics.auth ?? state.diagnostics.tvcore;
        if (state.diagnostics.errno === -120) {
          const account = state.diagnostics.auth === 0 ? 'Seu usuário e sua senha foram aceitos, mas a' : 'A';
          throw error(`${account} engine P2P não está autorizada para este aplicativo (código -120).`, 'NATIVE_ENGINE_CERTIFICATION_REQUIRED');
        }
        const detail = Number.isSafeInteger(errno) ? ` (código ${errno})` : '';
        throw error(`A engine P2P não conseguiu iniciar a reprodução${detail}.`, 'NATIVE_ENGINE_FAILED');
      }
      if (desired(state)) return state;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw error('O serviço P2P ainda não entregou o vídeo. Tente outro canal.', 'NATIVE_ENGINE_TIMEOUT', 504);
  }
  async configure({ authUrl, username, password, options } = {}, { signal, timeout = 15000 } = {}) {
    const auth = validUpstreamURL(authUrl).href;
    if (typeof username !== 'string' || !username || username.length > 200 || typeof password !== 'string' || !password || password.length > 200) {
      throw error('Os dados de configuração da engine são inválidos.', 'NATIVE_BRIDGE_CONFIGURATION', 400);
    }
    const generation = ++this.#generation;
    this.#prepared = null;
    // Only the observed optional DoH setting is accepted; no invented SDK values.
    const safeOptions = options?.doh_url ? { doh_url: validUpstreamURL(options.doh_url).href } : undefined;
    await this.#request('/configure', { engine: 'tvbus', authUrl: auth, username, password, playPort: this.playPort, ...(safeOptions ? { options: safeOptions } : {}) }, signal);
    await this.#wait(generation, status => status.state === 'initialized', { signal, timeout });
  }
  async start(uri, { signal, timeout = 25000 } = {}) {
    if (typeof uri !== 'string' || !uri.startsWith('tvbus://') || uri.length > 8192 || /[\x00-\x20\x7f]/.test(uri)) throw error('A fonte P2P recebida é inválida.', 'NATIVE_SOURCE_INVALID', 502);
    const generation = ++this.#generation;
    this.#prepared = null;
    await this.#request('/start', { uri }, signal);
    const result = await this.#wait(generation, status => status.state === 'prepared' && status.preparedURL, { signal, timeout });
    if (generation !== this.#generation || signal?.aborted) throw abortError();
    this.#prepared = result.preparedURL;
    return new URL(this.#prepared.href);
  }
  acceptsMediaURL(value) {
    if (!this.#prepared) return false;
    try {
      const url = new URL(value);
      const directory = this.#prepared.pathname.slice(0, this.#prepared.pathname.lastIndexOf('/') + 1);
      return url.origin === this.#mediaOrigin && !url.username && !url.password && !url.hash
        && url.pathname.startsWith(directory) && !/%(?:2f|5c|00)/i.test(url.pathname) && !url.pathname.includes('\\');
    } catch { return false; }
  }
  async fetchMedia(value, { method = 'GET', signal, timeout, range } = {}) {
    if (!this.acceptsMediaURL(value) || !['GET', 'HEAD'].includes(method) || (range && !/^bytes=\d*-\d*$/.test(range))) throw error('A fonte local não pertence à reprodução ativa.', 'NATIVE_SOURCE_INVALID', 400);
    // Control authentication must never be attached to HLS/segment requests.
    return requestUpstream(value, { allowPrivate: true, followRedirects: false, method, signal, timeout: timeout || 15000, headers: range ? { Range: range } : {} });
  }
  async stop() { ++this.#generation; this.#prepared = null; await this.#request('/stop', {}); }
  async close() { ++this.#generation; this.#prepared = null; await this.#request('/close', {}); }
}

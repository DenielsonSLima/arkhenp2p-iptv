import { randomUUID } from 'node:crypto';
import { ProviderError } from './provider.mjs';
import { requestUpstream } from './upstream.mjs';
import { OriginalEngineRPC } from './original-engine-rpc.mjs';

const error = (message, code, status = 503) => new ProviderError(message, code, status);
const cancelled = () => error('A reprodução foi interrompida.', 'PLAYBACK_CANCELLED', 409);
const invalid = () => error('A fonte local não pertence à reprodução ativa.', 'NATIVE_SOURCE_INVALID', 400);
const combine = (...signals) => AbortSignal.any(signals.filter(Boolean));
const numeric = value => Object.fromEntries(['auth', 'tvcore', 'extra_errno', 'errno', 'peers']
  .filter(key => Number.isSafeInteger(value?.[key])).map(key => [key, value[key]]));
const mediaPath = /^\/(\d{1,10})\/(?:main\.m3u8|index\.m3u8|cdn-dl-segment\.m3u8|hls-seg-\d+\.ts)$/;

// Optional NativeBridgeManager client. Attaches only to the intact original APK
// and its already authenticated account; no login or validation changes.
export class OriginalEngineBridge {
  #rpc = null; #factory; #origin; #configured = false; #username = null;
  #generation = 0; #prepared = null; #requestId = null; #lease = null; #poll = null;
  #sourceSignal = null; #sourceAbort = null;
  #nativeRequestId = null; #stopping = null;
  constructor({ mediaPort = 8904, rpcFactory, ...rpcOptions } = {}) {
    if (!Number.isInteger(mediaPort) || mediaPort < 1024 || mediaPort > 65535) throw invalid();
    this.#origin = 'http://127.0.0.1:' + mediaPort;
    this.#factory = rpcFactory || (() => new OriginalEngineRPC(rpcOptions));
  }
  #revoke() {
    this.#sourceSignal?.removeEventListener('abort', this.#sourceAbort);
    this.#sourceSignal = this.#sourceAbort = null;
    this.#generation++; this.#prepared = null; this.#requestId = null;
    clearTimeout(this.#poll); this.#poll = null; this.#lease?.abort(); this.#lease = null;
  }
  async configure({ username } = {}, { signal } = {}) {
    await this.close();
    if (typeof username !== 'string' || !username.trim() || username.length > 320 || /[\x00-\x20\x7f]/.test(username.trim())) throw error('A conta da engine é inválida.', 'NATIVE_BRIDGE_CONFIGURATION', 400);
    if (signal?.aborted) throw cancelled();
    if (this.#rpc?.closed) { await this.#rpc.close(); this.#rpc = null; }
    const rpc = this.#rpc || this.#factory(); this.#rpc = rpc;
    try {
      const attached = await rpc.ready({ signal });
      if (signal?.aborted) throw cancelled();
      if (!attached?.attached) throw error('Abra o aplicativo original e entre na sua conta.', 'ENGINE_NOT_INITIALIZED');
      if (await rpc.call('verifyAccount', { username }, { signal }) !== true) throw error('A conta ativa no aplicativo original é diferente da conta deste sistema.', 'NATIVE_ACCOUNT_MISMATCH', 409);
      this.#username = username; this.#configured = true;
    } catch (cause) { await this.close(); throw signal?.aborted ? cancelled() : cause; }
  }
  async #check(generation, signal) {
    if (generation !== this.#generation || !this.#prepared || signal?.aborted || !this.#rpc) throw cancelled();
    // These bounded read operations keep their protocol slot on cancellation;
    // the generation checks below suppress their result without killing the
    // control process during a routine channel switch.
    const status = await this.#rpc.call('status', {}, { timeout: 5000 });
    if (generation !== this.#generation || signal?.aborted) throw cancelled();
    if (!status?.attached || status.state !== 'playing' || status.requestId !== this.#requestId
      || status.channelId !== this.#prepared.channelId || status.identity !== 'serialized-start-callback') {
      this.#revoke(); throw error('O canal foi alterado no aplicativo original.', 'EXTERNAL_CHANNEL_CHANGE', 409);
    }
    if (await this.#rpc.call('verifyAccount', { username: this.#username }, { timeout: 5000 }) !== true) {
      this.#revoke(); this.#configured = false; throw error('A conta ativa no aplicativo original foi alterada.', 'NATIVE_ACCOUNT_MISMATCH', 409);
    }
    if (generation !== this.#generation || signal?.aborted) throw cancelled();
    return status;
  }
  #watch(generation) {
    this.#poll = setTimeout(async () => {
      try {
        await this.#check(generation, this.#lease?.signal);
        if (generation === this.#generation) this.#watch(generation);
      } catch { if (generation === this.#generation) this.#revoke(); }
    }, 1000);
    this.#poll.unref?.();
  }
  async start(uri, { signal, timeout = 30000 } = {}) {
    // Reattach only after an actual control-process failure. Routine channel
    // changes and logouts retain the engine and verify the account again.
    if (this.#rpc?.closed && this.#username) {
      const username = this.#username;
      await this.configure({ username }, { signal });
    }
    if (!this.#configured || !this.#rpc) throw error('Entre na mesma conta no aplicativo original.', 'ENGINE_NOT_INITIALIZED');
    if (typeof uri !== 'string' || !/^tvbus:\/\/[^\s\x00-\x1f\x7f]{1,8192}$/.test(uri)) throw invalid();
    this.#revoke(); const generation = this.#generation;
    const requestId = randomUUID(), rpc = this.#rpc;
    const lease = new AbortController(); this.#lease = lease;
    const activeSignal = combine(signal, lease.signal);
    try {
      if (await rpc.call('verifyAccount', { username: this.#username }, { signal: activeSignal }) !== true) throw error('A conta ativa no aplicativo original foi alterada.', 'NATIVE_ACCOUNT_MISMATCH', 409);
      this.#nativeRequestId = requestId;
      const result = await rpc.call('start', { requestId, uri, timeoutMs: timeout }, { signal: activeSignal, timeout: timeout + 7000 });
      if (generation !== this.#generation || activeSignal.aborted) throw cancelled();
      const match = typeof result?.hls === 'string' && /^http:\/\/127\.0\.0\.1:8902\/(\d{1,10})\/(main|index)\.m3u8$/.exec(result.hls);
      if (!match || +match[1] > 0xffffffff || result.requestId !== requestId || result.channelId !== +match[1] || result.identity !== 'serialized-start-callback') throw invalid();
      this.#requestId = requestId;
      this.#prepared = { channelId: +match[1], directory: '/' + match[1] + '/', url: new URL(result.hls.replace('http://127.0.0.1:8902', this.#origin)) };
      await this.#check(generation, activeSignal);
      if (signal) {
        this.#sourceSignal = signal;
        this.#sourceAbort = () => { void this.stop().catch(() => this.close()); };
        signal.addEventListener('abort', this.#sourceAbort, { once: true });
      }
      this.#watch(generation);
      return new URL(this.#prepared.url);
    } catch (cause) {
      if (generation === this.#generation) this.#revoke();
      throw signal?.aborted ? cancelled() : cause;
    }
  }
  acceptsMediaURL(value) {
    if (!this.#prepared || this.#lease?.signal.aborted) return false;
    const raw = String(value);
    if (/[\\%\x00-\x20\x7f]/.test(raw)) return false;
    try {
      const url = new URL(raw), match = mediaPath.exec(url.pathname);
      return !!match && url.origin === this.#origin && !url.username && !url.password && !url.search && !url.hash
        && url.pathname.startsWith(this.#prepared.directory);
    } catch { return false; }
  }
  async fetchMedia(value, { method = 'GET', signal, timeout = 15000, range } = {}) {
    if (!this.acceptsMediaURL(value) || !['GET', 'HEAD'].includes(method) || range && !/^bytes=\d*-\d*$/.test(range)) throw invalid();
    const generation = this.#generation, activeSignal = combine(signal, this.#lease.signal);
    await this.#check(generation, activeSignal);
    let response;
    try {
      response = await requestUpstream(value, { allowPrivate: true, followRedirects: false, method,
        signal: activeSignal, timeout, headers: range ? { Range: range } : {} });
      if (generation !== this.#generation || activeSignal.aborted) { response.body.destroy(); throw cancelled(); }
      if (response.status >= 300 && response.status < 400) { response.body.destroy(); throw invalid(); }
      return response;
    } catch (cause) {
      if (activeSignal.aborted) throw cancelled();
      if (cause instanceof ProviderError) throw cause;
      throw error('Não foi possível ler o vídeo da engine original.', 'NATIVE_MEDIA_UNAVAILABLE');
    }
  }
  async status({ signal } = {}) {
    if (!this.#rpc) return { state: 'closed', nativeLoaded: false, diagnostics: {}, prepared: false };
    const result = await this.#rpc.call('status', {}, { signal, timeout: 5000 });
    return { state: result?.state === 'playing' ? 'prepared' : result?.attached ? 'initialized' : 'closed',
      nativeLoaded: result?.attached === true, diagnostics: numeric(result?.diagnostics), prepared: !!this.#prepared };
  }
  async stop() {
    const id = this.#nativeRequestId, rpc = this.#rpc; this.#revoke();
    if (this.#stopping) return this.#stopping;
    this.#stopping = (async () => {
      if (rpc?.closed) await rpc.close();
      else if (id && rpc) {
        // This status follows any cancelled pending start in the RPC queue.
        // Ownership is retained even if no prepared callback reached the UI.
        const status = await rpc.call('status', {}, { timeout: 5000 });
        if (status?.requestId === id) await rpc.call('stop', { requestId: id }, { timeout: 7000 });
      }
      if (this.#nativeRequestId === id) this.#nativeRequestId = null;
    })();
    try { await this.#stopping; } finally { this.#stopping = null; }
  }
  async close() {
    this.#configured = false; this.#username = null;
    await this.stop();
  }
  async shutdown() {
    try { await this.close(); }
    finally {
      const rpc = this.#rpc; this.#rpc = null;
      if (rpc) await rpc.close();
    }
  }
}

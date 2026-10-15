import { WplayOTTProviderClient } from './wplay-ott-provider.mjs';
import { ProviderError, decodeText } from './provider.mjs';
import { requestUpstream, validUpstreamURL } from './upstream.mjs';

export const WPLAY_WEB_ORIGIN = 'https://player.wplayott.com';
const title = value => typeof value === 'string' ? value.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim() : '';
const cancelled = () => new ProviderError('A reprodução foi interrompida.', 'PLAYBACK_CANCELLED', 409);
const unavailable = () => new ProviderError('O player web WPLAY está indisponível no momento. Tente novamente.', 'WPLAY_WEB_UNAVAILABLE', 503);

/** Match complete provider labels, never an opaque ID fragment or partial title. */
export function resolveWplayWebLiveItem(item, client, catalog) {
  const wanted = title(item?.name), matches = [];
  if (item?.kind !== 'live' || !wanted) throw unavailable();
  for (const candidate of catalog?.items || []) {
    if (candidate?.kind !== 'live') continue;
    const raw = client.rawItems?.get(`live:${candidate.id}`);
    if (!raw || !['string', 'number'].includes(typeof raw.id)) continue;
    const baseMatches = title(decodeText(raw.title)) === wanted;
    if (!baseMatches && title(candidate.name) !== wanted) continue;
    let quality = '';
    // This is the existing OTT adapter's identity contract, not an association
    // between its opaque raw ID and a native WPLAY channel ID.
    for (const variant of Array.isArray(raw.liveVariants) ? raw.liveVariants : []) {
      const key = `item:live:${String(raw.id)}:quality:${String(variant?.quality ?? '')}`;
      if (client.identity(key) === String(candidate.id)) { quality = decodeText(variant?.quality); break; }
    }
    matches.push({ item: candidate, sourceId: String(raw.id), quality });
  }
  if (!matches.length) throw new ProviderError('Não encontramos este canal com o mesmo nome no player web WPLAY.', 'WPLAY_WEB_CHANNEL_NOT_FOUND', 404);
  if (new Set(matches.map(match => match.sourceId)).size !== 1) throw new ProviderError('O player web WPLAY retornou canais com nomes iguais. Não foi possível identificar este canal com segurança.', 'WPLAY_WEB_CHANNEL_AMBIGUOUS', 409);
  // The official watch view chooses HD, then its first supplied variant.
  return (matches.find(match => title(match.quality) === 'hd') || matches[0]).item;
}

/** A session-private live transport. It never supplies catalog/library IDs. */
export class WplayWebPlayback {
  #client = null; #current = null; #active = null; #queue = Promise.resolve();
  #closed = false; #username; #password; #createClient; #request; #startupTimeoutMs; #urls = new Set();
  constructor({ username, password } = {}, { createClient, request = requestUpstream, startupTimeoutMs = 40000 } = {}) {
    this.#username = String(username ?? '').trim(); this.#password = String(password ?? '').trim();
    this.#createClient = createClient || (config => new WplayOTTProviderClient(config)); this.#request = request;
    this.#startupTimeoutMs = Number.isFinite(startupTimeoutMs) && startupTimeoutMs > 0 ? Math.min(startupTimeoutMs, 40000) : 40000;
  }
  #enqueue(task) {
    const pending = this.#queue.then(task); this.#queue = pending.catch(() => {}); return pending;
  }
  get active() { return !!this.#active && !this.#closed; }
  owns(value) {
    try { return this.active && this.#urls.has(new URL(value).href); } catch { return false; }
  }
  #check(operation) {
    if (this.#closed || this.#current !== operation || operation.controller.signal.aborted) throw cancelled();
  }
  start(item, { signal } = {}) {
    if (this.#closed || signal?.aborted) return Promise.reject(cancelled());
    this.#current?.controller.abort();
    const operation = { controller: new AbortController() }; this.#current = operation;
    const abort = () => { if (this.#current === operation) void this.stop().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    return this.#enqueue(async () => {
      let selected = false;
      // Authentication and catalog loading share one startup budget. An old
      // selection cancels its HTTP requests so it cannot hold the next one.
      const deadline = setTimeout(() => { operation.timedOut = true; operation.controller.abort(); }, this.#startupTimeoutMs);
      deadline.unref?.();
      try {
        this.#check(operation);
        this.#client ||= this.#createClient({ server: WPLAY_WEB_ORIGIN, username: this.#username, password: this.#password });
        const client = this.#client;
        await client.connect({signal:operation.controller.signal}); this.#check(operation);
        const catalog = await client.catalog('live',{signal:operation.controller.signal}); this.#check(operation);
        const match = resolveWplayWebLiveItem(item, client, catalog);
        selected = true; operation.opening = true;
        const source = await client.playbackURL('live', match.id); this.#check(operation);
        const url = validUpstreamURL(source, client.allowPrivate === true);
        this.#urls.clear(); this.#urls.add(url.href); this.#active = operation;
        return url;
      } catch (error) {
        if (selected) await this.#client?.stopPlayback().catch(() => {});
        if (operation.timedOut && this.#current === operation && !this.#closed) throw new ProviderError('O player web WPLAY demorou para preparar este canal. Tente novamente.', 'WPLAY_WEB_START_TIMEOUT', 504);
        if (this.#closed || this.#current !== operation || operation.controller.signal.aborted || error?.code === 'PLAYBACK_CANCELLED') throw cancelled();
        if (['WPLAY_WEB_CHANNEL_NOT_FOUND', 'WPLAY_WEB_CHANNEL_AMBIGUOUS'].includes(error?.code)) throw error;
        if (error?.status === 401 || error?.code === 'AUTH_REJECTED') throw new ProviderError('O player web WPLAY não autorizou este acesso. Sua conexão principal foi preservada.', 'WPLAY_WEB_AUTH_REJECTED', 502);
        throw unavailable();
      } finally { clearTimeout(deadline); operation.opening = false; signal?.removeEventListener('abort', abort); }
    });
  }
  mediaURL(value) {
    if (!this.active) throw cancelled();
    const url = validUpstreamURL(value, this.#client.allowPrivate === true);
    this.#urls.add(url.href);
    // Retain bounded ownership evidence for manifests/segments, never globally.
    if (this.#urls.size > 20000) this.#urls.delete(this.#urls.values().next().value);
    return url.href;
  }
  upstreamHeaders(value) { return this.owns(value) ? this.#client.upstreamHeaders(value) : {}; }
  async upstreamRequest(value, options = {}) {
    const operation = this.#active;
    if (!operation || !this.owns(value)) throw cancelled();
    const range = options.headers?.Range ?? options.headers?.range;
    const headers = { ...this.#client.upstreamHeaders(value), ...(range ? { Range: range } : {}) };
    const signal = options.signal ? AbortSignal.any([options.signal, operation.controller.signal]) : operation.controller.signal;
    const response = await this.#request(value, { ...options, headers, signal, allowPrivate: this.#client.allowPrivate === true });
    if (this.#active !== operation || operation.controller.signal.aborted) { response.body?.destroy(); throw cancelled(); }
    // A redirected manifest may be reused by the main provider on its next poll.
    this.mediaURL(response.url || value); return response;
  }
  stop() {
    const mustDrain = !!this.#active || this.#current?.opening === true;
    this.#current?.controller.abort(); this.#current = null; this.#active = null; this.#urls.clear();
    const pending = this.#enqueue(async () => { await this.#client?.stopPlayback(); });
    // A pending login/catalog cannot start media after invalidation. VOD may
    // proceed immediately; close() still drains the reply before clearing it.
    return mustDrain ? pending : Promise.resolve();
  }
  close() {
    if (this.#closed) return this.#queue;
    this.#closed = true; this.#current?.controller.abort(); this.#current = null; this.#active = null; this.#urls.clear();
    this.#username = ''; this.#password = '';
    return this.#enqueue(async () => {
      const client = this.#client; if (!client) return;
      try { await client.logout(); }
      finally {
        // Runs after a pending login/catalog request, including a late reply.
        client.rpc?.cookieJar?.clear(); if (client.rpc) client.rpc.accessToken = null;
        client.refreshToken = null; client.session = null;
        if (client.config) { client.config.username = ''; client.config.password = ''; }
        client.cache?.clear(); client.rawItems?.clear(); client.episodes?.clear(); client.images?.clear();
        this.#client = null;
      }
    });
  }
}

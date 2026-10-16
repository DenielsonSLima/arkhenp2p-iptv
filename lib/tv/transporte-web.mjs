import { WplayOTTProviderClient } from '../wplay-ott-provider.mjs';
import { ProviderError } from '../provider.mjs';
import { requestUpstream, validUpstreamURL } from '../upstream.mjs';
import {liveSourceEntry,liveSourceCatalog,selectLiveSource,uniqueLiveSources} from './fontes.mjs';

import {resolveWplayWebLiveItems} from './resolver-web.mjs';
export {resolveWplayWebLiveItems,resolveWplayWebLiveItem} from './resolver-web.mjs';

export const WPLAY_WEB_ORIGIN = 'https://player.wplayott.com';
const cancelled = () => new ProviderError('A reprodução foi interrompida.', 'PLAYBACK_CANCELLED', 409);
const unavailable = () => new ProviderError('O player web WPLAY está indisponível no momento. Tente novamente.', 'WPLAY_WEB_UNAVAILABLE', 503);

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
  get active() { return !!this.#active && !this.#active.controller.signal.aborted && !this.#closed; }
  owns(value) {
    try { return this.active && this.#urls.has(new URL(value).href); } catch { return false; }
  }
  #check(operation) {
    if (this.#closed || this.#current !== operation || operation.controller.signal.aborted) throw cancelled();
  }
  #sourceEntries(item,client,catalog,nativeItem){
    return uniqueLiveSources(resolveWplayWebLiveItems(item,client,catalog,{nativeItem}).map(match=>{
      let address='';try{address=client.sourceURL(match.raw.playbackUrl).href;}catch{}
      return liveSourceEntry(item.id,{address,origin:'web',label:match.quality||match.item.name,quality:match.quality,
        metadata:match.metadata,available:!!address,key:match.sourceId,itemId:match.item.id});
    }));
  }
  sources(item,{signal,nativeItem}={}){
    if(this.#closed||signal?.aborted)return Promise.reject(cancelled());
    return this.#enqueue(async()=>{
      const controller=new AbortController(),abort=()=>controller.abort();let timedOut=false;
      const deadline=setTimeout(()=>{timedOut=true;controller.abort();},this.#startupTimeoutMs);
      const check=()=>{if(timedOut&&!this.#closed&&!signal?.aborted)throw new ProviderError('O player web WPLAY demorou para listar as fontes deste canal.','WPLAY_WEB_START_TIMEOUT',504);if(this.#closed||signal?.aborted||controller.signal.aborted)throw cancelled();};
      signal?.addEventListener('abort',abort,{once:true});deadline.unref?.();
      try{
        check();this.#client||=this.#createClient({server:WPLAY_WEB_ORIGIN,username:this.#username,password:this.#password});
        await this.#client.connect({signal:controller.signal});check();
        const catalog=await this.#client.catalog('live',{signal:controller.signal});check();
        return liveSourceCatalog(item.id,this.#sourceEntries(item,this.#client,catalog,nativeItem),this.#active?.sourceId);
      }catch(error){
        check();if(error?.status===401)throw new ProviderError('O player web WPLAY não autorizou este acesso. Sua conexão principal foi preservada.','WPLAY_WEB_AUTH_REJECTED',502);
        throw error;
      }finally{clearTimeout(deadline);signal?.removeEventListener('abort',abort);}
    });
  }
  start(item, { signal, nativeItem, sourceId } = {}) {
    if (this.#closed || signal?.aborted) return Promise.reject(cancelled());
    const previousMedia = !!this.#active || this.#current?.opening === true;
    this.#current?.controller.abort();
    this.#active = null; this.#urls.clear();
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
        if (previousMedia) { await this.#client?.stopPlayback(); this.#check(operation); }
        this.#client ||= this.#createClient({ server: WPLAY_WEB_ORIGIN, username: this.#username, password: this.#password });
        const client = this.#client;
        await client.connect({signal:operation.controller.signal}); this.#check(operation);
        const catalog = await client.catalog('live',{signal:operation.controller.signal}); this.#check(operation);
        const match = selectLiveSource(this.#sourceEntries(item,client,catalog,nativeItem),sourceId);
        if(!match)throw new ProviderError('O player WPLAY não disponibilizou uma fonte para este canal.','LIVE_SOURCE_UNAVAILABLE',503);
        selected = true; operation.opening = true;
        const source = await client.playbackURL('live', match.itemId, { signal: operation.controller.signal,exactVariant:true }); this.#check(operation);
        const url = validUpstreamURL(source, client.allowPrivate === true);
        this.#urls.clear(); this.#urls.add(url.href); operation.sourceId=match.descriptor.id;this.#active = operation;
        return url;
      } catch (error) {
        let cleanupError;
        if (selected && !['WPLAY_WEB_STOP_UNCONFIRMED', 'WPLAY_WEB_RATE_LIMITED'].includes(error?.code)) {
          try { await this.#client?.stopPlayback(); } catch (cause) { cleanupError = cause; }
        }
        if (operation.timedOut && this.#current === operation && !this.#closed) throw new ProviderError('O player web WPLAY demorou para preparar este canal. Tente novamente.', 'WPLAY_WEB_START_TIMEOUT', 504);
        if (this.#closed || this.#current !== operation || operation.controller.signal.aborted || error?.code === 'PLAYBACK_CANCELLED') throw cancelled();
        if (['WPLAY_WEB_STOP_UNCONFIRMED', 'WPLAY_WEB_RATE_LIMITED'].includes(cleanupError?.code)) throw cleanupError;
        if (['WPLAY_WEB_STOP_UNCONFIRMED', 'WPLAY_WEB_RATE_LIMITED'].includes(error?.code)) throw error;
        if (error?.status === 429) throw Object.assign(new ProviderError('O player web WPLAY pediu uma pausa antes de uma nova tentativa. Aguarde e tente novamente.', 'WPLAY_WEB_RATE_LIMITED', 429),{retryAfterSeconds:error.retryAfterSeconds||30});
        if (['WPLAY_WEB_CHANNEL_NOT_FOUND', 'WPLAY_WEB_CHANNEL_AMBIGUOUS','LIVE_SOURCE_INVALID','LIVE_SOURCE_CHANGED','LIVE_SOURCE_UNAVAILABLE'].includes(error?.code)) throw error;
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
    const mustDrain = !!this.#active || this.#current?.opening === true || !!this.#client?.liveStopTarget;
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

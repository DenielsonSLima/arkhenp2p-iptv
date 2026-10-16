import {withRequestSignals} from '../../request-signals.js';
import {homeTVReply, heartbeatReply, liveFilters} from './contrato.js';

/** Same-origin transport only; no SDK/Auth, playback URL, provider or ranking. */
export class HomeTVServices {
  constructor({request, timeoutMs = 6000} = {}) {
    this.request = request;
    this.timeoutMs = Number.isFinite(timeoutMs) ? Math.max(1000, Math.min(6000, timeoutMs)) : 6000;
  }

  async post(path, body, {signal, keepalive = false} = {}) {
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), this.timeoutMs);
    try {
      return await withRequestSignals([signal, deadline.signal], combined => this.request(path, {
        method: 'POST', body: JSON.stringify(body), signal: combined, ...(keepalive ? {keepalive: true} : {}),
      }));
    } catch (error) {
      if (deadline.signal.aborted && !signal?.aborted) throw Object.assign(new Error('A consulta dos canais demorou para responder.'),
        {code: 'HOME_TV_TIMEOUT', status: 504});
      throw error;
    } finally { clearTimeout(timer); }
  }

  async home(scope, options) {
    return homeTVReply(await this.post('/api/tv/home', liveFilters(scope), options));
  }

  async heartbeat({id, attempt, playing, scope}, options) {
    return heartbeatReply(await this.post('/api/tv/watch-heartbeat', {
      id, attempt, playing, ...liveFilters(scope),
    }, options));
  }
}

import {createLiveAttempt, supportsNativeHLS} from '../../live-playback-session.js';
import {PreparedLiveVideo} from '../../player/troca-canal/continuidade/preparacao.js';

const cancelled = () => new DOMException('A prévia do canal foi encerrada.', 'AbortError');
const scopeKey = value => {
  if (!value) return null;
  try { return typeof value === 'string' ? value : JSON.stringify(value); } catch { return null; }
};

/** A single silent decoder, sharing the application's authenticated transport.
 * The owner supplies STOP acknowledgement and gates every main-player opening
 * on pause(). No history, watch heartbeat, provider login or source rotation. */
export class HomeChannelPreview {
  constructor({playbackURL, beforeStart, stop, getConfig = () => ({}), readFailure,
    getScope = () => null, isActive = () => false, onState = () => {},
    environment = globalThis, HlsClass = environment.Hls} = {}) {
    Object.assign(this, {playbackURL, beforeStart, stopRemote: stop, getConfig, readFailure,
      getScope, isActive, onState, environment, HlsClass});
    this.document = environment.document;
    this.target = null;
    this.operation = null;
    this.failedStop = null;
    this.stopping = null;
    this.failedKey = null;
    this.suspended = false;
    this.destroyed = false;
    this.inViewport = false;
    this.resumeScheduled = false;
    this.cleanup = [];
    this.enabled = [playbackURL, beforeStart, stop].every(callback => typeof callback === 'function');
    this.observer = typeof environment.IntersectionObserver === 'function'
      ? new environment.IntersectionObserver(entries => {
        const entry = entries.find(value => value.target === this.target?.host);
        if (!entry) return;
        this.inViewport = entry.isIntersecting && entry.intersectionRatio >= .15;
        this.#reconcile();
      }, {threshold: [0, .15]}) : null;
    this.#listen(this.document, 'visibilitychange', () => {
      if (this.document.hidden) void this.pause('hidden', {suspend: false, retryStop: false}).catch(() => {});
      else this.#reconcile();
    });
    this.#listen(environment, 'pagehide', () => { void this.pause('pagehide').catch(() => {}); });
    if (!this.observer) {
      const update = () => { this.inViewport = this.#visible(); this.#reconcile(); };
      this.#listen(environment, 'scroll', update, {passive: true});
      this.#listen(environment, 'resize', update, {passive: true});
    }
  }

  #listen(target, event, listener, options, cleanup = this.cleanup) {
    target?.addEventListener?.(event, listener, options);
    cleanup.push(() => target?.removeEventListener?.(event, listener, options));
  }

  #visible() {
    const host = this.target?.host;
    if (!host?.isConnected) return false;
    const rect = host.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top <
      (this.environment.innerHeight || this.document?.documentElement?.clientHeight || 0);
  }

  #emit(state, error = null, target = this.target) {
    if (target !== this.target) return;
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
      ? error.code : null;
    this.onState({state, channelId: this.target?.item.id || null, code});
  }

  #eligible() {
    return this.enabled && !this.destroyed && !this.suspended && this.target
      && this.target.host.isConnected && this.inViewport && !this.document?.hidden
      && this.target.scope && this.target.scope === scopeKey(this.getScope()) && this.isActive();
  }

  #current(operation) {
    return this.operation === operation && !operation.controller.signal.aborted
      && this.target === operation.target && this.#eligible();
  }

  setTarget(video, item, {host = video} = {}) {
    const scope = scopeKey(this.getScope());
    const valid = video && host && item?.kind === 'live' && /^\d{1,12}$/.test(String(item.id));
    if (!valid && !this.target) return;
    if (valid && this.target?.video === video && String(this.target.item.id) === String(item.id)
      && this.target.scope === scope) {
      this.target.item = item;
      return;
    }
    void this.pause('target-changed', {suspend: false, retryStop: false}).catch(() => {});
    this.observer?.disconnect();
    this.target = valid ? {video, item, host, scope, key: `${scope}:${item.id}`} : null;
    this.failedKey = null;
    this.inViewport = this.#visible();
    if (this.target) this.observer?.observe(host);
    this.#emit('idle');
  }

  /** Called after reconciliation or an explicit return to Home. An error for
   * the same target is never converted into an automatic retry by rendering. */
  sync() {
    if (this.destroyed) return;
    this.suspended = false;
    if (!this.observer) this.inViewport = this.#visible();
    this.#reconcile();
  }

  #reconcile() {
    if (!this.#eligible()) {
      if (this.operation) void this.pause('inactive', {suspend: false, retryStop: false}).catch(() => {});
      return;
    }
    if (this.operation || this.failedKey === this.target.key) return;
    if (this.stopping) {
      if (!this.resumeScheduled) {
        this.resumeScheduled = true;
        void this.stopping.then(() => {
          this.resumeScheduled = false;
          this.#reconcile();
        }, () => { this.resumeScheduled = false; });
      }
      return;
    }
    if (this.failedStop) { this.#emit('blocked'); return; }
    void this.#start(this.target);
  }

  async #start(target) {
    const operation = {target, scope: target.scope, attempt: createLiveAttempt(),
      controller: new AbortController(), task: null, remoteStarted: false, cleanup: []};
    this.operation = operation;
    this.#emit('preparing');
    try {
      await this.beforeStart({signal: operation.controller.signal, attempt: operation.attempt, scope: operation.scope});
      if (!this.#current(operation)) throw cancelled();
      const url = this.playbackURL(target.item, {attempt: operation.attempt, purpose: 'preview'});
      operation.task = new PreparedLiveVideo({video: target.video, HlsClass: this.HlsClass,
        config: this.getConfig(), usingNativeHLS: supportsNativeHLS(target.video, this.environment.navigator),
        readFailure: typeof this.readFailure === 'function' ? options => this.readFailure(target.item, options) : undefined});
      operation.remoteStarted = true;
      const result = await operation.task.prepare({url, attempt: operation.attempt,
        signal: operation.controller.signal});
      if (!this.#current(operation)) {
        if (this.operation === operation) await this.pause('inactive', {suspend: false, retryStop: false});
        return;
      }
      if (result.autoplayBlocked || target.video.paused) {
        this.failedKey = target.key;
        await this.pause('autoplay-blocked', {suspend: false, retryStop: false});
        this.#emit('unavailable', null, target);
        return;
      }
      const failed = () => this.#failed(operation);
      this.#listen(target.video, 'error', failed, undefined, operation.cleanup);
      this.#listen(target.video, 'pause', failed, undefined, operation.cleanup);
      if (result.hls && this.HlsClass?.Events?.ERROR) {
        const onError = (_event, data) => {
          const status = Number(data?.response?.code ?? data?.networkDetails?.status);
          if (data?.fatal || [401, 403, 409, 429].includes(status)) this.#failed(operation);
        };
        result.hls.on(this.HlsClass.Events.ERROR, onError);
        operation.cleanup.push(() => result.hls.off(this.HlsClass.Events.ERROR, onError));
      }
      this.#emit('playing');
    } catch (error) {
      if (this.operation !== operation) return;
      this.failedKey = target.key;
      try { await this.pause('failure', {suspend: false, retryStop: false}); } catch { return; }
      this.#emit('unavailable', error, target);
    }
  }

  #failed(operation) {
    if (this.operation !== operation) return;
    this.failedKey = operation.target.key;
    void this.pause('failure', {suspend: false, retryStop: false}).then(() => this.#emit('unavailable', null, operation.target), () => {});
  }

  /** Local media is retired synchronously. The returned promise confirms the
   * remote STOP. A failed reference remains available to a later explicit call. */
  pause(reason = 'owner', {suspend = true, retryStop = true} = {}) {
    if (suspend) this.suspended = true;
    const operation = this.operation;
    this.operation = null;
    if (operation) {
      operation.controller.abort();
      for (const cleanup of operation.cleanup.splice(0)) cleanup();
      operation.task?.dispose();
      if (operation.remoteStarted) this.failedStop = operation;
      this.#emit('idle');
    }
    if (this.stopping) return this.stopping;
    const pending = this.failedStop;
    if (!pending) return Promise.resolve();
    // Logout/account replacement owns cleanup of its old backend session.
    // Never issue an old attempt's STOP against a newly authenticated account.
    if (pending.scope !== scopeKey(this.getScope())) {
      this.failedStop = null;
      return Promise.resolve();
    }
    if (!operation?.remoteStarted && !retryStop) return Promise.reject(pending.stopError || cancelled());
    const next = Promise.resolve().then(() => {
      if (pending.scope !== scopeKey(this.getScope())) return;
      return this.stopRemote({attempt: pending.attempt, scope: pending.scope, reason});
    }).then(() => {
      if (this.failedStop === pending) this.failedStop = null;
    }, error => {
      if (pending.scope !== scopeKey(this.getScope())) {
        if (this.failedStop === pending) this.failedStop = null;
        return;
      }
      pending.stopError = error;
      this.#emit('blocked', error);
      throw error;
    }).finally(() => { if (this.stopping === next) this.stopping = null; });
    this.stopping = next;
    return next;
  }

  dispose() {
    this.destroyed = true;
    this.observer?.disconnect();
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    return this.pause('dispose');
  }
}

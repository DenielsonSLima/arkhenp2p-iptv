import {tvScope, tvScopeKey} from '../../tv/scope.js';
import {isAdultItem} from '../../parental-classification.js';
import {HomeTVServices} from './services.js';
import {channelID} from './contrato.js';

/** Observe only the real player element. The server measures elapsed intervals;
 * the browser reports playing state, never positions, durations or watch time. */
export class TVWatchHeartbeat {
  constructor({video, getPlayer = () => null, getScope = () => null, request,
    onUpdate = () => {}, isAllowed = () => true, environment = globalThis} = {}) {
    Object.assign(this, {video, getPlayer, getScope, onUpdate, isAllowed, environment});
    this.document = environment.document;
    this.services = new HomeTVServices({request, timeoutMs: 6000});
    this.active = null;
    this.epoch = 0;
    this.timer = null;
    this.tail = Promise.resolve();
    this.mediaPlaying = false;
    this.resumeProbe = null;
    this.cleanup = [];
    this.destroyed = false;
    this.#listen(video, 'playing', () => {
      const player = this.getPlayer(), attempt = player?.attempt;
      // The application's existing listener may set mediaReady in this event.
      queueMicrotask(() => { if (attempt && this.getPlayer()?.attempt === attempt) this.confirmPlaying(); });
    });
    for (const event of ['pause', 'waiting', 'stalled', 'ended', 'error']) this.#listen(video, event, () => { void this.stop(); });
    this.#listen(this.document, 'visibilitychange', () => {
      if (this.document.hidden) void this.stop();
      else {
        const current = this.#player();
        if (current && Number.isFinite(video.currentTime)) this.resumeProbe = {
          attempt: current.attempt, scopeKey: current.scopeKey, position: video.currentTime,
        };
      }
    });
    this.#listen(video, 'timeupdate', () => {
      const probe = this.resumeProbe;
      if (!probe) return;
      const current = this.#player();
      if (!current || current.attempt !== probe.attempt || current.scopeKey !== probe.scopeKey) { this.resumeProbe = null; return; }
      if (!this.#frameReady(current)) return;
      if (video.currentTime > probe.position) {
        this.resumeProbe = null;
        this.confirmPlaying();
      } else if (video.currentTime < probe.position) probe.position = video.currentTime;
    });
    this.#listen(environment, 'pagehide', () => { void this.stop({keepalive: true}); });
  }

  #listen(target, name, callback, options) {
    target?.addEventListener?.(name, callback, options);
    this.cleanup.push(() => target?.removeEventListener?.(name, callback, options));
  }

  #player() {
    const player = this.getPlayer(), item = player?.item, id = channelID(item?.id);
    if (this.destroyed || item?.kind !== 'live' || !id || isAdultItem(item)
      || player.purpose === 'preview' || player.preview === true || player.playOptions?.purpose === 'preview'
      || typeof player.attempt !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(player.attempt)
      || !this.isAllowed(item, player)) return null;
    const scope = tvScope(this.getScope()), key = tvScopeKey(scope);
    return key ? {player, id, attempt: player.attempt, scope, scopeKey: key} : null;
  }

  #current(record) {
    const current = this.#player();
    return this.active === record && record.epoch === this.epoch && current
      && current.id === record.id && current.attempt === record.attempt && current.scopeKey === record.scopeKey;
  }

  #frameReady(current = this.#player()) {
    const video = this.video;
    return current && !this.document?.hidden && !video.paused && !video.ended && !video.error
      && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0
      && Number.isFinite(video.currentTime) && video.currentTime >= 0
      && (current.player.mediaReady || current.player.nativeSourceStarted || current.player.hlsReady === true);
  }

  #playing(record) {
    const current = this.#player(), video = this.video;
    return this.#current(record) && this.mediaPlaying && !this.document?.hidden
      && !video.paused && !video.ended && !video.error && video.readyState >= 2
      && (current.player.mediaReady || current.player.nativeSourceStarted || current.player.hlsReady === true);
  }

  #clearTimer() { clearTimeout(this.timer); this.timer = null; }

  #schedule(record) {
    this.#clearTimer();
    if (!this.#playing(record) || record.failed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.#playing(record)) { void this.stop(); return; }
      record.desired = true;
      void this.#pump(record, {pulse: true});
    }, 15000);
  }

  sync() {
    const current = this.#player();
    if (!current) { this.reset(); return; }
    let record = this.active;
    if (!record || record.id !== current.id || record.attempt !== current.attempt || record.scopeKey !== current.scopeKey) {
      this.#clearTimer();
      this.active?.controller?.abort();
      record = {...current, epoch: ++this.epoch, desired: false, lastSent: null, lastRevision: null,
        failed: false, pending: null, controller: null, keepalive: false, pauseRequired: false, recovering: false};
      this.active = record;
    }
    if (record.failed) return;
    const playing = this.#playing(record);
    record.desired = playing;
    if (!playing && record.lastSent === null && !record.pending) return;
    if (playing && record.lastSent === true && !record.pending && !record.pauseRequired) {
      if (this.timer === null) this.#schedule(record);
      return Promise.resolve();
    }
    return this.#pump(record);
  }

  /** The owner calls this after adopting a decoded, already-playing element;
   * promotion does not have to emit a second native `playing` event. */
  confirmPlaying() {
    if (!this.#frameReady()) return;
    this.mediaPlaying = true;
    this.resumeProbe = null;
    return this.sync();
  }

  #pump(record, {pulse = false} = {}) {
    if (record.pending) return record.pending;
    if (!this.#current(record) || record.failed || !pulse && !record.pauseRequired && record.lastSent === record.desired) return Promise.resolve();
    this.#clearTimer();
    const playing = record.pauseRequired ? false : record.desired, controller = new AbortController();
    let sent = false;
    record.controller = controller;
    const network = this.tail.catch(() => {}).then(async () => {
      if (!this.#current(record) || controller.signal.aborted || record.failed) return null;
      // A queued playing pulse cannot revive a waiting/hidden/stopped source.
      if (playing && (record.pauseRequired || !record.desired || !this.#playing(record))) {
        if (!this.#playing(record)) record.desired = false;
        if (record.lastSent === null) { record.lastSent = false; record.pauseRequired = false; }
        return null;
      }
      sent = true;
      return this.services.heartbeat({id: record.id, attempt: record.attempt, playing, scope: record.scope},
        {signal: controller.signal, keepalive: record.keepalive});
    });
    // Keep network serialization independent of transition-drain promises.
    this.tail = network.catch(() => {});
    const settled = network.then(value => {
      if (!this.#current(record)) return;
      if (value === null) {
        if (!sent && playing && record.lastSent === null && !record.desired) record.lastSent = false;
        return;
      }
      if (!value.accepted) {
        if (!playing && record.recovering && value.reason === 'session-not-started') {
          record.lastSent = false;
          record.pauseRequired = record.recovering = false;
          return;
        }
        record.failed = true;
        return;
      }
      record.lastSent = playing;
      if (!playing) record.pauseRequired = record.recovering = false;
      if (value.revision !== undefined && value.revision !== record.lastRevision) {
        record.lastRevision = value.revision;
        try { void Promise.resolve(this.onUpdate(value)).catch(() => {}); } catch { /* An observer cannot restart telemetry. */ }
      }
    }, () => { if (this.active === record) record.failed = true; }).then(() => {
      if (record.pending === settled) record.pending = null;
      if (!this.#current(record) || record.failed) return;
      if (record.pauseRequired || record.desired !== record.lastSent) return this.#pump(record);
      if (record.desired) this.#schedule(record);
    }).catch(() => { if (this.active === record) record.failed = true; });
    record.pending = settled;
    return settled;
  }

  stop({keepalive = false} = {}) {
    this.mediaPlaying = false;
    this.resumeProbe = null;
    this.#clearTimer();
    const record = this.active;
    if (!record || !this.#current(record)) return Promise.resolve();
    record.desired = false;
    record.pauseRequired ||= record.failed || record.lastSent === true || Boolean(record.pending);
    record.keepalive ||= keepalive;
    if (record.failed || record.lastSent === null && !record.pending) return Promise.resolve();
    return this.#pump(record);
  }

  /** Recovery waits for advancing media in this exact attempt/scope. A failed
   * pulse followed by pause retains its false barrier before any resumed true. */
  recover() {
    const current = this.#player();
    if (!current) return;
    this.#clearTimer();
    this.mediaPlaying = false;
    let record = this.active;
    if (!record || record.id !== current.id || record.attempt !== current.attempt || record.scopeKey !== current.scopeKey) {
      this.sync();
      record = this.active;
    }
    if (!record) return;
    if (record.failed) {
      record.failed = false;
      record.desired = false;
      record.pauseRequired = record.recovering = true;
    }
    if (this.#frameReady(current)) this.resumeProbe = {
      attempt: current.attempt, scopeKey: current.scopeKey, position: this.video.currentTime,
    };
    if (record.pauseRequired) return this.#pump(record);
  }

  reset() {
    this.epoch++;
    this.mediaPlaying = false;
    this.resumeProbe = null;
    this.#clearTimer();
    this.active?.controller?.abort();
    this.active = null;
  }

  dispose() {
    this.destroyed = true;
    this.reset();
    for (const cleanup of this.cleanup.splice(0)) cleanup();
  }
}

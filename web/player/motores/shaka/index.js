import {shakaConfiguration} from './configuracao.js';
import {readShakaTracks, audioIdentity, sameAudioCandidates} from './faixas.js';
import {hlsErrorFromShaka, localMediaURL} from './erros.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const cancelled = () => new DOMException('A abertura deste motor foi encerrada.', 'AbortError');
function settledBarrier(promises) {
  const barrier = Promise.allSettled(promises).then(results => {
    if (results.some(result => result.status === 'rejected')) {
      const error = new Error('O motor anterior não confirmou o encerramento da reprodução.');
      error.code = 'ENGINE_STOPPED'; error.status = 409; throw error;
    }
  });
  barrier.catch(() => {});
  return barrier;
}

/** Construct with the already loaded, locally vendored Shaka namespace and
 * real HLS.js enums. This module neither fetches a library nor opens a source. */
export function createShakaHlsClass({shaka, HlsClass} = {}) {
  if (!shaka?.Player || !HlsClass?.Events || !HlsClass?.ErrorTypes || !HlsClass?.ErrorDetails) throw new TypeError('Os motores de reprodução precisam estar disponíveis.');
  let retirement = Promise.resolve();
  const byMedia = new WeakMap();

  return class ShakaHlsAdapter {
    static Events = HlsClass.Events;
    static ErrorTypes = HlsClass.ErrorTypes;
    static ErrorDetails = HlsClass.ErrorDetails;
    static version = `shaka-${shaka.Player.version || 'local'}`;
    static supportsBufferedDrain = false;
    static supportsFragmentMetrics = false;
    static get whenStopped() { return retirement; }
    static isSupported() {
      try { return shaka.Player.isBrowserSupported() === true; } catch { return false; }
    }

    constructor(config = {}) {
      this.engine = 'shaka';
      this.supportsBufferedDrain = false;
      this.supportsFragmentMetrics = false;
      this.userConfig = {...config};
      this.config = new Proxy({...config}, {set: (target, key, value) => {
        target[key] = value; this._configure(); return true;
      }});
      this.media = null;
      this.url = '';
      this._listeners = new Map();
      this._operation = null;
      this._epoch = 0;
      this._destroyed = false;
      this._stopped = true;
      this._stopBarrier = Promise.resolve();
      this._manualVariant = null;
      this._startIndex = -1;
      this._subtitleVisible = false;
      this._subtitleId = null;
      this._tracks = {variants: [], active: null, levels: [], audioTracks: [], subtitleTracks: []};
    }

    on(event, callback, context) {
      if (typeof callback !== 'function' || this._destroyed) return this;
      let listeners = this._listeners.get(event);
      if (!listeners) this._listeners.set(event, listeners = new Set());
      listeners.add({callback, context}); return this;
    }
    off(event, callback, context) {
      const listeners = this._listeners.get(event);
      for (const entry of listeners || []) if (entry.callback === callback && (context === undefined || context === entry.context)) listeners.delete(entry);
      if (!listeners?.size) this._listeners.delete(event); return this;
    }
    once(event, callback, context) {
      const once = (name, data) => { this.off(event, once, context); callback.call(context || this, name, data); };
      return this.on(event, once, context);
    }
    _emit(event, data = {}) {
      const epoch = this._epoch;
      for (const {callback, context} of [...(this._listeners.get(event) || [])]) {
        if (event !== HlsClass.Events.DESTROYING && epoch !== this._epoch) break;
        try { callback.call(context || this, event, data); } catch { /* A visual consumer cannot revive a retired source. */ }
      }
    }
    _current(ticket) { return !this._destroyed && !this._stopped && this._operation === ticket && this._epoch === ticket.epoch; }
    get whenStopped() { return this._stopBarrier; }

    loadSource(value) {
      if (this._destroyed) return;
      const url = localMediaURL(value);
      if (!url) { this._localFailure(); return; }
      this.stopLoad(); this.url = url; this._stopped = false;
      this._tracks = {variants: [], active: null, levels: [], audioTracks: [], subtitleTracks: []};
      this._maybeStart();
    }
    attachMedia(value) {
      if (this._destroyed) return;
      const media = value?.media || value?.element || value;
      if (!media || typeof media.addEventListener !== 'function') { this._localFailure(); return; }
      if (this.media && this.media !== media) this.stopLoad();
      this.media = media;
      this._emit(HlsClass.Events.MEDIA_ATTACHED, {media});
      if (this.url && !this._operation) this._stopped = false;
      this._maybeStart();
    }
    detachMedia() {
      this.stopLoad(); this.media = null; this._emit(HlsClass.Events.MEDIA_DETACHED);
      return this.whenStopped;
    }

    _maybeStart(startTime) {
      if (this._destroyed || this._stopped || !this.media || !this.url || this._operation) return;
      const ticket = {epoch: ++this._epoch, media: this.media, url: this.url, player: null, listeners: [], loaded: false,
        reported: false, network: null, requestFilter: null, responseFilter: null, retired: false};
      this._operation = ticket;
      const barrier = settledBarrier([retirement, byMedia.get(ticket.media) || Promise.resolve(), this._stopBarrier]);
      ticket.startBarrier = barrier;
      const task = this._start(ticket, barrier, startTime);
      task.catch(() => {});
    }
    async _start(ticket, barrier, startTime) {
      try {
        await barrier;
        if (!this._current(ticket)) return;
        ticket.player = new shaka.Player();
        this._bind(ticket);
        await ticket.player.attach(ticket.media);
        if (!this._current(ticket)) return;
        this._configure(ticket);
        this._emit(HlsClass.Events.MANIFEST_LOADING, {url: ticket.url});
        if (!this._current(ticket)) return;
        // Shaka has no public parse-only equivalent of autoStartLoad:false.
        // load() must run to expose real tracks; callers already own STOP.
        const mime = new URL(ticket.url).pathname.endsWith('.m3u8') ? 'application/x-mpegurl' : undefined;
        await ticket.player.load(ticket.url, finite(startTime) && startTime >= 0 ? startTime : null, mime);
        if (!this._current(ticket)) return;
        ticket.loaded = true;
        this._refresh(ticket);
        if (!this._current(ticket)) return;
        this._configure(ticket);
        if (!this._current(ticket)) return;
        this._emit(HlsClass.Events.MANIFEST_PARSED, {levels: this.levels, audioTracks: this.audioTracks,
          subtitleTracks: this.subtitleTracks});
        if (!this._current(ticket)) return;
        this._applyVariant();
        this._applyText();
      } catch (error) {
        if (this._current(ticket) && error?.name !== 'AbortError') this._error(ticket, error);
      }
    }

    _bind(ticket) {
      const listen = (name, callback) => {
        const guarded = event => { if (this._current(ticket)) callback(event); };
        ticket.player.addEventListener(name, guarded);
        ticket.listeners.push(() => ticket.player.removeEventListener(name, guarded));
      };
      listen('error', event => this._error(ticket, event.detail));
      for (const name of ['trackschanged', 'audiotrackschanged']) listen(name, () => this._refresh(ticket));
      for (const name of ['adaptation', 'variantchanged', 'audiotrackchanged', 'mediaqualitychanged']) listen(name, () => this._refresh(ticket, {changed: true}));
      for (const name of ['textchanged', 'texttrackvisibility']) listen(name, () => {
        this._refresh(ticket);
        if (this._current(ticket)) this._emit(HlsClass.Events.SUBTITLE_TRACK_SWITCH, {id: this.subtitleTrack});
      });
      ticket.network = ticket.player.getNetworkingEngine?.();
      if (typeof ticket.network?.registerRequestFilter !== 'function' || typeof ticket.network?.registerResponseFilter !== 'function') throw new Error('O motor não disponibilizou as guardas do transporte local.');
      ticket.requestFilter = (_type, request) => {
        if (!this._current(ticket)) throw cancelled();
        if (!Array.isArray(request.uris) || !request.uris.length || request.uris.some(uri => !localMediaURL(uri))) throw new Error('A reprodução exige a rota local autenticada.');
      };
      ticket.responseFilter = (type, response, context) => {
        if (!this._current(ticket)) throw cancelled();
        if (response.uri && !localMediaURL(response.uri)) throw new Error('O recurso recebido não pertence ao transporte local.');
        if (type === shaka.net.NetworkingEngine.RequestType.SEGMENT && response.data?.byteLength > 0
          && context?.stream?.type !== 'text') ticket.mediaResponseObserved = true;
      };
      ticket.network?.registerRequestFilter(ticket.requestFilter);
      ticket.network?.registerResponseFilter(ticket.responseFilter);
    }
    _refresh(ticket, {changed = false} = {}) {
      if (!this._current(ticket)) return;
      const before = this.currentLevel, oldAudio = this.audioTrack;
      this._tracks = readShakaTracks(ticket.player);
      this._emit(HlsClass.Events.LEVELS_UPDATED, {levels: this.levels});
      if (!this._current(ticket)) return;
      this._emit(HlsClass.Events.AUDIO_TRACKS_UPDATED, {audioTracks: this.audioTracks});
      if (!this._current(ticket)) return;
      this._emit(HlsClass.Events.SUBTITLE_TRACKS_UPDATED, {subtitleTracks: this.subtitleTracks});
      if (!this._current(ticket)) return;
      if (changed || this.currentLevel !== before) this._emit(HlsClass.Events.LEVEL_SWITCHED, {level: this.currentLevel});
      if (!this._current(ticket)) return;
      if (changed || this.audioTrack !== oldAudio) this._emit(HlsClass.Events.AUDIO_TRACK_SWITCHED, {id: this.audioTrack});
    }
    _configure(ticket = this._operation) {
      if (!ticket?.player || !this._current(ticket)) return;
      try {
        const config = shakaConfiguration(this.config, {loaded: ticket.loaded, abrEnabled: this.autoLevelEnabled});
        const key = JSON.stringify(config);
        if (ticket.configKey === key) return;
        ticket.configKey = key;
        ticket.player.configure(config);
      }
      catch { this._localFailure(); }
    }
    _error(ticket, error) {
      if (!this._current(ticket)) return;
      const data = hlsErrorFromShaka(error, {shaka, HlsClass, url: ticket.url, loaded: ticket.loaded});
      if (data.fatal && ticket.reported) return;
      if (data.fatal) ticket.reported = true;
      this._emit(HlsClass.Events.ERROR, data);
    }
    _localFailure() {
      this._emit(HlsClass.Events.ERROR, {type: HlsClass.ErrorTypes.OTHER_ERROR,
        details: HlsClass.ErrorDetails.INTERNAL_EXCEPTION, fatal: true, error: new Error('O motor não pôde preparar esta reprodução local.')});
    }

    stopLoad() {
      this._stopped = true; this._epoch++;
      const ticket = this._operation; this._operation = null;
      if (!ticket || ticket.retired) return this.whenStopped;
      ticket.retired = true;
      for (const cleanup of ticket.listeners.splice(0)) { try { cleanup(); } catch {} }
      // Leave request guards installed until destroy resolves. Invalidating the
      // ticket synchronously prevents newly scheduled requests during teardown.
      let destroyed;
      try { destroyed = Promise.resolve(ticket.player?.destroy()); }
      catch (error) { destroyed = Promise.reject(error); }
      const closed = settledBarrier([ticket.startBarrier, destroyed]).finally(() => {
        try { ticket.network?.unregisterRequestFilter(ticket.requestFilter); } catch {}
        try { ticket.network?.unregisterResponseFilter(ticket.responseFilter); } catch {}
        ticket.player = ticket.network = null;
      });
      closed.catch(() => {});
      this._stopBarrier = settledBarrier([this._stopBarrier, closed]);
      this._stopBarrier.catch(() => {});
      retirement = settledBarrier([retirement, closed]);
      retirement.catch(() => {});
      byMedia.set(ticket.media, this._stopBarrier);
      return this.whenStopped;
    }
    startLoad(startPosition = -1) {
      if (this._destroyed) return;
      this._stopped = false;
      if (this._operation) {
        this._configure();
        if (this._operation.loaded) { try { this._operation.player.retryStreaming?.(0); } catch { this._localFailure(); } }
        return;
      }
      this._maybeStart(startPosition);
    }
    recoverMediaError() {
      const position = this.media?.currentTime;
      this.stopLoad(); this.startLoad(finite(position) ? position : -1);
    }
    destroy() {
      if (this._destroyed) return this.whenStopped;
      this._destroyed = true; this._emit(HlsClass.Events.DESTROYING);
      const stopped = this.stopLoad();
      this._listeners.clear(); this.media = null; this.userConfig = null;
      return stopped;
    }

    get levels() { return this._tracks.levels; }
    get currentLevel() { return this.levels.findIndex(level => level._shakaTrack.active); }
    set currentLevel(index) { this.loadLevel = index; }
    get firstLevel() { return this.levels.length ? 0 : -1; }
    get loadLevel() { return this._manualVariant === null ? -1 : this.levels.findIndex(level => level.id === this._manualVariant); }
    set loadLevel(index) {
      if (index === -1) { this._manualVariant = null; this._configure(); return; }
      if (!Number.isInteger(index) || !this.levels[index]) return;
      this._manualVariant = this.levels[index].id; this._configure(); this._applyVariant();
    }
    get nextLevel() { return this.loadLevel; }
    set nextLevel(index) { this.loadLevel = index; }
    get nextLoadLevel() { return this.loadLevel; }
    set nextLoadLevel(index) { this.loadLevel = index; }
    get startLevel() { return this._startIndex; }
    set startLevel(index) {
      if (!Number.isInteger(index) || index < -1) return;
      this._startIndex = index;
      if (this._operation?.loaded && this.levels[index]) this._select(this.levels[index]._shakaTrack);
    }
    get autoLevelEnabled() { return this._manualVariant === null; }
    get minAutoLevel() { return this.levels.length ? 0 : -1; }
    get maxAutoLevel() { return this.levels.length - 1; }
    _select(track) {
      const ticket = this._operation;
      if (!ticket?.loaded || !this._current(ticket)) return;
      try {
        if (ticket.player.getVariantTracks?.().some(value => value.active && value.id === track.id)) return;
        ticket.player.selectVariantTrack(track, false);
      }
      catch { this._localFailure(); }
    }
    _applyVariant() {
      const level = this._manualVariant === null ? this.levels[this._startIndex] : this.levels.find(value => value.id === this._manualVariant);
      if (level) this._select(level._shakaTrack);
    }
    get audioTracks() { return this._tracks.audioTracks; }
    get audioTrack() {
      const active = this._tracks.variants.find(track => track.active);
      return active ? this.audioTracks.findIndex(track => track.id === audioIdentity(active)) : -1;
    }
    set audioTrack(index) {
      const choice = this.audioTracks[index]?._shakaTrack, ticket = this._operation;
      if (!choice || !ticket?.loaded || !this._current(ticket)) return;
      const current = this._tracks.active;
      const candidates = sameAudioCandidates(this._tracks.variants, choice);
      const selected = candidates.find(track => current && track.videoId === current.videoId)
        || candidates.find(track => current && track.width === current.width && track.height === current.height) || candidates[0];
      if (!selected) return;
      try {
        ticket.player.configure({preferredAudio: [{language: selected.audioLanguage || selected.language || '',
          role: selected.audioRoles?.[0] || '', codec: selected.audioCodec || '',
          channelCount: finite(selected.channelsCount) ? selected.channelsCount : 0}]});
        if (!this.autoLevelEnabled) this._manualVariant = selected.id;
        this._select(selected);
      } catch { this._localFailure(); }
    }
    get subtitleTracks() { return this._tracks.subtitleTracks; }
    get subtitleTrack() {
      if (!this._subtitleVisible) return -1;
      const active = this.subtitleTracks.find(track => track._shakaTrack.active);
      return this.subtitleTracks.findIndex(track => track.id === (this._subtitleId ?? active?.id));
    }
    set subtitleTrack(index) {
      if (index === -1) { this._subtitleId = null; this.subtitleDisplay = false; return; }
      const choice = this.subtitleTracks[index];
      if (!choice) return; this._subtitleId = choice.id; this._applyText();
    }
    get subtitleDisplay() { return this._subtitleVisible; }
    set subtitleDisplay(value) { this._subtitleVisible = value === true; this._applyText(); }
    _applyText() {
      const ticket = this._operation;
      if (!ticket?.loaded || !this._current(ticket) || ticket.applyingText) return;
      try {
        // Shaka 5 manages visibility through selectTextTrack(track/null).
        // Read fresh tracks: the snapshot used by menus can lag textchanged.
        const tracks = ticket.player.getTextTracks();
        const choice = this._subtitleVisible ? tracks.find(track => track.id === this._subtitleId) : null;
        if (this._subtitleVisible && !choice) return;
        const active = tracks.find(track => track.active);
        if ((active?.id ?? null) === (choice?.id ?? null)) return;
        ticket.applyingText = true;
        ticket.player.selectTextTrack(choice || null);
      } catch { this._localFailure(); }
      finally { ticket.applyingText = false; }
    }

    get bandwidthEstimate() {
      try {
        if (!this._operation?.mediaResponseObserved) return NaN;
        const value = this._operation.player?.getStats()?.estimatedBandwidth;
        return finite(value) && value > 0 ? value : NaN;
      }
      catch { return NaN; }
    }
    get latency() {
      try {
        const player = this._operation?.player;
        if (!player?.isLive?.()) return NaN;
        const seconds = player.getStats()?.liveLatency;
        return finite(seconds) && seconds >= 0 ? seconds : NaN;
      } catch { return NaN; }
    }
    // Shaka exposes a seekable edge, not HLS.js's target synchronization point.
    // Returning null keeps profile controls from treating those as equivalent.
    get liveSyncPosition() { return null; }
  };
}

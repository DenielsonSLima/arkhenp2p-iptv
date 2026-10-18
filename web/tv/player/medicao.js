const finite = value => Number.isFinite(value) && value >= 0;
const milliseconds = value => finite(value) ? Math.round(value) : null;
const reasons = new Set(['repeated-stalls', 'manual-source', 'source-error', 'route', 'channel-navigation', 'opening', 'automatic', 'native-fallback']);
const errorTypes = new Set(['networkError', 'mediaError', 'muxError', 'keySystemError', 'otherError']);
const frameCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function frameCounters(video) {
  let decodedFrames = null, totalVideoFrames = null, droppedVideoFrames = null;
  try { decodedFrames = frameCount(video?.webkitDecodedFrameCount); } catch {}
  try {
    const quality = video?.getVideoPlaybackQuality?.();
    // Standard totalVideoFrames includes frames dropped before decoding, so
    // it must not be relabelled as the WebKit decoded-frame counter.
    totalVideoFrames = frameCount(quality?.totalVideoFrames);
    droppedVideoFrames = frameCount(quality?.droppedVideoFrames);
  } catch {}
  return {decodedFrames, totalVideoFrames, droppedVideoFrames};
}

/** Aggregate existing Resource Timing entries. URLs never leave this function.
 * Before-request time includes connection setup and scheduling; it cannot prove
 * connection-pool contention. Safari may expose no native media entries. */
export function summarizeTVResourceTiming(entries, {origin, startedAt = 0} = {}) {
  const samples = [];
  for (const entry of entries || []) {
    if (!finite(entry.startTime) || entry.startTime < startedAt) continue;
    let url;
    try { url = new URL(entry.name); } catch { continue; }
    if (url.origin !== origin || !/^\/api\/(?:play\/live\/|asset\/)/.test(url.pathname)) continue;
    if (!(entry.requestStart > 0 && entry.responseStart >= entry.requestStart && entry.responseEnd >= entry.responseStart)) continue;
    samples.push({
      beforeRequestMs: Math.max(0, entry.requestStart - entry.fetchStart),
      responseWaitMs: entry.responseStart - entry.requestStart,
      transferMs: entry.responseEnd - entry.responseStart
    });
    if (samples.length > 32) samples.shift();
  }
  const maximum = field => samples.length ? milliseconds(Math.max(...samples.map(sample => sample[field]).filter(finite))) : null;
  return {samples: samples.length, maxBeforeRequestMs: maximum('beforeRequestMs'), maxResponseWaitMs: maximum('responseWaitMs'), maxTransferMs: maximum('transferMs')};
}

function videoSnapshot(video) {
  let bufferSeconds = null;
  const position = Number(video?.currentTime);
  let visibilityState = null;
  try {
    const state = globalThis.document?.visibilityState;
    if (['visible', 'hidden', 'prerender', 'unloaded'].includes(state)) visibilityState = state;
  } catch {}
  try {
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= position + .15 && video.buffered.end(i) >= position) {
        bufferSeconds = Math.round(Math.max(0, video.buffered.end(i) - position) * 100) / 100;
        break;
      }
    }
    if (bufferSeconds === null) bufferSeconds = 0;
  } catch {}
  return {
    width: finite(video?.videoWidth) ? video.videoWidth : null,
    height: finite(video?.videoHeight) ? video.videoHeight : null,
    readyState: finite(video?.readyState) ? video.readyState : null,
    bufferSeconds,
    currentTime: finite(video?.currentTime) ? Math.round(video.currentTime * 1000) / 1000 : null,
    paused: typeof video?.paused === 'boolean' ? video.paused : null,
    seeking: typeof video?.seeking === 'boolean' ? video.seeking : null,
    networkState: Number.isInteger(video?.networkState) && video.networkState >= 0 && video.networkState <= 3 ? video.networkState : null,
    visibilityState,
    ...frameCounters(video)
  };
}

/** Per-opening measurements only. No network, storage, timer or media control.
 * `playing` measures browser readiness, not the first displayed video frame. */
export class TVPlaybackMeasurement {
  constructor({now = () => performance.now(), report = value => console.info('[arkhen.tv.playback]', value),
    resources = () => globalThis.performance?.getEntriesByType?.('resource') || [],
    origin = globalThis.location?.origin, reason = 'opening', prepared = false} = {}) {
    this.now = now; this.report = report; this.resources = resources; this.origin = origin;
    this.reason = reasons.has(reason) ? reason : 'opening'; this.prepared = prepared === true; this.awaitingUser = false;
    this.startedAt = now(); this.phases = {}; this.stalls = 0; this.waitMs = 0; this.waitStartedAt = null;
    this.firstPlayingAt = null; this.closed = false; this.engine = 'unknown';
  }
  mark(phase) {
    if (this.closed || !['preparation', 'sources', 'stopped', 'media'].includes(phase) || this.phases[phase] !== undefined) return;
    this.phases[phase] = this.now();
  }
  media(engine) {
    this.engine = ['native', 'hls', 'shaka'].includes(engine) ? engine : 'unknown';
    this.mark('media');
  }
  waitForUser() { this.awaitingUser = true; }
  recordError({type, detail, status} = {}) {
    const knownDetails = Object.values(globalThis.window?.Hls?.ErrorDetails || globalThis.Hls?.ErrorDetails || {});
    this.lastError = {type: errorTypes.has(type) ? type : 'otherError',
      detail: knownDetails.includes(detail) ? detail : 'unknownError',
      status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : null};
  }
  interrupt() {
    if (this.waitStartedAt === null) return;
    this.waitMs += Math.max(0, this.now() - this.waitStartedAt); this.waitStartedAt = null;
  }
  playing(video) {
    if (this.closed || !tvHasPlayableVideo(video)) return;
    this.interrupt();
    if (this.firstPlayingAt !== null) return;
    this.firstPlayingAt = this.now(); this.emit('first-playing', video);
  }
  waiting(video) {
    if (this.closed || this.firstPlayingAt === null || this.waitStartedAt !== null) return;
    this.waitStartedAt = this.now(); this.stalls++;
    if (this.stalls <= 4) this.emit('waiting', video);
  }
  snapshot(video) {
    const difference = (end, start) => finite(end) && finite(start) ? milliseconds(end - start) : null;
    return {
      reason: this.reason, engine: this.engine, prepared: this.prepared, awaitingUser: this.awaitingUser,
      startupMs: difference(this.firstPlayingAt, this.startedAt),
      sourcesMs: difference(this.phases.sources, this.phases.preparation),
      stopBarrierMs: difference(this.phases.stopped, this.phases.preparation),
      beforeMediaMs: difference(this.phases.media, this.startedAt),
      mediaToPlayingMs: difference(this.firstPlayingAt, this.phases.media),
      stalls: this.stalls, waitingMs: milliseconds(this.waitMs + (this.waitStartedAt === null ? 0 : Math.max(0, this.now() - this.waitStartedAt))),
      ...videoSnapshot(video)
    };
  }
  emit(event, video) {
    let timing = summarizeTVResourceTiming([], {});
    try { timing = summarizeTVResourceTiming(this.resources(), {origin: this.origin, startedAt: this.phases.media ?? this.now()}); } catch {}
    try {
      this.report({event, ...this.snapshot(video), resourceTiming: timing,
        ...(event === 'failed' ? {error: this.lastError || null} : {})});
    } catch { /* Diagnostics must never affect playback. */ }
  }
  close(video, {failed = false} = {}) {
    if (this.closed) return;
    this.interrupt(); this.closed = true; this.emit(failed ? 'failed' : 'closed', video);
  }
}
import {tvHasPlayableVideo} from './estado-media.js';


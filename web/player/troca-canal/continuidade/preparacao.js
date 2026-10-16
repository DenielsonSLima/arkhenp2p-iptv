import {localPlaybackMessage} from '../../../playback-api-error.js';

const preparingStates = new Set(['preparing', 'ready']);
const terminalHTTP = new Set([401, 403, 409, 429]);
const cancelled = () => new DOMException('A preparação deste canal foi encerrada.', 'AbortError');

function failure(message, code, status = 0) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function playbackAddress(value, attempt, sourceId) {
  const base = new URL(globalThis.location?.href || 'http://localhost/');
  let address;
  try { address = new URL(value, base); } catch {
    throw failure('O endereço local de reprodução é inválido.', 'LIVE_PREPARATION_URL_INVALID');
  }
  if (address.origin !== base.origin || address.username || address.password
    || !/^\/api\/play\/live\/\d{1,12}\/index\.m3u8$/.test(address.pathname)
    || attempt && address.searchParams.get('attempt') !== String(attempt)
    || sourceId && address.searchParams.get('sourceId') !== String(sourceId)) {
    throw failure('A preparação exige a rota local autenticada do canal.', 'LIVE_PREPARATION_URL_INVALID');
  }
  return address;
}

function responseStatus(data) {
  const value = Number(data?.response?.code ?? data?.networkDetails?.status);
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : 0;
}

function remoteFailure(value) {
  const status = Number(value?.status);
  const code = typeof value?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code)
    ? value.code : 'LIVE_PREPARATION_REMOTE_FAILURE';
  return failure(localPlaybackMessage(code)
    || (status === 401 || status === 403 ? 'Sua conexão precisa ser restabelecida para assistir a este canal.'
      : status === 409 ? 'Esta seleção de canal foi encerrada.'
        : 'O serviço não disponibilizou a transmissão escolhida.'),
  code, Number.isInteger(status) && status >= 400 && status <= 599 ? status : 0);
}

/** One silent target decoder. The owner must confirm STOP before prepare().
 * This module never selects a channel, stops another player or starts neighbours.
 * Readiness comes from the media element; it contains no EPG or progress policy. */
export class PreparedLiveVideo {
  constructor({video, HlsClass = null, config = {}, usingNativeHLS = false, engine = 'current', timeoutMs = 45000, readFailure} = {}) {
    if (!video || typeof video.addEventListener !== 'function' || typeof video.play !== 'function') {
      throw new TypeError('A preparação precisa de um elemento de vídeo.');
    }
    if (!['current', 'shaka'].includes(engine)) throw new TypeError('O motor de reprodução escolhido é inválido.');
    Object.assign(this, {video, HlsClass, config, readFailure, engine, usingNativeHLS: Boolean(usingNativeHLS)});
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 45000;
    this.state = 'idle';
    this.hls = null;
    this.result = null;
    this.error = null;
    this.cleanups = [];
    this.frame = null;
    this.frameFallback = null;
    this.deadline = null;
    this.playPending = false;
    this.transportGeneration = 0;
    this.nativeFallbackPending = false;
    this.nativeFallbackUsed = false;
    this.autoplayBlocked = false;
    this.resolve = null;
    this.reject = null;
    this.whenStopped = Promise.resolve();
    this.mediaRetiring = false;
  }

  prepare({url, attempt = '', sourceId = '', signal} = {}) {
    if (this.state !== 'idle') return Promise.reject(failure('Esta preparação já foi utilizada.', 'LIVE_PREPARATION_ALREADY_STARTED'));
    let address;
    try { address = playbackAddress(url, attempt, sourceId); } catch (error) { return Promise.reject(error); }
    if (signal?.aborted) return Promise.reject(cancelled());
    this.url = address.href;
    this.attempt = String(attempt || address.searchParams.get('attempt') || '');
    this.sourceId = String(sourceId || address.searchParams.get('sourceId') || '');
    this.signal = signal;
    this.state = 'preparing';

    const promise = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    try {
      // Empty a reusable standby before listening: its former frame is not
      // evidence that the newly selected channel is ready.
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.srcObject = null;
      this.video.load();
      this.video.muted = true;
      this.video.defaultMuted = true;
      this.video.autoplay = true;
      this.video.playsInline = true;
      this.video.preload = 'auto';
      this.video.controls = false;
      this.video.setAttribute('playsinline', '');
      this.video.setAttribute('webkit-playsinline', '');

      this.listen(this.video, 'error', () => {
        // load() clears MediaError; an already queued event from the retired
        // native pipeline is not a failure of its HLS replacement.
        if (this.video.error) this.mediaFailure(this.video.error.code);
      });
      for (const event of ['loadeddata', 'canplay', 'playing']) this.listen(this.video, event, () => this.checkReady());
      this.listen(this.video, 'loadedmetadata', () => this.requestPlay());
      if (signal) {
        this.listen(signal, 'abort', () => this.fail(cancelled()), {once: true});
        if (signal.aborted) { this.fail(cancelled()); return promise; }
      }
      this.deadline = setTimeout(() => this.fail(failure(
        'O canal escolhido demorou para preparar o vídeo.', 'LIVE_PREPARATION_TIMEOUT', 504
      )), this.timeoutMs);

      if (this.usingNativeHLS) {
        this.video.src = this.url;
        this.video.load();
        this.requestPlay();
      } else this.startHls();
    } catch {
      this.fail(failure('Não foi possível iniciar a preparação deste canal.', 'LIVE_PREPARATION_START_FAILED'));
    }
    return promise;
  }

  listen(target, event, callback, options) {
    target.addEventListener(event, callback, options);
    this.cleanups.push(() => target.removeEventListener(event, callback, options));
  }

  supportsHls() {
    try { return typeof this.HlsClass === 'function' && this.HlsClass.isSupported?.() === true; }
    catch { return false; }
  }

  startHls() {
    if (this.state !== 'preparing' || this.nativeFallbackPending) return;
    if (!this.supportsHls()) {
      this.fail(failure('Este navegador não disponibilizou o transporte de vídeo necessário.', 'LIVE_PREPARATION_UNSUPPORTED'));
      return;
    }
    this.hls = new this.HlsClass({...this.config, autoStartLoad: true});
    const onError = (_event, data) => {
      const status = responseStatus(data);
      if (data?.fatal || terminalHTTP.has(status)) this.fail(failure(
        status === 429 ? 'O provedor solicitou uma pausa antes de abrir este canal.' : 'Não foi possível preparar a transmissão escolhida.',
        'LIVE_PREPARATION_TRANSPORT_ERROR', status
      ));
    };
    const onManifest = () => this.requestPlay();
    this.hls.on(this.HlsClass.Events.ERROR, onError);
    this.hls.on(this.HlsClass.Events.MANIFEST_PARSED, onManifest);
    const hls = this.hls;
    this.cleanups.push(() => hls.off(this.HlsClass.Events.ERROR, onError),
      () => hls.off(this.HlsClass.Events.MANIFEST_PARSED, onManifest));
    this.hls.loadSource(this.url);
    if (this.state === 'preparing' && this.hls === hls) hls.attachMedia(this.video);
  }

  mediaFailure(mediaErrorCode) {
    if (!preparingStates.has(this.state) || this.nativeFallbackPending) return;
    const error = failure(mediaErrorCode === 3 ? 'O vídeo deste canal não pôde ser decodificado.'
      : 'Não foi possível preparar o vídeo deste canal.', 'LIVE_PREPARATION_MEDIA_ERROR');
    if (this.state !== 'preparing' || !this.usingNativeHLS || this.nativeFallbackUsed
      || ![3, 4].includes(mediaErrorCode) || !this.supportsHls() || typeof this.readFailure !== 'function') {
      this.fail(error); return;
    }
    this.nativeFallbackUsed = true;
    this.nativeFallbackPending = true;
    // Retire native play/frame callbacks while the authenticated status read
    // decides whether this is a decoder failure rather than a service refusal.
    this.transportGeneration++;
    this.playPending = false;
    this.clearFrameWaits();
    void this.tryNativeFallback(mediaErrorCode);
  }

  async tryNativeFallback(mediaErrorCode) {
    try {
      const reported = await this.readFailure({attempt: this.attempt, sourceId: this.sourceId,
        mediaErrorCode, signal: this.signal});
      if (this.state !== 'preparing' || !this.nativeFallbackPending || this.signal?.aborted) return;
      // Only a successful, explicit null means the server reported no failure.
      // Missing/ambiguous status and every reported refusal are conservative.
      if (reported !== null) {
        this.fail(reported && typeof reported === 'object' && !Array.isArray(reported)
          ? remoteFailure(reported)
          : failure('Não foi possível confirmar a disponibilidade deste canal.', 'LIVE_PREPARATION_STATUS_UNCONFIRMED'));
        return;
      }
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.srcObject = null;
      this.video.load();
      if (this.state !== 'preparing' || this.signal?.aborted) return;
      this.usingNativeHLS = false;
      this.nativeFallbackPending = false;
      this.startHls();
    } catch {
      if (this.state !== 'preparing') return;
      if (this.signal?.aborted) this.fail(cancelled());
      else this.fail(failure('Não foi possível confirmar a disponibilidade deste canal.', 'LIVE_PREPARATION_STATUS_UNCONFIRMED'));
    }
  }

  requestPlay() {
    if (this.state !== 'preparing' || this.nativeFallbackPending || this.playPending) return;
    const generation = this.transportGeneration;
    this.playPending = true;
    try {
      Promise.resolve(this.video.play()).then(() => {
        if (generation !== this.transportGeneration) return;
        this.playPending = false;
        this.checkReady();
      }, error => {
        if (generation !== this.transportGeneration) return;
        this.playPending = false;
        if (this.state !== 'preparing') return;
        if (error?.name === 'NotAllowedError') {
          this.autoplayBlocked = true;
          this.checkReady();
        } else if (error?.name === 'NotSupportedError' && this.usingNativeHLS) {
          this.mediaFailure(this.video.error?.code || 4);
        } else if (error?.name !== 'AbortError') {
          this.fail(failure('O vídeo escolhido não pôde iniciar.', 'LIVE_PREPARATION_PLAY_FAILED'));
        }
      });
    } catch (error) {
      this.playPending = false;
      if (error?.name === 'NotSupportedError' && this.usingNativeHLS) this.mediaFailure(this.video.error?.code || 4);
      else this.fail(failure('O vídeo escolhido não pôde iniciar.', 'LIVE_PREPARATION_PLAY_FAILED'));
    }
  }

  hasFrameData() {
    return !this.video.error && this.video.readyState >= 2 && this.video.videoWidth > 0 && this.video.videoHeight > 0;
  }

  checkReady() {
    if (this.state !== 'preparing' || this.nativeFallbackPending || !this.hasFrameData()) return;
    if (typeof this.video.requestVideoFrameCallback !== 'function') { this.ready('data'); return; }
    if (this.frame === null) {
      try {
        this.frame = this.video.requestVideoFrameCallback(() => {
          this.frame = null;
          if (this.state === 'preparing' && this.hasFrameData()) this.ready('frame');
        });
      } catch { this.ready('data'); return; }
    }
    // Occluded/hidden videos can have decoded data without presentation callbacks.
    // The fallback still requires HAVE_CURRENT_DATA and real video dimensions.
    if (this.frameFallback === null) this.frameFallback = setTimeout(() => {
      this.frameFallback = null;
      if (this.state === 'preparing' && this.hasFrameData()) this.ready('data');
    }, 200);
  }

  ready(readiness) {
    if (this.state !== 'preparing' || this.nativeFallbackPending || !this.hasFrameData()) return;
    this.state = 'ready';
    this.clearWaits();
    this.result = {video: this.video, hls: this.hls, usingNativeHLS: this.usingNativeHLS, engine: this.engine,
      attempt: this.attempt, sourceId: this.sourceId, url: this.url, readiness, autoplayBlocked: this.autoplayBlocked};
    const resolve = this.resolve;
    this.resolve = this.reject = null;
    resolve?.(this.result);
  }

  clearFrameWaits() {
    clearTimeout(this.frameFallback);
    this.frameFallback = null;
    if (this.frame !== null) {
      try { this.video.cancelVideoFrameCallback?.(this.frame); } catch { /* The video may already be detached. */ }
      this.frame = null;
    }
  }

  clearWaits() {
    clearTimeout(this.deadline);
    this.deadline = null;
    this.clearFrameWaits();
  }

  cleanup() {
    this.transportGeneration++;
    this.clearWaits();
    for (const cleanup of this.cleanups.splice(0)) {
      try { cleanup(); } catch { /* Ownership cleanup must finish for every reader. */ }
    }
  }

  clearMedia() {
    if (this.mediaRetiring) return this.whenStopped;
    this.mediaRetiring = true;
    const hls = this.hls, waiting = [];
    this.hls = null;
    try {
      const destroyed = hls?.destroy();
      if (destroyed && typeof destroyed.then === 'function') waiting.push(destroyed);
      if (hls?.whenStopped && typeof hls.whenStopped.then === 'function') waiting.push(hls.whenStopped);
    } catch (error) { waiting.push(Promise.reject(error)); }
    const clear = () => {
      try { this.video.pause(); this.video.removeAttribute('src'); this.video.srcObject = null; this.video.load(); }
      catch { /* The host can retire a detached standby. */ }
    };
    if (waiting.length) this.whenStopped = Promise.allSettled(waiting).then(results => {
      clear();
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    });
    else { clear(); this.whenStopped = Promise.resolve(); }
    // The owner awaits this same promise through its shared transport barrier.
    // Keep it handled when failure arrives before the owner releases the task.
    void this.whenStopped.catch(() => {});
    return this.whenStopped;
  }

  fail(error) {
    if (!preparingStates.has(this.state)) return;
    this.state = 'failed';
    this.error = error;
    const reject = this.reject;
    this.resolve = this.reject = null;
    this.cleanup();
    this.clearMedia();
    reject?.(error);
  }

  adopt() {
    if (this.state !== 'ready' || !this.hasFrameData()) throw this.error || failure('O canal escolhido ainda não está pronto.', 'LIVE_PREPARATION_NOT_READY');
    this.state = 'adopted';
    this.cleanup();
    return this.result;
  }

  dispose() {
    if (this.state === 'adopted' || this.state === 'disposed') return this.whenStopped;
    if (preparingStates.has(this.state)) this.fail(cancelled());
    else { this.cleanup(); this.clearMedia(); }
    this.state = 'disposed';
    return this.whenStopped;
  }
}

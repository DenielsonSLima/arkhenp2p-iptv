const captureOf = options => typeof options === 'boolean' ? options : Boolean(options?.capture);
const validVolume = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/** Two real elements, one stable control surface. A standby receives media only
 * through its real element; shared controls keep observing the visible slot
 * until the application confirms the target and calls promote(). This host
 * never opens a source, moves a MediaSource or owns the remote STOP sequence. */
export class LiveVideoHost {
  constructor({video, stage} = {}) {
    if (!video?.ownerDocument || typeof video.play !== 'function' || !stage?.insertBefore
      || video.parentElement !== stage) throw new TypeError('O vídeo deve pertencer à área de reprodução.');
    this.stage = stage;
    this.primary = video;
    this._active = video;
    this._slots = [video];
    this._listeners = new Set();
    this._methods = new Map();
    this._frameRequests = new Map();
    this._frameSerial = 0;
    this._canvas = null;
    this.destroyed = false;
    this._original = {
      id: video.getAttribute('id'), tabIndex: video.getAttribute('tabindex'),
      ariaHidden: video.getAttribute('aria-hidden'), className: video.className,
      slot: video.getAttribute('data-continuity-slot')
    };
    this._activeID = video.id || this._availableID('video');
    this._standbyID = this._availableID(`${this._activeID}-standby`);
    video.id = this._activeID;
    this._show(video, true);
    this.video = new Proxy(Object.create(null), {
      get: (_target, key) => this._get(key),
      set: (_target, key, value) => Reflect.set(this._active, key, value, this._active),
      has: (_target, key) => key === 'element' || key in this._active
    });
  }

  get element() { return this._active; }
  get visibleElement() { return this._active; }

  _availableID(base) {
    let id = base, suffix = 1;
    while (this.primary.ownerDocument.getElementById(id)) id = `${base}-${suffix++}`;
    return id;
  }

  _assertOpen() {
    if (this.destroyed) throw new DOMException('A área de reprodução foi encerrada.', 'InvalidStateError');
  }

  _get(key) {
    if (key === 'element') return this._active;
    if (key === 'addEventListener') return this._method(key, (...args) => this._listen(...args));
    if (key === 'removeEventListener') return this._method(key, (...args) => this._unlisten(...args));
    if (key === 'requestVideoFrameCallback') {
      if (typeof this._active.requestVideoFrameCallback !== 'function') return undefined;
      return this._method(key, callback => this._requestFrame(callback));
    }
    if (key === 'cancelVideoFrameCallback') {
      if (typeof this._active.cancelVideoFrameCallback !== 'function') return undefined;
      return this._method(key, id => this._cancelFrame(id));
    }
    const value = Reflect.get(this._active, key, this._active);
    if (typeof value !== 'function' || key === 'constructor') return value;
    // Resolve the receiver at invocation too, so a saved play/pause function
    // continues to address the active slot after promotion.
    return this._method(key, (...args) => {
      const element = this._active, method = Reflect.get(element, key, element);
      return Reflect.apply(method, element, args);
    });
  }

  _method(key, create) {
    if (!this._methods.has(key)) this._methods.set(key, create);
    return this._methods.get(key);
  }

  _listen(type, callback, options) {
    if (this.destroyed || callback == null) return;
    type = String(type);
    const capture = captureOf(options), signal = typeof options === 'object' ? options?.signal : null;
    if (signal?.aborted || [...this._listeners].some(record => record.type === type
      && record.callback === callback && record.capture === capture)) return;
    const record = {
      type, callback, capture, passive: Boolean(typeof options === 'object' && options?.passive),
      once: Boolean(typeof options === 'object' && options?.once), signal, element: null,
      abort: null, wrapper: null
    };
    record.wrapper = event => {
      const element = record.element;
      if (this.destroyed || !this._listeners.has(record) || element !== this._active
        || event.currentTarget !== element) return;
      if (record.once) this._remove(record);
      if (typeof callback === 'function') callback.call(element, event);
      else callback.handleEvent?.(event);
    };
    this._listeners.add(record);
    if (signal) {
      record.abort = () => this._remove(record);
      signal.addEventListener('abort', record.abort, {once: true});
    }
    this._bind(record, this._active);
  }

  _bind(record, element) {
    record.element = element;
    element.addEventListener(record.type, record.wrapper, {capture: record.capture, passive: record.passive});
  }

  _unbind(record) {
    record.element?.removeEventListener(record.type, record.wrapper, record.capture);
    record.element = null;
  }

  _remove(record) {
    this._unbind(record);
    this._listeners.delete(record);
    if (record.abort) record.signal?.removeEventListener('abort', record.abort);
  }

  _unlisten(type, callback, options) {
    const capture = captureOf(options);
    for (const record of this._listeners) if (record.type === String(type)
      && record.callback === callback && record.capture === capture) { this._remove(record); break; }
  }

  _requestFrame(callback) {
    this._assertOpen();
    const element = this._active, id = ++this._frameSerial;
    const request = {element, nativeID: null};
    this._frameRequests.set(id, request);
    try {
      request.nativeID = element.requestVideoFrameCallback((now, metadata) => {
        if (this._frameRequests.get(id) !== request) return;
        this._frameRequests.delete(id);
        if (!this.destroyed && this._active === element) callback.call(element, now, metadata);
      });
    } catch (error) { this._frameRequests.delete(id); throw error; }
    return id;
  }

  _cancelFrame(id) {
    const request = this._frameRequests.get(id);
    if (!request) return;
    this._frameRequests.delete(id);
    request.element.cancelVideoFrameCallback?.(request.nativeID);
  }

  _show(element, active) {
    element.classList.add('ip-continuity-video');
    element.dataset.continuitySlot = active ? 'active' : 'standby';
    element.setAttribute('aria-hidden', String(!active));
    if (!active) element.tabIndex = -1;
    else if (this._original.tabIndex === null) element.removeAttribute('tabindex');
    else element.setAttribute('tabindex', this._original.tabIndex);
  }

  standby() {
    this._assertOpen();
    let element = this._slots.find(slot => slot !== this._active);
    if (!element) {
      element = this.primary.ownerDocument.createElement('video');
      element.className = this._original.className;
      for (const name of ['playsinline', 'webkit-playsinline', 'crossorigin', 'disablepictureinpicture', 'disableremoteplayback']) {
        if (this.primary.hasAttribute(name)) element.setAttribute(name, this.primary.getAttribute(name));
      }
      element.playsInline = true;
      element.preload = 'auto';
      element.controls = false;
      element.id = this._standbyID;
      this._slots.push(element);
      this.stage.insertBefore(element, this.primary.nextSibling);
    }
    this.clear(element);
    return element;
  }

  promote(target, {muted, volume} = {}) {
    this._assertOpen();
    if (!this._slots.includes(target)) throw new TypeError('O vídeo não pertence a esta área de reprodução.');
    if (target === this._active) return null;
    const previous = this._active;
    const selectedMuted = typeof muted === 'boolean' ? muted : previous.muted;
    const selectedVolume = validVolume(volume) ? volume : previous.volume;
    for (const record of this._listeners) this._unbind(record);
    for (const id of [...this._frameRequests.keys()]) this._cancelFrame(id);
    // Muting first also makes callers which do not use WebAudio safe from an
    // overlap. The application may promote muted while it transfers its graph.
    previous.muted = true;
    target.muted = true;
    this._active = target;
    target.removeAttribute('id');
    previous.id = this._standbyID;
    target.id = this._activeID;
    this._show(previous, false);
    this._show(target, true);
    for (const record of this._listeners) this._bind(record, target);
    if (validVolume(selectedVolume)) target.volume = selectedVolume;
    target.muted = selectedMuted;
    this.releaseFrame();
    // The application still owns the previous HLS instance and its release.
    return previous;
  }

  clear(element = this._active) {
    if (!this._slots.includes(element)) return false;
    for (const [id, request] of this._frameRequests) if (request.element === element) this._cancelFrame(id);
    try { element.pause(); } catch {}
    try { element.removeAttribute('src'); } catch {}
    try { if ('srcObject' in element) element.srcObject = null; } catch {}
    try { element.load(); } catch {}
    if (element !== this._active) { element.muted = true; this._show(element, false); }
    else this.releaseFrame();
    return true;
  }

  resetStandby() {
    for (const element of this._slots) if (element !== this._active) this.clear(element);
  }

  /** Capture a fallback without interrupting or covering the running video.
   * Replace a previous snapshot only after a new drawing has succeeded. */
  captureFrame() {
    if (this.destroyed || this._active.error || this._active.readyState < 2
      || !(this._active.videoWidth > 0 && this._active.videoHeight > 0)) return false;
    try {
      const canvas = this.primary.ownerDocument.createElement('canvas');
      canvas.className = 'ip-continuity-frame';
      canvas.setAttribute('aria-hidden', 'true');
      canvas.dataset.visible = 'false';
      canvas.width = this._active.videoWidth;
      canvas.height = this._active.videoHeight;
      const context = canvas.getContext('2d');
      if (!context) return false;
      context.drawImage(this._active, 0, 0, canvas.width, canvas.height);
      this.stage.insertBefore(canvas, this.primary.nextSibling);
      this._canvas?.remove();
      this._canvas = canvas;
      return true;
    } catch { return false; }
  }

  /** Called only when the old buffer stalls or ends. A failed fresh capture
   * keeps the snapshot taken before STOP instead of replacing it with black. */
  holdFrame() {
    if (this.destroyed) return false;
    this.captureFrame();
    if (!this._canvas?.width || !this._canvas.height) return false;
    this._canvas.dataset.visible = 'true';
    return true;
  }

  releaseFrame() {
    if (!this._canvas) return;
    this._canvas.dataset.visible = 'false';
    this._canvas.width = 0;
    this._canvas.height = 0;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const record of [...this._listeners]) this._remove(record);
    for (const id of [...this._frameRequests.keys()]) this._cancelFrame(id);
    for (const element of this._slots) this.clear(element);
    for (const element of this._slots) if (element !== this.primary) element.remove();
    this._canvas?.remove();
    this._canvas = null;
    this._active = this.primary;
    this._slots = [this.primary];
    this.primary.className = this._original.className;
    for (const [attribute, value] of [['id', this._original.id], ['tabindex', this._original.tabIndex],
      ['aria-hidden', this._original.ariaHidden], ['data-continuity-slot', this._original.slot]]) {
      if (value === null) this.primary.removeAttribute(attribute);
      else this.primary.setAttribute(attribute, value);
    }
    this._methods.clear();
  }
}

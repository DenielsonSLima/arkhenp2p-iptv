const STORAGE_KEY = 'arkhen.audio-processing.v1';
const instances = new WeakMap();
const modes = new Set(['original', 'balanced', 'night']);
const dbGain = db => 10 ** (db / 20);
const memoryStorage = () => {try {return globalThis.localStorage;} catch {return null;}};

export const AUDIO_PRESETS = Object.freeze({
  balanced:Object.freeze({threshold:-18, ratio:4, knee:0, attack:.003, release:.25}),
  night:Object.freeze({threshold:-28, ratio:8, knee:0, attack:.0015, release:.35})
});
export const AUDIO_LIMITER = Object.freeze({threshold:-3, ratio:20, knee:0, attack:0, release:.08});

// Web Audio adds fixed makeup gain internally. With a hard knee its inverse is
// deterministic: cancel that boost instead of amplifying quiet programmes.
// https://webaudio.github.io/web-audio-api/#DynamicsCompressorNode
export function compressorCompensation({threshold, ratio, knee = 0}) {
  if (!Number.isFinite(threshold) || threshold > 0 || !Number.isFinite(ratio) || ratio < 1 || knee !== 0) throw new RangeError('Perfil de compressão inválido.');
  return dbGain(threshold * (1 - 1 / ratio) * .6);
}

export function webKitAudioRoutingUnsafe(userAgent = '', maxTouchPoints = 0) {
  return /iPhone|iPad|iPod/i.test(userAgent) || /Macintosh/i.test(userAgent) && maxTouchPoints > 1
    || /AppleWebKit/i.test(userAgent) && !/Chrome\/|Chromium\/|Edg\/|OPR\//i.test(userAgent);
}

export function isLocalAudioSource(value, baseURL) {
  if (!value) return false;
  try {
    const base = new URL(baseURL), source = new URL(value,base);
    return ['http:','https:','blob:'].includes(source.protocol) && source.origin === base.origin;
  } catch {return false;}
}

/** One graph for the lifetime of one video element. Never close its context. */
export class AudioProcessing {
  constructor(video, {
    storage = memoryStorage(), AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext,
    baseURL = globalThis.location?.href || 'http://localhost/',
    userAgent = globalThis.navigator?.userAgent || '', maxTouchPoints = globalThis.navigator?.maxTouchPoints || 0,
    isUserGesture = () => globalThis.navigator?.userActivation?.isActive === true, activationTimeoutMs = 2000, onStatus
  } = {}) {
    if (!video || typeof video !== 'object') throw new TypeError('Vídeo inválido.');
    if (instances.has(video)) return instances.get(video);
    Object.assign(this,{video,storage,AudioContextClass,baseURL,isUserGesture,activationTimeoutMs});
    this.listeners = new Set(); if (typeof onStatus === 'function') this.listeners.add(onStatus);
    this.mode = 'original';
    try {const saved=JSON.parse(storage?.getItem(STORAGE_KEY) || 'null');if (modes.has(saved?.mode)) this.mode=saved.mode;} catch { /* Device preferences are optional. */ }
    this.platformReason = webKitAudioRoutingUnsafe(userAgent,maxTouchPoints) ? 'webkit-media-routing' : typeof AudioContextClass !== 'function' ? 'web-audio-unavailable' : '';
    this.context = null; this.source = null; this.nodes = null; this.graphReady = false;
    this.sourceInfo = null; this.failure = ''; this.activating = null; this.transitioning = false;
    instances.set(video,this); this.#emit();
  }
  getPreferences() {return {mode:this.mode};}
  setPreferences(value = {}) {
    if (!modes.has(value.mode)) return this.getPreferences();
    this.mode = value.mode;
    try {this.storage?.setItem(STORAGE_KEY,JSON.stringify(this.getPreferences()));} catch { /* Playback must not depend on storage. */ }
    this.#applyMode(); this.#emit(); return this.getPreferences();
  }
  getStatus() {
    const contextState = this.context?.state;
    const capturedSuspended = Boolean(this.source && contextState !== 'running');
    const unsafe = Boolean(this.sourceInfo && !isLocalAudioSource(this.sourceInfo.url,this.baseURL)
      || this.video.currentSrc && !isLocalAudioSource(this.video.currentSrc,this.baseURL));
    let state, reason;
    if (capturedSuspended) {state='suspended'; reason=contextState === 'closed' ? 'context-closed' : 'interaction-required';}
    else if (this.mode === 'original') {state='original'; reason='original-audio';}
    else if (this.platformReason) {state='unsupported'; reason=this.platformReason;}
    else if (unsafe) {state=this.source?'error':'unsupported'; reason='cross-origin-source';}
    else if (this.failure) {state=this.failure==='interaction-required'?'suspended':'error'; reason=this.failure;}
    else if (this.graphReady && this.sourceInfo && contextState === 'running') {state='active'; reason='peak-protection';}
    else {state='idle'; reason=this.sourceInfo?'interaction-required':'awaiting-source';}
    const reductionDb = this.graphReady && state === 'active'
      ? Math.min(0,Number(this.nodes.compressor.reduction) || 0) + Math.min(0,Number(this.nodes.limiter.reduction) || 0) : 0;
    return {state,mode:this.mode,supported:!this.platformReason && !unsafe,active:state==='active',reason,reductionDb};
  }
  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener); listener(this.getStatus()); return () => this.listeners.delete(listener);
  }
  #emit() {const status=this.getStatus();for (const listener of this.listeners) {try {listener(status);} catch { /* A settings view cannot interrupt sound. */ }}}
  #set(param,value,time = this.context.currentTime) {
    param.cancelScheduledValues(time); param.setValueAtTime(value,time);
  }
  #ramp(param,value,seconds = .02) {
    const time=this.context.currentTime;
    if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(time);
    else {param.cancelScheduledValues(time);param.setValueAtTime(param.value,time);}
    if (typeof param.linearRampToValueAtTime === 'function') param.linearRampToValueAtTime(value,time+seconds);
    else param.setValueAtTime(value,time);
  }
  #configure(compressor,preset) {for (const [name,value] of Object.entries(preset)) this.#set(compressor[name],value);}
  #applyMode(initial = false) {
    if (!this.nodes) return;
    const {compressor,compensation,limiter,limiterCompensation,dry,wet,output}=this.nodes;
    const enabled=this.mode !== 'original' && (this.graphReady || initial);
    const preset=AUDIO_PRESETS[this.mode] || AUDIO_PRESETS.balanced;
    this.#configure(compressor,preset); this.#set(compensation.gain,compressorCompensation(preset));
    this.#configure(limiter,AUDIO_LIMITER); this.#set(limiterCompensation.gain,compressorCompensation(AUDIO_LIMITER));
    if (initial) {this.#set(dry.gain,enabled?0:1);this.#set(wet.gain,enabled?1:0);}
    else {this.#ramp(dry.gain,enabled?0:1);this.#ramp(wet.gain,enabled?1:0);}
    // Original is a unity dry path, including immediately after a source change.
    if (!enabled) this.#set(output.gain,1);
    else if (this.transitioning) this.#set(output.gain,dbGain(-6));
  }
  #bindSource() {
    if (this.source) {if (!this.graphReady && !this.failure) this.failure='processing-unavailable';return this.graphReady;}
    if (this.mode === 'original' || this.platformReason || this.context?.state !== 'running' || !this.sourceInfo) return false;
    if (!isLocalAudioSource(this.sourceInfo.url,this.baseURL)
      || this.video.currentSrc && !isLocalAudioSource(this.video.currentSrc,this.baseURL)) return false;
    let dryConnected=false;
    try {
      const context=this.context;
      const nodes={compressor:context.createDynamicsCompressor(),compensation:context.createGain(),limiter:context.createDynamicsCompressor(),limiterCompensation:context.createGain(),dry:context.createGain(),wet:context.createGain(),output:context.createGain()};
      this.nodes=nodes;
      // Wire both routes and configure protection before permanently routing the video.
      this.#set(nodes.dry.gain,1);this.#set(nodes.wet.gain,0);this.#set(nodes.output.gain,1);
      this.#applyMode(true);
      nodes.compressor.connect(nodes.compensation);nodes.compensation.connect(nodes.limiter);nodes.limiter.connect(nodes.limiterCompensation);
      nodes.limiterCompensation.connect(nodes.wet);nodes.wet.connect(nodes.output);nodes.dry.connect(nodes.output);nodes.output.connect(context.destination);
      this.source=context.createMediaElementSource(this.video);
      this.source.connect(nodes.dry);dryConnected=true;this.source.connect(nodes.compressor);
      this.graphReady=true;this.failure='';this.#applyMode(true);return true;
    } catch {
      this.graphReady=false;this.failure='processing-unavailable';
      // Capturing cannot be undone. Keep the context and an unprocessed route.
      if (this.source) {
        if (!dryConnected) {try {this.source.connect(this.context.destination);} catch {this.failure='audio-route-failed';}}
        else {try {this.#set(this.nodes.dry.gain,1);this.#set(this.nodes.wet.gain,0);this.#set(this.nodes.output.gain,1);} catch {this.failure='audio-route-failed';}}
      }
      return false;
    }
  }
  requestActivation() {
    if (this.mode === 'original' && !this.source || this.platformReason) {this.#emit();return Promise.resolve(false);}
    if (this.activating) return this.activating;
    if (this.sourceInfo && !isLocalAudioSource(this.sourceInfo.url,this.baseURL)
      || this.video.currentSrc && !isLocalAudioSource(this.video.currentSrc,this.baseURL)) {this.#emit();return Promise.resolve(false);}
    if ((!this.context || this.context.state !== 'running') && !this.isUserGesture()) {this.failure='interaction-required';this.#emit();return Promise.resolve(false);}
    let resume;
    try {
      if (!this.context) {
        this.context=new this.AudioContextClass({latencyHint:'interactive'});
        this.context.addEventListener?.('statechange',() => this.#emit());
      }
      if (this.context.state === 'closed') {this.failure='context-closed';this.#emit();return Promise.resolve(false);}
      // Invoke resume synchronously while the DOM handler still has activation.
      resume=this.context.state === 'running' ? undefined : this.context.resume();
    } catch {this.failure='activation-unavailable';this.#emit();return Promise.resolve(false);}
    let deadline;
    const resumed=Promise.resolve(resume).then(() => true);
    const timedOut=new Promise(resolve => {deadline=setTimeout(() => resolve(false),Math.max(1,Number(this.activationTimeoutMs)||2000));});
    this.activating=Promise.race([resumed,timedOut]).then(confirmed => {
      if (!confirmed || this.context.state !== 'running') {this.failure='interaction-required';return false;}
      this.failure='';this.#bindSource();return this.getStatus().active;
    }).catch(() => {this.failure='interaction-required';return false;}).finally(() => {clearTimeout(deadline);this.activating=null;this.#emit();});
    return this.activating;
  }
  beginSourceChange({url,transport = 'file'} = {}) {
    this.sourceInfo=url?{url:String(url),transport}:null;this.transitioning=true;
    this.#bindSource();
    if (this.graphReady && this.mode !== 'original') this.#ramp(this.nodes.output.gain,dbGain(-6),.005);
    this.#emit();return this.getStatus();
  }
  finishSourceChange() {
    this.transitioning=false;this.#bindSource();
    if (this.graphReady) {
      if (this.mode === 'original') this.#set(this.nodes.output.gain,1);
      else this.#ramp(this.nodes.output.gain,1,.15);
    }
    this.#emit();return this.getStatus();
  }
  reset() {
    this.sourceInfo=null;this.transitioning=false;
    if (this.nodes) this.#set(this.nodes.output.gain,1);
    this.#emit();
  }
}

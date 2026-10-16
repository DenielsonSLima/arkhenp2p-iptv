import {AudioProcessing} from '../../../audio-processing.js';

/**
 * Stable audio API for the two real media elements owned by the player host.
 * A Web Audio graph always belongs to its original element, even after handoff.
 * Preparing the next graph never resets the element still playing its buffer.
 */
export class ContinuityAudio {
  constructor({host,AudioProcessingClass=AudioProcessing,processingOptions={}}={}) {
    if(!host||typeof AudioProcessingClass!=='function')throw new TypeError('Host de áudio inválido.');
    Object.assign(this,{host,AudioProcessingClass,processingOptions});
    this.instances=new Map();this.listeners=new Set();this.preferences=null;
    this.boundElement=null;this.unsubscribeActive=null;this.disposed=false;
    this.bindActive();
  }

  #processing(element) {
    if(!element||typeof element!=='object')throw new TypeError('Elemento de áudio inválido.');
    let processing=this.instances.get(element);
    if(!processing) {
      if(this.instances.size>=2)throw new RangeError('A continuidade admite somente dois elementos de vídeo.');
      processing=new this.AudioProcessingClass(element,this.processingOptions);
      this.instances.set(element,processing);
      if(this.preferences===null)this.preferences={...processing.getPreferences()};
      else this.#synchronize(processing);
    }
    return processing;
  }

  #synchronize(processing) {
    if(processing.getPreferences().mode!==this.preferences?.mode)processing.setPreferences(this.preferences);
  }

  #emit(status) {
    if(this.disposed)return;
    for(const listener of this.listeners) {
      try{listener(status);}catch{/* Settings listeners cannot interrupt the audio handoff. */}
    }
  }

  get active() {
    const element=this.host.element;
    return this.boundElement===element?this.#processing(element):this.bindActive();
  }

  /** Call synchronously after host.promote(), before changing source audio state. */
  bindActive() {
    const element=this.host.element,processing=this.#processing(element);
    if(this.boundElement===element)return processing;
    this.unsubscribeActive?.();this.unsubscribeActive=null;
    this.boundElement=element;
    this.#synchronize(processing);
    if(!this.disposed)this.unsubscribeActive=processing.subscribe(status=>{
      if(this.boundElement===element&&this.host.element===element)this.#emit(status);
    });
    return processing;
  }

  getPreferences(){return this.active.getPreferences();}
  getStatus(){return this.active.getStatus();}

  setPreferences(value={}) {
    const processing=this.active;
    this.preferences={...processing.setPreferences(value)};
    for(const candidate of this.instances.values())if(candidate!==processing)this.#synchronize(candidate);
    return {...this.preferences};
  }

  subscribe(listener) {
    if(typeof listener!=='function'||this.disposed)return()=>{};
    const status=this.getStatus();this.listeners.add(listener);
    try{listener(status);}catch{/* Keep the sound independent from its settings view. */}
    return()=>this.listeners.delete(listener);
  }

  /**
   * Invoke within the selecting gesture, before awaiting source preparation.
   * Only resumes the target AudioContext; it never loads or plays media.
   */
  prepare(element=this.host.element) {
    const processing=this.#processing(element);this.#synchronize(processing);
    return Promise.resolve(processing.requestActivation()).catch(()=>false);
  }

  requestActivation(){return this.active.requestActivation();}
  beginSourceChange(value){return this.active.beginSourceChange(value);}
  finishSourceChange(){return this.active.finishSourceChange();}
  reset(){return this.active.reset();}

  /** Graphs are permanent for their elements; disposing only removes forwarding. */
  dispose() {
    this.disposed=true;this.unsubscribeActive?.();this.unsubscribeActive=null;
    this.listeners.clear();
  }
}

import { NativeBridgeClient } from './native-bridge.mjs';
import { ProviderError } from './provider.mjs';

const cancelled=()=>new ProviderError('A reprodução foi interrompida.','PLAYBACK_CANCELLED',409);
const combined=(...signals)=>AbortSignal.any(signals.filter(Boolean));

// The process shares one Android engine. Session identity, control credentials,
// and the prepared playlist remain private to this lease manager.
export class NativeBridgeManager {
  #bridge;#owner=null;#configuredOwner=null;#controller=null;#generation=0;
  #queue=Promise.resolve();#ready=false;#dirty=false;#streamActive=false;
  constructor({client,...options}={}){this.#bridge=client||new NativeBridgeClient(options);}
  #serialize(operation){const result=this.#queue.catch(()=>{}).then(operation);this.#queue=result.catch(()=>{});return result;}
  #check(owner,generation,signal){if(this.#owner!==owner||this.#generation!==generation||signal?.aborted)throw cancelled();}
  async start(owner,configuration,uri,{signal,timeout}={}) {
    if(!owner||(typeof owner!=='object'&&typeof owner!=='function'))throw new ProviderError('Sessão de reprodução inválida.','NATIVE_SESSION_INVALID',400);
    if(this.#owner&&this.#owner!==owner)throw new ProviderError('A TV ao vivo está em uso em outra sessão deste sistema. Encerre essa reprodução para continuar.','NATIVE_BRIDGE_BUSY',409);
    this.#controller?.abort();this.#controller=new AbortController();
    const activeSignal=combined(this.#controller.signal,signal),generation=++this.#generation;
    this.#owner=owner;this.#ready=false;
    return this.#serialize(async()=>{
      this.#check(owner,generation,activeSignal);
      try {
        if(this.#configuredOwner!==owner){
          if(this.#dirty){await this.#bridge.close();this.#configuredOwner=null;this.#dirty=false;this.#streamActive=false;}
          this.#check(owner,generation,activeSignal);
          this.#dirty=true;
          await this.#bridge.configure(configuration,{signal:activeSignal});
          this.#check(owner,generation,activeSignal);this.#configuredOwner=owner;
        }else if(this.#streamActive){await this.#bridge.stop();this.#streamActive=false;this.#check(owner,generation,activeSignal);}
        this.#streamActive=true;
        const url=await this.#bridge.start(uri,{signal:activeSignal,timeout});
        this.#check(owner,generation,activeSignal);this.#ready=true;
        return new URL(url);
      }catch(error){
        const interrupted=activeSignal.aborted;
        if(this.#owner===owner&&this.#generation===generation){
          this.#ready=false;this.#owner=null;this.#controller?.abort();
          // Release only after cleanup, while this serialized operation still
          // precedes any next owner. A failed SDK init must be reconfigured.
          let closed=false;try{await this.#bridge.close();closed=true;}catch{}
          this.#configuredOwner=null;this.#dirty=!closed;this.#streamActive=!closed;
        }
        if(interrupted)throw cancelled();
        throw error;
      }
    });
  }
  acceptsMediaURL(owner,value){return this.#owner===owner&&this.#ready&&!this.#controller?.signal.aborted&&this.#bridge.acceptsMediaURL(value);}
  async fetchMedia(owner,value,options={}){
    if(!this.acceptsMediaURL(owner,value))throw new ProviderError('A fonte local não pertence à reprodução ativa.','NATIVE_SOURCE_INVALID',400);
    return this.#bridge.fetchMedia(value,{...options,signal:combined(this.#controller.signal,options.signal)});
  }
  stop(owner){
    if(this.#owner!==owner)return Promise.resolve();
    const generation=++this.#generation;this.#ready=false;this.#controller?.abort();
    return this.#serialize(async()=>{
      let stopped=false;
      try{await this.#bridge.stop();stopped=true;}
      finally{this.#streamActive=!stopped;if(!stopped)this.#configuredOwner=null;if(this.#owner===owner&&this.#generation===generation)this.#owner=null;}
    });
  }
  close(owner){
    if(this.#owner&&this.#owner!==owner||this.#configuredOwner!==owner&&this.#owner!==owner)return Promise.resolve();
    const generation=++this.#generation;this.#ready=false;this.#controller?.abort();
    return this.#serialize(async()=>{
      // A queued start by another owner is always later than this close.
      let closed=false;
      try{await this.#bridge.close();closed=true;}
      finally{this.#configuredOwner=null;this.#dirty=!closed;this.#streamActive=!closed;if(this.#owner===owner&&this.#generation===generation)this.#owner=null;}
    });
  }
  shutdown(){
    ++this.#generation;this.#ready=false;this.#controller?.abort();
    return this.#serialize(async()=>{
      try{if(typeof this.#bridge.shutdown==='function')await this.#bridge.shutdown();else await this.#bridge.close();}
      finally{this.#owner=null;this.#configuredOwner=null;this.#dirty=false;this.#streamActive=false;}
    });
  }
}

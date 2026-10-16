import {PreparedLiveVideo} from './preparacao.js';

const cancelled=()=>new DOMException('Esta preparação de vídeo foi encerrada.','AbortError');
const settledStops=values=>Promise.allSettled(values).then(results=>{
  const failed=results.find(result=>result.status==='rejected');
  if(failed)throw failed.reason;
});

/** One upstream at a time. The old element can consume only its local buffer
 * after STOP; the new element is never exposed before actual media readiness. */
export class LiveContinuityFlow{
  constructor({host,audio,getCurrent,getHls,getScope,stopRemote,makeAttempt,playbackURL,getConfig,
    suspendRecovery,readFailure,onBufferEmpty=()=>{},HlsClass=globalThis.Hls,getTransport,registerTransportStop}={}){
    Object.assign(this,{host,audio,getCurrent,getHls,getScope,stopRemote,makeAttempt,playbackURL,getConfig,suspendRecovery,readFailure,onBufferEmpty,HlsClass,getTransport,registerTransportStop});
    this.operation=null;this.draining=null;this.drainCleanup=[];this.whenStopped=Promise.resolve();this.cleanupPending=0;
  }
  prime(){
    // Called synchronously from the confirmation gesture, before metadata I/O.
    if(this.operation||this.cleanupPending)return;
    this.audio?.prepare(this.host.standby());
  }
  owns(ticket){return Boolean(ticket&&this.operation?.ticket===ticket&&!ticket.controller.signal.aborted&&ticket.scope===this.getScope());}
  isDraining(){return Boolean(this.draining&&this.draining.player===this.getCurrent()&&this.draining.element===this.host.element);}
  clearDrainListeners(){for(const dispose of this.drainCleanup)dispose();this.drainCleanup=[];}
  trackTransportStop(value){
    if(!value||typeof value.then!=='function')return this.whenStopped;
    const stopped=Promise.resolve(value);this.cleanupPending++;
    void stopped.then(()=>{this.cleanupPending--;},()=>{this.cleanupPending--;});
    // Register immediately: a normal opening outside this flow must also wait.
    const registered=this.registerTransportStop?.(stopped);
    this.whenStopped=settledStops([this.whenStopped,stopped,registered]);
    void this.whenStopped.catch(()=>{});
    return this.whenStopped;
  }
  watchDrain(player,element){
    this.clearDrainListeners();this.draining={player,element};this.host.captureFrame?.();
    const depleted=()=>{
      if(!this.isDraining())return;
      this.host.holdFrame?.();this.onBufferEmpty();
    };
    for(const name of ['waiting','ended','error','emptied']){
      element.addEventListener(name,depleted);this.drainCleanup.push(()=>element.removeEventListener(name,depleted));
    }
  }
  async prepare(item,ticket){
    this.cancel();
    const active=this.getCurrent(),element=this.host.element;
    const operation={ticket,item,player:active,element,task:null,result:null,adopted:false,remoteStarted:false,oldSuspended:false};
    this.operation=operation;
    const check=()=>{if(this.operation!==operation||!this.owns(ticket)||this.getCurrent()!==active)throw cancelled();};
    const abort=()=>{if(this.operation===operation)this.cancel(ticket);};
    ticket.controller.signal.addEventListener('abort',abort,{once:true});operation.removeAbort=()=>ticket.controller.signal.removeEventListener('abort',abort);
    try{
      check();
      // Loading an explicitly selected engine is metadata/code work only. A
      // missing/unsupported engine must leave the playing channel untouched.
      const transport=this.getTransport?await this.getTransport(item,{signal:ticket.controller.signal,video:element}):{
        HlsClass:this.HlsClass,usingNativeHLS:Boolean(element.canPlayType?.('application/vnd.apple.mpegurl')),engine:'current'
      };
      check();
      if(!transport||!['current','shaka'].includes(transport.engine))throw new Error('LIVE_TRANSPORT_UNAVAILABLE');
      if(!transport.usingNativeHLS&&(typeof transport.HlsClass!=='function'||transport.HlsClass.isSupported?.()!==true))throw new Error('LIVE_TRANSPORT_UNSUPPORTED');
      await this.whenStopped;check();
      const previousTransport=this.getHls();
      this.suspendRecovery?.();this.watchDrain(active,element);operation.oldSuspended=true;
      // Some engines unload their MSE during stopLoad. Capture and expose the
      // last frame before that destructive operation, rather than showing black.
      if(previousTransport?.supportsBufferedDrain===false){this.host.holdFrame?.();this.onBufferEmpty();}
      let stopping;
      try{stopping=previousTransport?.stopLoad();}catch(error){stopping=Promise.reject(error);}
      const waits=[stopping,previousTransport?.whenStopped].filter(value=>value&&typeof value.then==='function');
      if(waits.length)await this.trackTransportStop(settledStops(waits));
      check();
      // STOP is awaited and never cancelled halfway: no target request can
      // overtake a still-running stop from a superseded selection.
      await this.stopRemote();check();
      const target=this.host.standby(),attempt=this.makeAttempt();
      const sourceId=ticket.prepared?.sourceId||'',url=this.playbackURL(item,{attempt,sourceId});
      operation.task=new PreparedLiveVideo({video:target,HlsClass:transport.HlsClass,config:this.getConfig(),usingNativeHLS:transport.usingNativeHLS,engine:transport.engine,
        readFailure:options=>this.readFailure?.(item,options)});
      operation.remoteStarted=true;
      operation.result=await operation.task.prepare({url,attempt,sourceId,signal:ticket.controller.signal});check();
      return operation.result;
    }catch(error){
      if(this.operation===operation)this.cancel(ticket);
      throw error;
    }
  }
  adopt(ticket){
    const operation=this.operation;
    if(!this.owns(ticket)||!operation?.result)throw cancelled();
    const result=operation.task.adopt();operation.adopted=true;operation.removeAbort?.();
    this.clearDrainListeners();this.draining=null;
    // Respect volume/mute changed while the user was waiting for this target.
    const restoreMuted=operation.element.muted,restoreVolume=operation.element.volume;
    const previous=this.host.promote(result.video,{muted:true,volume:restoreVolume});
    this.audio?.bindActive();this.host.clear(previous);this.host.releaseFrame?.();
    this.operation=null;
    return {...result,restoreMuted};
  }
  cancel(ticket){
    const operation=this.operation;if(!operation||ticket&&operation.ticket!==ticket)return this.whenStopped;
    this.operation=null;operation.removeAbort?.();if(!operation.adopted)this.trackTransportStop(operation.task?.dispose());
    this.host.resetStandby();
    // Register this STOP synchronously in the application's shared barrier.
    // A following opening cannot overtake cleanup of the abandoned target.
    if((operation.remoteStarted||operation.oldSuspended)&&!operation.adopted)void this.stopRemote().catch(()=>{});
    // Keep the visible element/frame after a failed preparation. Only a
    // general stop may discard it; it must never reopen the old upstream.
    return this.whenStopped;
  }
  reset({preserveTicket}={}){
    if(this.owns(preserveTicket))return this.whenStopped;
    this.cancel();this.clearDrainListeners();this.draining=null;this.host.resetStandby();this.host.releaseFrame?.();
    return this.whenStopped;
  }
  destroy(){return this.reset();}
}

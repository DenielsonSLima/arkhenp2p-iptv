const TYPES=Object.freeze(['live','movies','series']);

/** Collapse cache publication bursts into snapshot reads, without requesting
 * another upstream refresh or altering the player's current source. */
export class SharedCatalogUpdates {
  constructor({reload,getGeneration=()=>0,isConnected=()=>false,getTypes=()=>[],delayMs=250,
    schedule=(callback,delay)=>globalThis.setTimeout(callback,delay),cancel=timer=>globalThis.clearTimeout(timer)}={}){
    Object.assign(this,{reload,getGeneration,isConnected,getTypes,delayMs,schedule,cancel});
    this.epoch=0;this.pending=new Set();this.timer=null;this.inflight=null;this.revisions=new Map();this.pendingRevisions=new Map();this.inflightRevisions=new Map();
    this.retryTimers=new Map();this.retryCounts=new Map();
  }
  notify(type,{revision}={}){
    if(!this.isConnected())return;
    for(const value of TYPES.includes(type)?[type]:this.getTypes())if(TYPES.includes(value)){
      if(revision&&(this.revisions.get(value)===revision||this.inflightRevisions.get(value)===revision))continue;
      if(this.retryTimers.has(value)){this.cancel(this.retryTimers.get(value));this.retryTimers.delete(value);}
      this.retryCounts.delete(value);
      this.pending.add(value);if(revision)this.pendingRevisions.set(value,revision);
    }
    this.#schedule();
  }
  #retry(type,revision,epoch,generation){
    if(epoch!==this.epoch||generation!==this.getGeneration()||!this.isConnected()||this.retryTimers.has(type)||this.pending.has(type))return;
    const count=this.retryCounts.get(type)||0,delays=[1000,5000,15000];if(count>=delays.length)return;
    this.retryCounts.set(type,count+1);
    this.retryTimers.set(type,this.schedule(()=>{
      this.retryTimers.delete(type);
      if(epoch!==this.epoch||generation!==this.getGeneration()||!this.isConnected())return;
      this.pending.add(type);if(revision)this.pendingRevisions.set(type,revision);this.#schedule();
    },delays[count]));
  }
  #schedule(){
    if(this.timer!==null||this.inflight||!this.pending.size)return;
    const epoch=this.epoch,generation=this.getGeneration();
    this.timer=this.schedule(()=>{
      this.timer=null;
      if(epoch!==this.epoch||generation!==this.getGeneration()||!this.isConnected()){this.pending.clear();return;}
      const types=[...this.pending];this.pending.clear();this.inflightRevisions=new Map(this.pendingRevisions);this.pendingRevisions.clear();
      const work=Promise.allSettled(types.map(type=>{
        const revision=this.inflightRevisions.get(type);
        return Promise.resolve().then(()=>this.reload(type,{generation,revision})).then(value=>{
          if(epoch===this.epoch&&generation===this.getGeneration()){
            if(value){if(revision)this.revisions.set(type,revision);this.retryCounts.delete(type);}
            else this.#retry(type,revision,epoch,generation);
          }return value;
        },()=>{this.#retry(type,revision,epoch,generation);return null;});
      }));
      this.inflight=work;
      void work.finally(()=>{
        if(this.inflight===work){this.inflight=null;this.inflightRevisions.clear();}
        if(epoch===this.epoch&&generation===this.getGeneration()&&this.isConnected())this.#schedule();
      });
    },this.delayMs);
  }
  reset(){this.epoch++;if(this.timer!==null)this.cancel(this.timer);this.timer=null;for(const timer of this.retryTimers.values())this.cancel(timer);this.retryTimers.clear();this.retryCounts.clear();this.pending.clear();this.inflight=null;this.revisions.clear();this.pendingRevisions.clear();this.inflightRevisions.clear();}
}

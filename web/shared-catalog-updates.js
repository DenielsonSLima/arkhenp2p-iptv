const TYPES=Object.freeze(['live','movies','series']);

/** Collapse cache publication bursts into snapshot reads, without requesting
 * another upstream refresh or altering the player's current source. */
export class SharedCatalogUpdates {
  constructor({reload,getGeneration=()=>0,isConnected=()=>false,getTypes=()=>TYPES,delayMs=250,
    schedule=(callback,delay)=>globalThis.setTimeout(callback,delay),cancel=timer=>globalThis.clearTimeout(timer)}={}){
    Object.assign(this,{reload,getGeneration,isConnected,getTypes,delayMs,schedule,cancel});
    this.epoch=0;this.pending=new Set();this.timer=null;this.inflight=null;
  }
  notify(type){
    if(!this.isConnected())return;
    for(const value of TYPES.includes(type)?[type]:this.getTypes())if(TYPES.includes(value))this.pending.add(value);
    this.#schedule();
  }
  #schedule(){
    if(this.timer!==null||this.inflight||!this.pending.size)return;
    const epoch=this.epoch,generation=this.getGeneration();
    this.timer=this.schedule(()=>{
      this.timer=null;
      if(epoch!==this.epoch||generation!==this.getGeneration()||!this.isConnected()){this.pending.clear();return;}
      const types=[...this.pending];this.pending.clear();
      const work=Promise.allSettled(types.map(type=>Promise.resolve().then(()=>this.reload(type,{generation}))));
      this.inflight=work;
      void work.finally(()=>{
        if(this.inflight===work)this.inflight=null;
        if(epoch===this.epoch&&generation===this.getGeneration()&&this.isConnected())this.#schedule();
      });
    },this.delayMs);
  }
  reset(){this.epoch++;if(this.timer!==null)this.cancel(this.timer);this.timer=null;this.pending.clear();this.inflight=null;}
}

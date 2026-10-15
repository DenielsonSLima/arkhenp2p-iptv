const TYPES=Object.freeze(['live','movies','series']);

/** Collapse cache publication bursts into snapshot reads, without requesting
 * another upstream refresh or altering the player's current source. */
export class SharedCatalogUpdates {
  constructor({reload,getGeneration=()=>0,isConnected=()=>false,getTypes=()=>[],delayMs=250,
    schedule=(callback,delay)=>globalThis.setTimeout(callback,delay),cancel=timer=>globalThis.clearTimeout(timer)}={}){
    Object.assign(this,{reload,getGeneration,isConnected,getTypes,delayMs,schedule,cancel});
    this.epoch=0;this.pending=new Set();this.timer=null;this.inflight=null;this.revisions=new Map();this.pendingRevisions=new Map();this.inflightRevisions=new Map();
  }
  notify(type,{revision}={}){
    if(!this.isConnected())return;
    for(const value of TYPES.includes(type)?[type]:this.getTypes())if(TYPES.includes(value)){
      if(revision&&(this.revisions.get(value)===revision||this.inflightRevisions.get(value)===revision))continue;
      this.pending.add(value);if(revision)this.pendingRevisions.set(value,revision);
    }
    this.#schedule();
  }
  #schedule(){
    if(this.timer!==null||this.inflight||!this.pending.size)return;
    const epoch=this.epoch,generation=this.getGeneration();
    this.timer=this.schedule(()=>{
      this.timer=null;
      if(epoch!==this.epoch||generation!==this.getGeneration()||!this.isConnected()){this.pending.clear();return;}
      const types=[...this.pending];this.pending.clear();this.inflightRevisions=new Map(this.pendingRevisions);this.pendingRevisions.clear();
      const work=Promise.allSettled(types.map(type=>Promise.resolve().then(()=>this.reload(type,{generation})).then(value=>{if(epoch===this.epoch&&generation===this.getGeneration()&&this.inflightRevisions.has(type))this.revisions.set(type,this.inflightRevisions.get(type));return value;})));
      this.inflight=work;
      void work.finally(()=>{
        if(this.inflight===work){this.inflight=null;this.inflightRevisions.clear();}
        if(epoch===this.epoch&&generation===this.getGeneration()&&this.isConnected())this.#schedule();
      });
    },this.delayMs);
  }
  reset(){this.epoch++;if(this.timer!==null)this.cancel(this.timer);this.timer=null;this.pending.clear();this.inflight=null;this.revisions.clear();this.pendingRevisions.clear();this.inflightRevisions.clear();}
}

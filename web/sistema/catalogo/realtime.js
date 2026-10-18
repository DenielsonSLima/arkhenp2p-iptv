import {catalogRevisionToken,compareCatalogRevisions} from '../../catalog-revision.js';
const TYPES=Object.freeze(['live','movies','series']);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const same=(left,right)=>!!left&&!!right&&catalogRevisionToken(left.revision)===catalogRevisionToken(right.revision)&&left.snapshotId===right.snapshotId;
const identified=value=>!!value?.revision||!!value?.snapshotId;

/** Collapse cache publication bursts into snapshot reads, without requesting
 * another upstream refresh or altering the player's current source. */
export class SharedCatalogUpdates {
  constructor({reload,getGeneration=()=>0,isConnected=()=>false,isActive=()=>true,getTypes=()=>[],delayMs=250,
    schedule=(callback,delay)=>globalThis.setTimeout(callback,delay),cancel=timer=>globalThis.clearTimeout(timer)}={}){
    Object.assign(this,{reload,getGeneration,isConnected,isActive,getTypes,delayMs,schedule,cancel});
    this.epoch=0;this.generation=this.getGeneration();this.pending=new Set();this.timer=null;this.inflight=null;this.revisions=new Map();this.pendingRevisions=new Map();this.inflightRevisions=new Map();
    this.retryTimers=new Map();this.retryCounts=new Map();this.retryRevisions=new Map();
  }
  notify(type,{revision,snapshotId}={}){
    this.#synchronizeGeneration();
    // A compact event must identify its domain. Unknown events cannot fan out
    // into every catalog; private progress is handled by its own projection.
    if(!this.isConnected()||!TYPES.includes(type)||revision!=null&&!catalogRevisionToken(revision)||snapshotId!=null&&(typeof snapshotId!=='string'||!UUID.test(snapshotId)))return false;
    const hint={revision:revision||null,snapshotId:snapshotId?.toLowerCase()||null};
    const acknowledged=this.revisions.get(type),pending=this.pendingRevisions.get(type),inflight=this.inflightRevisions.get(type),retry=this.retryRevisions.get(type);
    if(identified(hint)&&same(acknowledged,hint)||same(pending,hint)||same(inflight,hint)||[acknowledged,pending,inflight,retry].some(previous=>compareCatalogRevisions(hint.revision,previous?.revision)<0))return false;
    // Duplicates must not cancel the timer/reset the retry budget indefinitely.
    if((this.retryTimers.has(type)||(this.retryCounts.get(type)||0)>=3)&&same(retry,hint))return false;
    if(this.retryTimers.has(type)){this.cancel(this.retryTimers.get(type));this.retryTimers.delete(type);}
    this.retryCounts.delete(type);this.retryRevisions.delete(type);
    this.pending.add(type);this.pendingRevisions.set(type,hint);this.#schedule();return true;
  }
  #synchronizeGeneration(){if(this.generation!==this.getGeneration())this.reset();}
  #retry(type,hint,epoch,generation){
    if(epoch!==this.epoch||generation!==this.getGeneration()||!this.isConnected()||this.retryTimers.has(type)||this.pending.has(type))return;
    if(!this.isActive()){this.pending.add(type);this.pendingRevisions.set(type,hint);return;}
    const count=this.retryCounts.get(type)||0,delays=[1000,5000,30000];if(count>=delays.length)return;
    this.retryCounts.set(type,count+1);this.retryRevisions.set(type,hint);
    this.retryTimers.set(type,this.schedule(()=>{
      if(epoch!==this.epoch)return;
      this.retryTimers.delete(type);
      if(generation!==this.getGeneration()){this.reset();return;}
      if(!this.isConnected())return;
      this.pending.add(type);this.pendingRevisions.set(type,hint);this.#schedule();
    },delays[count]));
  }
  #schedule(){
    if(this.timer!==null||this.inflight||!this.pending.size||!this.isActive())return;
    const epoch=this.epoch,generation=this.getGeneration();
    this.timer=this.schedule(()=>{
      if(epoch!==this.epoch)return;
      this.timer=null;
      if(generation!==this.getGeneration()){this.reset();return;}
      if(!this.isConnected()){this.pending.clear();this.pendingRevisions.clear();return;}
      if(!this.isActive())return;
      const types=[...this.pending];this.pending.clear();this.inflightRevisions=new Map(this.pendingRevisions);this.pendingRevisions.clear();
      const work=Promise.allSettled(types.map(type=>{
        const hint=this.inflightRevisions.get(type);
        return Promise.resolve().then(()=>this.reload(type,{generation,...hint})).then(value=>{
          if(epoch===this.epoch&&generation===this.getGeneration()){
            if(value){if(identified(hint))this.revisions.set(type,hint);this.retryCounts.delete(type);this.retryRevisions.delete(type);}
            else this.#retry(type,hint,epoch,generation);
          }return value;
        },()=>{this.#retry(type,hint,epoch,generation);return null;});
      }));
      this.inflight=work;
      void work.finally(()=>{
        if(this.inflight===work){this.inflight=null;this.inflightRevisions.clear();}
        if(epoch===this.epoch&&generation===this.getGeneration()&&this.isConnected())this.#schedule();
      });
    },this.delayMs);
  }
  resume(){this.#synchronizeGeneration();this.#schedule();}
  reset(){this.epoch++;this.generation=this.getGeneration();if(this.timer!==null)this.cancel(this.timer);this.timer=null;for(const timer of this.retryTimers.values())this.cancel(timer);this.retryTimers.clear();this.retryCounts.clear();this.retryRevisions.clear();this.pending.clear();this.inflight=null;this.revisions.clear();this.pendingRevisions.clear();this.inflightRevisions.clear();}
}

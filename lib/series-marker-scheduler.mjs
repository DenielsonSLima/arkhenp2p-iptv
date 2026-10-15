import {syncSeriesMarkers,SKIPDB_CACHE_MS} from './skipdb-markers.mjs';

/** One global metadata refresh per backend, independent of browser sessions.
 * The selected open dataset is published before its rows enter Supabase. */
export class SeriesMarkerScheduler {
  constructor({cloud,sync=syncSeriesMarkers,intervalMs=SKIPDB_CACHE_MS,retryMs=900000,
    schedule=(callback,delay)=>setTimeout(callback,delay),cancel=timer=>clearTimeout(timer),onStatus=()=>{}}={}){
    Object.assign(this,{cloud,sync,intervalMs,retryMs,schedule,cancel,onStatus});
    this.running=false;this.timer=null;this.pending=null;this.controller=null;this.generation=0;
  }
  start(){if(this.running)return this.pending??Promise.resolve(null);this.running=true;this.generation++;return this.pending?this.pending.then(()=>this.running?this.tick():null):this.tick();}
  stop(){this.running=false;this.generation++;if(this.timer!==null)this.cancel(this.timer);this.timer=null;this.controller?.abort();}
  status(value){try{this.onStatus(value);}catch{/* Observers never control synchronization. */}}
  tick(){
    if(!this.running)return Promise.resolve(null);
    if(this.pending)return this.pending;
    if(this.timer!==null)this.cancel(this.timer);this.timer=null;
    const generation=this.generation,controller=new AbortController();this.controller=controller;
    const current=()=>this.running&&generation===this.generation&&!controller.signal.aborted;
    let retry=false,disabled=false;
    const pending=(async()=>{
      try{
        await this.cloud?.ready;if(!current())return null;
        if(!this.cloud?.enabled){disabled=true;return null;}
        const value=await this.sync({cloud:this.cloud,apply:true,signal:controller.signal});
        if(current())this.status({state:'ready',editions:Number(value?.activeEditions)||0});
        return value;
      }catch(error){
        if(current()){retry=true;const code=/^SKIPDB_[A-Z0-9_]{1,80}$/.test(error?.code||'')?error.code:'SKIPDB_SYNC_FAILED';this.status({state:'unavailable',code});}
        return null;
      }finally{
        if(this.pending===pending)this.pending=null;
        if(this.controller===controller)this.controller=null;
        if(current()&&!disabled){this.timer=this.schedule(()=>{this.timer=null;void this.tick();},retry?this.retryMs:this.intervalMs);this.timer?.unref?.();}
      }
    })();
    this.pending=pending;return pending;
  }
}

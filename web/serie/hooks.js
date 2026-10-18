import {withRequestSignals} from '../request-signals.js';
import {seriesMetadataScopeKey} from './scope.js';

const cancelled=()=>new DOMException('A consulta da série foi encerrada.','AbortError');

/** Coalesce metadata readers without sharing their cancellation. The last
 * reader retires the request; account/PIN changes retire every old reader. */
export class SeriesReadHooks{
  constructor({getScope=()=>null}={}){this.getScope=getScope;this.scope=null;this.epoch=0;this.jobs=new Map();}
  synchronize(){
    const key=seriesMetadataScopeKey(this.getScope());
    if(key!==this.scope){this.reset();this.scope=key;}return key;
  }
  current(job){return job.epoch===this.epoch&&job.scope===seriesMetadataScopeKey(this.getScope())&&!job.controller.signal.aborted;}
  read(key,run,{signal}={}){
    const scope=this.synchronize();
    if(!scope||signal?.aborted)return Promise.reject(cancelled());
    let job=this.jobs.get(key);
    if(job?.controller.signal.aborted||job?.settled){this.jobs.delete(key);job=null;}
    if(!job){
      job={scope,epoch:this.epoch,controller:new AbortController(),readers:0,settled:false};this.jobs.set(key,job);
      job.promise=Promise.resolve().then(()=>{if(!this.current(job))throw cancelled();return run(job.controller.signal);})
        .then(value=>{if(!this.current(job))throw cancelled();return value;})
        .finally(()=>{job.settled=true;if(this.jobs.get(key)===job)this.jobs.delete(key);});
    }
    job.readers++;
    return withRequestSignals([signal,job.controller.signal],combined=>new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(error,value)=>{
        if(settled)return;settled=true;combined?.removeEventListener('abort',abort);job.readers--;
        if(!job.readers&&!job.settled){if(this.jobs.get(key)===job)this.jobs.delete(key);job.controller.abort();}
        if(!error&&!this.current(job))error=cancelled();
        if(error)reject(error);else resolve(value);
      };
      const abort=()=>finish(cancelled());combined?.addEventListener('abort',abort,{once:true});
      if(combined?.aborted){abort();return;}job.promise.then(value=>finish(null,value),error=>finish(error));
    }));
  }
  reset(){this.epoch++;for(const job of this.jobs.values())job.controller.abort();this.jobs.clear();this.scope=null;}
}

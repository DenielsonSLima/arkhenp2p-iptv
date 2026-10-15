import {LiveProgramFeed, programWindow, retainCurrentProgramList} from './program-guide.js';

const channelID = value => /^\d{1,12}$/.test(String(value ?? '')) ? String(value) : null;
const CACHE_MS = 60000;

// Two visible slots share one feed per channel. Their EPG requests never start
// media playback, and cache ownership follows the authenticated connection.
export class NeighborProgramFeeds {
  constructor({request, onUpdate, getNamespace=()=>'', now=Date.now,
    schedule=(callback,delay)=>globalThis.setTimeout(callback,delay),
    cancel=timer=>globalThis.clearTimeout(timer)}) {
    Object.assign(this,{request,onUpdate,getNamespace,now,schedule,cancel});
    this.namespace=null;this.jobs=new Map();this.cache=new Map();this.selection={previous:null,next:null};
  }
  active(job) {return this.jobs.get(job.id)===job && this.namespace===job.namespace && String(this.getNamespace())===job.namespace;}
  select({previous=null,next=null}={}) {
    const namespace=String(this.getNamespace());
    if (namespace!==this.namespace) {this.stop({clearCache:true});this.namespace=namespace;}
    const selection={previous:channelID(previous),next:channelID(next)};
    if (selection.previous===this.selection.previous && selection.next===this.selection.next) return;
    this.selection=selection;
    const ids=new Set(Object.values(selection).filter(Boolean));
    for (const [id,job] of this.jobs) if (!ids.has(id)) {this.jobs.delete(id);job.feed.stop();}
    for (const id of ids) {
      const existing=this.jobs.get(id);
      if (existing) {this.emit(existing);continue;}
      const cached=this.cache.get(`${namespace}:${id}`),window=programWindow(cached?.list,this.now());
      const initialData=cached&&(window.current||cached.expiresAt>this.now()&&window.next)?{list:cached.list}:null;
      const job={id,namespace,list:initialData?.list||[],received:Boolean(initialData),status:initialData?'ready':'loading',feed:null};
      job.feed=new LiveProgramFeed({now:this.now,schedule:this.schedule,cancel:this.cancel,getNamespace:()=>String(this.getNamespace()),
        request:(url,options)=>this.requestProgram(job,url,options),
        onUpdate:data=>{if (!this.active(job)) return;job.list=data.list;this.emit(job);}});
      this.jobs.set(id,job);job.feed.start(id,{initialData});
    }
  }
  emit(job) {
    if (!this.active(job)) return;
    for (const [slot,id] of Object.entries(this.selection)) if (id===job.id) this.onUpdate({slot,id,list:job.list,status:job.status});
  }
  async requestProgram(job,url,options) {
    const key=`${job.namespace}:${job.id}`,cached=this.cache.get(key);
    if (cached && cached.expiresAt>this.now()) {job.received=true;job.status='ready';return {list:cached.list};}
    try {
      const data=await this.request(url,options);
      if (!this.active(job) || options.signal.aborted) return data;
      const list=retainCurrentProgramList(cached?.list || job.list, data?.list, this.now());
      job.received=true;job.status='ready';this.cache.delete(key);this.cache.set(key,{list,expiresAt:this.now()+CACHE_MS});
      for (const [entry,value] of this.cache) if (value.expiresAt<=this.now()) this.cache.delete(entry);
      while (this.cache.size>64) this.cache.delete(this.cache.keys().next().value);
      return {list};
    } catch (error) {
      if (this.active(job)) {job.status=job.received ? 'ready' : 'unavailable';this.emit(job);}
      throw error;
    }
  }
  stop({clearCache=false}={}) {
    const jobs=[...this.jobs.values()];this.jobs.clear();this.selection={previous:null,next:null};
    for (const job of jobs) job.feed.stop();
    if (clearCache) this.cache.clear();
  }
  destroy() {this.stop({clearCache:true});this.namespace=null;}
}

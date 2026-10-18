/** Session-memory cache of server-selected programme windows. It never derives
 * the current programme from a device clock, persists viewing data, or owns a
 * request. A scope reset discards everything; a new EPG revision replaces it. */
export class TVProgramWindowCache{
  constructor({now=Date.now,maxEntries=2000}={}){this.now=now;this.maxEntries=Math.max(1,Math.min(2000,maxEntries));this.entries=new Map();this.revision=null;this.fullUntil=0;}
  clear(){this.entries.clear();this.revision=null;this.fullUntil=0;}
  invalidate(){this.fullUntil=0;for(const entry of this.entries.values())entry.expiresAt=0;}
  remember(data,{ids=null,delay}={}){
    const revision=JSON.stringify([data.revision??null,data.snapshotFetchedAt??null]);
    if(ids===null||revision!==this.revision)this.clear();
    this.revision=revision;
    const expiresAt=this.now()+delay;
    const wanted=new Set([...(ids||[]),...Object.keys(data.channels)]);
    for(const id of wanted){
      const channel=data.channels[id],value=channel?{...channel,revision:data.revision,projectionVersion:data.projectionVersion,asOf:data.asOf,
        stale:Boolean(data.stale),snapshotFetchedAt:data.snapshotFetchedAt}:null;
      this.entries.delete(id);this.entries.set(id,{value,expiresAt});
    }
    while(this.entries.size>this.maxEntries)this.entries.delete(this.entries.keys().next().value);
    // A later subset is not a fresh full-map response for legacy consumers.
    this.fullUntil=ids===null&&this.entries.size===wanted.size?expiresAt:0;
  }
  freshUntil(ids){
    if(ids===null)return this.fullUntil;
    let until=Infinity;
    for(const id of ids){const entry=this.entries.get(id);if(!entry)return 0;until=Math.min(until,entry.expiresAt);}
    return Number.isFinite(until)?until:0;
  }
  peek(id,{stale=false}={}){
    const entry=this.entries.get(String(id));if(!entry?.value)return null;
    // Touch only recency. A visit cannot extend the server's validity window.
    this.entries.delete(String(id));this.entries.set(String(id),entry);
    return {...entry.value,stale:Boolean(stale||entry.value.stale||entry.expiresAt<=this.now())};
  }
}

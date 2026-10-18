/** Session-memory cache of server-selected programme windows. It never derives
 * the current programme from a device clock, persists viewing data, or owns a
 * request. A scope reset discards everything; a new EPG revision replaces it. */
const unavailable=()=>({status:'unavailable',window:{previous:null,current:null,next:null},list:[],schedule:[],progressPercent:0});
export class TVProgramWindowCache{
  constructor({now=Date.now,maxEntries=2000}={}){this.now=now;this.maxEntries=Math.max(1,Math.min(2000,maxEntries));this.entries=new Map();this.revision=null;this.fullUntil=0;this.fullIds=null;this.fetchedAt=null;}
  clear(){this.entries.clear();this.revision=null;this.fullUntil=0;this.fullIds=null;this.fetchedAt=null;}
  invalidate(){this.fullUntil=0;for(const entry of this.entries.values())entry.expiresAt=0;}
  remember(data,{ids=null,delay}={}){
    const revision=JSON.stringify([data.revision??null,data.snapshotFetchedAt??null]);
    const fetchedAt=Date.parse(data.snapshotFetchedAt);
    // A delayed fallback cannot replace a newer source snapshot. Projection
    // changes within the same source capture remain eligible.
    if(Number.isFinite(fetchedAt)&&Number.isFinite(this.fetchedAt)&&fetchedAt<this.fetchedAt)return;
    // A partial fallback cannot replace a completed navigation snapshot or
    // certify that channels omitted from that fallback have no programmes.
    if(data.partial===true&&revision!==this.revision&&this.entries.size){this.invalidate();return;}
    if(ids===null&&data.partial!==true||revision!==this.revision)this.clear();
    this.revision=revision;if(Number.isFinite(fetchedAt))this.fetchedAt=fetchedAt;
    const expiresAt=this.now()+delay;
    const wanted=new Set([...(data.partial===true?[]:ids||[]),...Object.keys(data.channels)]);
    for(const id of wanted){
      const channel=data.channels[id],value=channel?{...channel,revision:data.revision,projectionVersion:data.projectionVersion,asOf:data.asOf,
        stale:Boolean(data.stale),snapshotFetchedAt:data.snapshotFetchedAt}:null;
      this.entries.delete(id);this.entries.set(id,{value,expiresAt});
      if(channel&&this.fullIds&&!this.fullIds.has(id)){
        if(this.fullIds.size>=this.maxEntries){this.fullIds=null;this.fullUntil=0;}else this.fullIds.add(id);
      }
    }
    while(this.entries.size>this.maxEntries)this.entries.delete(this.entries.keys().next().value);
    // A subset refresh does not extend or erase the still-valid coverage of
    // the prior complete batch from this same source revision.
    if(ids===null&&data.partial!==true&&this.entries.size===wanted.size){this.fullUntil=expiresAt;this.fullIds=new Set(Object.keys(data.channels));}
  }
  freshUntil(ids){
    if(ids===null)return this.fullUntil;
    let until=Infinity;
    for(const id of ids){const entry=this.entries.get(String(id)),covered=entry?.expiresAt??(this.fullIds&&!this.fullIds.has(String(id))?this.fullUntil:0);until=Math.min(until,covered);}
    return Number.isFinite(until)?until:0;
  }
  peek(id,{stale=false}={}){
    const entry=this.entries.get(String(id));
    if(!entry)return this.fullIds&&!this.fullIds.has(String(id))?{...unavailable(),stale:Boolean(stale||this.fullUntil<=this.now())}:null;
    // Touch only recency. A visit cannot extend the server's validity window.
    this.entries.delete(String(id));this.entries.set(String(id),entry);
    return {...(entry.value||unavailable()),stale:Boolean(stale||entry.value?.stale||entry.expiresAt<=this.now())};
  }
}

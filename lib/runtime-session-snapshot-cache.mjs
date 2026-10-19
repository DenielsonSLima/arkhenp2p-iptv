const MAX_TTL=2000,MAX_BYTES=8*1024*1024,MAX_ENTRIES=8;
const bounded=(value,limit)=>Number.isFinite(value)?Math.min(limit,Math.max(0,Math.floor(value))):limit;

/** Process-private encrypted snapshots only. Hits never renew their lifetime;
 * generation fences prevent an older in-flight read replacing a local commit. */
export class RuntimeSessionSnapshotCache{
  #entries=new Map();#bytes=0;#generation=0;
  constructor({now=Date.now,ttlMs=MAX_TTL,maxBytes=MAX_BYTES,maxEntries=MAX_ENTRIES}={}){
    this.now=now;
    this.ttlMs=bounded(ttlMs,MAX_TTL);
    this.maxBytes=bounded(maxBytes,MAX_BYTES);
    this.maxEntries=bounded(maxEntries,MAX_ENTRIES);
  }
  get generation(){return this.#generation;}
  get size(){this.#prune();return this.#entries.size;}
  get bytes(){this.#prune();return this.#bytes;}
  #drop(key){const entry=this.#entries.get(key);if(!entry)return false;this.#entries.delete(key);this.#bytes-=entry.bytes;return true;}
  #prune(){for(const[key,entry]of this.#entries)if(entry.expiresAt<=this.now())this.#drop(key);}
  get(key){this.#prune();return this.#entries.get(key)||null;}
  invalidate(key,expected){
    if(expected&&this.#entries.get(key)!==expected)return;
    this.#drop(key);this.#generation++;
  }
  set(key,row,{generation=this.#generation,createdAt=this.now()}={}){
    if(generation!==this.#generation)return false;
    this.#prune();
    if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key)||typeof row?.cipher!=='string'||!row.cipher||
      typeof row.mediaEpoch!=='string'||!/^[a-f0-9]{64}$/.test(row.mediaEpoch)||
      !Number.isFinite(createdAt)||createdAt>this.now()||createdAt+this.ttlMs<=this.now())return false;
    const previous=this.#entries.get(key);
    if(previous?.cipher===row.cipher&&previous.mediaEpoch===row.mediaEpoch)return true;
    const bytes=Buffer.byteLength(key)+Buffer.byteLength(row.cipher)+Buffer.byteLength(row.mediaEpoch);
    if(bytes>this.maxBytes||this.maxEntries<1)return false;
    this.#drop(key);
    while(this.#entries.size>=this.maxEntries||this.#bytes+bytes>this.maxBytes)this.#drop(this.#entries.keys().next().value);
    this.#entries.set(key,Object.freeze({cipher:row.cipher,mediaEpoch:row.mediaEpoch,expiresAt:createdAt+this.ttlMs,bytes}));
    this.#bytes+=bytes;this.#generation++;return true;
  }
  committed(key,row,{createdAt=this.now()}={}){
    const previous=this.get(key);
    // Every accepted commit fences pending full reads, including null-cipher
    // commits. An unchanged durable cipher retains its original expiry.
    this.#generation++;
    if(previous?.cipher===row?.cipher&&previous.mediaEpoch===row?.mediaEpoch)return;
    this.#drop(key);this.set(key,row,{createdAt});
  }
}

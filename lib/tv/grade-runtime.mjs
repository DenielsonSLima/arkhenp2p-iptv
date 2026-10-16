const HASH=/^[a-f0-9]{64}$/i,ID=/^[0-9]{1,12}$/;
const ZONES=new Set(['America/Maceio','America/Sao_Paulo','UTC']);
const object=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const valid=value=>value?.schemaVersion===1&&typeof value.revision==='string'&&typeof value.projectionVersion==='string'&&object(value.channels)&&Number.isFinite(Date.parse(value.asOf))&&Number.isFinite(Date.parse(value.nextRefreshAt));

/** Global, public-program metadata only. Account/PIN authorization is captured
 * by each caller and checked after awaits; it never becomes a shared cache key. */
export class TvGuideRuntime {
  constructor({now=Date.now,maxEntries=32}={}){this.now=now;this.maxEntries=maxEntries;this.entries=new Map();this.closed=false;}
  async get({providerKey,scopeHash,ids=null,includeAdult=false,timeZone='America/Maceio',fresh=false,read,current=()=>true}){
    if(this.closed||!HASH.test(providerKey||'')||!HASH.test(scopeHash||'')||!ZONES.has(timeZone)||!current())return null;
    if(ids!==null&&(!Array.isArray(ids)||ids.length>2000||ids.some(id=>!ID.test(String(id)))))return null;
    const key=JSON.stringify([providerKey,scopeHash,includeAdult===true,timeZone]);
    let entry=this.entries.get(key);
    const filter=data=>{
      if(!current()||!data)return null;
      return {...data,serverTime:new Date(this.now()).toISOString(),...(ids===null?{}:{channels:Object.fromEntries([...new Set(ids.map(String))].filter(id=>Object.hasOwn(data.channels,id)).map(id=>[id,data.channels[id]]))})};
    };
    if(entry?.failed&&entry.expiresAt>this.now())return filter(entry.data?{...entry.data,stale:true,retryAfterMs:5000}:null);
    if(entry?.data&&entry.expiresAt>this.now()&&(!fresh||entry.attemptedAt>this.now()-1000))return filter(entry.failed?{...entry.data,stale:true}:entry.data);
    if(!entry){entry={data:null,pending:null,expiresAt:0,attemptedAt:-Infinity,failed:false};this.entries.set(key,entry);}
    if(!entry.pending&&entry.attemptedAt<=this.now()-1000){
      entry.attemptedAt=this.now();
      entry.pending=Promise.resolve().then(()=>read({providerKey,scopeHash,includeAdult:includeAdult===true,timeZone})).then(data=>{
        if(!this.closed&&valid(data)){
          entry.data=data;entry.failed=false;entry.expiresAt=Math.min(Date.parse(data.nextRefreshAt),this.now()+60000);
        }else{entry.failed=true;entry.expiresAt=this.now()+5000;}
      }).catch(()=>{entry.failed=true;entry.expiresAt=this.now()+5000;}).finally(()=>{entry.pending=null;});
      while(this.entries.size>this.maxEntries){const oldest=[...this.entries].find(([,value])=>!value.pending);if(!oldest)break;this.entries.delete(oldest[0]);}
    }
    // Keep the last server-calculated window visible while its shared refresh
    // runs. Mark it stale instead of extending times or recalculating progress.
    if(entry.data&&entry.pending&&!fresh)return filter({...entry.data,stale:true,retryAfterMs:1000});
    if(entry.pending)await entry.pending;
    return filter(entry.failed&&entry.data?{...entry.data,stale:true,retryAfterMs:5000}:entry.data);
  }
  close(){this.closed=true;this.entries.clear();}
}

import {catalogReadLimiter} from '../catalog-snapshot-reader.mjs';
import {SharedLiveEPG} from './grade-compartilhada.mjs';
import {TvGuideRuntime} from './grade-runtime.mjs';
import {TvGuideCompat} from './grade-legada.mjs';
import {TvGuideProvider} from './grade-provedor.mjs';
import {TvGuidePublishedSchedule} from './grade-programacao-publicada.mjs';
import {cloudSourceScope} from '../supabase-cloud.mjs';

const usable=(guide,now)=>Object.values(guide?.channels||{}).some(channel=>[channel?.window?.current,channel?.window?.next].some(program=>typeof program?.title==='string'&&Date.parse(program.end)>now));
const channelEventCount=(channel,now)=>new Set([...(Array.isArray(channel?.schedule)?channel.schedule:[]),...(Array.isArray(channel?.list)?channel.list:[]),...Object.values(channel?.window||{})].filter(program=>typeof program?.title==='string'&&Date.parse(program.start)<Date.parse(program.end)&&Date.parse(program.end)>now).map(program=>JSON.stringify([program.title,Date.parse(program.start),Date.parse(program.end)]))).size;
const eventCount=(guide,now)=>Object.values(guide?.channels||{}).reduce((count,channel)=>count+channelEventCount(channel,now),0);
const retainsProgramming=(base,candidate,now)=>Object.entries(base?.channels||{}).every(([id,channel])=>{
  const replacement=candidate?.channels?.[id];
  for(const name of ['current','next']){const original=channel?.window?.[name],next=replacement?.window?.[name];if(typeof original?.title==='string'&&Date.parse(original.end)>now&&!(typeof next?.title==='string'&&Date.parse(next.end)>now))return false;}
  return channelEventCount(replacement,now)>=channelEventCount(channel,now);
});

/** TV metadata transport/cache. Auth provisioning, provider credentials,
 * collector jobs and media/engine lifecycle belong to their existing owners. */
export class ConectorTvSupabase{
  #closed=false;
  constructor({cloud=null,now=Date.now,maxEntries=32,maxReadEntries=256,isEnabled=()=>Boolean(cloud?.enabled),isClosed=()=>false,limitRead=catalogReadLimiter(2),onStatus=()=>{}}={}){
    Object.assign(this,{cloud,now,isEnabled,isClosed,limitRead});
    this.epgCache=new SharedLiveEPG({now,maxEntries:maxReadEntries});
    this.guideCache=new TvGuideRuntime({now,maxEntries});
    this.legacyGuide=new TvGuideCompat({now});
    this.providerGuide=new TvGuideProvider({now,maxEntries,onStatus});
    this.publishedSchedule=new TvGuidePublishedSchedule({now});
  }
  get closed(){return this.#closed||this.isClosed();}
  epg(state,id){
    if(this.closed||!this.isEnabled()||!state.cloud?.session?.access_token)return Promise.resolve(null);
    const account=state.cloud,{providerKey,scopeHash}=account,client=state.client,generation=state.authGeneration;
    const current=()=>!this.closed&&state.client===client&&state.authGeneration===generation&&state.cloud?.providerKey===providerKey&&state.cloud?.scopeHash===scopeHash&&state.cloud?.userId===account.userId&&state.cloud?.libraryId===account.libraryId;
    return this.epgCache.get({providerKey,scopeHash,id,current,
      read:ids=>{
        const params=new URLSearchParams({select:'channel_id,payload,expires_at',provider_key:'eq.'+providerKey,scope_hash:'eq.'+scopeHash,channel_id:'in.('+ids.join(',')+')',limit:String(ids.length)});
        // Rejected/expired Auth is a cache miss here; reading a guide never
        // provisions a session or introduces another blocking login.
        return this.limitRead(()=>current()?this.cloud.request('/rest/v1/provider_epg_cache?'+params,{publicKey:true,accessToken:account.session.access_token,timeoutMs:4000}):null);
      },
    });
  }
  async expandPublished(guide,{providerKey,scopeHash,includeAdult,timeZone,current,read}){
    if(!guide||!current())return null;
    if(guide.legacySnapshot===true){
      // Historical independently collected rows cannot certify the RPC's
      // revision. Return a whole legacy projection with its own provenance,
      // restricted to the authoritative RPC channel IDs and without data loss.
      const legacy=await this.legacyGuide.get({providerKey,scopeHash,includeAdult,timeZone,current,read});if(!legacy||!current())return null;
      const channels=Object.fromEntries(Object.keys(guide.channels||{}).filter(id=>Object.hasOwn(legacy.channels||{},id)).map(id=>[id,legacy.channels[id]])),expanded={...legacy,channels},now=this.now();
      if(!retainsProgramming(guide,expanded,now))return null;
      return usable(expanded,now)&&eventCount(expanded,now)>eventCount(guide,now)?expanded:null;
    }
    return this.publishedSchedule.enrich({guide,providerKey,scopeHash,current,read});
  }
  async guide(state,{ids=null,includeAdult=false,timeZone='America/Maceio',fresh=false}={}){
    const account=state.cloud,client=state.client,generation=state.authGeneration,pinUnlocked=state.parental?.unlocked===true,adult=includeAdult===true&&pinUnlocked;
    const current=()=>!this.closed&&state.client===client&&state.authGeneration===generation&&(state.parental?.unlocked===true)===pinUnlocked;
    if(!current()||!client?.session?.connected||client.authInfo?.service?.enabledLive===false)return null;
    let scope;try{scope=cloudSourceScope(client.libraryProvider||client.config?.provider,client.config?.server);}catch{return null;}
    const {providerKey,scopeHash}=scope;
    // A bootstrap/Edge outage must not disable metadata already authorized by
    // the provider. Cloud reads retain their own RLS/epoch boundary.
    const epoch=state.cloudEpoch||0,cloudCurrent=()=>current()&&(state.cloudEpoch||0)===epoch&&state.cloud===account;
    // Start independent metadata reads together: a 3s RPC miss plus legacy
    // reads must not consume the browser's entire guide deadline before WPLAY
    // recovery can even begin. All provider reads still join one 6h capture.
    let recoverySettled=false,publishedSettled=false,expansionSettled=false,recoveryValue=null,publishedValue=null,expansionValue=null;
    const recovery=this.providerGuide.get({client,providerKey,scopeHash,ids,includeAdult:adult,timeZone,current}).catch(()=>null).then(value=>{recoverySettled=true;recoveryValue=value;return value;});
    const published=(this.isEnabled()&&account?.session?.access_token&&account.providerKey===providerKey&&account.scopeHash===scopeHash?this.guideCache.get({providerKey,scopeHash,ids,includeAdult:adult,timeZone,fresh,current:cloudCurrent,
      read:async input=>{
        try{
          const result=await this.cloud.request('/rest/v1/rpc/arkhen_tv_guide',{method:'POST',body:{p_provider_key:input.providerKey,p_scope_hash:input.scopeHash,p_channel_ids:null,p_include_adult:input.includeAdult,p_time_zone:input.timeZone},timeoutMs:3000});
          if(result?.schemaVersion===1)return result;
        }catch{/* A rolling Edge deployment cannot erase the published guide. */}
        if(!cloudCurrent())return null;
        return this.legacyGuide.get({...input,current:cloudCurrent,read:(table,params)=>cloudCurrent()?this.cloud.request('/rest/v1/'+table+'?'+params,{publicKey:true,accessToken:account.session.access_token,timeoutMs:4000}):null});
      },
    }).catch(()=>null):Promise.resolve(null)).then(value=>{publishedSettled=true;publishedValue=value;return value;});
    const expansion=published.then(value=>this.expandPublished(value,{providerKey,scopeHash,includeAdult:adult,timeZone,current:cloudCurrent,
      read:(table,params,{signal,timeoutMs=4000}={})=>this.limitRead(()=>cloudCurrent()&&!signal?.aborted?this.cloud.request('/rest/v1/'+table+'?'+params,{publicKey:true,accessToken:account.session.access_token,timeoutMs,signal}):null),
    })).catch(()=>null).then(value=>{expansionSettled=true;expansionValue=value;return value;});
    let first=await Promise.race([published.then(value=>({origin:'shared',value})),recovery.then(value=>({origin:'provider',value}))]);
    if(!current())return null;
    if(!usable(first.value,this.now())||first.origin==='shared'&&!cloudCurrent()){
      const [shared,recovered]=await Promise.all([published,recovery]);if(!current())return null;
      // Preserve the original complete-provider/central fallback selection.
      first=usable(recovered,this.now())?{origin:'provider',value:recovered}:{origin:'shared',value:(cloudCurrent()?shared:null)||recovered};
    }
    if(usable(first.value,this.now())&&(first.origin!=='shared'||cloudCurrent())){
      const stamp=this.now(),firstCount=eventCount(first.value,stamp),counts=new Map();
      const protectedFirst=first.value.legacySnapshot===false&&first.value.stale!==true&&first.value.partial!==true;
      const acceptable=({origin,value})=>{
        if(!usable(value,this.now())||origin!=='provider'&&!cloudCurrent())return false;
        if(!counts.has(value))counts.set(value,eventCount(value,stamp));
        if(counts.get(value)<=firstCount||!retainsProgramming(first.value,value,stamp))return false;
        const firstFetched=Date.parse(first.value.snapshotFetchedAt),alternativeFetched=Date.parse(value.snapshotFetchedAt);
        return !(protectedFirst&&(value.partial===true||Number.isFinite(firstFetched)&&Number.isFinite(alternativeFetched)&&alternativeFetched<firstFetched));
      };
      const alternatives=[{origin:'expanded',promise:expansion,value:expansionValue,settled:expansionSettled},first.origin==='shared'?{origin:'provider',promise:recovery,value:recoveryValue,settled:recoverySettled}:{origin:'shared',promise:published,value:publishedValue,settled:publishedSettled}];
      let alternative=alternatives.find(acceptable);
      if(!alternative&&alternatives.some(entry=>!entry.settled)){
        // An older RPC may win every race while the provider capture is
        // already cached. Give only the existing independent read a short
        // chance to supply its entire richer projection; never mix revisions.
        let timer;
        const richer=new Promise(resolve=>{let remaining=alternatives.length;for(const entry of alternatives)entry.promise.then(value=>{const candidate={origin:entry.origin,value};if(acceptable(candidate))resolve(candidate);else if(--remaining===0)resolve(null);});});
        try{alternative=await Promise.race([richer,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),120);})]);}
        finally{clearTimeout(timer);}
        if(!current())return null;
      }
      // DTO additions come from its certified revision; choosing another
      // whole projection retains its own revision and quality guards.
      if(alternative&&acceptable(alternative))return alternative.value;
      // The shared browser query already honours retryAfterMs and fresh=1.
      // Retry promptly only while that same whole-file capture is pending;
      // a failed/missing provider must not create permanent five-second reads.
      if(first.origin==='shared'&&!cloudCurrent())return null;
      const pending=!recoverySettled||cloudCurrent()&&(!publishedSettled||!expansionSettled);
      return pending?{...first.value,schedulePending:true,retryAfterMs:5000}:first.value;
    }
    return first.origin!=='shared'||cloudCurrent()?first.value:null;
  }
  invalidate(providerKey,scopeHash){this.epgCache.invalidate(providerKey,scopeHash);}
  close(){this.#closed=true;this.epgCache.close();this.guideCache.close();this.legacyGuide.close();this.providerGuide.close();this.publishedSchedule.close();}
}

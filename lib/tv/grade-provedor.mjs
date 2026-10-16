import {createHash} from 'node:crypto';
import {isAdultItem} from '../../web/parental-classification.js';
import {epgTimestamp,wplayEPGChannelID,wplayEPGSnapshot} from '../wplay-epg.mjs';
import {projectTvGuide} from './grade-legada.mjs';

const SIX_HOURS=21600000,RETRY_MS=30000,MAX_CHANNELS=2000,MAX_PROGRAMS=250000;
const ID=/^\d{1,12}$/,HASH=/^[a-f0-9]{64}$/i,ZONES=new Set(['America/Maceio','America/Sao_Paulo','UTC']);
const failure=code=>Object.assign(new Error('A programação não pôde ser atualizada.'),{code});
const text=(value,max)=>typeof value==='string'?value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/(?:https?:)?\/\/[^\s<>"']+/gi,'').trim().slice(0,max):'';
const active=(client,now)=>{
  const account=client?.session?.account,expires=account?.expiresAt,validated=Number(client?.authenticatedAt);
  return Boolean(client?.session?.connected&&String(account?.status||'').toLowerCase()==='active'&&(!expires||Number.isFinite(Date.parse(expires))&&Date.parse(expires)>now)&&Number.isFinite(validated)&&validated>0&&validated<=now+60000&&now-validated<=86400000);
};

/** Reuse only this account's authorized live catalog. When absent, read ch_url
 * with its EXISTING token; catalog()/connect() would create an unrelated login. */
export async function readWplayLiveCatalog(client,{current=()=>true,fresh=false,now=Date.now}={}){
  const auth=client?.authInfo,session=client?.session,sourceCurrent=()=>current()&&client?.authInfo===auth&&client?.session===session&&active(client,now())&&client.authInfo?.service?.enabledLive!==false;
  if(!sourceCurrent())throw failure('WPLAY_EPG_SOURCE_UNAVAILABLE');
  if(fresh)client.cache?.delete('catalog:live');
  const cached=client.cache?.get('catalog:live');
  if(cached?.promise)return cached.promise;
  if(!client.authInfo?.service?.ch_url||typeof client.normalizeItems!=='function')throw failure('WPLAY_EPG_CATALOG_UNAVAILABLE');
  const entry={time:now(),promise:null};
  entry.promise=Promise.resolve().then(()=>client.requestJSON(client.serviceURL('ch_url'),{timeout:8000})).then(payload=>{
    if(!sourceCurrent())throw failure('WPLAY_EPG_SOURCE_CANCELLED');
    if(!Array.isArray(payload)||payload.length>MAX_CHANNELS)throw failure('WPLAY_EPG_CATALOG_INVALID');
    return client.normalizeItems(payload,'live');
  });
  client.cache.set('catalog:live',entry);
  void entry.promise.catch(()=>{if(client.cache.get('catalog:live')===entry)client.cache.delete('catalog:live');});
  return entry.promise;
}

/** Whole provider/scope capture, independent of Supabase or playback. Shared
 * metadata contains no tokens/URLs and is filtered against each caller's live
 * entitlement catalog and PIN before returning a projection. */
export class TvGuideProvider{
  constructor({now=Date.now,maxEntries=8,onStatus=()=>{}}={}){
    Object.assign(this,{now,onStatus});this.maxEntries=Number.isFinite(maxEntries)?Math.max(1,Math.min(8,Math.trunc(maxEntries))):8;this.entries=new Map();this.closed=false;
  }
  status(value){try{this.onStatus(Object.freeze(value));}catch{/* Diagnostics cannot fail a metadata read. */}}
  async capture({client,providerKey,scopeHash}={}){
    if(this.closed||!HASH.test(providerKey||'')||!HASH.test(scopeHash||'')||!active(client,this.now())||client.authInfo?.service?.enabledLive===false||!client.authInfo?.service?.epg_url||typeof client.serviceURL!=='function'||typeof client.requestJSON!=='function')return null;
    const auth=client.authInfo,session=client.session,sourceCurrent=()=>!this.closed&&client.authInfo===auth&&client.session===session&&active(client,this.now());
    const key=JSON.stringify([providerKey,scopeHash]);let entry=this.entries.get(key);
    if(!entry){
      while(this.entries.size>=this.maxEntries){const old=[...this.entries].find(([,v])=>!v.pending);if(!old)return null;this.entries.delete(old[0]);}
      entry={data:null,pending:null,retryAt:0,controller:null,forceNext:false};this.entries.set(key,entry);
    }
    if((!entry.data||entry.data.expires<=this.now())&&!entry.pending&&entry.retryAt<=this.now()){
      const controller=new AbortController();entry.controller=controller;
      const started=this.now(),force=entry.forceNext;entry.forceNext=false;
      entry.pending=wplayEPGSnapshot(client,{cacheMs:SIX_HOURS,now:this.now,signal:controller.signal,force}).then(snapshot=>{
        if(!sourceCurrent()||controller.signal.aborted)throw failure('WPLAY_EPG_SOURCE_CANCELLED');
        if(snapshot.error||snapshot.stale)throw snapshot.error||failure('WPLAY_EPG_INCOMPLETE');
        const partial=!snapshot.coverage||snapshot.coverage.invalidChannels>0||snapshot.coverage.invalidPrograms>0;
        if(entry.data&&!entry.data.partial&&(partial||[...entry.data.guides.keys()].some(id=>!snapshot.guides.has(id))))throw failure('WPLAY_EPG_PARTIAL');
        let total=0,horizon=null;const guides=new Map(),digest=createHash('sha256').update(key);
        for(const [id,rows] of snapshot.guides){
          const list=[];
          for(const row of rows){
            const title=text(row.title,1000),start=epgTimestamp(row.start),end=epgTimestamp(row.end);
            if(!title||start===null||end===null||end<=start)continue;
            if(++total>MAX_PROGRAMS)throw failure('WPLAY_EPG_TOO_LARGE');
            horizon=horizon===null?end:Math.max(horizon,end);
            list.push({title,description:text(row.description,5000),start:new Date(start).toISOString(),end:new Date(end).toISOString(),startMs:start,endMs:end});
          }
          guides.set(id,list);digest.update(JSON.stringify([id,list]));
        }
        if(!total||horizon<=this.now())throw failure('WPLAY_EPG_EMPTY');
        const fetched=Number.isFinite(snapshot.fetchedAt)?snapshot.fetchedAt:this.now();
        entry.data={guides,revision:'wplay-epg:'+digest.digest('hex'),fetched,expires:fetched+(partial?RETRY_MS:SIX_HOURS),horizon,partial};entry.retryAt=0;
        this.status({phase:'provider-epg',state:partial?'partial':'ready',channels:guides.size,programs:total,invalidChannels:snapshot.coverage?.invalidChannels||0,invalidPrograms:snapshot.coverage?.invalidPrograms||0,durationMs:this.now()-started});
      }).catch(error=>{
        if(['WPLAY_EPG_PARTIAL','WPLAY_EPG_EMPTY'].includes(error?.code))entry.forceNext=true;
        entry.retryAt=this.now()+(error?.code==='WPLAY_EPG_SOURCE_CANCELLED'?1000:RETRY_MS);
        this.status({phase:'provider-epg',state:'unavailable',code:/^[A-Z_]{1,80}$/.test(error?.code||'')?error.code:'WPLAY_EPG_UNAVAILABLE',durationMs:this.now()-started});
      }).finally(()=>{entry.pending=null;entry.controller=null;});
    }
    if(entry.pending)await entry.pending;
    return sourceCurrent()?entry.data:null;
  }
  async get({client,providerKey,scopeHash,ids=null,includeAdult=false,timeZone='America/Maceio',current=()=>true}={}){
    if(this.closed||!current()||!ZONES.has(timeZone)||!active(client,this.now())||client.authInfo?.service?.enabledLive===false||!client.authInfo?.service?.epg_url)return null;
    if(ids!==null&&(!Array.isArray(ids)||ids.length>MAX_CHANNELS||ids.some(id=>!ID.test(String(id)))))return null;
    const auth=client.authInfo,session=client.session,sourceCurrent=()=>!this.closed&&client.authInfo===auth&&client.session===session&&active(client,this.now());
    // All read projections join one capture; card/channel IDs never select a
    // separate provider download or renew the capture's six-hour lifetime.
    const [catalogResult,captureResult]=await Promise.allSettled([readWplayLiveCatalog(client,{current:sourceCurrent,now:this.now}),this.capture({client,providerKey,scopeHash})]);
    if(this.closed||!current()||!sourceCurrent()||catalogResult.status!=='fulfilled'||captureResult.status!=='fulfilled'||!captureResult.value)return null;
    const catalog=catalogResult.value;
    if(!Array.isArray(catalog?.items)||!Array.isArray(catalog.categories)||catalog.items.length>MAX_CHANNELS||catalog.pagination)return null;
    const raw=captureResult.value,eligible=new Map(),programs=new Map(),wanted=ids===null?null:new Set(ids.map(String));let missing=0;
    for(const item of catalog.items){
      const id=String(item?.id??'');if(item?.kind!=='live'||!ID.test(id)||wanted&&!wanted.has(id))continue;
      const adult=isAdultItem(item,catalog.categories);if(adult&&!includeAdult)continue;
      const sourceId=wplayEPGChannelID(client.rawItems?.get('live:'+id),id);
      if(!raw.guides.has(sourceId))missing++;
      eligible.set(id,adult);programs.set(id,raw.guides.get(sourceId)||[]);
    }
    if(!current())return null;
    return projectTvGuide({...raw,eligible,programs},includeAdult,timeZone,this.now(),{source:'wplay-epg',legacySnapshot:false,partial:raw.partial||missing>0,stale:raw.expires<=this.now()||raw.horizon<=this.now()});
  }
  close(){this.closed=true;for(const entry of this.entries.values())entry.controller?.abort();this.entries.clear();}
}

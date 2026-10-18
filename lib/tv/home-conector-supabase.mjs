import {randomUUID} from 'node:crypto';
import {currentPlaybackIntent} from '../live-playback-session.mjs';
import {isAdultItem} from '../../web/parental-classification.js';
import {homeTvChannelId} from './home-request.mjs';
import {homeTVReply} from '../../web/inicio/lista-canais/contrato.js';

const HASH=/^[a-f0-9]{64}$/i;
const unavailable=()=>Object.assign(new Error('A seleção de canais está temporariamente indisponível.'),{status:503,code:'TV_HOME_UNAVAILABLE'});
const inactive=()=>Object.assign(new Error('Esta reprodução de TV foi encerrada.'),{status:409,code:'TV_WATCH_INACTIVE'});
const heartbeatValue=value=>value?.schemaVersion===1&&typeof value.accepted==='boolean'&&Number.isFinite(value.creditedSeconds)&&value.creditedSeconds>=0&&value.creditedSeconds<=20;
const visible=(item,input,categories)=>item?.kind==='live'&&homeTvChannelId(item.id)&&item.available!==false&&!isAdultItem(item,categories)&&!input.hiddenItems.includes(item.id)&&
  (!(item.categoryIds?.length||item.categoryId)||[...(Array.isArray(item.categoryIds)?item.categoryIds:[]),item.categoryId].filter(id=>id!==undefined&&id!==null).some(id=>!input.hidden.includes(String(id))));

/** Separate owner-scoped Home TV reads and real-player pulses. No new SDK,
 * provider login, engine, Realtime subscription or catalog collector is owned
 * here. The browser cannot supply the database lease, sequence or elapsed time. */
export class ConectorHomeTvSupabase{
  constructor({runtime}={}){this.runtime=runtime;this.queues=new WeakMap();this.leases=new WeakMap();this.catalogues=new WeakMap();}
  context(state,{signal,current=()=>true}={}){
    const runtime=this.runtime,account=state.cloud,client=state.client,generation=state.authGeneration,pin=state.parental?.unlocked===true;
    if(!client?.session?.connected)throw Object.assign(new Error('Esta sessão de TV foi encerrada.'),{status:401,code:'TV_SESSION_REQUIRED'});
    if(client.authInfo?.service?.enabledLive===false)throw Object.assign(new Error('TV ao vivo indisponível para esta conta.'),{status:403,code:'TV_LIVE_DISABLED'});
    if(runtime.closed||!runtime.enabled||!account?.session?.access_token||!HASH.test(account.providerKey||'')||!HASH.test(account.scopeHash||''))throw unavailable();
    return {account,client,current:()=>current()&&!signal?.aborted&&!runtime.closed&&state.cloud===account&&state.client===client&&state.authGeneration===generation&&(state.parental?.unlocked===true)===pin,
      options:{publicKey:true,accessToken:account.session.access_token,timeoutMs:5000,...(signal?{signal}:{})}};
  }
  async read(state,input,options={}){
    const context=this.context(state,options),{account,client,current}=context;
    if(!current())throw inactive();
    // The TV RPC resolves eligibility against its published live generation.
    // Five cards never wait for a full catalog download or a VOD projection.
    const result=await this.runtime.cloud.request('/rest/v1/rpc/arkhen_home_tv_catalog',{
      ...context.options,method:'POST',body:{p_provider_key:account.providerKey,p_scope_hash:account.scopeHash,p_hidden_categories:input.hidden,p_hidden_items:input.hiddenItems},
    });
    if(!current())throw inactive();
    try{homeTVReply(result);}catch{throw unavailable();}
    for(const entry of result.items)if(!visible(entry.item,input,[]))throw unavailable();
    const catalogue={items:result.items.map(entry=>entry.item),categories:[]};
    state.parental?.rememberCatalog(catalogue,'live');
    this.catalogues.set(state,{account,client,items:new Map(catalogue.items.map(item=>[item.id,item])),categories:[]});
    return result;
  }
  enqueue(state,task){
    // A state-local queue prevents reordered requests from switching the SQL
    // lease back to an old attempt. It never serializes another account.
    const previous=this.queues.get(state)||Promise.resolve();
    const operation=previous.catch(()=>{}).then(task);
    const settled=operation.catch(()=>{});this.queues.set(state,settled);
    settled.finally(()=>{if(this.queues.get(state)===settled)this.queues.delete(state);});
    return operation;
  }
  heartbeat(state,input,options={}){return this.enqueue(state,()=>this.pulse(state,input,options));}
  finish(state,client,{intent=state.playbackIntent}={}){
    // Capture while STOP/new intent still owns the old real-player reference.
    // The queue may finish SQL after its transport has already been retired.
    if(!intent||!/^live:\d{1,12}$/.test(intent.key)||(intent.purpose||'playback')!=='playback'||intent.authGeneration!==state.authGeneration||state.client!==client)return Promise.resolve(null);
    let context;try{context=this.context(state,{signal:AbortSignal.timeout(6000)});}catch{return Promise.resolve(null);}
    const id=intent.key.slice(5);
    return this.enqueue(state,async()=>{
      const {account,current}=context,lease=this.leases.get(intent)||intent.watchLease;
      if(!current()||!lease||lease.sequence<0&&!lease.pending)return null;
      const send=async playing=>{
        if(!current())return null;
        const pending=lease.pending||{sequence:lease.sequence+1,playing};
        if(!Number.isSafeInteger(pending.sequence))return null;
        lease.pending=pending;
        const value=await this.runtime.cloud.request('/rest/v1/rpc/arkhen_tv_watch_heartbeat',{
          ...context.options,method:'POST',body:{p_provider_key:account.providerKey,p_scope_hash:account.scopeHash,p_channel_id:id,p_session_id:lease.id,p_sequence:pending.sequence,p_playing:pending.playing},
        });
        if(!heartbeatValue(value))throw unavailable();
        lease.pending=null;
        if(value.accepted||lease.sequence>=0&&value.reason==='channel-ineligible')lease.sequence=pending.sequence;
        lease.playing=value.accepted&&pending.playing;lease.lastSentAt=this.runtime.now();
        return value;
      };
      if(lease.pending){const acknowledged=await send(lease.pending.playing);if(!acknowledged?.accepted)return acknowledged;}
      if(!current()||!lease.playing)return null;
      return send(false);
    });
  }
  async pulse(state,input,options){
    const context=this.context(state,options),{account,client,current}=context;
    const intent=currentPlaybackIntent(state,client,{kind:'live',id:input.id,attempt:input.attempt,purpose:'playback',active:input.playing});
    if(!current()||!intent)throw inactive();
    const cached=this.catalogues.get(state),catalogue=cached?.account===account&&cached.client===client?cached:null;
    const item=catalogue?.items.get(input.id)||state.parental?.items.get('live:'+input.id);
    const categories=catalogue?.categories||[...(state.parental?.categories.get('live')?.values()||[])];
    // Even with PIN unlocked, protected/unclassified channels never become
    // persisted watch time. Playback itself remains independently authorized.
    let lease=this.leases.get(intent)||intent.watchLease;
    const eligible=Boolean(item&&(item.classified||catalogue?.items.has(input.id))&&visible(item,input,categories));
    if(!lease&&(!eligible||!input.playing))return {schemaVersion:1,accepted:false,reason:eligible?'session-not-started':'channel-ineligible',creditedSeconds:0};
    if(!lease){lease={id:randomUUID(),sequence:-1,playing:false,lastSentAt:0,pending:null};this.leases.set(intent,lease);}
    intent.watchLease=lease;
    const desired=eligible&&input.playing;
    const send=async playing=>{
      if(!current()||currentPlaybackIntent(state,client,{kind:'live',id:input.id,attempt:input.attempt,purpose:'playback',active:input.playing})!==intent)throw inactive();
      const pending=lease.pending||{sequence:lease.sequence+1,playing};
      if(!Number.isSafeInteger(pending.sequence))throw inactive();
      lease.pending=pending;
      const value=await this.runtime.cloud.request('/rest/v1/rpc/arkhen_tv_watch_heartbeat',{
        ...context.options,method:'POST',body:{p_provider_key:account.providerKey,p_scope_hash:account.scopeHash,p_channel_id:input.id,p_session_id:lease.id,p_sequence:pending.sequence,p_playing:pending.playing},
      });
      if(!heartbeatValue(value))throw unavailable();
      // Preserve the exact pending value across uncertain transport failures.
      // A pause cannot reuse an unacknowledged playing sequence with a new body.
      lease.pending=null;
      if(value.accepted||lease.sequence>=0&&value.reason==='channel-ineligible')lease.sequence=pending.sequence;
      lease.playing=value.accepted&&pending.playing;lease.lastSentAt=this.runtime.now();
      return value;
    };
    if(lease.pending&&lease.pending.playing!==desired){
      const acknowledged=await send(lease.pending.playing);if(!acknowledged.accepted)return acknowledged;
    }
    if(!lease.pending&&lease.sequence>=0&&lease.playing===desired&&(!desired||this.runtime.now()-lease.lastSentAt<10000))return {schemaVersion:1,accepted:eligible,duplicate:true,creditedSeconds:0,...(!eligible?{reason:'channel-ineligible'}:{})};
    const result=await send(desired);
    if(!current())throw inactive();
    return eligible?result:{...result,accepted:false,reason:'channel-ineligible'};
  }
}

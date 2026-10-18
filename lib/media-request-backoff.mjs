import {ProviderError} from './provider.mjs';
import {liveRetryAfter} from './live-playback-session.mjs';

/** A provider cooldown belongs to the authenticated client, never to the
 * public catalogue. Range probes and playlist polls share the same pause. */
export class MediaRequestBackoff{
  constructor({now=Date.now}={}){this.now=now;this.clients=new WeakMap();}
  #state(client){let state=this.clients.get(client)||client.runtimeMediaBackoff;if(!state)state={keys:new Map(),origins:new Map(),failures:new Map()};this.clients.set(client,state);client.runtimeMediaBackoff=state;return state;}
  #origin(source){try{return new URL(source).origin;}catch{return null;}}
  #put(map,key,value,limit=128){map.delete(key);map.set(key,value);while(map.size>limit)map.delete(map.keys().next().value);}
  remaining(client,key,source){
    const state=this.#state(client),origin=this.#origin(source),until=Math.max(state.keys.get(key)||0,origin?state.origins.get(origin)||0:0);
    return Math.max(0,Math.ceil((until-this.now())/1000));
  }
  assert(client,key,source){
    const seconds=this.remaining(client,key,source);if(!seconds)return;
    const state=this.#state(client),origin=this.#origin(source),until=Math.max(state.keys.get(key)||0,origin?state.origins.get(origin)||0:0);
    this.#put(state.keys,key,until);
    const error=new ProviderError('O provedor solicitou uma pausa antes de retomar esta transmissão.',key.startsWith('live:')?'LIVE_RATE_LIMITED':'PLAYBACK_RATE_LIMITED',429);error.retryAfterSeconds=seconds;error.mediaCooldown=true;throw error;
  }
  failure(client,key,{status,upstreamStatus=null,code='PLAYBACK_UPSTREAM_HTTP',retryAfter,source,attempt=''}={}){
    const state=this.#state(client),observedAt=this.now();
    if(status===429){const until=observedAt+liveRetryAfter(retryAfter,observedAt)*1000;this.#put(state.keys,key,Math.max(until,state.keys.get(key)||0));const origin=this.#origin(source);if(origin)this.#put(state.origins,origin,Math.max(until,state.origins.get(origin)||0),32);}
    this.#put(state.failures,key,{status,upstreamStatus,code:/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:'PLAYBACK_UPSTREAM_HTTP',observedAt,attempt});
  }
  success(client,key){this.#state(client).failures.delete(key);}
  status(client,key,attempt=''){
    const last=this.#state(client).failures.get(key),retryAfterSeconds=this.remaining(client,key);
    if(retryAfterSeconds)return {status:429,code:key.startsWith('live:')?'LIVE_RATE_LIMITED':'PLAYBACK_RATE_LIMITED',retryAfterSeconds};
    return last&&last.status!==429&&last.attempt===attempt&&this.now()-last.observedAt<60000?{status:last.status,upstreamStatus:last.upstreamStatus,code:last.code,retryAfterSeconds:0}:null;
  }
}

import {ProviderError} from './provider.mjs';

const cancelled=()=>new ProviderError('Esta seleção de canal foi encerrada.','PLAYBACK_CANCELLED',409);

/** One browser opening owns a generation; playlist polls are only readers. */
export function reservePlaybackIntent(state,client,{kind,id,attempt='',sourceId='',purpose='playback'}){
  if(attempt&&!/^[a-zA-Z0-9_-]{1,100}$/.test(attempt))throw new ProviderError('Seleção de canal inválida.','INVALID_PLAYBACK_ATTEMPT',400);
  if(!['playback','preview'].includes(purpose)||purpose==='preview'&&(kind!=='live'||!attempt))throw new ProviderError('Finalidade de reprodução inválida.','INVALID_PLAYBACK_PURPOSE',400);
  if(state.liveIntentScope!==state.authGeneration){state.liveIntentScope=state.authGeneration;state.retiredLiveAttempts=new Set();}
  if(sourceId&&!/^[nwo]_[a-f0-9]{28}$/.test(sourceId))throw new ProviderError('Fonte de canal inválida.','INVALID_PLAYBACK_SOURCE',400);
  const key=`${kind}:${id}`,previous=state.playbackIntent,liveAttempt=attempt;
  if(liveAttempt&&state.retiredLiveAttempts.has(liveAttempt))throw cancelled();
  if(previous?.key===key&&previous.attempt===liveAttempt&&previous.sourceId===sourceId&&previous.authGeneration===state.authGeneration){
    // A manifest poll cannot promote a silent preview into a watched session.
    // The real player receives a new attempt and performs the normal handoff.
    if((previous.purpose||'playback')!==purpose)throw cancelled();
    if(previous.generation===client.playbackGeneration)return previous;
    if(liveAttempt)throw cancelled();
  }
  if(previous?.attempt){
    state.retiredLiveAttempts.add(previous.attempt);
    while(state.retiredLiveAttempts.size>128)state.retiredLiveAttempts.delete(state.retiredLiveAttempts.values().next().value);
  }
  return state.playbackIntent={key,attempt:liveAttempt,sourceId,purpose,generation:++client.playbackGeneration,authGeneration:state.authGeneration};
}

/** Match the one current server intent. IDs, attempts and generation come from
 * the authorized opening; callers never obtain an upstream URL or provider sid. */
export function currentPlaybackIntent(state,client,{kind,id,attempt,purpose,active=false}={}){
  const intent=state.playbackIntent;
  if(!client||!intent||state.client!==client||intent.authGeneration!==state.authGeneration||intent.generation!==client.playbackGeneration)return null;
  if(kind!==undefined&&intent.key!==`${kind}:${id}`||attempt!==undefined&&intent.attempt!==attempt||purpose!==undefined&&(intent.purpose||'playback')!==purpose)return null;
  if(active&&(!client.playback||client.playback.key!==intent.key||!client.playback.controller?.signal||client.playback.controller.signal.aborted))return null;
  return intent;
}

/** Tombstone a canceled opening even if its first GET has not arrived. A stale
 * preview callback cannot invalidate the token of the current real player. */
export function retirePlaybackAttempt(state,client,attempt){
  if(state.client!==client||typeof attempt!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(attempt))return false;
  if(currentPlaybackIntent(state,client)?.attempt===attempt)return false;
  if(state.liveIntentScope!==state.authGeneration){state.liveIntentScope=state.authGeneration;state.retiredLiveAttempts=new Set();}
  state.retiredLiveAttempts.add(attempt);
  while(state.retiredLiveAttempts.size>128)state.retiredLiveAttempts.delete(state.retiredLiveAttempts.values().next().value);
  return true;
}

/** Cancel preparation when this HTTP reader goes away, without owning playback. */
export function playbackReader(req,res){
  const controller=new AbortController(),cancel=()=>controller.abort();
  req.once('aborted',cancel);res.once('close',cancel);
  if(req.aborted||res.destroyed)cancel();
  return {signal:controller.signal,dispose(){req.off('aborted',cancel);res.off('close',cancel);}};
}

export function liveRetryAfter(value,now=Date.now()){
  const raw=Array.isArray(value)?value[0]:value;
  const seconds=typeof raw==='string'&&/^\d+(?:\.\d+)?$/.test(raw)?Number(raw):typeof raw==='string'?(Date.parse(raw)-now)/1000:NaN;
  // Preserve longer provider pauses; the UI only retries automatically <=35s.
  return Math.ceil(Math.max(1,Math.min(604800,Number.isFinite(seconds)?seconds:30)));
}

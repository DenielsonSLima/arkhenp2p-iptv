// Explicit browser-session DTO. Sources: app-server.mjs, cloud-runtime.mjs,
// parental-control.mjs, live-playback-session.mjs and tv/home-conector-supabase.mjs.
// Provider runtime hooks own upstream sessions; no library/progress or global
// caches enter this snapshot. Constructors/restoration must never authenticate.
const busy=()=>Object.assign(new Error('A sessão ainda está concluindo uma operação.'),{code:'RUNTIME_SESSION_BUSY',status:503});
const invalid=()=>Object.assign(new Error('Estado da sessão indisponível.'),{code:'RUNTIME_SESSION_INVALID',status:503});

function watchLease(value) {
  return value?{id:value.id,sequence:value.sequence,playing:value.playing===true,lastSentAt:value.lastSentAt,
    pending:value.pending?{sequence:value.pending.sequence,playing:value.pending.playing===true}:null}:null;
}

function playbackIntent(value) {
  return value?{key:value.key,attempt:value.attempt,sourceId:value.sourceId,purpose:value.purpose||'playback',
    generation:value.generation,authGeneration:value.authGeneration,
    ...(value.watchLease?{watchLease:watchLease(value.watchLease)}:{})}:null;
}

function clientRecord(value,client,fields) {
  if(!value||!client||value.client!==client)return null;
  return Object.fromEntries(fields.map(field=>[field,value[field]??null]));
}

export function captureRuntimeSession(state) {
  if(!state?.parental)throw invalid();
  // Root waits for these operations before committing. Serializing only the
  // apparent result while their promises still run would revive stale rights.
  if(state.cloudPending||state.cloudValidationPending||state.cloudRecovery?.pending)throw busy();
  const client=state.client,parental=state.parental,cloud=state.cloud??null;
  if(state.loggedOut&&client||cloud&&(!client||state.cloudClient!==client))throw invalid();
  const validation=clientRecord(state.cloudValidationRetry,client,['generation','epoch','attempts','retryAt']);
  return {version:1,client:client?.exportRuntimeState()??null,provider:client?.libraryProvider??null,
    authGeneration:state.authGeneration||0,loggedOut:state.loggedOut===true,seen:state.seen,
    attempts:[...(state.attempts??[])],parental:parental.exportRuntimeState(),
    playbackIntent:playbackIntent(state.playbackIntent),liveIntentScope:state.liveIntentScope??null,
    retiredLiveAttempts:new Set(state.retiredLiveAttempts??[]),
    cloud,cloudClientOwned:!!client&&state.cloudClient===client,cloudStatus:state.cloudStatus??null,
    cloudExpiresAt:state.cloudExpiresAt||0,cloudEpoch:state.cloudEpoch||0,cloudValidationKey:state.cloudValidationKey??null,
    cloudRetry:clientRecord(state.cloudRetry,client,['epoch','generation','libraryId','attempts','retryAt']),
    cloudDenial:clientRecord(state.cloudDenial,client,['generation','libraryId','status','expiresAt','validatedAt']),
    cloudValidationRetry:validation&&state.cloudValidationRetry.identity===cloud?validation:null};
}

export async function restoreRuntimeSession(dto,{createClient,createState}={}) {
  if(dto?.version!==1||typeof createState!=='function'||!dto.parental)throw invalid();
  if(dto.loggedOut&&dto.client||dto.cloud&&(!dto.client||dto.cloudClientOwned!==true))throw invalid();
  const state=await createState();
  if(!state?.parental)throw invalid();
  let client=null;
  if(dto.client){
    if(typeof createClient!=='function')throw invalid();
    client=await createClient({provider:dto.provider,config:dto.client.config});
    if(typeof client?.restoreRuntimeState!=='function')throw invalid();
    client.restoreRuntimeState(dto.client);client.libraryProvider=dto.provider;
  }
  state.client=client;state.authGeneration=dto.authGeneration||0;state.loggedOut=dto.loggedOut===true;
  if(Number.isFinite(dto.seen))state.seen=dto.seen;
  state.attempts=[...(dto.attempts??[])];
  state.parental.restoreRuntimeState(dto.parental);
  state.playbackIntent=playbackIntent(dto.playbackIntent);state.liveIntentScope=dto.liveIntentScope??null;
  state.retiredLiveAttempts=new Set(dto.retiredLiveAttempts??[]);
  state.cloud=dto.cloud??null;state.cloudClient=state.cloud&&dto.cloudClientOwned?client:null;
  state.cloudStatus=dto.cloudStatus??null;state.cloudExpiresAt=dto.cloudExpiresAt||0;state.cloudEpoch=dto.cloudEpoch||0;
  state.cloudValidationKey=dto.cloudValidationKey??null;
  state.cloudRetry=client&&dto.cloudRetry?{...dto.cloudRetry,client}:null;
  state.cloudDenial=client&&dto.cloudDenial?{...dto.cloudDenial,client}:null;
  state.cloudValidationRetry=client&&state.cloud&&dto.cloudValidationRetry?{...dto.cloudValidationRetry,client,identity:state.cloud}:null;
  state.cloudPending=null;state.cloudValidationPending=null;state.cloudRecovery=null;
  return state;
}

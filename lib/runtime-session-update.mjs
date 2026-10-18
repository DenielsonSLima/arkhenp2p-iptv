import {randomUUID} from 'node:crypto';

const failure=code=>Object.assign(new Error('Não foi possível atualizar o estado de reprodução.'),{status:503,code});
const pause=(milliseconds,signal)=>new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(failure('RUNTIME_SESSION_CANCELLED'));return;}
  const finish=()=>{signal?.removeEventListener('abort',cancel);resolve();};
  const timer=setTimeout(finish,milliseconds);
  const cancel=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);reject(failure('RUNTIME_SESSION_CANCELLED'));};
  signal?.addEventListener('abort',cancel,{once:true});
});

/** Persist a rare readonly-media failure against the latest fenced snapshot.
 * update must be pure (no provider/network side effects); validate returns its
 * authorization/media epoch. Never merge the reader's older state here. */
export async function updateRuntimeSession({cloud,store,sessionHash,expectedEpoch,capture,restore,validate,update,
  signal,now=Date.now,timeoutMs=12000}){
  if(typeof expectedEpoch!=='string'||!expectedEpoch||typeof validate!=='function'||typeof update!=='function')
    throw failure('RUNTIME_SESSION_INVALID');
  const budget=Number.isFinite(timeoutMs)?Math.min(12000,Math.max(0,timeoutMs)):12000;
  const owner=randomUUID(),deadline=now()+budget;
  const assertCancelled=()=>{if(signal?.aborted)throw failure('RUNTIME_SESSION_CANCELLED');};
  let row=null,leased=false,released=false,releaseEpoch,leaseUntil;
  const args=()=>({p_session_hash:sessionHash,p_owner:owner,p_fence:row.fence,p_revision:row.revision});
  const assertLease=()=>{
    assertCancelled();
    if(!Number.isFinite(leaseUntil)||now()>=leaseUntil)throw failure('RUNTIME_SESSION_LEASE_LOST');
  };
  const rpc=async(operation,args)=>{
    try{return await cloud.runtimeSessionRPC(operation,args);}
    catch(error){throw typeof error?.code==='string'&&error.code.startsWith('RUNTIME_SESSION_')?error:failure('RUNTIME_SESSION_UNAVAILABLE');}
  };
  try{
    do{
      assertCancelled();
      row=await rpc('acquire',{p_session_hash:sessionHash,p_owner:owner,p_create:false});
      if(!row?.busy)break;
      assertCancelled();
      const remaining=deadline-now();
      if(remaining<=0)throw failure('RUNTIME_SESSION_BUSY');
      await pause(Math.min(remaining,Math.max(25,Math.min(350,Number(row.retryAfterMs)||250))),signal);
      if(now()>=deadline)throw failure('RUNTIME_SESSION_BUSY');
    }while(true);
    leased=Boolean(row&&!row.missing&&!row.busy);
    if(!leased)throw failure('RUNTIME_SESSION_SCOPE_CHANGED');
    leaseUntil=Date.parse(row.leaseUntil);
    if(!Number.isSafeInteger(row.revision)||!Number.isSafeInteger(row.fence)||typeof row.cipher!=='string'||!row.cipher)
      throw failure('RUNTIME_SESSION_INVALID');
    if(!Number.isFinite(leaseUntil)||now()>=leaseUntil)throw failure('RUNTIME_SESSION_LEASE_LOST');
    // acquire predates mediaEpoch in its return DTO. Read under the lease and
    // require the same ciphertext before trusting its epoch, including cleanup.
    const current=await rpc('read',{p_session_hash:sessionHash});
    if(current?.cipher!==row.cipher||(current.mediaEpoch!==null&&typeof current.mediaEpoch!=='string'))
      throw failure('RUNTIME_SESSION_INVALID');
    releaseEpoch=current.mediaEpoch;
    if(releaseEpoch!==expectedEpoch)throw failure('RUNTIME_SESSION_SCOPE_CHANGED');
    assertLease();
    const state=await restore(await store.openCipher(row.cipher,sessionHash));
    assertLease();
    if(validate(state)!==expectedEpoch)throw failure('RUNTIME_SESSION_SCOPE_CHANGED');
    const result=await update(state);
    assertLease();
    if(validate(state)!==expectedEpoch)throw failure('RUNTIME_SESSION_SCOPE_CHANGED');
    const cipher=await store.seal(await capture(state),sessionHash);
    assertLease();
    if(validate(state)!==expectedEpoch)throw failure('RUNTIME_SESSION_SCOPE_CHANGED');
    const committed=await rpc('commit',{...args(),p_cipher:cipher,p_release:true,p_media_epoch:expectedEpoch});
    if(!committed?.ok)throw failure('RUNTIME_SESSION_LEASE_LOST');
    released=true;
    return result;
  }finally{
    if(leased&&!released){
      try{
        // A failed read leaves its epoch unknown. Let the lease expire rather
        // than overwrite that epoch while attempting a best-effort release.
        if(releaseEpoch!==undefined)await rpc('commit',{...args(),p_cipher:null,p_release:true,p_media_epoch:releaseEpoch});
      }catch{}
    }
  }
}

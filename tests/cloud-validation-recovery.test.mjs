import test from 'node:test';
import assert from 'node:assert/strict';
import {CloudRuntime} from '../lib/cloud-runtime.mjs';

function fixture(){
  let clock=Date.now();const calls=[],libraryId='c'.repeat(64),client={libraryProvider:'wplay',authenticatedAt:clock,session:{connected:true,account:{status:'Active'}},images:new Map()};
  const session={connected:true,account:{libraryId,status:'Active'}},state={client,authGeneration:1};
  const cloud={enabled:true,ready:Promise.resolve(),bootstrap:async()=>({userId:'d243589c-25c5-4db0-b9aa-c087ace3d180',providerKey:'a'.repeat(64),scopeHash:'b'.repeat(64),session:{access_token:'fixture-access',expires_in:3600}}),rpc:async()=>{},revoke:async()=>calls.push('revoke')};
  const worker={registerSource(){},unregisterSource(){},start(){},stop(){},tick:async()=>{}};
  const runtime=new CloudRuntime({cloud,worker,now:()=>clock});
  return {runtime,cloud,state,client,session,calls,advance(ms){clock+=ms;},freshProof(){client.authenticatedAt=clock;}};
}
const timeout=()=>Object.assign(new Error('synthetic private failure'),{code:'CLOUD_TIMEOUT',cloudStage:'arkhen_validate_account',elapsedMs:5000});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

test('a transient validation RPC failure preserves the still-valid cloud session and artwork access',async()=>{
  const f=fixture();try{
    await f.runtime.attach(f.state,f.session,f.client);const account=f.state.cloud;
    f.advance(300001);f.freshProof();f.cloud.rpc=async()=>{throw timeout();};
    assert.equal(await f.runtime.attach(f.state,f.session,f.client),account);
    assert.equal(f.state.cloud,account);assert.equal(f.state.cloudStatus.state,'ready');assert.equal(f.calls.length,0);
    assert.equal(f.state.cloudStatus.validationPending,true);
    f.cloud.request=async()=>[];assert.equal(await f.runtime.parentalArtworkItem(f.state,'e'.repeat(64)),null);
    assert.doesNotMatch(JSON.stringify(f.state.cloudStatus),/synthetic|private|fixture-access/);
  }finally{f.runtime.close();}
});

test('concurrent validation joins one request and retry backoff survives refreshed provider proof',async()=>{
  const f=fixture();try{
    await f.runtime.attach(f.state,f.session,f.client);f.advance(300001);f.freshProof();
    let reads=0;const gate=deferred();f.cloud.rpc=()=>{reads++;return gate.promise;};
    const pending=Array.from({length:10},()=>f.runtime.attach(f.state,f.session,f.client));
    await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,1);gate.reject(timeout());await Promise.all(pending);
    f.cloud.rpc=async()=>{reads++;throw timeout();};
    for(let n=0;n<10;n++){f.advance(1);f.freshProof();await f.runtime.attach(f.state,f.session,f.client);}assert.equal(reads,1);
    f.advance(30000);f.freshProof();await f.runtime.attach(f.state,f.session,f.client);assert.equal(reads,2);
    f.advance(30000);f.freshProof();await f.runtime.attach(f.state,f.session,f.client);assert.equal(reads,2);
    f.advance(30000);f.freshProof();f.cloud.rpc=async()=>{reads++;};await f.runtime.attach(f.state,f.session,f.client);
    assert.equal(reads,3);assert.deepEqual(f.state.cloudStatus,{state:'ready'});assert.equal(f.state.cloudValidationRetry,null);assert.equal(f.calls.length,0);
  }finally{f.runtime.close();}
});

test('authentication denials and unexpected validation failures still revoke and detach',async()=>{
  for(const error of [Object.assign(timeout(),{status:401}),Object.assign(timeout(),{remoteStatus:403}),new Error('unexpected failure')]){
    const f=fixture();try{
      await f.runtime.attach(f.state,f.session,f.client);f.advance(300001);f.freshProof();f.cloud.rpc=async()=>{throw error;};
      assert.equal(await f.runtime.attach(f.state,f.session,f.client),null);assert.equal(f.state.cloud,null);assert.equal(f.calls.length,1);
    }finally{f.runtime.close();}
  }
});

test('a transient reply cannot retain a cloud token that expired while validation was pending',async()=>{
  const f=fixture();try{
    await f.runtime.attach(f.state,f.session,f.client);f.advance(300001);f.freshProof();const gate=deferred();f.cloud.rpc=()=>gate.promise;
    const pending=f.runtime.attach(f.state,f.session,f.client);await new Promise(resolve=>setImmediate(resolve));
    f.advance(3600001);gate.reject(timeout());assert.equal(await pending,null);assert.equal(f.state.cloud,null);
  }finally{f.runtime.close();}
});

test('provider denial while validation is pending wins over the late transient reply',async()=>{
  const f=fixture();try{
    await f.runtime.attach(f.state,f.session,f.client);f.advance(300001);f.freshProof();const gate=deferred();
    f.cloud.rpc=(name,args)=>args.p_status==='active'?gate.promise:Promise.resolve();
    const pending=f.runtime.attach(f.state,f.session,f.client);await new Promise(resolve=>setImmediate(resolve));
    f.session.account.status='Disabled';await f.runtime.attach(f.state,f.session,f.client);gate.reject(timeout());await pending;
    assert.equal(f.state.cloud,null);assert.equal(f.state.cloudStatus.code,'CLOUD_PROVIDER_VALIDATION_REQUIRED');assert.equal(f.calls.length,1);
  }finally{f.runtime.close();}
});

test('a late validation reply cannot overwrite a replacement cloud identity',async()=>{
  const f=fixture();try{
    await f.runtime.attach(f.state,f.session,f.client);f.advance(300001);f.freshProof();const gate=deferred();f.cloud.rpc=()=>gate.promise;
    const pending=f.runtime.attach(f.state,f.session,f.client);await new Promise(resolve=>setImmediate(resolve));
    f.runtime.detach(f.state);f.state.authGeneration++;f.session.account.libraryId='d'.repeat(64);
    await f.runtime.attach(f.state,f.session,f.client);const replacement=f.state.cloud;
    gate.reject(timeout());await pending;assert.equal(f.state.cloud,replacement);assert.equal(f.state.cloudStatus.state,'ready');
  }finally{f.runtime.close();}
});

test('forced Auth recovery supersedes pending validation without revoking or restoring its old token',async()=>{
  const f=fixture();try{
    await f.runtime.attach(f.state,f.session,f.client);f.advance(300001);f.freshProof();const gate=deferred();f.cloud.rpc=()=>gate.promise;
    const pending=f.runtime.attach(f.state,f.session,f.client);await new Promise(resolve=>setImmediate(resolve));
    const replacementGate=deferred(),bootstrap=f.cloud.bootstrap;f.cloud.bootstrap=async()=>{await replacementGate.promise;return bootstrap();};
    const recovery=f.runtime.recoverSession(f.state,f.session,f.client);await new Promise(resolve=>setImmediate(resolve));
    gate.reject(timeout());assert.equal(await pending,null);assert.equal(f.state.cloudStatus.state,'pending');assert.equal(f.calls.length,0);
    replacementGate.resolve();await recovery;assert.equal(f.state.cloudStatus.state,'ready');assert.equal(f.calls.length,0);
  }finally{f.runtime.close();}
});

test('an expired provider account or stale provider proof cannot be preserved after a transient reply',async()=>{
  for(const mode of ['account-expired','provider-disabled','proof-expired']){
    const f=fixture();try{
      await f.runtime.attach(f.state,f.session,f.client);f.advance(300001);f.freshProof();const gate=deferred();f.cloud.rpc=()=>gate.promise;
      if(mode==='proof-expired')f.state.cloudExpiresAt+=86400001;
      const pending=f.runtime.attach(f.state,f.session,f.client);await new Promise(resolve=>setImmediate(resolve));
      if(mode==='account-expired')f.session.account.expiresAt='2000-01-01T00:00:00Z';
      if(mode==='provider-disabled')f.client.session.account.status='Disabled';
      if(mode==='proof-expired')f.advance(86400001);
      gate.reject(timeout());assert.equal(await pending,null);
      assert.equal(f.state.cloud,null);
    }finally{f.runtime.close();}
  }
});

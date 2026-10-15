import test from 'node:test';
import assert from 'node:assert/strict';
import {createHlsErrorHandler} from '../web/hls-error-handler.js';
import {PlayerTools,fastLoadPolicies} from '../web/player-tools.js';

const network={type:'networkError',details:'fragLoadTimeOut',fatal:true};
function fixture({record, recover=false, native=false}={}){
  let active=true;const calls=[];
  const tools={current:{segments:2},recordError(data){calls.push('record');record?.(()=>{active=false;});},recoverError(){calls.push('recover');return recover;}};
  const handler=createHlsErrorHandler({isCurrent:()=>active,tools,video:{videoWidth:1920},fail:(message)=>calls.push(['failure',message]),canUseNative:()=>native,useNative:()=>calls.push('native')});
  return {calls,handler,stop:()=>{active=false;}};
}
test('obsolete HLS callbacks cannot touch a new source, including a synchronous switch during telemetry',()=>{
  const old=fixture();old.stop();old.handler(null,network);assert.deepEqual(old.calls,[]);
  for(const error of [network,{...network,response:{code:401}},{...network,type:'mediaError'}]){
    const current=fixture({record:stop=>stop(),native:true});current.handler(null,error);assert.deepEqual(current.calls,['record']);
  }
});
test('transient HLS errors remain owned by HLS, while bounded recovery avoids terminal UI',()=>{
  const transient=fixture();transient.handler(null,{...network,fatal:false});assert.deepEqual(transient.calls,[]);
  const recover=fixture({recover:true});recover.handler(null,network);assert.deepEqual(recover.calls,['record','recover']);
  const exhausted=fixture();exhausted.handler(null,network);assert.equal(exhausted.calls.at(-1)[0],'failure');assert.match(exhausted.calls.at(-1)[1],/próximo trecho/);
});
test('authentication does not retry; native fallback is only selected after recovery is exhausted',()=>{
  const auth=fixture({native:true});auth.handler(null,{...network,response:{code:403}});assert.equal(auth.calls.length,2);assert.match(auth.calls[1][1],/conexão/);
  const native=fixture({native:true});native.handler(null,network);assert.deepEqual(native.calls,['record','recover','native']);
});
test('only initial live manifest gets the OTT startup budget; playlist/VOD/segment bounds stay unchanged',()=>{
  const live=fastLoadPolicies('live'),vod=fastLoadPolicies('movie');
  assert.equal(live.manifestLoadPolicy.default.maxTimeToFirstByteMs,55000);
  assert.equal(live.manifestLoadPolicy.default.maxLoadTimeMs,60000);
  assert.equal(live.manifestLoadPolicy.default.timeoutRetry.maxNumRetry,0);
  assert.equal(vod.manifestLoadPolicy.default.maxTimeToFirstByteMs,4000);
  assert.deepEqual(live.playlistLoadPolicy,vod.playlistLoadPolicy);assert.deepEqual(live.fragLoadPolicy,vod.fragLoadPolicy);
});
function recovery(t,{started=true,levels=[{}]}={}){
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const calls=[];const current={hls:{levels,startLoad:()=>calls.push('load'),recoverMediaError:()=>calls.push('media')},started,networkRetries:0,mediaRetries:0,failed:false,buffering:false};
  const player={current,timers:new Set(),$:()=>({}),video:{currentTime:0,paused:false,ended:false}};
  player.recoverError=PlayerTools.prototype.recoverError;player.observeRecoveryProgress=PlayerTools.prototype.observeRecoveryProgress;
  return {player,current,calls};
}
test('recovery coalesces duplicate fatal events, stays bounded, and rejects stale timers after channel switch',t=>{
  const {player,current,calls}=recovery(t);
  assert.equal(player.recoverError(network),true);assert.equal(player.recoverError(network),true);assert.equal(current.networkRetries,1);
  t.mock.timers.tick(900);assert.deepEqual(calls,['load']);
  assert.equal(player.recoverError(network),true);t.mock.timers.tick(1800);assert.deepEqual(calls,['load','load']);
  assert.equal(player.recoverError(network),false);
  current.networkRetries=0;assert.equal(player.recoverError(network),true);player.current={};t.mock.timers.tick(900);assert.equal(calls.length,2);
});
test('parsed manifests can recover the first fragment before playing, but absent manifests are not restarted as parsed streams',t=>{
  const {player,current}=recovery(t,{started:false});assert.equal(player.recoverError(network),true);
  current.hls.levels=[];current.recoveryTimer=null;assert.equal(player.recoverError(network),false);
});
test('retry budget resets only after sustained moving playback; repeated playing/paused/static frames cannot reset it',t=>{
  const {player,current}=recovery(t);current.networkRetries=2;current.mediaRetries=1;
  for(let i=0;i<40;i++){t.mock.timers.tick(1000);player.observeRecoveryProgress();}
  assert.equal(current.networkRetries,2);
  for(let i=0;i<15;i++){t.mock.timers.tick(1000);player.video.currentTime++;player.observeRecoveryProgress();}
  current.buffering=true;t.mock.timers.tick(1000);player.observeRecoveryProgress();current.buffering=false;
  for(let i=0;i<20;i++){t.mock.timers.tick(1000);player.video.currentTime++;player.observeRecoveryProgress();}
  assert.equal(current.networkRetries,2);
  for(let i=0;i<12;i++){t.mock.timers.tick(1000);player.video.currentTime++;player.observeRecoveryProgress();player.observeRecoveryProgress();}
  assert.equal(current.networkRetries,0);assert.equal(current.mediaRetries,0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PlayerTools} from '../web/player-tools.js';
import {ImmersivePlayer} from '../web/player/orquestrador.js';
import {TVPlaybackMeasurement} from '../web/tv/player/medicao.js';
import {observeTVPlaybackReadiness,tvHasPlayableVideo} from '../web/tv/player/estado-media.js';
import {ChannelSwitchController} from '../web/player/troca-canal/orquestrador.js';

const emptyVideo=()=>Object.assign(new EventTarget(),{paused:false,ended:false,seeking:false,readyState:1,
  videoWidth:0,videoHeight:0,currentTime:0,buffered:{length:0},error:null});

test('a queued playing event without current video cannot arm TV stalls or report successful startup',t=>{
  t.mock.method(globalThis,'setInterval',()=>1);const video=emptyVideo(),reports=[];let stalls=0;
  const measurement=new TVPlaybackMeasurement({now:()=>1000,report:event=>reports.push(event),resources:()=>[]});
  const tools={video,profiles:{live:'balanced'},autoQuality:true,listeners:[],
    listen:PlayerTools.prototype.listen,reset(){},renderMenus(){},applyAutoQuality(){},inspectSourceCapabilities:async()=>{},
    observeRecoveryProgress(){},updateMetrics(){},tvQuality:{recordStall:()=>stalls++,cancel(){}}};
  PlayerTools.prototype.attach.call(tools,{item:{id:'1',name:'Synthetic TV',kind:'live'},measurement});
  const emit=type=>video.dispatchEvent(new Event(type));
  emit('playing');emit('waiting');
  assert.equal(tools.current.started,false);assert.equal(tools.current.stalls,0);assert.equal(stalls,0);assert.equal(reports.length,0);
  Object.assign(video,{readyState:3,videoWidth:1280,videoHeight:720});emit('playing');emit('waiting');
  assert.equal(tools.current.started,true);assert.equal(tools.current.stalls,1);assert.equal(stalls,1);assert.equal(reports[0].width,1280);
});

test('a stale TV playing event cannot dismiss loading or mark the immersive startup clock',t=>{
  const previous=globalThis.document;globalThis.document={};t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
  const video=emptyVideo();let recorded=0,hidden=0;
  const view={video,current:{item:{kind:'live'},loading:true,awaitingPlay:true},error:{hidden:false},
    listen:(target,event,callback)=>{if(target===video)target.addEventListener(event,callback);},
    recordStart:()=>recorded++,setLoading:()=>hidden++,updateControls(){}};
  ImmersivePlayer.prototype.bind.call(view);video.dispatchEvent(new Event('playing'));
  assert.equal(recorded,0);assert.equal(hidden,0);assert.equal(view.error.hidden,false);
  Object.assign(video,{readyState:3,videoWidth:1280,videoHeight:720});video.dispatchEvent(new Event('playing'));
  assert.equal(recorded,1);assert.equal(hidden,1);assert.equal(view.error.hidden,true);
});

test('advancing current TV video reconciles an early playing event without leaving an opaque loader',t=>{
  t.mock.method(globalThis,'setInterval',()=>1);
  const previous=globalThis.document;globalThis.document={};t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
  const video=emptyVideo(),reports=[];let clock=1000,recorded=0;
  const measurement=new TVPlaybackMeasurement({now:()=>clock,report:event=>reports.push(event),resources:()=>[]});
  const tools={video,profiles:{live:'balanced'},autoQuality:true,listeners:[],
    listen:PlayerTools.prototype.listen,reset(){},renderMenus(){},applyAutoQuality(){},inspectSourceCapabilities:async()=>{},
    observeRecoveryProgress(){},updateMetrics(){},tvQuality:{recordStall(){},cancel(){}}};
  PlayerTools.prototype.attach.call(tools,{item:{id:'1',kind:'live'},measurement});
  const view={video,current:{item:{kind:'live'},loading:true,awaitingPlay:false},error:{hidden:true},
    listen:(target,event,callback)=>{if(target===video)target.addEventListener(event,callback);},
    recordStart:()=>recorded++,setLoading(value){this.current.loading=value;},updateControls(){}};
  ImmersivePlayer.prototype.bind.call(view);
  const emit=type=>video.dispatchEvent(new Event(type));
  emit('playing');
  Object.assign(video,{readyState:4,videoWidth:1920,videoHeight:1080});
  for(const event of ['loadedmetadata','loadeddata','canplay','resize','timeupdate'])emit(event);
  assert.equal(tools.current.started,false);assert.equal(view.current.loading,true,'Metadata alone is not playback.');
  video.currentTime=.25;clock+=250;emit('timeupdate');
  assert.equal(tools.current.started,true);assert.equal(view.current.loading,false);assert.equal(recorded,1);
  assert.equal(reports.filter(report=>report.event==='first-playing').length,1);
  video.currentTime=.5;emit('timeupdate');assert.equal(recorded,1,'Progress cannot repeatedly reset the loader.');
  emit('waiting');video.currentTime=.75;emit('timeupdate');video.currentTime=1;emit('timeupdate');
  assert.equal(tools.current.buffering,false);assert.equal(view.current.loading,false);
  assert.equal(reports.filter(report=>report.event==='first-playing').length,1);
});

test('readiness progress cannot cross a retired owner, element, source or seek and stops after cleanup',()=>{
  const video=Object.assign(emptyVideo(),{readyState:4,videoWidth:1920,videoHeight:1080,src:'first'});
  let owner={id:'first'},accepted=[];
  const dispose=observeTVPlaybackReadiness({video,getOwner:()=>owner?.failed?null:owner,onReady:value=>accepted.push(value.id)});
  const advance=value=>{video.currentTime=value;video.dispatchEvent(new Event('timeupdate'));};
  advance(0);advance(1);assert.deepEqual(accepted,['first']);
  video.dispatchEvent(new Event('waiting'));advance(2);
  owner={id:'second'};advance(3);assert.deepEqual(accepted,['first']);
  advance(4);assert.deepEqual(accepted,['first','second']);
  video.dispatchEvent(new Event('waiting'));advance(5);
  video.src='replacement';advance(6);assert.equal(accepted.length,2);advance(7);assert.equal(accepted.length,3);
  video.dispatchEvent(new Event('waiting'));advance(8);
  video.element={src:'replacement'};advance(9);assert.equal(accepted.length,3);advance(10);assert.equal(accepted.length,4);
  video.seeking=true;video.dispatchEvent(new Event('seeking'));advance(100);
  video.seeking=false;video.dispatchEvent(new Event('seeked'));advance(100);assert.equal(accepted.length,4);
  advance(100.25);assert.equal(accepted.length,5);
  for(const state of [{paused:true},{paused:false,error:{code:3}},{error:null,ended:true},{ended:false,readyState:1}]){
    Object.assign(video,state);advance(video.currentTime+1);video.dispatchEvent(new Event('playing'));assert.equal(accepted.length,5);
  }
  Object.assign(video,{readyState:4});owner.failed=true;advance(105);advance(106);video.dispatchEvent(new Event('playing'));assert.equal(accepted.length,5);
  owner={id:'third'};advance(107);assert.equal(accepted.length,5);dispose();advance(108);video.dispatchEvent(new Event('playing'));assert.equal(accepted.length,5);
});

const app=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
function appReadinessFixture(video,{kind='live',playerTools={current:{failed:false}}}={}){
  const item={kind,id:'target'},player={item,mediaReady:true},activity=[],effects=[];
  const channelSwitch=new ChannelSwitchController({getCurrent:()=>player,getScope:()=> 'scope',onActivity:value=>activity.push(value)});
  const ticket={item,scope:'scope',phase:'connecting',controller:new AbortController(),activeReference:player};
  channelSwitch.pending=ticket;player.channelSwitchTicket=ticket;
  const nodes=new Map(),f={video,player,channelSwitch,observeTVPlaybackReadiness,tvHasPlayableVideo,playerTools,
    continuityFlow:{isDraining:()=>false},tvWatchHeartbeat:{confirmPlaying:()=>effects.push('heartbeat')},
    tv:{audio:{playing:()=>effects.push('tv-audio')}},movieAudio:{playing:()=>effects.push('movie-audio')},seriesAudio:{playing:()=>effects.push('series-audio')},
    saveLiveWatch(){},$:key=>{if(!nodes.has(key))nodes.set(key,{});return nodes.get(key);}};
  const start=app.indexOf('function onActiveVideoPlaying()'),end=app.indexOf("video.addEventListener('waiting'",start);
  const legacyPlaying=app.split('\n').find(line=>line.startsWith("video.addEventListener('playing',()=>{if(player?.mediaReady"));
  assert.ok(start>=0&&end>start&&legacyPlaying);
  const onActiveVideoPlaying=new Function('f',`const {${Object.keys(f).join(',')}}=f;${legacyPlaying}\n${app.slice(start,end)}\nreturn onActiveVideoPlaying;`)(f);
  return {...f,item,ticket,activity,effects,onActiveVideoPlaying};
}

test('app readiness reconciliation completes a connecting handoff when the only playing event was early',()=>{
  const video=Object.assign(emptyVideo(),{src:'target'}),item={kind:'live',id:'target'};
  const player={item,mediaReady:true},activity=[];
  const channelSwitch=new ChannelSwitchController({getCurrent:()=>player,getScope:()=> 'scope',onActivity:value=>activity.push(value)});
  const ticket={item,scope:'scope',phase:'connecting',controller:new AbortController(),activeReference:player};
  channelSwitch.pending=ticket;player.channelSwitchTicket=ticket;
  const nodes=new Map(),f={video,player,channelSwitch,observeTVPlaybackReadiness,tvHasPlayableVideo,
    playerTools:{current:{failed:false}},continuityFlow:{isDraining:()=>false},tvWatchHeartbeat:{confirmPlaying(){}},
    tv:{audio:{playing(){}}},movieAudio:{playing(){}},seriesAudio:{playing(){}},saveLiveWatch(){},
    $:key=>{if(!nodes.has(key))nodes.set(key,{});return nodes.get(key);}};
  const start=app.indexOf('function onActiveVideoPlaying()'),end=app.indexOf("video.addEventListener('waiting'",start);
  const legacyPlaying=app.split('\n').find(line=>line.startsWith("video.addEventListener('playing',()=>{if(player?.mediaReady"));
  assert.ok(start>=0&&end>start&&legacyPlaying,'The current app readiness and handoff listeners must be exercised.');
  new Function('f',`const {${Object.keys(f).join(',')}}=f;${legacyPlaying}\n${app.slice(start,end)}`)(f);
  video.dispatchEvent(new Event('playing'));assert.equal(channelSwitch.isPending(),true);
  Object.assign(video,{readyState:4,videoWidth:1920,videoHeight:1080});
  video.dispatchEvent(new Event('timeupdate'));assert.equal(channelSwitch.isPending(),true);
  video.currentTime=.25;video.dispatchEvent(new Event('timeupdate'));
  assert.equal(channelSwitch.isPending(),false);assert.equal(player.channelSwitchTicket,null);assert.deepEqual(activity,[false]);
  assert.equal(ticket.controller.signal.aborted,false,'Completing the UI handoff must not abort the playing source.');
  video.currentTime=.5;video.dispatchEvent(new Event('timeupdate'));video.dispatchEvent(new Event('playing'));
  assert.deepEqual(activity,[false],'A second playback confirmation cannot release the same handoff again.');
});

test('adopted TV waits for valid playback instead of releasing a handoff on 0x0, seek or error',t=>{
  t.mock.method(globalThis,'setInterval',()=>1);
  const previous=globalThis.document;globalThis.document={};t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
  const start=app.indexOf('  if(adopted){\n    video.muted='),end=app.indexOf('\n  }\n  }finally',start)+5;
  assert.ok(start>=0&&end>start,'Exercise the current application adoption branch.');
  for(const invalid of [{readyState:2,videoWidth:0,videoHeight:0},{seeking:true},{error:{code:3}}]){
    const video=Object.assign(emptyVideo(),{src:'target',readyState:4,videoWidth:1920,videoHeight:1080},invalid),reports=[];
    const measurement=new TVPlaybackMeasurement({now:()=>1000,report:event=>reports.push(event),resources:()=>[]});
    const tools={video,profiles:{live:'balanced'},autoQuality:true,listeners:[],
      listen:PlayerTools.prototype.listen,reset(){},renderMenus(){},applyAutoQuality(){},inspectSourceCapabilities:async()=>{},
      observeRecoveryProgress(){},updateMetrics(){},tvQuality:{recordStall(){},cancel(){}}};
    PlayerTools.prototype.attach.call(tools,{item:{id:'target',kind:'live'},measurement});
    const view={video,current:{item:{kind:'live'},loading:true,awaitingPlay:false},error:{hidden:true},
      listen:(target,event,callback)=>{if(target===video)target.addEventListener(event,callback);},
      recordStart(){},setLoading(value){this.current.loading=value;},updateControls(){},acceptPreparedPlayback:ImmersivePlayer.prototype.acceptPreparedPlayback};
    ImmersivePlayer.prototype.bind.call(view);
    const fixture=appReadinessFixture(video,{playerTools:tools}),f={...fixture,adopted:{restoreMuted:false},
      playNow(){},playbackMeasurement:measurement,immersivePlayer:view};
    new Function('f',`const {${Object.keys(f).join(',')}}=f;${app.slice(start,end)}`)(f);
    video.dispatchEvent(new Event('playing'));
    assert.equal(tools.current.started,false,'Adoption and invalid playing cannot arm the stall counter.');
    assert.equal(view.current.loading,true);assert.equal(reports.length,0);assert.equal(fixture.channelSwitch.isPending(),true);
    assert.deepEqual(fixture.effects,[],'Invalid playback cannot confirm heartbeat or audio.');
    Object.assign(video,{readyState:4,videoWidth:1920,videoHeight:1080,seeking:false,error:null});
    video.dispatchEvent(new Event('timeupdate'));assert.equal(fixture.channelSwitch.isPending(),true);
    video.currentTime=.25;video.dispatchEvent(new Event('timeupdate'));
    assert.equal(tools.current.started,true);assert.equal(view.current.loading,false);assert.equal(fixture.channelSwitch.isPending(),false);
    assert.equal(reports.filter(report=>report.event==='first-playing').length,1);assert.equal(fixture.ticket.controller.signal.aborted,false);
    for(const dispose of tools.listeners)dispose();for(const dispose of view.disposers)dispose();
  }
});

test('direct prepared acceptance rejects invalid TV while preserving VOD readiness',()=>{
  for(const invalid of [{videoWidth:0,videoHeight:0},{seeking:true},{error:{code:3}}]){
    const video=Object.assign(emptyVideo(),{readyState:4,videoWidth:1920,videoHeight:1080},invalid);
    const view={video,current:{item:{kind:'live'},loading:true},error:{hidden:false},recordStart(){},setLoading(value){this.current.loading=value;},updateControls(){}};
    ImmersivePlayer.prototype.acceptPreparedPlayback.call(view);assert.equal(view.current.loading,true);assert.equal(view.error.hidden,false);
  }
  for(const kind of ['movie','series']){
    const video=Object.assign(emptyVideo(),{readyState:2}),view={video,current:{item:{kind},loading:true},error:{hidden:false},recordStart(){},setLoading(value){this.current.loading=value;},updateControls(){}};
    ImmersivePlayer.prototype.acceptPreparedPlayback.call(view);assert.equal(view.current.loading,false);assert.equal(view.error.hidden,true);
    const fixture=appReadinessFixture(video,{kind});video.dispatchEvent(new Event('playing'));
    assert.deepEqual(fixture.effects,['heartbeat',`${kind}-audio`]);
  }
});

const marker="video.addEventListener('error',async()=>{";
const begin=app.lastIndexOf(marker)+marker.length;
const end=app.indexOf("\n});\ndocument.addEventListener('keydown'",begin);
assert.ok(begin>=marker.length&&end>begin,'The application native error handler must be present.');

test('a queued native error cleared by load cannot detach or restart the new TV source',async()=>{
  const calls=[],video=emptyVideo();
  const f={video,continuityFlow:null,hls:null,playbackSerial:2,
    player:{item:{kind:'live',id:'1'},nativeSourceStarted:true,usingNativeHLS:true,playOptions:{}},
    detachNativeMedia:()=>calls.push('detach'),api:async()=>{calls.push('status');return {failure:null};},
    playerTools:{getQualitySelection:()=>({}),getErrorEvents:()=>[]},localPlaybackMessage:()=>null,
    window:{Hls:{isSupported:()=>true}},openPlayer:()=>calls.push('open'),playbackContinuationOptions:()=>({}),
    playbackFailure:()=>calls.push('failure')};
  const handler=new Function('f',`const {${Object.keys(f).join(',')}}=f;return async()=>{${app.slice(begin,end)}};`)(f);
  await handler();assert.deepEqual(calls,[]);
  video.error={code:3};await handler();assert.deepEqual(calls,['detach','status','open']);
});

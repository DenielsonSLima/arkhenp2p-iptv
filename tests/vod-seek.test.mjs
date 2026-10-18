import test from 'node:test';
import assert from 'node:assert/strict';
import {VodSeekController,clampSeekTarget} from '../web/vod-seek.js';
import {ImmersivePlayer} from '../web/player/orquestrador.js';

class Video extends EventTarget {
  constructor(){super();this.duration=3600;this.readyState=4;this.currentTime=100;this.paused=false;this.seeking=false;this.ended=false;this.error=null;this.playCalls=0;this.pauseCalls=0;this.seekable={length:1,start:()=>0,end:()=>3600};}
  play(){this.playCalls++;this.paused=false;this.dispatchEvent(new Event('play'));return Promise.resolve();}
  pause(){this.pauseCalls++;this.paused=true;this.dispatchEvent(new Event('pause'));}
  event(type){this.dispatchEvent(new Event(type));}
}
function fixture(options={}){
  const video=new Video(),states=[],recoveries=[],timers=new Map();let time=0,next=0;
  const controller=new VodSeekController({video,onRecover:data=>recoveries.push(data),onStateChange:data=>states.push(data),
    now:()=>time,setInterval:callback=>{timers.set(++next,callback);return next;},clearInterval:id=>timers.delete(id),...options});
  controller.attach({kind:'movie',sourceKey:'movie:1'});
  return {video,controller,states,recoveries,timers,advance:ms=>{time+=ms;for(const callback of [...timers.values()])callback();}};
}

test('a seek waits for metadata, then uses the available timeline rather than dropping the request',()=>{
  const f=fixture();f.video.readyState=0;f.video.duration=NaN;
  assert.equal(f.controller.request(900),true);assert.equal(f.video.currentTime,100);
  f.advance(2000);assert.equal(f.recoveries.length,0);
  f.video.duration=3600;f.video.readyState=1;f.video.event('loadedmetadata');
  assert.equal(f.video.currentTime,900);assert.equal(f.states.at(-1).state,'seeking');
  f.video.readyState=4;f.video.currentTime=900.3;f.video.event('timeupdate');
  assert.equal(f.states.at(-1).state,'ready');assert.equal(f.timers.size,0);
});

test('timeline and discontinuous seekable ranges bound seeks without creating negative or end-exclusive positions',()=>{
  const video=new Video();assert.equal(clampSeekTarget(video,-30),0);assert.equal(clampSeekTarget(video,9999),3599.95);
  video.seekable={length:2,start:index=>index===0?10:400,end:index=>index===0?100:600};
  assert.equal(clampSeekTarget(video,0),10);assert.equal(clampSeekTarget(video,80),80);
  assert.equal(clampSeekTarget(video,300),400);assert.equal(clampSeekTarget(video,150),99.99);
  assert.equal(clampSeekTarget(video,Infinity),null);
});

test('successful paused seeks preserve pause and playing seeks need actual time progression',()=>{
  const paused=fixture();paused.video.paused=true;paused.controller.request(800);paused.video.event('seeked');
  assert.equal(paused.video.paused,true);assert.equal(paused.video.playCalls,0);assert.equal(paused.states.at(-1).state,'ready');
  const playing=fixture();playing.controller.request(800);playing.video.event('seeked');playing.advance(4000);
  assert.equal(playing.states.at(-1).state,'seeking','A seeked event alone does not prove that video resumed.');
  playing.video.currentTime=800.25;playing.video.event('timeupdate');playing.advance(10000);
  assert.equal(playing.states.at(-1).state,'ready');assert.equal(playing.recoveries.length,0);
});

test('a frozen seek reloads only once and carries the exact target and play intent',()=>{
  const f=fixture();f.controller.request(1400);f.video.seeking=true;f.video.readyState=1;f.video.event('waiting');
  f.advance(7999);assert.equal(f.recoveries.length,0);f.advance(1);
  assert.deepEqual(f.recoveries,[{target:1400,play:true,sourceKey:'movie:1',recoveryAttempt:1}]);
  f.advance(60000);assert.equal(f.recoveries.length,1);assert.equal(f.states.at(-1).state,'recovering');
  const paused=fixture();paused.video.paused=true;paused.controller.request(600);paused.video.readyState=1;paused.video.seeking=true;paused.advance(8000);
  assert.equal(paused.recoveries[0].play,false);
});

test('reloaded seek failure stops recovery, but a later explicit seek receives a new bounded attempt',()=>{
  const f=fixture();f.controller.attach({kind:'series',sourceKey:'series:1:ep2',recoveryAttempt:1});
  f.controller.request(1800,{reason:'recovery'});f.advance(8000);
  assert.equal(f.recoveries.length,0);assert.equal(f.states.at(-1).detail,'seek-stalled');assert.equal(f.timers.size,0);
  f.controller.request(1900,{reason:'user'});f.advance(8000);
  assert.equal(f.recoveries.length,1);assert.equal(f.recoveries[0].recoveryAttempt,1);
});

test('a newer seek replaces an older timer and reset or source changes cancel pending recovery',()=>{
  const f=fixture();f.controller.request(500);f.advance(7000);f.controller.request(1000);f.advance(1001);
  assert.equal(f.recoveries.length,0);assert.equal(f.timers.size,1);f.advance(6999);assert.equal(f.recoveries[0].target,1000);
  f.controller.request(1200);f.controller.reset();f.advance(10000);f.video.event('loadedmetadata');
  assert.equal(f.recoveries.length,1);assert.equal(f.timers.size,0);assert.equal(f.controller.request(30),false);
  f.controller.attach({kind:'live',sourceKey:'live:1'});assert.equal(f.controller.request(30),false);
});

test('media errors, missing metadata and user-blocked play do not trigger a reload loop',async()=>{
  const error=fixture();error.controller.request(500);error.video.error={code:3};error.video.event('error');error.advance(10000);
  assert.equal(error.recoveries.length,0);assert.equal(error.states.at(-1).detail,'media-error');
  const metadata=fixture();metadata.video.readyState=0;metadata.controller.request(500);metadata.advance(15000);
  assert.equal(metadata.recoveries.length,0);assert.equal(metadata.states.at(-1).detail,'metadata-timeout');
  const blocked=fixture();blocked.video.paused=true;blocked.video.play=()=>Promise.reject(Object.assign(new Error('Gesture required'),{name:'NotAllowedError'}));
  blocked.controller.request(500,{play:true});await Promise.resolve();await Promise.resolve();blocked.advance(10000);
  assert.equal(blocked.recoveries.length,0);assert.equal(blocked.states.some(state=>state.state==='paused'),true);
  assert.equal(blocked.states.at(-1).state,'ready','A successfully applied paused seek confirms the target after autoplay is blocked.');
});

test('an obsolete recovery rejection cannot affect a newly attached source',async()=>{
  let reject;
  const f=fixture({onRecover:()=>new Promise((_,failure)=>{reject=failure;})});
  f.controller.request(500);f.advance(8000);f.controller.attach({kind:'movie',sourceKey:'movie:2'});f.controller.request(800);
  const count=f.states.length;reject(new Error('old source'));await Promise.resolve();await Promise.resolve();
  assert.equal(f.states.length,count);assert.equal(f.controller.session.sourceKey,'movie:2');
});

test('immersive seeks delegate to the shared controller and never change live positions',()=>{
  const calls=[],player={current:{item:{kind:'movie'}},video:{currentTime:20,duration:200},options:{onSeek:(...args)=>{calls.push(args);return true;}}};
  assert.equal(ImmersivePlayer.prototype.requestSeek.call(player,120,{reason:'opening'}),true);
  assert.deepEqual(calls,[[120,{reason:'opening'}]]);assert.equal(player.video.currentTime,20);
  player.current.item.kind='live';assert.equal(ImmersivePlayer.prototype.requestSeek.call(player,40),false);assert.equal(calls.length,1);
});

test('default browser timers keep the global receiver and limited seek ranges are reported honestly',()=>{
  const originalSet=globalThis.setInterval,originalClear=globalThis.clearInterval;
  const calls=[];
  try{
    globalThis.setInterval=function(){assert.equal(this,globalThis);calls.push('set');return 1;};
    globalThis.clearInterval=function(){assert.equal(this,globalThis);calls.push('clear');};
    const video=new Video(),states=[];video.seekable={length:1,start:()=>0,end:()=>120};
    const seeks=new VodSeekController({video,onStateChange:state=>states.push(state)});
    seeks.attach({kind:'movie'});seeks.request(800);seeks.reset();
    assert.deepEqual(calls,['set','clear']);assert.equal(states.at(-1).detail,'seek-range-limited');
    assert.equal(video.currentTime,119.99);
  }finally{globalThis.setInterval=originalSet;globalThis.clearInterval=originalClear;}
});

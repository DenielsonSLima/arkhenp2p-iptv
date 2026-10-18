import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {HomeChannelPreview} from '../web/inicio/lista-canais/previa.js';
import {TVPlaybackMeasurement} from '../web/tv/player/medicao.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
class Video extends EventTarget{
  constructor(){super();this.paused=true;this.readyState=0;this.videoWidth=0;this.videoHeight=0;this.muted=true;}
  canPlayType(){return '';}
  setAttribute(){}
  removeAttribute(){this.src='';}
  pause(){this.paused=true;}
  load(){this.readyState=0;}
  play(){this.paused=false;this.readyState=2;this.videoWidth=320;this.videoHeight=180;this.dispatchEvent(new Event('playing'));return Promise.resolve();}
}
function fixture(t,{stop=async()=>{},beforeStart=async()=>{},destroy=()=>undefined}={}){
  const instances=[],urls=[],stops=[],states=[];
  class Hls{
    static Events={ERROR:'error',MANIFEST_PARSED:'manifest'};
    static isSupported(){return true;}
    constructor(){this.listeners=new Map();this.index=instances.length;instances.push(this);}
    on(event,callback){this.listeners.set(event,callback);}
    off(event){this.listeners.delete(event);}
    loadSource(url){this.url=url;}
    attachMedia(video){this.video=video;queueMicrotask(()=>this.listeners.get('manifest')?.());}
    destroy(){this.destroyed=true;return destroy(this);}
  }
  const document=Object.assign(new EventTarget(),{hidden:false,documentElement:{clientHeight:800}});
  const environment=Object.assign(new EventTarget(),{document,navigator:{userAgent:'Chrome/125'},innerHeight:800});
  const host={isConnected:true,getBoundingClientRect:()=>({width:320,height:180,top:0,bottom:180})};
  let scope='account:1',active=true;
  const video=new Video(),preview=new HomeChannelPreview({environment,HlsClass:Hls,getScope:()=>scope,isActive:()=>active,
    beforeStart,stop:async value=>{stops.push(value);return stop(value);},onState:value=>states.push(value),
    playbackURL:(item,options)=>{urls.push({item,options});return `/api/play/live/${item.id}/index.m3u8?attempt=${options.attempt}&purpose=${options.purpose}`;}});
  t.after(()=>preview.dispose().catch(()=>{}));
  return {preview,video,host,document,environment,instances,urls,stops,states,
    setScope:value=>{scope=value;},setActive:value=>{active=value;},
    select:(id='91')=>{preview.setTarget(video,{id,kind:'live',name:'Synthetic channel'},{host});preview.sync();}};
}

test('Home prepares one muted preview with its own preview purpose and stable attempt',async t=>{
  const f=fixture(t);f.select();await tick();
  for(let index=0;index<20;index++)f.preview.sync();
  assert.equal(f.instances.length,1);assert.equal(f.urls.length,1);assert.equal(f.urls[0].options.purpose,'preview');
  assert.ok(f.urls[0].options.attempt);assert.equal(f.video.muted,true);assert.equal(f.video.controls,false);
  assert.equal(f.states.at(-1).state,'playing');
});

test('Home waits for both local decoder retirement and acknowledged STOP before reusing the video',async t=>{
  const retirement=deferred(),f=fixture(t,{destroy:instance=>instance.index===0?retirement.promise:undefined});
  f.select();await tick();let settled=false;
  const paused=f.preview.pause('watch').then(()=>{settled=true;});await tick();
  assert.equal(f.stops.length,1);assert.equal(settled,false);
  f.select('92');await tick();assert.equal(f.instances.length,1);
  retirement.resolve();await paused;await tick();
  assert.equal(f.instances.length,2);assert.equal(f.urls.at(-1).item.id,'92');assert.equal(f.video.paused,false);
});

test('a failed Home STOP blocks automatic reopening until an explicit stop succeeds',async t=>{
  let attempts=0;const f=fixture(t,{stop:async()=>{if(++attempts===1)throw new Error('Synthetic stop failure');}});
  f.select();await tick();await assert.rejects(f.preview.pause('navigate'),/Synthetic stop failure/);
  for(let index=0;index<20;index++)f.preview.sync();await tick();
  assert.equal(f.instances.length,1);assert.equal(attempts,1);
  await f.preview.pause('explicit-retry');f.preview.sync();await tick();
  assert.equal(attempts,2);assert.equal(f.instances.length,2);
});

test('hidden Home and an inactive owner retire preview media without reopening it',async t=>{
  const f=fixture(t);f.select();await tick();f.setActive(false);f.document.hidden=true;
  f.document.dispatchEvent(new Event('visibilitychange'));await tick();
  assert.equal(f.instances[0].destroyed,true);assert.equal(f.preview.operation,null);assert.equal(f.stops.length,1);
  f.document.hidden=false;f.document.dispatchEvent(new Event('visibilitychange'));f.preview.sync();await tick();
  assert.equal(f.instances.length,1);assert.equal(f.video.src,'');
});

test('account replacement while Home preparation waits cannot start or stop a source in the new account',async t=>{
  const gate=deferred(),f=fixture(t,{beforeStart:()=>gate.promise});
  f.select();await tick();f.setScope('account:2');await f.preview.pause('account-change');gate.resolve();await tick();
  assert.equal(f.urls.length,0);assert.equal(f.instances.length,0);assert.equal(f.stops.length,0);
});

test('account replacement waits for the old local decoder without sending its STOP to the new account',async t=>{
  const retirement=deferred(),f=fixture(t,{destroy:instance=>instance.index===0?retirement.promise:undefined});
  f.select();await tick();f.setScope('account:2');f.select('92');await tick();
  assert.equal(f.instances.length,1);assert.equal(f.stops.length,0);
  retirement.resolve();await tick();
  assert.equal(f.instances.length,2);assert.equal(f.urls.at(-1).item.id,'92');assert.equal(f.stops.length,0);
});

const app=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
const start=app.indexOf('async function openPlayer('),opening=app.slice(start,app.indexOf('\nfunction updateProgram(',start));
function homeOpening({allowed=true,unlock=async()=>false}={}){
  const transport=deferred(),calls=[],dialog={hidden:true},loading={hidden:true};
  const f={homeChannels:{pause:()=>{calls.push('pause-preview');return Promise.resolve();}},homeChannelPrograms:{pause:()=>calls.push('pause-programs')},
    TVPlaybackMeasurement,pauseCatalogWork:()=>{},resumeCatalogWork:()=>{},filmes:{suggestions:{pausePreview(){}}},
    document:{hidden:false},detailItem:null,
    channelSwitch:null,allowsKnownItem:()=>allowed,parentalControl:{unlock},playerEnginePreference:{get:()=> 'shaka'},
    resolvePlayerTransport:()=>{calls.push('engine');return transport.promise;},videoHost:{element:{}},audioProcessing:{prepare:()=>{}},
    toast:()=>{},homeTVActive:()=>false,syncHomeChannels:()=>{},session:{connected:true},player:null,playerTools:{tvQuality:{cancel(){}}},
    contentPageOpen:()=>!dialog.hidden,$:selector=>selector==='#player-dialog'?dialog:loading,
    tryNativeFullscreen:()=>{assert.equal(dialog.hidden,false);calls.push('fullscreen');},leaveNativeFullscreen:()=>calls.push('leave-fullscreen')};
  const open=new Function('f',`let homePlaybackOpening=0,homeFullscreenPending=false,playerTransportRequest=0,connectionGeneration=1,playbackSerial=0;const {${Object.keys(f).join(',')}}=f;return ${opening}`)(f);
  return {open,transport,calls,dialog,loading};
}

test('authorized Home fullscreen is requested in the click before a cold engine yields and is restored on failure',async()=>{
  const f=homeOpening(),pending=f.open({id:'91',kind:'live'},null,{fullscreen:true,beforePlayback:Promise.resolve()});
  assert.ok(f.calls.includes('fullscreen'));assert.ok(f.calls.indexOf('fullscreen')<f.calls.indexOf('engine'));
  assert.equal(f.dialog.hidden,false);assert.equal(f.loading.hidden,false);
  f.transport.reject(new Error('Synthetic engine unavailable'));await pending;
  assert.equal(f.dialog.hidden,true);assert.equal(f.loading.hidden,true);assert.ok(f.calls.includes('leave-fullscreen'));
});

test('Home fullscreen never reveals a protected player when authorization is refused',async()=>{
  const f=homeOpening({allowed:false});await f.open({id:'91',kind:'live'},null,{fullscreen:true});
  assert.equal(f.dialog.hidden,true);assert.equal(f.calls.includes('fullscreen'),false);assert.equal(f.calls.includes('engine'),false);
});

test('ordinary openings keep their existing fullscreen timing while the engine is pending',async()=>{
  const f=homeOpening(),pending=f.open({id:'91',kind:'live'});
  assert.equal(f.dialog.hidden,true);assert.equal(f.calls.includes('fullscreen'),false);
  f.transport.reject(new Error('Synthetic engine unavailable'));await pending;
});


test('two failed overlapping Home openings release their shared temporary fullscreen surface',async()=>{
  const f=homeOpening(),first=f.open({id:'91',kind:'live'},null,{fullscreen:true}),second=f.open({id:'92',kind:'live'},null,{fullscreen:true});
  assert.equal(f.dialog.hidden,false);f.transport.reject(new Error('Synthetic engine unavailable'));
  await Promise.all([first,second]);assert.equal(f.dialog.hidden,true);assert.equal(f.loading.hidden,true);
  assert.equal(f.calls.filter(value=>value==='leave-fullscreen').length,1);
});

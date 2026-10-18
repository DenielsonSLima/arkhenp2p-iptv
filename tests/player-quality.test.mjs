import test from 'node:test';
import assert from 'node:assert/strict';
import {PlayerTools, fragmentBitrateBps} from '../web/player-tools.js';
import {createAdaptiveState} from '../web/adaptive-quality.js';

const source=(id,name)=>({id,name,kind:'live'});
const fhd=source('fhd','Canal Sergipe FHD'),hd=source('hd','Canal Sergipe HD'),uhd=source('4k','Canal Sergipe 4K');
function hlsFor(){
  let loadLevel=-1,auto=true;const writes=[];
  return {levels:[{height:720},{height:1080},{height:2160}],currentLevel:0,config:{},writes,
    get autoLevelEnabled(){return auto;},set autoLevelEnabled(value){auto=value;},
    get loadLevel(){return loadLevel;},set loadLevel(value){loadLevel=value;auto=value===-1;writes.push(value);}};
}
function qualityHarness(item=uhd){
  const hls=hlsFor();const player={autoQuality:true,current:{item,hls,qualityMode:'manual',manualHeight:null,forcedLevel:null,stalls:0},
    applyAutoQuality:PlayerTools.prototype.applyAutoQuality,renderQuality:()=>{}};
  return {hls,player};
}

test('manual 4K uses an offered level and is not clobbered by repeated level or audio updates',()=>{
  const {hls,player}=qualityHarness();player.applyAutoQuality();
  assert.deepEqual(hls.writes,[2]);assert.equal(hls.config.preserveManualLevelOnError,true);
  hls.currentLevel=2;player.applyAutoQuality();player.applyAutoQuality();assert.deepEqual(hls.writes,[2]);
  hls.autoLevelEnabled=true;player.applyAutoQuality();assert.deepEqual(hls.writes,[2,2],'A library error fallback cannot silently replace the manual selection.');
  assert.deepEqual(PlayerTools.prototype.getQualitySelection.call(player),{qualityMode:'manual',qualityHeight:2160});
});

test('activating TV Auto holds the highest offered level until its warning permits a step',()=>{
  const {hls,player}=qualityHarness();player.applyAutoQuality();hls.currentLevel=1;
  PlayerTools.prototype.setAutoQuality.call(player,true);assert.deepEqual(hls.writes,[2,2]);
  player.applyAutoQuality();player.applyAutoQuality();assert.deepEqual(hls.writes,[2,2]);assert.equal(hls.config.preserveManualLevelOnError,true);
  PlayerTools.prototype.setAutoQuality.call(player,false);assert.equal(hls.writes.at(-1),1);
  assert.deepEqual(PlayerTools.prototype.getQualitySelection.call(player),{qualityMode:'manual',qualityHeight:1080});
});

test('manual resolution survives a retry with a different manifest level order',()=>{
  const {hls,player}=qualityHarness();player.current.manualHeight=1080;hls.levels=[{height:2160},{height:720},{height:1080}];
  player.applyAutoQuality();assert.equal(hls.writes[0],2);
  assert.deepEqual(PlayerTools.prototype.getQualitySelection.call(player),{qualityMode:'manual',qualityHeight:1080});
});

test('an approved automatic reduction survives a manifest level reorder without returning to 4K',()=>{
  const {hls,player}=qualityHarness();player.current.qualityMode='auto';player.applyAutoQuality();
  PlayerTools.prototype.applyTVQualityStep.call({...player,video:{paused:false,ended:false},renderQuality:()=>{}},
    {kind:'level',key:'level:1080:0:'},player.current);
  assert.equal(hls.loadLevel,1);hls.levels=[{height:1080},{height:720},{height:2160}];
  player.applyAutoQuality();assert.equal(hls.loadLevel,0);assert.equal(hls.levels[hls.loadLevel].height,1080);
});

test('restoring the same TV Auto preference preserves an approved reduction and its stall evidence',()=>{
  const {hls,player}=qualityHarness();player.current.qualityMode='auto';player.applyAutoQuality();
  PlayerTools.prototype.applyTVQualityStep.call({...player,video:{paused:false,ended:false}},
    {kind:'level',key:'level:1080:0:'},player.current);
  let resets=0;player.tvQuality={reset:()=>resets++};const writes=hls.writes.length;
  PlayerTools.prototype.setAutoQuality.call(player,true,null,{restore:true});
  assert.equal(hls.loadLevel,1);assert.equal(hls.writes.length,writes);assert.equal(resets,0);
});

test('restoring TV profiles applies changed budgets without seeking, while an explicit choice keeps live sync',()=>{
  let renders=0;const player={profiles:{live:'balanced',vod:'balanced'},bufferMode:'balanced',
    current:{item:fhd,hls:{config:{},liveSyncPosition:100}},video:{readyState:4,currentTime:90},
    options:{toast:()=>{}},syncToProfile:PlayerTools.prototype.syncToProfile,renderBuffer:()=>renders++};
  PlayerTools.prototype.setProfile.call(player,'live','balanced',{restore:true});
  assert.equal(player.video.currentTime,90);assert.equal(renders,0);assert.equal(player.current.intentionalSeekUntil,undefined);
  PlayerTools.prototype.setProfile.call(player,'live','stable',{restore:true});
  assert.equal(player.current.hls.config.maxBufferLength,60);assert.equal(player.video.currentTime,90);assert.equal(renders,1);
  PlayerTools.prototype.setProfile.call(player,'live','balanced');assert.equal(player.video.currentTime,100);assert.ok(player.current.intentionalSeekUntil>Date.now());
});

test('manual source choice locks the requested ID without changing the global preference',()=>{
  const calls=[],player={autoQuality:true,current:{item:fhd,qualityMode:'auto',variants:[fhd,hd,uhd]},options:{switchChannel:(...args)=>calls.push(args)}};
  PlayerTools.prototype.selectSourceVariant.call(player,uhd);
  assert.deepEqual(calls,[[uhd,{automatic:false,qualityMode:'manual'}]]);assert.equal(player.autoQuality,true);assert.equal(player.current.qualityMode,'manual');
  PlayerTools.prototype.selectSourceVariant.call(player,source('other','Outro canal 4K'));assert.equal(calls.length,1);
});

test('fragment media rates use bytes times eight per media second, without folding audio-only tracks into video',()=>{
  assert.equal(fragmentBitrateBps({payload:{byteLength:1500000},frag:{duration:4,type:'main'}}),3000000);
  assert.equal(fragmentBitrateBps({stats:{loaded:750000},frag:{duration:2}}),3000000);
  assert.equal(fragmentBitrateBps({payload:{byteLength:1500000},frag:{duration:4,type:'audio'}}),null);
  for(const data of [{},{payload:{byteLength:0},frag:{duration:4}},{payload:{byteLength:100},frag:{duration:0}}])assert.equal(fragmentBitrateBps(data),null);
});

function metricsHarness(mode='auto',levels=1){
  const nodes=new Map(),calls=[];
  const node=selector=>{if(!nodes.has(selector))nodes.set(selector,{dataset:{},classList:{toggle:()=>{}}});return nodes.get(selector);};
  const state=createAdaptiveState({now:0,currentId:fhd.id});Object.assign(state,{lastObservedAt:1000,lastStallCount:1,stallTimes:[1000]});
  return {nodes,calls,player:{$:node,autoQuality:true,adaptiveState:state,
    video:{currentTime:10,buffered:{length:1,start:()=>0,end:()=>11},videoWidth:1920,videoHeight:1080,paused:false,ended:false},
    current:{item:fhd,sources:[],variants:[fhd,hd],qualityMode:mode,hls:{levels:Array.from({length:levels},()=>({bitrate:3000000})),currentLevel:0,bandwidthEstimate:8000000},segments:1,stalls:2,lastStall:2100,started:true,buffering:true,failed:false,errorEvents:[]},
    options:{toast:()=>{},switchChannel:(...args)=>calls.push(args)}}};
}

test('metrics alone cannot retune a channel after two stalls or bypass the quality warning',t=>{
  t.mock.method(Date,'now',()=>2100);
  const auto=metricsHarness();PlayerTools.prototype.updateMetrics.call(auto.player);assert.equal(auto.calls.length,0);
  const manual=metricsHarness('manual');PlayerTools.prototype.updateMetrics.call(manual.player);assert.equal(manual.calls.length,0);
  const abr=metricsHarness('auto',2);PlayerTools.prototype.updateMetrics.call(abr.player);assert.equal(abr.calls.length,0);
  assert.equal(manual.nodes.get('#metric-bandwidth').textContent,'≈ 8,0 Mb/s');
  assert.equal(manual.nodes.get('#metric-resolution').textContent,'1920 × 1080','A nominal source name cannot manufacture measured 4K.');
});

test('native playback without network samples does not manufacture bandwidth',()=>{
  const view=metricsHarness('manual');view.player.current.hls=null;view.player.video.videoHeight=2160;view.player.video.videoWidth=3840;
  PlayerTools.prototype.updateMetrics.call(view.player);
  assert.equal(view.nodes.get('#metric-bandwidth').textContent,'Não disponível');
  assert.equal(view.nodes.get('#metric-resolution').textContent,'3840 × 2160 · 4K');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {ChannelVolumeMemory} from '../web/channel-volume-memory.js';

const item=id=>({kind:'live',id:String(id)});
function fixture(options={}){
  const entries=new Map(),storage={getItem:key=>entries.get(key),setItem:(key,value)=>entries.set(key,value)};
  const video={volume:.6,muted:false},memory=new ChannelVolumeMemory({video,storage,getNamespace:()=> 'wplay',...options});
  return {memory,video,storage,entries};
}
test('returning to a loud channel restores its own explicit volume without overwriting mute',()=>{
  const {memory,video}=fixture();
  memory.select(item(1));video.volume=.2;memory.remember(.2);
  memory.select(item(2));video.volume=.7;memory.remember(.7);
  video.muted=true;memory.select(item(1));
  assert.equal(video.volume,.2);assert.equal(video.muted,true);
  memory.select(item(2));assert.equal(video.volume,.7);
});
test('automatic restorations never become another channel adjustment and reset cannot save the old selection',()=>{
  const {memory,video}=fixture();memory.select(item(1));memory.remember(.25);
  memory.select(item(2));assert.equal(video.volume,.25);assert.equal(memory.volumes.size,1);
  memory.reset();memory.remember(.5);assert.equal(memory.volumes.get('wplay:1'),.25);
  memory.select(item(3));assert.equal(video.volume,.5);
});
test('preferences survive reload, can be disabled without changing the current volume and keep channel data',()=>{
  const {memory,storage,video}=fixture();memory.select(item(1));memory.remember(.2);memory.setEnabled(false);video.volume=.8;
  memory.select(item(1));assert.equal(video.volume,.8);
  const next=new ChannelVolumeMemory({video,storage,getNamespace:()=> 'wplay'});
  assert.equal(next.enabled,false);next.setEnabled(true);next.select(item(1));assert.equal(video.volume,.2);
});
test('provider namespaces and live titles remain isolated, and invalid or unsupported volume does not break playback',()=>{
  let provider='a';const f=fixture({getNamespace:()=>provider});f.memory.select(item(1));f.memory.remember(.1);
  provider='b';f.memory.select(item(1));f.memory.remember(.8);provider='a';f.memory.select(item(1));assert.equal(f.video.volume,.1);
  f.memory.select({kind:'movie',id:'1'});f.memory.remember(.4);assert.equal(f.memory.volumes.get('a:1'),.1);
  for(const value of [-1,1.1,NaN,Infinity,'0.5',null])f.memory.remember(value);
  assert.equal(f.memory.lastUserVolume,.4);
  const unsupported={get volume(){return 1;},set volume(_){throw new Error('device volume');}};
  assert.equal(new ChannelVolumeMemory({video:unsupported,storage:null}).select(item(1)),false);
});
test('storage is bounded and unavailable persistence cannot stop a channel switch',()=>{
  const f=fixture({limit:2});for(let id=1;id<=3;id++){f.memory.select(item(id));f.memory.remember(id/10);}
  assert.deepEqual([...f.memory.volumes.keys()],['wplay:2','wplay:3']);
  const broken={getItem(){throw new Error('blocked');},setItem(){throw new Error('full');}};
  const memory=new ChannelVolumeMemory({video:{volume:.5},storage:broken});assert.doesNotThrow(()=>{memory.select(item(1));memory.remember(.3);memory.setEnabled(false);});
});
test('cloud volume preferences expose only current account channels and importing cannot erase another account',()=>{
  let account='account-a';const f=fixture({getNamespace:()=>account});f.memory.select(item(1));f.memory.remember(.2);
  account='account-b';f.memory.select(item(1));f.memory.remember(.7);assert.deepEqual(f.memory.getPreferences().volumes,[['1',.7]]);
  f.memory.setPreferences({enabled:true,lastUserVolume:.4,volumes:[['2',.4],['bad-id',1],['3',NaN],null]});
  assert.deepEqual(f.memory.getPreferences().volumes,[['2',.4]]);account='account-a';f.memory.select(item(1));assert.equal(f.video.volume,.2);assert.deepEqual(f.memory.getPreferences().volumes,[['1',.2]]);
});

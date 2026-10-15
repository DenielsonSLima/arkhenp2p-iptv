import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSeriesPlaybackSequence} from '../web/series-playback-sequence.js';

const item={kind:'series',id:'100',name:'Game of Thrones'};
const historyEpisode={id:'501',title:'S05E001'};
const details={seasons:[{number:5,episodes:[{id:'501',title:'S05E001',season:5,number:1},{id:'502',season:5,number:2}]},{number:6,episodes:[{id:'601',season:6,number:1}]}]};

test('starting from history without a cached preview hydrates episode identity and the next episode',async()=>{
  let requested=0,updated;
  const sequence=await loadSeriesPlaybackSequence({item,episode:historyEpisode,getDetails:async value=>{assert.equal(value,item);requested++;return details;},onUpdate:value=>{updated=value;}});
  assert.equal(requested,1);assert.equal(updated,sequence);assert.equal(sequence.episode.season,5);assert.equal(sequence.episode.number,1);
  assert.equal(sequence.next.id,'502');assert.equal(sequence.status,'ready');
  const boundary=await loadSeriesPlaybackSequence({item,episode:{id:'502'},getDetails:async()=>details});assert.equal(boundary.next.id,'601');
  const last=await loadSeriesPlaybackSequence({item,episode:{id:'601'},getDetails:async()=>details});assert.equal(last.next,null);assert.equal(last.status,'ready');
});

test('late sequence requests cannot replace another episode or a different account',async()=>{
  let release,current=true,updates=0;
  const pending=loadSeriesPlaybackSequence({item,episode:historyEpisode,getDetails:()=>new Promise(resolve=>{release=resolve;}),isCurrent:()=>current,onUpdate:()=>updates++});
  current=false;release(details);assert.equal(await pending,null);assert.equal(updates,0);
});

test('missing episodes and request failures preserve current playback without guessing an unrelated next episode',async()=>{
  const missing=await loadSeriesPlaybackSequence({item,episode:{id:'999'},getDetails:async()=>details});assert.equal(missing.next,null);assert.equal(missing.status,'unavailable');
  const failed=await loadSeriesPlaybackSequence({item,episode:historyEpisode,getDetails:async()=>{throw new Error('Offline');}});assert.equal(failed.episode,historyEpisode);assert.equal(failed.next,null);
  assert.equal(await loadSeriesPlaybackSequence({item:{kind:'movie'},episode:historyEpisode,getDetails:()=>assert.fail('No episode lookup for movies')}),null);
});

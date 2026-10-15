import test from 'node:test';
import assert from 'node:assert/strict';
import { resumePlaybackPosition as resume, PlaybackPositionGuard, continuedPlaybackPosition } from '../web/playback-position.js';

test('loader fallback retains an unconfirmed resume before metadata and uses actual position after confirmation',()=>{
  assert.equal(continuedPlaybackPosition({resumePending:true,resumeTarget:600,currentTime:0}),600);
  assert.equal(continuedPlaybackPosition({resumePending:false,resumeTarget:600,currentTime:1200}),1200);
  assert.equal(continuedPlaybackPosition({seekTarget:900,resumePending:true,resumeTarget:600,currentTime:0}),900);
  assert.equal(continuedPlaybackPosition({seekTarget:0,currentTime:1200}),0);
  assert.equal(continuedPlaybackPosition({currentTime:NaN}),0);
});
const item={kind:'series',id:'1'},episode={id:'101'};
test('resume selects the requested episode independently of the last series episode',()=>{
  const base={item,episode,episodeEntry:{itemId:'1',episodeId:'101',time:600,duration:1800},historyEntry:{item,episode:{id:'102'},time:1200,duration:1800}};
  assert.equal(resume(base),600);
  assert.equal(resume({...base,episodeEntry:{...base.episodeEntry,episodeId:'other'}}),0);
  assert.equal(resume({...base,episodeEntry:null,historyEntry:{...base.historyEntry,episode}}),1200);
});
test('completed entries restart while explicit recovery positions and start-over intent remain exact',()=>{
  const base={item,episode,episodeEntry:{itemId:'1',episodeId:'101',time:1750,duration:1800}};
  assert.equal(resume(base),0);
  assert.equal(resume({...base,episodeEntry:{...base.episodeEntry,time:20,completed:true}}),0);
  assert.equal(resume({...base,options:{resumeTime:1750}}),1750);
  assert.equal(resume({...base,options:{resumeTime:1750,startFromBeginning:true}}),0);
  assert.equal(resume({...base,options:{resumeTime:0}}),0);
});
test('movie continuation matches kind and ID and tolerates genuinely unknown total runtime',()=>{
  const item={kind:'movie',id:'2'},historyEntry={item,time:100,duration:0};
  assert.equal(resume({item,historyEntry}),100);
  assert.equal(resume({item,historyEntry:{...historyEntry,item:{...item,id:'other'}}}),0);
  for(const time of [Infinity,NaN,-1,4,'100',null])assert.equal(resume({item,historyEntry:{...historyEntry,time}}),0);
  assert.equal(resume({item:{...item,kind:'live'},options:{resumeTime:100}}),0);
});

test('tagged history never resumes another account while untagged legacy records remain compatible',()=>{
  for(const kind of ['movie','series']){
    const title={kind,id:'1'},historyEntry={item:title,episode,time:600,duration:1800,libraryId:'account-a'};
    const options={item:title,episode,historyEntry};
    assert.equal(resume({...options,accountLibraryId:'account-a'}),600);
    assert.equal(resume({...options,accountLibraryId:'account-b'}),0);
    assert.equal(resume(options),0);
    const legacy={...historyEntry};delete legacy.libraryId;
    assert.equal(resume({...options,historyEntry:legacy,accountLibraryId:'account-b'}),600);
  }
  const own={itemId:item.id,episodeId:episode.id,time:300,duration:1800};
  assert.equal(resume({item,episode,episodeEntry:own,accountLibraryId:'account-b',historyEntry:{item,episode,time:900,duration:1800,libraryId:'account-a'}}),300);
});

test('initial resume cannot save zero or seek readback until actual readiness is confirmed',()=>{
  const guard=new PlaybackPositionGuard();guard.attach({resumeTime:600});
  for(const state of ['waiting-metadata','seeking','recovering']){
    guard.observe({state,target:600,reason:'resume'});
    assert.equal(guard.canSave(0),false);
    assert.equal(guard.canSave(600),false);
  }
  guard.observe({state:'ready',target:600,reason:'resume'});
  assert.equal(guard.canSave(600.25),true);
  assert.equal(guard.canSave(0),true,'A later deliberate rewind can save a new position.');
});

test('failed or autoplay-paused resume retains the saved target through a forced close',()=>{
  const guard=new PlaybackPositionGuard();guard.attach({resumeTime:1200});
  guard.observe({state:'failed',detail:'metadata-timeout',target:1200,reason:'recovery'});
  assert.equal(guard.canSave(0),false);assert.equal(guard.target,1200);
  guard.observe({state:'paused',detail:'interaction-required',target:1200,reason:'resume'});
  assert.equal(guard.canSave(0),false);assert.equal(guard.target,1200);
  guard.reset();assert.equal(guard.pending,false);assert.equal(guard.target,null);
});

test('accepted user seeks and start-over intent release an automatic resume guard',()=>{
  const guard=new PlaybackPositionGuard();
  for(const reason of ['user','opening','credits','restart']){
    guard.attach({resumeTime:600});
    guard.observe({state:'waiting-metadata',target:0,reason});
    assert.equal(guard.canSave(0),true,reason);
  }
  guard.attach({resumeTime:600});guard.onUserSeek();assert.equal(guard.canSave(0),true);
});

test('new sources start clean and malformed media times are never saved',()=>{
  const guard=new PlaybackPositionGuard();
  assert.equal(guard.canSave(0),true);
  for(const time of [Infinity,NaN,-1,'20',null,undefined])assert.equal(guard.canSave(time),false);
  guard.attach({resumeTime:600});guard.observe({state:'ready',target:600,reason:'resume'});
  guard.attach({resumeTime:900});assert.equal(guard.canSave(0),false);
  guard.attach({resumeTime:0});assert.equal(guard.canSave(0),true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {TVPlaybackMeasurement, summarizeTVResourceTiming} from '../web/tv/player/medicao.js';
import {prepareTVOpening} from '../web/tv/player/abertura.js';

const video = () => ({videoWidth:1920,videoHeight:1080,readyState:4,currentTime:10,
  buffered:{length:1,start:()=>5,end:()=>15}});
function harness(options={}) {
  let time=0;const reports=[];
  const measurement=new TVPlaybackMeasurement({now:()=>time,report:record=>reports.push(record),resources:()=>[],...options});
  return {measurement,reports,at:value=>{time=value;}};
}

test('local timing separates overlapping preparation from media readiness without summing parallel phases',()=>{
  const h=harness(),media=video();h.at(100);h.measurement.mark('preparation');
  h.at(400);h.measurement.mark('sources');h.at(900);h.measurement.mark('stopped');
  h.at(1000);h.measurement.media('native');h.at(4000);h.measurement.playing(media);
  const record=h.reports[0];assert.equal(record.event,'first-playing');
  assert.equal(record.startupMs,4000);assert.equal(record.sourcesMs,300);assert.equal(record.stopBarrierMs,800);
  assert.equal(record.beforeMediaMs,1000);assert.equal(record.mediaToPlayingMs,3000);
  assert.equal(record.bufferSeconds,5);assert.equal(record.width,1920);assert.equal(record.height,1080);
  h.at(9000);h.measurement.playing(media);assert.equal(h.reports.length,1);assert.equal(h.measurement.snapshot(media).startupMs,4000);
});

test('snapshots expose media progression, pause, seeking, visibility and distinct frame counters without media control',t=>{
  const previous=globalThis.document;globalThis.document={visibilityState:'visible'};
  t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
  let qualityReads=0;
  const h=harness(),media=Object.assign(video(),{currentTime:10.12345,paused:false,seeking:false,networkState:2,
    webkitDecodedFrameCount:297,src:'https://private/stream?token=secret',
    getVideoPlaybackQuality(){qualityReads++;return {totalVideoFrames:300,droppedVideoFrames:5};}});
  const first=h.measurement.snapshot(media);
  assert.equal(first.currentTime,10.123);assert.equal(first.paused,false);assert.equal(first.seeking,false);
  assert.equal(first.networkState,2);assert.equal(first.visibilityState,'visible');
  assert.equal(first.decodedFrames,297);assert.equal(first.totalVideoFrames,300);assert.equal(first.droppedVideoFrames,5);
  assert.equal(qualityReads,1);assert.equal(media.currentTime,10.12345);assert.doesNotMatch(JSON.stringify(first),/private|secret|https/);
  Object.assign(media,{currentTime:11.5,paused:true,seeking:true,networkState:1,webkitDecodedFrameCount:301});
  globalThis.document.visibilityState='hidden';const second=h.measurement.snapshot(media);
  assert.equal(second.currentTime,11.5);assert.equal(second.paused,true);assert.equal(second.seeking,true);
  assert.equal(second.networkState,1);assert.equal(second.visibilityState,'hidden');assert.equal(second.decodedFrames,301);
  assert.equal(qualityReads,2,'The counter API is read once per existing snapshot, without adding samples.');
});

test('missing or failing frame APIs remain null, while genuine zero counters are retained',()=>{
  const h=harness(),media=video();let snapshot=h.measurement.snapshot(media);
  assert.equal(snapshot.decodedFrames,null);assert.equal(snapshot.totalVideoFrames,null);assert.equal(snapshot.droppedVideoFrames,null);
  assert.equal(snapshot.paused,null);assert.equal(snapshot.seeking,null);assert.equal(snapshot.networkState,null);
  media.getVideoPlaybackQuality=()=>{throw new Error('API unavailable');};media.webkitDecodedFrameCount=0;
  snapshot=h.measurement.snapshot(media);assert.equal(snapshot.decodedFrames,0);assert.equal(snapshot.totalVideoFrames,null);
  Object.defineProperty(media,'webkitDecodedFrameCount',{get(){throw new Error('WebKit counter unavailable');}});
  media.getVideoPlaybackQuality=()=>({totalVideoFrames:0,droppedVideoFrames:0});
  snapshot=h.measurement.snapshot(media);assert.equal(snapshot.decodedFrames,null);assert.equal(snapshot.totalVideoFrames,0);assert.equal(snapshot.droppedVideoFrames,0);
});

test('snapshot metadata excludes invalid counters, enum values and stringified state',t=>{
  const previous=globalThis.document;globalThis.document={visibilityState:'private-page-title'};
  t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
  const h=harness(),media=Object.assign(video(),{currentTime:Infinity,paused:'false',seeking:0,networkState:99,
    webkitDecodedFrameCount:-1,getVideoPlaybackQuality:()=>({totalVideoFrames:'100',droppedVideoFrames:NaN})});
  const snapshot=h.measurement.snapshot(media);
  for(const field of ['currentTime','paused','seeking','networkState','visibilityState','decodedFrames','totalVideoFrames','droppedVideoFrames'])assert.equal(snapshot[field],null,field);
  assert.doesNotMatch(JSON.stringify(snapshot),/private-page-title/);
});

test('wait reports are bounded, startup and duplicate waits are ignored, pauses stop the waiting clock',()=>{
  const h=harness(),media=video();h.measurement.media('hls');h.measurement.waiting(media);
  assert.equal(h.measurement.stalls,0);h.at(100);h.measurement.playing(media);
  h.at(1000);h.measurement.waiting(media);h.measurement.waiting(media);
  h.at(1300);h.measurement.interrupt();h.at(5000);h.measurement.playing(media);
  assert.equal(h.measurement.snapshot(media).waitingMs,300);
  for(let i=1;i<9;i++){h.at(5000+i*1000);h.measurement.waiting(media);h.at(5200+i*1000);h.measurement.playing(media);}
  h.measurement.close(media);assert.equal(h.reports.length,6);assert.equal(h.reports.at(-1).stalls,9);
  assert.equal(h.reports.at(-1).waitingMs,1900);h.measurement.close(media);h.measurement.playing(media);
  h.measurement.waiting(media);assert.equal(h.reports.length,6);
});

test('resource timing excludes old, foreign and nonmedia resources, retaining only bounded anonymous aggregates',()=>{
  const entry=(name,startTime=10)=>({name,startTime,fetchStart:startTime,requestStart:startTime+20,responseStart:startTime+80,responseEnd:startTime+100});
  const entries=[entry('https://app.test/api/asset/private-token?credential=secret',1),
    entry('https://foreign.test/api/play/live/secret.m3u8'),entry('https://app.test/api/shared-image/1'),
    entry('https://app.test/api/asset/private-token?credential=secret'),entry('https://app.test/api/play/live/99.m3u8')];
  const summary=summarizeTVResourceTiming(entries,{origin:'https://app.test',startedAt:5});
  assert.deepEqual(summary,{samples:2,maxBeforeRequestMs:20,maxResponseWaitMs:60,maxTransferMs:20});
  assert.doesNotMatch(JSON.stringify(summary),/secret|token|https|99|credential/);
  assert.equal(summarizeTVResourceTiming(Array.from({length:100},()=>entries[3]),{origin:'https://app.test'}).samples,32);
  assert.deepEqual(summarizeTVResourceTiming([],{}),{samples:0,maxBeforeRequestMs:null,maxResponseWaitMs:null,maxTransferMs:null});
});

test('diagnostic callbacks cannot interrupt playback and untrusted reason strings are never emitted',()=>{
  const h=harness({reason:'private-channel-and-url'}),media=video();h.measurement.media('private-engine-name');
  h.measurement.playing(media);assert.equal(h.reports[0].reason,'opening');assert.equal(h.reports[0].engine,'unknown');
  const broken=harness({report:()=>{throw new Error('console unavailable');}});
  assert.doesNotThrow(()=>{broken.measurement.playing(media);broken.measurement.waiting(media);broken.measurement.close(media);});
  const unavailable=harness({resources:()=>{throw new Error('timing unavailable');}});
  assert.doesNotThrow(()=>unavailable.measurement.playing(media));
  assert.equal(unavailable.reports.length,1);assert.equal(unavailable.reports[0].resourceTiming.samples,0);
  assert.equal(media.currentTime,10,'Measurement never seeks or controls media.');
});

test('prepared and user-gated openings are explicit instead of being mistaken for cold automatic startup',()=>{
  const h=harness({prepared:true});h.measurement.waitForUser();h.at(30000);h.measurement.playing(video());
  assert.equal(h.reports[0].prepared,true);assert.equal(h.reports[0].awaitingUser,true);assert.equal(h.reports[0].startupMs,30000);
});

test('failed reports expose only known error enums and an HTTP status, never message or media URL',t=>{
  const previous=globalThis.Hls;globalThis.Hls={ErrorDetails:{FRAG_LOAD_TIMEOUT:'fragLoadTimeOut'}};
  t.after(()=>{if(previous===undefined)delete globalThis.Hls;else globalThis.Hls=previous;});
  const h=harness();h.measurement.recordError({type:'networkError',detail:'fragLoadTimeOut',status:503,
    url:'https://private/media?token=secret',message:'private failure'});h.measurement.close(video(),{failed:true});
  assert.deepEqual(h.reports[0].error,{type:'networkError',detail:'fragLoadTimeOut',status:503});
  assert.doesNotMatch(JSON.stringify(h.reports),/private|secret|https/);
  const unknown=harness();unknown.measurement.recordError({type:'private',detail:'secret',status:3});
  unknown.measurement.close(video(),{failed:true});assert.deepEqual(unknown.reports[0].error,{type:'otherError',detail:'unknownError',status:null});
});

test('opening phase hooks preserve the STOP barrier even if diagnostics throw',async()=>{
  let stop;const phases=[];const stopped=new Promise(resolve=>{stop=resolve;});let released=false;
  const opening=prepareTVOpening({prepare:async()=>({sourceId:'fixture'}),stopped:[stopped],
    onPhase:phase=>{phases.push(phase);throw new Error('diagnostics unavailable');}}).then(value=>{released=true;return value;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(released,false);assert.deepEqual(phases,['sources']);
  stop();assert.deepEqual(await opening,{sourceId:'fixture'});assert.deepEqual(phases,['sources','stopped']);
});

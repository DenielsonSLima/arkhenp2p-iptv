import test from 'node:test';
import assert from 'node:assert/strict';
import {createTvTransportObserver} from '../lib/tv/transport-observer.mjs';

test('passive TV observations expose only selected measurements and keep transport phases separate',()=>{
  const events=[],client={},intent={},observe=createTvTransportObserver({emit:event=>events.push(event),now:()=>100});
  observe(client,intent,{phase:'prepare',durationMs:120,ok:true,status:200,url:'private',channelId:'446',attempt:'secret'});
  observe(client,intent,{phase:'manifest',headersMs:31,firstBodyMs:34,durationMs:37,bytes:1200,rewriteMs:1,ok:true,status:200});
  observe(client,intent,{phase:'segment',headersMs:50,firstBodyMs:54,durationMs:120,bytes:300000,mediaSeconds:4,ok:true,status:206});
  observe(client,intent,{phase:'cache',durationMs:1,bytes:300000,ok:true,status:200});
  assert.deepEqual(events.map(event=>event.phase),['prepare','manifest','segment','cache']);
  assert.ok(events.every(event=>event.observation===1&&Object.isFrozen(event)));
  assert.equal(events[2].mediaSeconds,4);assert.equal(events[2].firstBodyMs,54);
  assert.doesNotMatch(JSON.stringify(events),/private|secret|channelId|attempt|url/);
});

test('steady transfers are aggregated after ten seconds and cache does not inflate network delivery',()=>{
  const events=[],client={},intent={};let now=0;
  const observe=createTvTransportObserver({emit:event=>events.push(event),now:()=>now});
  observe(client,intent,{phase:'segment',headersMs:10,firstBodyMs:12,durationMs:100,bytes:100,mediaSeconds:4,ok:true,status:200});
  now=100;observe(client,intent,{phase:'cache',bytes:100,ok:true,status:200});
  now=200;observe(client,intent,{phase:'segment',headersMs:20,firstBodyMs:30,durationMs:200,bytes:200,mediaSeconds:4,ok:true,status:200});
  now=9999;observe(client,intent,{phase:'segment',headersMs:25,durationMs:300,bytes:0,ok:false,status:503});
  assert.equal(events.length,2);
  now=10000;observe(client,intent,{phase:'segment',headersMs:30,firstBodyMs:40,durationMs:400,bytes:400,mediaSeconds:4,ok:true,status:200});
  const window=events.at(-1);assert.equal(window.phase,'window');
  assert.equal(window.segmentSamples,4);assert.equal(window.cacheHits,1);assert.equal(window.failures,1);
  assert.equal(window.segmentBytes,700);assert.equal(window.mediaSeconds,12);assert.equal(window.segmentDurationMs,700);
});

test('zapping and callback failures stay bounded per client; an old playback cannot mix into the new one',()=>{
  const events=[],client={};let now=0;
  const observe=createTvTransportObserver({emit:event=>{events.push(event);throw new Error('observer failed');},now:()=>now});
  for(let i=0;i<100;i++)observe(client,{}, {phase:'prepare',durationMs:1,ok:true,status:200});
  assert.equal(events.length,36);
  now=300000;const newIntent={},olderIntent={};observe(client,olderIntent,{phase:'segment',bytes:10,durationMs:1,mediaSeconds:1,ok:true,status:200});
  assert.equal(events.length,37);assert.equal(events.at(-1).segmentBytes,undefined);
  assert.notEqual(events.at(-1).observation,events[0].observation);
  observe(client,newIntent,{phase:'prepare',durationMs:1,ok:true,status:200});
  observe(client,olderIntent,{phase:'segment',bytes:10000,durationMs:1,mediaSeconds:1,ok:true,status:200});
  assert.equal(events.length,38);assert.equal(events.at(-1).phase,'prepare');
});

test('disabled, invalid and non-finite samples never emit uncontrolled payloads',()=>{
  const events=[],client={},intent={},observe=createTvTransportObserver({emit:event=>events.push(event),now:()=>0});
  assert.doesNotThrow(()=>createTvTransportObserver()({}, {}, {phase:'prepare'}));
  observe(client,intent,{phase:'https://private'});observe(null,intent,{phase:'prepare'});
  observe(client,intent,{phase:'segment',bytes:Infinity,durationMs:NaN,headersMs:-1,firstBodyMs:999999999,mediaSeconds:'4',ok:false,status:999});
  assert.equal(events.length,1);assert.equal(events[0].bytes,null);assert.equal(events[0].headersMs,null);assert.equal(events[0].firstBodyMs,null);assert.equal(events[0].status,null);
  assert.doesNotMatch(JSON.stringify(events),/Infinity|NaN|private/);
});

test('playlist observations retain numeric progress privately per resource and summarize within the existing event budget',()=>{
  let now=0;const events=[],client={},intent={};
  const observe=createTvTransportObserver({emit:event=>events.push(event),now:()=>now});
  const manifest=(key,seq,count=3)=>observe(client,intent,{phase:'manifest',playlistKey:key,mediaPlaylist:true,mediaSequence:seq,
    discontinuitySequence:2,segmentCount:count,windowSeconds:count*2,targetDuration:2,endList:false,llHls:false,hasVariables:false,
    hasByteRange:true,bootstrap:false,resolvedURL:true,entryPlaylist:true,ageSeconds:7,ok:true,status:200,url:'secret-url',headers:{Cookie:'secret'}});
  manifest('private-a',100);assert.equal(events[0].mediaSequence,100);assert.equal(events[0].sequenceAdvance,null);
  now=1000;manifest('private-a',101);now=2000;manifest('private-b',900);now=10000;manifest('private-a',101,4);
  const window=events.at(-1);assert.equal(window.phase,'window');assert.equal(window.playlist.mediaSequence,101);
  assert.equal(window.playlist.sequenceAdvance,0);assert.equal(window.playlist.tailSequenceAdvance,1);assert.equal(window.sequenceAdvanceTotal,1);
  assert.equal(window.playlist.ageSeconds,7);assert.equal(window.manifestResolvedCount,4);assert.equal(window.manifestBootstrapCount,0);
  assert.doesNotMatch(JSON.stringify(events),/private|secret|"(?:playlistKey|Cookie|url|headers)"/);
  for(let i=0;i<24;i++){now+=10000;manifest('private-a',102+i);}
  assert.ok(events.length<=36);
});

test('the first media playlist is visible immediately after a master without emitting every reload',()=>{
  const events=[],observe=createTvTransportObserver({emit:event=>events.push(event),now:()=>0}),client={},intent={};
  observe(client,intent,{phase:'manifest',mediaPlaylist:false,mediaSequence:null,ok:true,status:200});
  observe(client,intent,{phase:'manifest',playlistKey:'private-media',mediaPlaylist:true,mediaSequence:10,segmentCount:3,ok:true,status:200});
  observe(client,intent,{phase:'manifest',playlistKey:'private-media',mediaPlaylist:true,mediaSequence:11,segmentCount:3,ok:true,status:200});
  assert.equal(events.length,2);assert.equal(events[1].mediaSequence,10);assert.equal(events[0].observation,events[1].observation);
});

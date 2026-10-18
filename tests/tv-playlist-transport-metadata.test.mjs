import test from 'node:test';
import assert from 'node:assert/strict';
import {tvPlaylistTransportMetadata,tvPlaylistUriIdentity,createTvTransportObserver,TV_AUTH_QUERY_FLAGS} from '../lib/tv/transport-observer.mjs';
import {ProviderClient} from '../lib/provider.mjs';

test('a media window emits only numbers and flags, excluding URI, key, query and EXTINF titles',()=>{
  const text='#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:1234\n#EXT-X-DISCONTINUITY-SEQUENCE:7\n'+
    '#EXT-X-KEY:METHOD=AES-128,URI="https://private.example/key?token=secret"\n#EXTINF:3.5,Private title\nhttps://private.example/one.ts?secret=value\n'+
    '#EXTINF:4,Another private title\nsegment.ts\n#EXT-X-ENDLIST\n';
  const value=tvPlaylistTransportMetadata(text);
  assert.deepEqual(value,{mediaPlaylist:true,mediaSequence:1234,discontinuitySequence:7,segmentCount:2,windowSeconds:7.5,targetDuration:4,
    endList:true,llHls:false,hasVariables:false,hasByteRange:false});
  assert.ok(Object.values(value).every(item=>item===null||typeof item==='number'||typeof item==='boolean'));
  assert.doesNotMatch(JSON.stringify(value),/private|secret|https|title|token/i);
});

test('LL-HLS, variable references and media/init byte ranges are flags without retained attributes',()=>{
  for(const tag of ['#EXT-X-BYTERANGE:100@0','#EXT-X-MAP:URI="private",BYTERANGE="100@0"','#EXT-X-PART:DURATION=0.5,URI="private",BYTERANGE="10@0"']){
    const value=tvPlaylistTransportMetadata('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-DEFINE:NAME="secret",VALUE="private"\n'+
      '#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES\n'+tag+'\n#EXTINF:2,Secret title\nseg_{$secret}.ts\n');
    assert.equal(value.llHls,true);assert.equal(value.hasVariables,true);assert.equal(value.hasByteRange,true);
    assert.equal(value.discontinuitySequence,0);assert.equal(value.segmentCount,1);assert.equal(value.windowSeconds,2);
    assert.doesNotMatch(JSON.stringify(value),/private|secret|URI/);
  }
});

test('master and malformed numeric tags are distinguished without inventing a sequence',()=>{
  const master=tvPlaylistTransportMetadata('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nprivate.m3u8\n');
  assert.equal(master.mediaPlaylist,false);assert.equal(master.mediaSequence,null);assert.equal(master.discontinuitySequence,null);assert.equal(master.segmentCount,0);
  const malformed=tvPlaylistTransportMetadata('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:9007199254740993\n#EXT-X-DISCONTINUITY-SEQUENCE:-1\n#EXT-X-TARGETDURATION:secret\n#EXTINF:Infinity,private\nprivate.ts\n');
  assert.equal(malformed.mediaSequence,null);assert.equal(malformed.discontinuitySequence,null);assert.equal(malformed.targetDuration,null);assert.equal(malformed.segmentCount,0);
});

test('sequence regressions and a renewed observation remain numeric and never reuse the old advancement state',()=>{
  let now=0;const events=[],client={},first={},second={},observe=createTvTransportObserver({emit:event=>events.push(event),now:()=>now});
  const sample=mediaSequence=>({phase:'manifest',mediaPlaylist:true,mediaSequence,segmentCount:3,playlistKey:'private',ok:true,status:200,
    ageSeconds:'private',hasVariables:'secret',headers:{Cookie:'private'}});
  observe(client,first,sample(100));now=10000;observe(client,first,sample(90));
  assert.equal(events.at(-1).playlist.sequenceAdvance,-10);assert.equal(events.at(-1).sequenceRegressions,1);
  observe(client,second,sample(80));assert.equal(events.at(-1).sequenceAdvance,null);assert.equal(events.at(-1).ageSeconds,null);assert.equal(events.at(-1).hasVariables,false);
  assert.doesNotMatch(JSON.stringify(events),/private|secret|Cookie/);
});

const playlist=(uri='segment.ts?token=secret',duration=1,sequence=10,discontinuity=0)=>
  `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXT-X-DISCONTINUITY-SEQUENCE:${discontinuity}\n#EXTINF:${duration},Private title\n${uri}\n`;
function identityFixture(){
  let now=0;const events=[],identity={},client=new ProviderClient({server:'https://private.example',username:'fixture',password:'secret'});
  client.beginPlayback('live:1');const observe=createTvTransportObserver({emit:event=>events.push(event),now:()=>now});
  return{events,client,sample(text,base='https://private.example/live/index.m3u8?token=secret',intent=identity){
    const rewritten=client.rewriteManifest(text,base,'live:1'),uriIdentity=tvPlaylistUriIdentity(text,rewritten,base);
    assert.equal(JSON.stringify(uriIdentity),'{}');
    observe(client,intent,{phase:'manifest',...tvPlaylistTransportMetadata(text),uriIdentity,playlistKey:'private-playlist',ok:true,status:200});
    now+=10000;return rewritten;
  }};
}

test('same-sequence comparison separates provider URI changes, URL resolution and local rewrite identity',()=>{
  for(const [name,first,second,baseA,baseB,expected]of [
    ['stable',playlist(),playlist(),undefined,undefined,{rawUriStable:true,resolvedUriStable:true,proxyUriStable:true,durationStable:true,mediaBaseChanged:false}],
    ['provider URI',playlist(),playlist('different.ts?token=secret'),undefined,undefined,{rawUriStable:false,resolvedUriStable:false,proxyUriStable:false,durationStable:true,rawUriChanges:1,resolvedUriChanges:1,proxyUriChanges:1,rewriteOnlyUriChanges:0}],
    ['equivalent spelling',playlist(),playlist('./segment.ts?token=secret'),undefined,undefined,{rawUriStable:false,resolvedUriStable:true,proxyUriStable:true,durationStable:true,rawUriChanges:1}],
    ['base query',playlist(),playlist(),'https://private.example/live/index.m3u8?token=secret-a','https://private.example/live/index.m3u8?token=secret-b',{rawUriStable:true,resolvedUriStable:true,proxyUriStable:false,mediaBaseChanged:true,proxyUriChanges:1,rewriteOnlyUriChanges:1}],
    ['base directory',playlist(),playlist(),'https://private.example/a/index.m3u8','https://private.example/b/index.m3u8',{rawUriStable:true,resolvedUriStable:false,proxyUriStable:false,mediaBaseChanged:true,resolvedUriChanges:1}],
    ['duration only',playlist(),playlist(undefined,2),undefined,undefined,{rawUriStable:true,resolvedUriStable:true,proxyUriStable:true,durationStable:false,durationChanges:1}],
  ]){
    const f=identityFixture();f.sample(first,baseA);f.sample(second,baseB);const event=f.events.at(-1),actual=event.playlist;
    assert.equal(actual.sameSequenceSamples,1,name);
    for(const [field,value]of Object.entries(expected))assert.equal(actual[field],value,`${name}: ${field}`);
    assert.equal(event.sameSequenceSamples,1,name);
    assert.doesNotMatch(JSON.stringify(f.events),/private|secret|fixture|https|digest|uriIdentity|playlistKey|token|\/api\/asset/i);
    assert.ok(Object.values(actual).every(value=>value===null||typeof value==='number'||typeof value==='boolean'));
  }
});

test('comparison keys include discontinuity and reset across observations; caller payload cannot forge private identities',()=>{
  const f=identityFixture();f.sample(playlist());f.sample(playlist(undefined,1,10,1));
  assert.equal(f.events.at(-1).playlist.sameSequenceSamples,0);assert.equal(f.events.at(-1).playlist.rawUriStable,null);
  f.sample(playlist(),undefined,{});assert.equal(f.events.at(-1).sameSequenceSamples,0);assert.equal(f.events.at(-1).proxyUriStable,null);
  const events=[],observe=createTvTransportObserver({emit:event=>events.push(event),now:()=>0});
  observe({}, {}, {phase:'manifest',...tvPlaylistTransportMetadata(playlist()),uriIdentity:{raw:'private',proxy:'secret'},ok:true,status:200});
  assert.equal(events[0].sameSequenceSamples,0);assert.equal(events[0].proxyUriStable,null);assert.doesNotMatch(JSON.stringify(events),/private|secret/);
});

test('segment comparison retains at most the latest 128 identities and totals intermittent changes within the window',()=>{
  const many=marker=>'#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n'+Array.from({length:300},(_,i)=>`#EXTINF:1,\nsegment-${i}.ts?private=${marker}\n`).join('');
  const f=identityFixture();f.sample(many('secret-a'));f.sample(many('secret-b'));
  const event=f.events.at(-1);assert.equal(event.playlist.sameSequenceSamples,128);assert.equal(event.playlist.rawUriChanges,128);
  assert.equal(event.rawUriChanges,128);assert.equal(event.resolvedUriChanges,128);assert.equal(event.proxyUriChanges,128);
  assert.doesNotMatch(JSON.stringify(f.events),/private|secret|segment-/);
  let now=0;const events=[],client={},intent={},observe=createTvTransportObserver({emit:event=>events.push(event),now:()=>now});
  const sample=(raw,proxy)=>observe(client,intent,{phase:'manifest',...tvPlaylistTransportMetadata(raw),uriIdentity:tvPlaylistUriIdentity(raw,proxy,'https://private.example/live.m3u8'),ok:true,status:200});
  sample(playlist(),playlist('/api/asset/a'));now=100;sample(playlist(),playlist('/api/asset/b'));now=10000;sample(playlist(),playlist('/api/asset/b'));
  assert.equal(events.at(-1).playlist.proxyUriChanges,0);assert.equal(events.at(-1).proxyUriChanges,1);assert.equal(events.at(-1).rewriteOnlyUriChanges,1);
});

test('URI rotation is separated into private path, filename, query and origin comparisons',()=>{
  for(const [name,first,second,expected]of [
    ['query only','segment.ts?token=secret-a','segment.ts?token=secret-b',{rawPathChanges:0,resolvedPathChanges:0,queryChanges:1,originChanges:0,filenameChanges:0,queryOnlyUriChanges:1}],
    ['filename only','segment-a.ts?token=secret','segment-b.ts?token=secret',{rawPathChanges:1,resolvedPathChanges:1,queryChanges:0,originChanges:0,filenameChanges:1,queryOnlyUriChanges:0}],
    ['directory only','a/segment.ts?token=secret','b/segment.ts?token=secret',{rawPathChanges:1,resolvedPathChanges:1,queryChanges:0,originChanges:0,filenameChanges:0,queryOnlyUriChanges:0}],
    ['equivalent spelling','segment.ts?token=secret','./segment.ts?token=secret',{rawPathChanges:1,resolvedPathChanges:0,queryChanges:0,originChanges:0,filenameChanges:0,queryOnlyUriChanges:0}],
    ['origin only','https://private-a.example/segment.ts?token=secret','https://private-b.example/segment.ts?token=secret',{rawPathChanges:0,resolvedPathChanges:0,queryChanges:0,originChanges:1,filenameChanges:0,queryOnlyUriChanges:0}],
    ['path and query','segment-a.ts?token=secret-a','segment-b.ts?token=secret-b',{rawPathChanges:1,resolvedPathChanges:1,queryChanges:1,originChanges:0,filenameChanges:1,queryOnlyUriChanges:0}],
  ]){
    const f=identityFixture();f.sample(playlist(first));f.sample(playlist(second));const event=f.events.at(-1);
    for(const [field,value]of Object.entries(expected)){
      assert.equal(event.playlist[field],value,`${name}: playlist ${field}`);assert.equal(event[field],value,`${name}: window ${field}`);
    }
    assert.doesNotMatch(JSON.stringify(f.events),/private|secret|segment(?:-|\.ts)|token|uriIdentity|digest|https/i);
  }
});

test('changed query names become fixed numeric flags while arbitrary names and every value stay private',()=>{
  const flags=TV_AUTH_QUERY_FLAGS;
  for(const [first,second,expected,knownOnly,unknown,representation]of [
    ['token=private-a','token=private-b',flags.token,true,false,0],
    ['token=private&expires=1','token=changed&expires=2',flags.token|flags.expires,true,false,0],
    ['signature=private','sig=private',flags.signature|flags.sig,true,false,0],
    ['auth=private','Auth=private',flags.auth,true,false,0],
    ['token=private&channel=1','token=changed&channel=1',flags.token,true,false,0],
    ['token=private&private_param=1','token=changed&private_param=2',flags.token,false,true,0],
    ['private_param=1','private_param=2',0,false,true,0],
    ['constructor=1','constructor=2',0,false,true,0],
    ['__proto__=1','__proto__=2',0,false,true,0],
    ['token=a&expires=1','expires=1&token=a',0,false,false,1],
    ['token=%2f','token=%2F',0,false,false,1],
    ['token=a&token=b','token=b&token=a',flags.token,true,false,0],
    ['token=a','',flags.token,true,false,0],
  ]){
    const f=identityFixture();f.sample(playlist('segment.ts?'+first));f.sample(playlist('segment.ts?'+second));const event=f.events.at(-1);
    for(const actual of [event,event.playlist]){
      assert.equal(actual.changedAuthQueryFlags,expected);assert.equal(actual.queryKnownAuthOnly,knownOnly);
      assert.equal(actual.unknownChangedQuery,unknown);assert.equal(actual.queryRepresentationChanges,representation);
    }
    assert.doesNotMatch(JSON.stringify(f.events),/private|secret|token|expires|signature|channel|digest|https/i);
  }
  assert.ok(Object.values(flags).every(value=>Number.isSafeInteger(value)&&value>0));
});

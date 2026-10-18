import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../lib/app-server.mjs';
import {ProviderClient,ProviderError} from '../lib/provider.mjs';

async function fixture(t,{prepareError,segmentStatus=200,throwObserver=false,prepareGate,prepareEntered}={}){
  const events=[],requests=[];let apiCalls=0;
  const app=createApp({connection:{server:'https://fixture.example'},sharedWorker:{stop(){},unregisterSource(){}},
    onPlaybackTransport:event=>{events.push(event);if(throwObserver)throw new Error('observer failure');},
    providerFactory:({config})=>{
      const client=new ProviderClient({...config,server:'https://fixture.example'});
      client.connect=async()=>client.session={connected:true,account:{status:'Active'}};
      client.api=async()=>{apiCalls++;throw new Error('Passive observations must not probe the account');};
      client.catalog=async()=>({categories:[{id:'safe',name:'TV'}],items:[{id:'446',kind:'live',name:'Canal sintético',categoryId:'safe'}]});
      client.playbackURL=async()=>{prepareEntered?.();await prepareGate;if(prepareError)throw prepareError;await delay(2);return new URL('https://private-media.example/live.m3u8?token=secret');};
      client.upstreamRequest=async value=>{
        requests.push(String(value));await delay(2);
        const manifest=new URL(value).pathname==='/live.m3u8';
        const body=manifest?'#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:4,\nsegment.ts?token=secret\n':'synthetic-segment';
        return {status:manifest?200:segmentStatus,url:String(value),headers:{'content-type':manifest?'application/vnd.apple.mpegurl':'video/mp2t',age:'7'},
          body:Readable.from((async function*(){await delay(2);yield Buffer.from(body);})())};
      };
      return client;
    }});
  await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{app.closeAllConnections?.();await app.shutdown();});
  const base='http://127.0.0.1:'+app.address().port;
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'private-user',password:'private-password'})});
  assert.equal(login.status,200);await login.json();
  const headers={Cookie:login.headers.get('set-cookie').split(';')[0]};
  return{events,requests,get apiCalls(){return apiCalls;},read:(path,options={})=>fetch(base+path,{headers,...options})};
}

test('existing live requests report prepare, manifest, first segment and cache without any diagnostics probes',async t=>{
  const f=await fixture(t),response=await f.read('/api/play/live/446/index.m3u8?attempt=private-attempt');
  assert.equal(response.status,200);
  const manifest=await response.text(),asset=manifest.split('\n').find(line=>line.startsWith('/api/asset/'));
  assert.ok(asset);const first=await f.read(asset);assert.equal(first.status,200);assert.equal(await first.text(),'synthetic-segment');
  const cached=await f.read(asset);assert.equal(cached.status,200);assert.equal(await cached.text(),'synthetic-segment');
  assert.deepEqual(f.events.map(event=>event.phase),['prepare','manifest','segment','cache']);
  assert.ok(f.events.every(event=>event.observation===f.events[0].observation));
  const transfer=f.events.find(event=>event.phase==='segment');assert.equal(transfer.mediaSeconds,4);
  assert.ok(transfer.firstBodyMs>=transfer.headersMs);assert.ok(transfer.durationMs>=transfer.firstBodyMs);
  assert.equal(f.events.find(event=>event.phase==='manifest').bytes,Buffer.byteLength('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:4,\nsegment.ts?token=secret\n'));
  const playlist=f.events.find(event=>event.phase==='manifest');
  assert.equal(playlist.mediaSequence,100);assert.equal(playlist.discontinuitySequence,0);assert.equal(playlist.segmentCount,1);assert.equal(playlist.windowSeconds,4);
  assert.equal(playlist.bootstrap,true);assert.equal(playlist.resolvedURL,false);assert.equal(playlist.entryPlaylist,true);assert.equal(playlist.ageSeconds,7);
  assert.equal(f.requests.length,2);assert.equal(f.apiCalls,0);
  assert.doesNotMatch(JSON.stringify(f.events),/private|secret|"446"|token|channelId|sourceId|attempt|https:|cookie|password/i);
});

test('preparation and segment failures retain their phases and cannot leak provider errors',async t=>{
  const denied=await fixture(t,{prepareError:new ProviderError('https://private.example/secret','SYNTHETIC_UNAVAILABLE',503)});
  const blocked=await denied.read('/api/play/live/446/index.m3u8?attempt=private-attempt');assert.equal(blocked.status,503);await blocked.json();
  assert.equal(denied.events.length,1);assert.equal(denied.events[0].phase,'prepare');assert.equal(denied.events[0].ok,false);assert.equal(denied.events[0].status,503);assert.equal(denied.requests.length,0);
  const failed=await fixture(t,{segmentStatus:503}),manifest=await failed.read('/api/play/live/446/index.m3u8?attempt=private-attempt');
  const asset=(await manifest.text()).split('\n').find(line=>line.startsWith('/api/asset/'));
  const segment=await failed.read(asset);assert.equal(segment.status,502);await segment.json();
  assert.equal(failed.events.at(-1).phase,'segment');assert.equal(failed.events.at(-1).ok,false);assert.equal(failed.events.at(-1).status,503);
  assert.doesNotMatch(JSON.stringify([...denied.events,...failed.events]),/private|secret|https:|SYNTHETIC_UNAVAILABLE/);
});

test('a broken telemetry consumer cannot interrupt the live response',async t=>{
  const f=await fixture(t,{throwObserver:true}),response=await f.read('/api/play/live/446/index.m3u8?attempt=synthetic');
  assert.equal(response.status,200);assert.match(await response.text(),/^#EXTM3U/);assert.equal(f.events.length,2);
});

test('an upstream range rejection remains visible without changing its 416 response',async t=>{
  const f=await fixture(t,{segmentStatus:416}),manifest=await f.read('/api/play/live/446/index.m3u8?attempt=range');
  const asset=(await manifest.text()).split('\n').find(line=>line.startsWith('/api/asset/'));
  const response=await f.read(asset);assert.equal(response.status,416);await response.text();
  assert.equal(f.events.at(-1).phase,'segment');assert.equal(f.events.at(-1).status,416);assert.equal(f.events.at(-1).ok,false);
});

test('HEAD readers and a preparation retired by STOP do not become TV delivery observations',async t=>{
  const head=await fixture(t),response=await head.read('/api/play/live/446/index.m3u8?attempt=head-only',{method:'HEAD'});
  assert.equal(response.status,200);assert.deepEqual(head.events,[]);
  let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
  const stopped=await fixture(t,{prepareGate:gate,prepareEntered:entered});
  const pending=stopped.read('/api/play/live/446/index.m3u8?attempt=retired');await ready;
  const stop=await stopped.read('/api/stop',{method:'POST'});assert.equal(stop.status,200);await stop.json();release();
  assert.equal((await pending).status,409);assert.deepEqual(stopped.events,[]);assert.equal(stopped.requests.length,0);
});

test('later bounded windows correlate a frozen resolved playlist and numeric Age without logging its source',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const f=await fixture(t),path='/api/play/live/446/index.m3u8?attempt=private-attempt';
  for(let i=0;i<3;i++){const response=await f.read(path);assert.equal(response.status,200);await response.text();now+=10000;}
  const window=f.events.filter(event=>event.phase==='window').at(-1);
  assert.equal(window.playlist.mediaSequence,100);assert.equal(window.playlist.sequenceAdvance,0);
  assert.equal(window.playlist.resolvedURL,true);assert.equal(window.playlist.bootstrap,false);assert.equal(window.playlist.ageSeconds,7);
  assert.equal(window.playlist.sameSequenceSamples,1);assert.equal(window.playlist.rawUriStable,true);assert.equal(window.playlist.resolvedUriStable,true);
  assert.equal(window.playlist.proxyUriStable,true);assert.equal(window.playlist.durationStable,true);assert.equal(window.playlist.mediaBaseChanged,false);
  for(const field of ['rawPathChanges','resolvedPathChanges','queryChanges','originChanges','filenameChanges','queryOnlyUriChanges']){
    assert.equal(window.playlist[field],0);assert.equal(window[field],0);
  }
  assert.ok(f.events.every(event=>event.observation===f.events[0].observation));assert.equal(f.apiCalls,0);assert.equal(f.requests.length,3);
  assert.doesNotMatch(JSON.stringify(f.events),/private|secret|"446"|token|channelId|sourceId|attempt|https:|cookie|password/i);
});

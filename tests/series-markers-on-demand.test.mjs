import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {EpisodeMarkersOnDemand} from '../lib/serie/marcadores/sob-demanda.mjs';
import {EpisodeMarkerRoute} from '../lib/serie/marcadores/rota.mjs';
import {reservePlaybackIntent} from '../lib/live-playback-session.mjs';
import {EpisodeOnDemandReader} from '../web/serie/marcadores/sob-demanda.js';
import {validEpisodeReference,sourceSegments} from '../web/serie/marcadores/referencia.js';

const input={imdbId:'tt0903747',season:1,episode:1,duration:600};
const segments={intro:{start_ms:10000,end_ms:40000},outro:{start_ms:550000,end_ms:600000}};
const payload=(parts=segments)=>({imdb_id:input.imdbId,season:1,episode:1,segments:parts});
const reference={schemaVersion:1,...input,status:'reference',ttlSeconds:86400,segments:{intro:{start:10,end:40,source:'SkipDB'}}};
const context={item:{kind:'series',id:'100',name:'Breaking Bad',imdbId:input.imdbId},episode:{id:'200',season:1,number:1},duration:600,sourceFingerprint:'edition-one',playing:true};
const storage=()=>{const map=new Map();return {map,getItem:key=>map.get(key),setItem:(key,value)=>map.set(key,value)};};

test('one episode lookup passes runtime without fetching the season, coalesces and caches',async()=>{
  const calls=[];let now=1000;
  const service=new EpisodeMarkersOnDemand({now:()=>now,fetch:async(url)=>{calls.push(new URL(url));return Response.json(payload());}});
  const [a,b]=await Promise.all([service.lookup(input),service.lookup(input)]);
  assert.equal(calls.length,1);assert.equal(calls[0].pathname,'/api/segments');
  assert.equal(calls[0].searchParams.get('duration'),'600');assert.equal(calls[0].searchParams.get('adjust'),'none');
  assert.equal(calls[0].searchParams.get('episode'),'1');assert.equal(validEpisodeReference(a,input),true);
  a.segments.intro.end=99;assert.equal(b.segments.intro.end,40);assert.equal((await service.lookup(input)).segments.intro.end,40);
  now+=86400001;await service.lookup(input);assert.equal(calls.length,2);
});

test('fallback preserves each primary window, tolerates <=5s, and flags only larger differences',async()=>{
  for(const delta of [3,5,5.001]){
    const calls=[];const service=new EpisodeMarkersOnDemand({fetch:async url=>{
      calls.push(url);return Response.json(url.includes('skipdb')?payload({intro:segments.intro,outro:null}):
        {...payload(),segments:undefined,intro:{start_ms:10000+delta*1000,end_ms:40000+delta*1000},outro:segments.outro});
    }});
    const result=await service.lookup(input);assert.equal(calls.length,2);
    assert.equal(result.segments.intro.start,10);assert.equal(result.segments.intro.end,40);
    assert.equal(result.segments.outro.source,'IntroDB');
    assert.equal(result.segments.intro.divergenceSeconds,delta>5?delta:undefined);
  }
});

test('confirmed absence is not replaced with fallback and malformed/foreign segments cannot be used',async()=>{
  const service=new EpisodeMarkersOnDemand({fetch:async url=>Response.json(url.includes('skipdb')?
    payload({intro:{start_ms:0,end_ms:0},outro:null}):{...payload(),segments:undefined,...segments})});
  const result=await service.lookup(input);assert.equal(result.segments.intro,undefined);assert.ok(result.segments.outro);
  assert.equal(sourceSegments('SkipDB',{...payload(),episode:2},input),null);
  assert.deepEqual(sourceSegments('SkipDB',payload({intro:{start_ms:10,end_ms:9999999}}),input),{});
  assert.equal(validEpisodeReference({...reference,episode:2},input),false);
  assert.equal(validEpisodeReference({...reference,status:'empty'},input),false);
});

test('empty and failed lookups have bounded negative caches and 429 backoff',async()=>{
  let now=1000,count=0;
  const service=new EpisodeMarkersOnDemand({now:()=>now,fetch:async()=>{count++;return new Response(null,{status:429,headers:{'Retry-After':'120'}});}});
  assert.equal((await service.lookup(input)).status,'unavailable');assert.equal(count,2);
  now+=61000;await service.lookup(input);assert.equal(count,2);
  now+=61000;await service.lookup(input);assert.equal(count,4);
  const empty=new EpisodeMarkersOnDemand({fetch:async()=>new Response(null,{status:404})});
  assert.deepEqual(await empty.lookup(input),{schemaVersion:1,...input,status:'empty',segments:{},ttlSeconds:3600});
});

test('cancel one reader keeps the shared request; cancel all aborts upstream and caches nothing',async()=>{
  let finish,upstream;
  const service=new EpisodeMarkersOnDemand({fetch:(url,{signal})=>{upstream=signal;return new Promise((resolve,reject)=>{
    finish=()=>resolve(Response.json(payload()));signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  });}});
  const a=new AbortController(),b=new AbortController();
  const first=service.lookup(input,{signal:a.signal}),second=service.lookup(input,{signal:b.signal});
  a.abort();await assert.rejects(first,{name:'AbortError'});assert.equal(upstream.aborted,false);
  finish();assert.equal((await second).status,'reference');
  let aborted;
  const other=new EpisodeMarkersOnDemand({fetch:(url,{signal})=>new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true});
  })});
  const c=new AbortController(),pending=other.lookup(input,{signal:c.signal});c.abort();await assert.rejects(pending,{name:'AbortError'});
  assert.equal(aborted,true);assert.equal(other.cache.size,0);
});

test('responses over 64KB are rejected and the other source may answer',async()=>{
  const service=new EpisodeMarkersOnDemand({fetch:async url=>url.includes('skipdb')?new Response(' '.repeat(65537)):
    Response.json({...payload(),segments:undefined,...segments})});
  assert.equal((await service.lookup(input)).segments.intro.source,'IntroDB');
});

test('device cache is episode/source/runtime/account specific and no request runs before playing',async()=>{
  const device=storage();let account='a'.repeat(64),count=0;
  const options={getNamespace:()=>account,storage:device,request:async url=>{
    count++;const q=new URL(url,'http://local').searchParams;
    return {...reference,season:Number(q.get('season')),episode:Number(q.get('episode')),duration:Number(q.get('duration'))};
  }};
  const reader=new EpisodeOnDemandReader(options);
  await reader.lookup({...context,playing:false});assert.equal(count,0);
  assert.equal((await reader.lookup(context)).status,'reference');assert.equal(count,1);
  await new EpisodeOnDemandReader(options).lookup(context);assert.equal(count,1);
  await reader.lookup({...context,episode:{...context.episode,id:'201',number:2}});assert.equal(count,2);
  await reader.lookup({...context,sourceFingerprint:'edition-two'});assert.equal(count,3);
  await reader.lookup({...context,duration:601});assert.equal(count,4);
  account='b'.repeat(64);await reader.lookup(context);assert.equal(count,5);
  const saved=[...device.map.values()].join('');assert.equal(saved.includes('edition-one'),false);assert.equal(saved.includes('"mediaId"'),false);
});

test('late response after account/reset/abort is not stored or returned',async()=>{
  for(const mode of ['reset','account','abort']){
    let finish,account='a'.repeat(64);const device=storage(),controller=new AbortController();
    const reader=new EpisodeOnDemandReader({storage:device,getNamespace:()=>account,request:()=>new Promise(resolve=>finish=resolve)});
    const pending=reader.lookup({...context,signal:controller.signal});
    if(mode==='reset')reader.reset();else if(mode==='account')account='b'.repeat(64);else controller.abort();
    finish(reference);await assert.rejects(pending,{name:'AbortError'});assert.equal(device.map.size,0);
  }
});

test('known title with conflicting external ID does not fall through to a guessed identity',async()=>{
  let requests=0;const reader=new EpisodeOnDemandReader({storage:null,request:async()=>{requests++;return reference;}});
  const result=await reader.lookup({...context,item:{...context.item,imdbId:'tt0944947'}});
  assert.equal(result.reason,'identity-conflict');assert.equal(requests,0);
});

function routeFixture(service){
  const client={playbackGeneration:0,playback:{key:'series:200',controller:new AbortController()}},state={client,authGeneration:1,parental:{assertPlayback(){}}};
  reservePlaybackIntent(state,client,{kind:'series',id:'200'});
  const replies=[],route=new EpisodeMarkerRoute({service,respond:(res,value,status)=>replies.push({value,status})});
  const url=new URL('/api/series/episode-markers?'+new URLSearchParams({...input,episodeId:'200'}),'http://local');
  const req=Object.assign(new EventEmitter(),{method:'GET'}),res=new EventEmitter();
  return {state,client,route,replies,url,req,res,run(){return route.handle(req,res,url,{state,client});}};
}
test('route requires the active episode and respects parental, account and playback invalidation',async()=>{
  let calls=0;const service={lookup:async()=>{calls++;return reference;}};
  const f=routeFixture(service);await f.run();assert.equal(f.replies[0].status,200);
  f.url.searchParams.set('episodeId','201');await f.run();assert.equal(f.replies[1].status,409);assert.equal(calls,1);
  const denied=routeFixture(service);denied.state.parental.assertPlayback=()=>{throw new Error('PIN');};
  await assert.rejects(denied.run(),/PIN/);assert.equal(calls,1);
  for(const mode of ['account','playback','disconnect']){
    let finish,signal;const late=routeFixture({lookup:(input,options)=>{signal=options.signal;return new Promise(resolve=>finish=resolve);}});
    const pending=late.run();
    if(mode==='account')late.state.authGeneration++;
    else if(mode==='playback')late.client.playback.controller.abort();else late.res.emit('close');
    finish(reference);await pending;
    if(mode==='disconnect'){assert.equal(signal.aborted,true);assert.equal(late.replies.length,0);}else assert.equal(late.replies[0].status,409);
    assert.equal(late.res.listenerCount('close'),0);
  }
});

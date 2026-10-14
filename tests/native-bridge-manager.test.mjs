import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeBridgeManager } from '../lib/native-bridge-manager.mjs';
import { WplayPlaybackProviderClient } from '../lib/wplay-playback.mjs';

const configuration={authUrl:'https://sdk.example/auth',username:'fixture@wareztv.io',password:'private-password'};
const interruption=()=>Object.assign(new Error('cancelled'),{code:'PLAYBACK_CANCELLED'});
const deferred=()=>{let resolve,reject;const promise=new Promise((ok,bad)=>{resolve=ok;reject=bad;});return {promise,resolve,reject};};
function fakeBridge(){
  let prepared=null,sequence=0;
  return {calls:[],configureHook:null,startHook:null,
    async configure(config,options){this.calls.push({action:'configure',config});if(this.configureHook)await this.configureHook(options.signal);},
    async start(uri,options){this.calls.push({action:'start',uri});if(this.startHook)await this.startHook(options.signal);prepared=new URL(`http://127.0.0.1:8902/${++sequence}/main.m3u8`);return prepared;},
    async stop(){this.calls.push({action:'stop'});prepared=null;},
    async close(){this.calls.push({action:'close'});prepared=null;},
    acceptsMediaURL(value){if(!prepared)return false;const url=new URL(value);return url.origin===prepared.origin&&url.pathname.startsWith(prepared.pathname.slice(0,prepared.pathname.lastIndexOf('/')+1));},
    async fetchMedia(value,options){this.calls.push({action:'media',options});return {url:String(value),status:200};}
  };
}

test('native manager allows one active session and reuses configuration only for that owner',async()=>{
  const bridge=fakeBridge(),manager=new NativeBridgeManager({client:bridge}),first={},second={};
  const source=await manager.start(first,configuration,'tvbus://one');
  assert.equal(manager.acceptsMediaURL(first,source),true);assert.equal(manager.acceptsMediaURL(second,source),false);
  await assert.rejects(manager.start(second,configuration,'tvbus://two'),{code:'NATIVE_BRIDGE_BUSY',status:409});
  await manager.stop(first);assert.equal(manager.acceptsMediaURL(first,source),false);
  await manager.start(first,configuration,'tvbus://two');
  assert.equal(bridge.calls.filter(call=>call.action==='configure').length,1);
  await manager.stop(first);await manager.start(second,{...configuration,username:'second@wareztv.io'},'tvbus://three');
  assert.equal(bridge.calls.filter(call=>call.action==='configure').length,2);
  assert.equal(bridge.calls.filter(call=>call.action==='close').length,1);
  const current=bridge.calls.length;await manager.close(first);assert.equal(bridge.calls.length,current);
  assert.equal(JSON.stringify(manager),'{}');
});

test('native stop aborts in-flight startup and a stale start cannot replace the next selection',async()=>{
  const bridge=fakeBridge(),manager=new NativeBridgeManager({client:bridge}),owner={},entered=deferred();
  bridge.configureHook=async signal=>{entered.resolve();await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(interruption()),{once:true});});};
  const first=manager.start(owner,configuration,'tvbus://old');const firstResult=assert.rejects(first,{code:'PLAYBACK_CANCELLED'});
  await entered.promise;
  const stopped=manager.stop(owner);bridge.configureHook=null;
  const newest=manager.start(owner,configuration,'tvbus://new');
  await firstResult;await stopped;const source=await newest;
  assert.equal(manager.acceptsMediaURL(owner,source),true);
  assert.deepEqual(bridge.calls.filter(call=>call.action==='start').map(call=>call.uri),['tvbus://new']);
  assert.equal(bridge.calls.filter(call=>call.action==='close').length,1);
});

test('native engine errors are preserved and release the failed session lease',async()=>{
  const bridge=fakeBridge(),manager=new NativeBridgeManager({client:bridge});
  bridge.configureHook=async()=>{throw Object.assign(new Error('Engine failed'),{code:'NATIVE_ENGINE_FAILED'});};
  await assert.rejects(manager.start({},configuration,'tvbus://bad'),{code:'NATIVE_ENGINE_FAILED'});
  bridge.configureHook=null;const owner={};const source=await manager.start(owner,configuration,'tvbus://good');
  assert.equal(manager.acceptsMediaURL(owner,source),true);
});

test('native media requests are owner-bound and aborted when the lease stops',async()=>{
  const bridge=fakeBridge(),manager=new NativeBridgeManager({client:bridge}),owner={};
  const source=await manager.start(owner,configuration,'tvbus://one');
  await assert.rejects(manager.fetchMedia({},source),{code:'NATIVE_SOURCE_INVALID'});
  await manager.fetchMedia(owner,source,{method:'GET',range:'bytes=0-1023'});
  const request=bridge.calls.find(call=>call.action==='media');assert.equal(request.options.signal.aborted,false);
  await manager.stop(owner);assert.equal(request.options.signal.aborted,true);
  await assert.rejects(manager.fetchMedia(owner,source),{code:'NATIVE_SOURCE_INVALID'});
});

test('failed native cleanup cannot reuse another session configuration',async()=>{
  const bridge=fakeBridge(),manager=new NativeBridgeManager({client:bridge}),owner={},next={};
  await manager.start(owner,configuration,'tvbus://one');
  bridge.stop=async()=>{throw new Error('Stop failed');};
  await assert.rejects(manager.stop(owner));
  const close=bridge.close;bridge.close=async()=>{throw new Error('Close failed');};
  await assert.rejects(manager.start(next,configuration,'tvbus://two'));
  assert.equal(bridge.calls.filter(call=>call.action==='configure').length,1);
  bridge.close=close;await manager.start(next,configuration,'tvbus://two');
  assert.equal(bridge.calls.filter(call=>call.action==='configure').length,2);
});

function providerFixture(manager){
  const client=new WplayPlaybackProviderClient({username:'fixture',password:'private-password'},{bridge:manager});
  client.authInfo={service:{auth_url_sdk:'https://sdk.example/auth'}};client.session={connected:true};
  client.connect=async()=>client.session;
  client.catalog=async()=>({categories:[],items:[{id:'1',kind:'live',name:'Native'},{id:'2',kind:'live',name:'HTTP'},{id:'3',kind:'live',name:'Unsupported'}]});
  client.rawItems.set('live:1',{sources:[{address:'tvbus://one'}]});
  client.rawItems.set('live:2',{sources:[{address:'https://video.example/live.m3u8'},{address:'tvbus://unused'}]});
  client.rawItems.set('live:3',{sources:[{address:'bts://unsupported'}]});
  return client;
}

test('WPlay playback prefers catalog HTTP, bridges only registered TVBus, and reuses playlist startup',async()=>{
  const bridge=fakeBridge(),manager=new NativeBridgeManager({client:bridge}),client=providerFixture(manager);
  assert.equal((await client.playbackURL('live','2')).href,'https://video.example/live.m3u8');assert.equal(bridge.calls.length,0);
  await assert.rejects(client.playbackURL('live','3'),{code:'WPLAY_NATIVE_ENGINE_REQUIRED'});assert.equal(bridge.calls.length,0);
  const first=await client.playbackURL('live','1'),again=await client.playbackURL('live','1');assert.equal(first.href,again.href);
  assert.equal(bridge.calls.filter(call=>call.action==='start').length,1);
  const config=bridge.calls.find(call=>call.action==='configure').config;assert.equal(config.username,'fixture@wareztv.io');
  assert.equal(client.mediaURL(first),first.href);assert.throws(()=>client.mediaURL('http://127.0.0.1:62731/status'));
  await client.upstreamRequest(first,{method:'GET',headers:{'X-Bridge-Key':'must-never-be-forwarded','User-Agent':'Android','Range':'bytes=0-255'}});
  const media=bridge.calls.find(call=>call.action==='media');assert.equal(media.options.range,'bytes=0-255');assert.equal(media.options.headers,undefined);
  await client.logout();assert.equal(client.session,null);assert.equal(client.config.password,'');assert.equal(client.isNativeMediaURL(first),false);
});

test('WPlay stop cancels pending native playback without exposing late prepared URLs',async()=>{
  const bridge=fakeBridge(),manager=new NativeBridgeManager({client:bridge}),client=providerFixture(manager),entered=deferred();
  bridge.startHook=async signal=>{entered.resolve();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(interruption()),{once:true}));};
  const pending=client.playbackURL('live','1'),rejected=assert.rejects(pending,{code:'PLAYBACK_CANCELLED'});
  await entered.promise;await client.stopPlayback();await rejected;
  assert.equal(client.isNativeMediaURL('http://127.0.0.1:8902/1/main.m3u8'),false);
});

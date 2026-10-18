import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {SessionGuard} from '../web/login/session-guard.js';

const source=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
const names=['homePlaybackScope','handleSessionLoss','requestPlaybackStop','stopPlayback'];
const functions=names.map(name=>{
  const start=source.indexOf('function '+name+'(');assert.notEqual(start,-1,name+' must exist');
  const next=source.indexOf('\n}',start),line=source.indexOf('\n',start);
  // Read each actual helper without modifying its implementation.
  return source.slice(start,['handleSessionLoss','requestPlaybackStop'].includes(name)?next+2:line);
}).join('\n');
const defer=()=>{let resolve,reject;return {promise:new Promise((yes,no)=>{resolve=yes;reject=no;}),resolve:value=>resolve(value),reject:value=>reject(value)};};
const flush=async()=>{for(let index=0;index<12;index++)await Promise.resolve();};

function fixture({pendingStop=Promise.resolve(),rawRequest}={}){
  const calls=[],http=[],nodes=new Map([['#toast',{hidden:false}],['#player-loading',{hidden:false}]]);
  const c={Promise,URLSearchParams,console,session:{connected:true,account:{libraryId:'account-a'}},connectionGeneration:1,
    player:{item:{kind:'movie',id:'synthetic'},mediaReady:true,sourceController:new AbortController()},playbackSerial:2,
    hls:{destroy(){}},pendingStop,pendingTransportStop:Promise.resolve(),lastPlaybackStop:Promise.resolve(),
    toastTimer:123,catalogReturn:{},contentReturnFocus:{},playerMetadataCleanup:()=>calls.push('metadata-cleanup'),
    tvWatchHeartbeat:{stop:()=>{calls.push('heartbeat-stop');return Promise.resolve();}},channelSwitch:{cancel:()=>calls.push('channel-cancel')},
    continuityFlow:{reset:()=>calls.push('continuity-reset')},movieSuggestions:{reset(){}},moviePlayback:{reset(){}},seriesPlayback:{reset(){}},
    vodSeek:{reset(){}},positionGuard:{reset(){}},resumePrompt:{reset(){}},tv:{audio:{reset(){}},stopProgram(){}},
    movieAudio:{reset(){}},seriesAudio:{reset(){}},channelVolumeMemory:{reset(){}},audioProcessing:{reset(){}},
    immersivePlayer:{reset(){}},playerTools:{reset:()=>calls.push('tools-reset')},
    video:{pause:()=>calls.push('pause'),removeAttribute:name=>calls.push('remove-'+name),load:()=>calls.push('load')},
    saveProgress:force=>{if(c.player)calls.push({event:'save',force,account:c.session?.account?.libraryId});},
    destroyPlayerTransport:()=>calls.push('destroy'),clearTimeout:id=>calls.push(['clear-toast',id]),
    $:selector=>{assert.ok(nodes.has(selector));return nodes.get(selector);},
    window:{history:{replaceState:(_a,_b,path)=>calls.push(['route',path])}},
    api:(path,options)=>{http.push({path,options,account:c.session?.account?.libraryId});return Promise.resolve({connected:Boolean(c.session?.connected)});},
    resetConnectionData:()=>{calls.push({event:'reset',session:c.session});c.sessionGuard.reset();return ++c.connectionGeneration;},
    showConnection:message=>calls.push({event:'login',message})};
  vm.createContext(c);vm.runInContext(functions,c);
  c.sessionGuard=new SessionGuard({request:rawRequest||(()=>Promise.reject(Object.assign(new Error('synthetic'),{status:401,code:'SESSION_REQUIRED'}))),
    getScope:()=>c.homePlaybackScope(),onLost:c.handleSessionLoss});
  return {c,calls,http,nodes};
}

test('real loss callback saves the old account, tears down media, clears UI and never logs out remotely',async()=>{
  const {c,calls,http,nodes}=fixture();
  await assert.rejects(c.sessionGuard.request('/api/catalog'),{code:'SESSION_REQUIRED'});await flush();
  assert.deepEqual(calls.find(value=>value?.event==='save'),{event:'save',force:true,account:'account-a'});
  assert.ok(calls.findIndex(value=>value?.event==='save')<calls.findIndex(value=>value?.event==='reset'));
  assert.equal(calls.find(value=>value?.event==='reset').session,null);
  for(const event of ['pause','remove-src','load','destroy','metadata-cleanup','tools-reset'])assert.ok(calls.includes(event),event);
  assert.equal(c.session,null);assert.equal(c.player,null);assert.equal(c.hls,null);assert.equal(c.connectionGeneration,2);
  assert.equal(nodes.get('#toast').hidden,true);assert.equal(nodes.get('#player-loading').hidden,true);
  assert.equal(c.catalogReturn,null);assert.equal(c.contentReturnFocus,null);
  assert.match(calls.find(value=>value?.event==='login').message,/sessão foi encerrada/);
  assert.equal(http.length,0,'Old scoped STOP must be discarded; no remote logout is requested.');
  const count=calls.length;c.handleSessionLoss();assert.equal(calls.length,count,'A duplicate loss is inert.');
});

test('a STOP queued before loss cannot hit a newer login after the queue releases',async()=>{
  const gate=defer(),{c,http}=fixture({pendingStop:gate.promise});
  await assert.rejects(c.sessionGuard.request('/api/catalog'),{code:'SESSION_REQUIRED'});
  c.session={connected:true,account:{libraryId:'account-b'}};c.connectionGeneration++;
  const replacement={item:{kind:'live'}};c.player=replacement;
  gate.resolve();await flush();
  assert.equal(http.length,0);assert.equal(c.player,replacement);assert.equal(c.session.account.libraryId,'account-b');
});

test('a definitive old-account response never invokes the real loss callback on a newer login',async()=>{
  const gate=defer(),{c,calls}=fixture({rawRequest:()=>gate.promise});
  const old=assert.rejects(c.sessionGuard.request('/api/catalog'),{code:'SESSION_REQUIRED'});
  c.sessionGuard.reset();c.connectionGeneration++;c.session={connected:true,account:{libraryId:'account-b'}};
  const replacement={item:{kind:'live'}};c.player=replacement;
  gate.reject(Object.assign(new Error('synthetic'),{status:401,code:'SESSION_REQUIRED'}));await old;await flush();
  assert.equal(calls.length,0);assert.equal(c.player,replacement);assert.equal(c.session.account.libraryId,'account-b');
});

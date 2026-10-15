import test from 'node:test';
import assert from 'node:assert/strict';
import {playbackAPIError} from '../web/playback-api-error.js';

const origin='http://127.0.0.1:4175';
const event=(body={code:'NATIVE_BRIDGE_UNAVAILABLE'},options={})=>({type:'networkError',details:'manifestLoadError',fatal:true,url:origin+'/api/play/live/405/index.m3u8',response:{code:503},networkDetails:{status:503,responseText:JSON.stringify(body)},...options});
test('local HLS JSON errors expose a useful fixed P2P message without reflecting credentials or replaying a request',()=>{
 const result=playbackAPIError(event({code:'NATIVE_BRIDGE_UNAVAILABLE',error:'upstream-secret https://private.example/token'}),{origin});
 assert.equal(result.code,'NATIVE_BRIDGE_UNAVAILABLE');assert.equal(result.terminal,true);assert.match(result.message,/P2P local.*não está disponível/);assert.doesNotMatch(result.message,/upstream|private|token/);
 assert.equal(playbackAPIError(event(undefined,{response:{code:503,data:{code:'NATIVE_ENGINE_FAILED'}}}),{origin}).code,'NATIVE_ENGINE_FAILED');
});
test('transient network errors and non-playback/external URLs keep existing HLS recovery',()=>{
 for(const sample of [event({code:'CONNECTION_FAILED'}),event({code:'NATIVE_ENGINE_TIMEOUT'}),event(undefined,{url:'https://external.example/api/play/live/405/index.m3u8'}),event(undefined,{url:origin+'/api/catalog?type=live'}),event(undefined,{response:{code:200},networkDetails:{status:200}}),event(undefined,{type:'mediaError'})])assert.equal(playbackAPIError(sample,{origin}),null);
});

test('known web transport failures are terminal fixed messages without repeated HLS requests or private upstream text',()=>{
 for(const [code,status]of [['WPLAY_WEB_UNAVAILABLE',503],['WPLAY_WEB_START_TIMEOUT',504],['WPLAY_WEB_AUTH_REJECTED',502],['WPLAY_WEB_CHANNEL_NOT_FOUND',404],['WPLAY_WEB_CHANNEL_AMBIGUOUS',409]]){
  const result=playbackAPIError(event({code,error:'private-cookie https://secret.example/token'},{response:{code:status}}),{origin});assert.equal(result.code,code);assert.equal(result.terminal,true);assert.match(result.message,/web WPLAY/);assert.doesNotMatch(result.message,/private-cookie|secret|token/);
 }
});
test('malformed, oversized and unreadable HLS error bodies fail closed',()=>{
 const unreadable={status:503,get responseText(){throw new DOMException('Arraybuffer response','InvalidStateError');}};
 for(const sample of [event(undefined,{networkDetails:unreadable}),event(undefined,{networkDetails:{responseText:'<html>503</html>'}}),event(undefined,{response:{code:503,data:'x'.repeat(16385)}}),event(undefined,{response:{code:503,data:{code:'constructor'}}}),null])assert.equal(playbackAPIError(sample,{origin}),null);
});

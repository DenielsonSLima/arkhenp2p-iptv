import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {performance} from 'node:perf_hooks';
import {createApp} from '../lib/app-server.mjs';
import {ProviderClient} from '../lib/provider.mjs';
import {ParentalControl} from '../lib/parental-control.mjs';
import {withRuntimeSession} from '../lib/runtime-session-context.mjs';

class FakeResponse extends EventEmitter{
  constructor(){super();this.headers=new Map();this.headersSent=false;this.destroyed=false;this.statusCode=200;this.body='';}
  setHeader(name,value){this.headers.set(name.toLowerCase(),value);return this;}
  getHeader(name){return this.headers.get(name.toLowerCase());}
  writeHead(status,headers={}){this.statusCode=status;for(const[name,value]of Object.entries(headers))this.setHeader(name,value);this.headersSent=true;return this;}
  end(body=''){this.body+=body;return this;}
}

test('live first-body and header durations share the network clock and exclude checkpoint latency',async t=>{
  let clock=0,checkpoints=0,releases=0;const events=[];
  t.mock.method(performance,'now',()=>clock);
  const client=new ProviderClient({server:'https://fixture.invalid',username:'synthetic',password:'synthetic'});
  client.session={connected:true,account:{status:'Active'}};
  client.playbackURL=async()=>{clock+=5;return new URL('https://fixture.invalid/live.m3u8');};
  client.upstreamRequest=async value=>{
    clock+=20;
    return {status:200,url:String(value),headers:{'content-type':'application/vnd.apple.mpegurl'},body:Readable.from((async function*(){
      clock+=5;yield Buffer.from('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXTINF:1,\nsegment.ts\n');
    })())};
  };
  const parental=new ParentalControl();parental.unlocked=true;
  const state={client,parental,authGeneration:1,loggedOut:false};
  const context={readOnly:false,assert(){},checkpoint:async()=>{checkpoints++;clock+=1000;},
    beforeStreaming:async()=>{releases++;clock+=600;},timing:()=> 'runtime_commit;dur=600.0;count=1'};
  const app=createApp({connection:{server:'https://fixture.invalid'},environment:{},cloud:null,
    sessionStore:{run:async(_req,_res,_options,operation)=>withRuntimeSession(context,()=>operation(state))},
    onPlaybackTransport:event=>events.push(event)});
  t.after(()=>app.shutdown());
  const req=new EventEmitter();Object.assign(req,{url:'/api/play/live/81/index.m3u8?attempt=synthetic',method:'GET',headers:{host:'127.0.0.1'},aborted:false});
  const res=new FakeResponse();
  // Invoke the real request handler without a listener, socket, login or media.
  await app.listeners('request')[0](req,res);
  assert.equal(res.statusCode,200);assert.match(res.body,/^#EXTM3U/);
  assert.equal(checkpoints,1);assert.equal(releases,1);
  const manifest=events.find(event=>event.phase==='manifest');assert.ok(manifest);
  assert.equal(manifest.headersMs,20);assert.equal(manifest.firstBodyMs,25);
  assert.equal(manifest.durationMs,1625);
  assert.equal(res.getHeader('server-timing'),'prepare;dur=5.0, upstream;dur=20.0, runtime_commit;dur=600.0;count=1');
  assert.doesNotMatch(JSON.stringify(events),/https:|password|synthetic|cookie|token/i);
});

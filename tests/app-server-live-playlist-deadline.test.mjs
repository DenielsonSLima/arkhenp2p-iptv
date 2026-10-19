import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createApp} from '../lib/app-server.mjs';
import {ProviderClient} from '../lib/provider.mjs';
import {ParentalControl} from '../lib/parental-control.mjs';
import {RuntimeSessionStore} from '../lib/runtime-session-store.mjs';
import {captureRuntimeSession} from '../lib/runtime-session-state.mjs';

const cookie='P'.repeat(32);
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
class ResponseFixture extends EventEmitter{
  constructor(){super();this.headers=new Map();this.statusCode=200;this.headersSent=false;this.destroyed=false;this.body=[];}
  setHeader(name,value){this.headers.set(name.toLowerCase(),value);return this;}
  getHeaders(){return Object.fromEntries(this.headers);}
  getHeaderNames(){return [...this.headers.keys()];}
  removeHeader(name){this.headers.delete(name.toLowerCase());}
  writeHead(status,headers={}){this.statusCode=status;for(const[name,value]of Object.entries(headers))this.setHeader(name,value);this.headersSent=true;return this;}
  write(value){if(value!==undefined)this.body.push(Buffer.from(value));this.headersSent=true;return true;}
  end(value){this.write(value);return this;}
  json(){return JSON.parse(Buffer.concat(this.body).toString());}
}

async function fixture(t,{fallback=false}={}){
  const row={cipher:null,revision:0,fence:0,owner:null,mediaEpoch:null},calls=[],entered=deferred(),stream=new Readable({read(){entered.resolve();}});
  t.after(()=>stream.destroy());
  let signal,requests=0;
  const makeClient=config=>{
    const client=new ProviderClient(config);client.libraryProvider='xtream';
    client.playbackURL=async()=>new URL('https://fixture.invalid/entry.m3u8');
    client.upstreamRequest=async(value,options)=>{
      signal=options.signal;requests++;
      if(fallback&&requests===1){
        t.mock.timers.tick(6000);
        return {status:403,url:String(value),headers:{},body:Readable.from([])};
      }
      return {status:200,url:String(value),headers:{'content-type':'application/vnd.apple.mpegurl'},body:stream};
    };
    return client;
  };
  const client=makeClient({server:'https://fixture.invalid',username:'synthetic',password:'synthetic'});
  client.session={connected:true,account:{status:'Active'}};client.authenticatedAt=Date.now();
  if(fallback){client.beginPlayback('live:81');client.playback.manifestURL='https://fixture.invalid/resolved.m3u8';}
  const parental=new ParentalControl();parental.unlocked=true;
  const state={client,parental,authGeneration:1,loggedOut:false,seen:Date.now(),attempts:[]};
  const cloud={enabled:false,ready:Promise.resolve(false),runtimeSessionKey:()=>Buffer.alloc(32,19),
    async runtimeSessionRPC(operation,args){
      calls.push({operation,release:args.p_release});
      if(operation==='acquire'){
        assert.equal(row.owner,null,'The previous request must have released its writer');row.owner=args.p_owner;row.fence++;
        return {...row,leaseUntil:new Date(Date.now()+90000).toISOString()};
      }
      assert.equal(operation,'commit');assert.equal(row.owner,args.p_owner);assert.equal(row.fence,args.p_fence);assert.equal(row.revision,args.p_revision);
      if(args.p_cipher!==null){row.cipher=args.p_cipher;row.revision++;}
      row.mediaEpoch=args.p_media_epoch;if(args.p_release)row.owner=null;
      return {ok:true,revision:row.revision,fence:row.fence};
    },
  };
  const store=new RuntimeSessionStore({cloud});
  await store.run({headers:{cookie:'ORBIT_SID='+cookie},aborted:false},new ResponseFixture(),{
    createState:()=>state,restore:()=>state,capture:captureRuntimeSession,
  },async()=>{});
  calls.length=0;
  const app=createApp({connection:{server:'https://fixture.invalid'},environment:{},cloud,sessionStore:store,
    providerFactory:({config})=>makeClient(config)});
  t.after(()=>app.shutdown());
  const req=new EventEmitter();Object.assign(req,{method:'GET',url:'/api/play/live/81/index.m3u8?attempt=synthetic',
    headers:{host:'127.0.0.1',cookie:'ORBIT_SID='+cookie},aborted:false});
  const res=new ResponseFixture();
  return {row,calls,stream,entered,req,res,app,signal:()=>signal,requests:()=>requests};
}

test('live playlist trickle stops at an absolute deadline and releases its hosted writer without committing a successful body',{timeout:1000},async t=>{
  const f=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});
  let ended=false;const operation=f.app.listeners('request')[0](f.req,f.res).then(()=>{ended=true;});
  await f.entered.promise;
  f.stream.push('#EXTM3U\n');t.mock.timers.tick(9000);f.stream.push('# another byte before the inactivity timeout\n');
  t.mock.timers.tick(999);assert.equal(ended,false);assert.notEqual(f.row.owner,null);
  t.mock.timers.tick(1);await operation;
  assert.equal(f.signal().aborted,true);assert.equal(f.signal().reason.code,'LIVE_PLAYLIST_TIMEOUT');assert.equal(f.stream.destroyed,true);
  assert.equal(f.res.statusCode,502);assert.equal(f.res.json().code,'LIVE_PLAYLIST_TIMEOUT');assert.equal(f.row.owner,null);
  assert.equal(f.calls.at(-1).operation,'commit');assert.equal(f.calls.at(-1).release,true);
  assert.doesNotMatch(Buffer.concat(f.res.body).toString(),/#EXTM3U|fixture\.invalid/);
  const nextRequest=new EventEmitter();Object.assign(nextRequest,{method:'GET',url:'/api/parental',headers:f.req.headers,aborted:false});
  const nextResponse=new ResponseFixture();await f.app.listeners('request')[0](nextRequest,nextResponse);
  assert.equal(nextResponse.statusCode,200,'The next writer must not remain BUSY behind the trickling playlist');
  assert.equal(f.row.owner,null);assert.equal(f.row.fence,3);
  t.mock.timers.tick(30000);assert.equal(f.row.owner,null);
});

test('resolved playlist denial and bootstrap fallback share the same absolute live deadline',{timeout:1000},async t=>{
  const f=await fixture(t,{fallback:true});t.mock.timers.enable({apis:['setTimeout']});
  const operation=f.app.listeners('request')[0](f.req,f.res);
  await f.entered.promise;assert.equal(f.requests(),2);
  f.stream.push('#EXTM3U\n');t.mock.timers.tick(3999);assert.equal(f.signal().aborted,false);
  t.mock.timers.tick(1);await operation;
  assert.equal(f.res.statusCode,502);assert.equal(f.res.json().code,'LIVE_PLAYLIST_TIMEOUT');assert.equal(f.row.owner,null);
});

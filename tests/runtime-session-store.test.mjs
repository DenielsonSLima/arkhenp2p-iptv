import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {Readable,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {RuntimeSessionStore} from '../lib/runtime-session-store.mjs';
import {runtimeSessionContext} from '../lib/runtime-session-context.mjs';
import {captureRuntimeSession,restoreRuntimeSession} from '../lib/runtime-session-state.mjs';
import {ParentalControl} from '../lib/parental-control.mjs';
import {WplayPlaybackProviderClient} from '../lib/wplay/conexao/reproducao.mjs';
import {WplayOTTProviderClient} from '../lib/wplay/ott/provedor.mjs';
import {runtimeSessionReadPolicy} from '../lib/runtime-session-read-policy.mjs';

const cookie='A'.repeat(32),sessionHash=createHash('sha256').update(cookie).digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const request=()=>({headers:{cookie:'ORBIT_SID='+cookie},aborted:false});

class FakeResponse{
  constructor(){this.statusCode=200;this.headers=new Map();this.headersSent=false;this.destroyed=false;this.body=[];this.ends=0;}
  setHeader(name,value){this.headers.set(name.toLowerCase(),value);return this;}
  getHeaders(){return Object.fromEntries(this.headers);}
  getHeaderNames(){return [...this.headers.keys()];}
  getHeader(name){return this.headers.get(name.toLowerCase());}
  removeHeader(name){this.headers.delete(name.toLowerCase());}
  writeHead(status,headers={}){this.statusCode=status;for(const[key,value]of Object.entries(headers))this.setHeader(key,value);this.headersSent=true;return this;}
  write(chunk){if(chunk!==undefined)this.body.push(Buffer.from(chunk));this.headersSent=true;return true;}
  end(chunk,encoding,callback){if(chunk!==undefined)this.body.push(Buffer.from(chunk));this.headersSent=true;this.ends++;if(typeof encoding==='function')encoding();else callback?.();return this;}
  json(){return JSON.parse(Buffer.concat(this.body).toString());}
}

// Exercise Node's real finish lifecycle without opening an HTTP socket. The
// runtime must distinguish a completed pipeline from a merely opened response.
class StreamingResponse extends Writable{
  constructor(){super();this.statusCode=200;this.headers=new Map();this.headersSent=false;this.body=[];}
  _write(chunk,encoding,callback){this.body.push(Buffer.from(chunk));callback();}
  setHeader(name,value){this.headers.set(name.toLowerCase(),value);return this;}
  getHeaders(){return Object.fromEntries(this.headers);}
  getHeaderNames(){return [...this.headers.keys()];}
  getHeader(name){return this.headers.get(name.toLowerCase());}
  removeHeader(name){this.headers.delete(name.toLowerCase());}
  writeHead(status,headers={}){this.statusCode=status;for(const[key,value]of Object.entries(headers))this.setHeader(key,value);this.headersSent=true;return this;}
}

class FakeCloud{
  constructor(){this.row={cipher:null,revision:0,fence:0,owner:null,leaseUntil:0};this.calls=[];this.busy=deferred();this.busyCount=0;this.rejectCipherCommits=false;this.rejectMedia=false;}
  runtimeSessionKey(){return Buffer.alloc(32,23);}
  async runtimeSessionRPC(operation,args){
    this.calls.push({operation,hasCipher:args.p_cipher!=null,release:args.p_release});
    const row=this.row,now=Date.now();
    if(operation==='read')return row.cipher?{cipher:row.cipher,mediaEpoch:row.mediaEpoch??null}:{missing:true};
    if(operation==='acquire'){
      if(row.owner&&row.owner!==args.p_owner&&row.leaseUntil>now){this.busyCount++;this.busy.resolve();return {busy:true,retryAfterMs:250};}
      row.owner=args.p_owner;row.fence++;row.leaseUntil=now+90000;
      return {cipher:row.cipher,revision:row.revision,fence:row.fence,leaseUntil:new Date(row.leaseUntil).toISOString()};
    }
    if(operation==='media'){
      if(this.rejectMedia)throw Object.assign(new Error('Synthetic validation failure'),{code:'FIXTURE_UNAVAILABLE'});
      return {ok:row.mediaEpoch===args.p_media_epoch};
    }
    if(row.owner!==args.p_owner||row.fence!==args.p_fence||row.leaseUntil<=now)return {ok:false,conflict:true};
    if(operation==='renew'){row.leaseUntil=now+90000;return {ok:true,leaseUntil:new Date(row.leaseUntil).toISOString()};}
    if(operation!=='commit'||row.revision!==args.p_revision)return {ok:false,conflict:true};
    if(this.rejectCipherCommits&&args.p_cipher!=null)throw Object.assign(new Error('Synthetic commit failure'),{code:'FIXTURE_UNAVAILABLE'});
    if(args.p_cipher!=null&&args.p_cipher!==row.cipher){row.cipher=args.p_cipher;row.revision++;}
    row.mediaEpoch=args.p_media_epoch;
    if(args.p_release){row.owner=null;row.leaseUntil=0;}else row.leaseUntil=now+90000;
    return {ok:true,revision:row.revision,fence:row.fence};
  }
}

const options={createState:()=>({counter:0,events:[]}),restore:value=>value,capture:value=>value};
const reply=(res,value)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
const seed=async(cloud,value)=>{cloud.row.cipher=await new RuntimeSessionStore({cloud}).seal(value,sessionHash);return cloud.row.cipher;};
const failedResponse=async(store,req,res,settings,operation)=>{
  try{await store.run(req,res,settings,operation);assert.fail('The checkpoint must fail');}
  catch(error){assert.equal(error.status,503);res.writeHead(error.status,{'Content-Type':'application/json'});res.end(JSON.stringify({code:error.code}));return error;}
};

test('an oversized checkpoint is captured once, preserves the previous cipher and releases its lease before returning 503',async()=>{
  const cloud=new FakeCloud(),previous=await seed(cloud,{counter:7,events:['durable']});
  const store=new RuntimeSessionStore({cloud}),res=new FakeResponse();let captures=0;
  res.setHeader('X-Content-Type-Options','nosniff');
  await failedResponse(store,request(),res,{...options,capture:state=>{captures++;return state;}},async state=>{
    state.payload=randomBytes(3*1024*1024).toString('hex');state.counter=8;
    res.writeHead(200,{'Content-Type':'image/png','Content-Length':'999999','Location':'/stale-response'});
    res.end('must not escape before persistence');
  });
  assert.equal(captures,1);
  assert.equal(cloud.row.cipher,previous);assert.equal(cloud.row.revision,0);assert.equal(cloud.row.owner,null);
  assert.deepEqual(cloud.calls.filter(call=>call.operation==='commit'),[{operation:'commit',hasCipher:false,release:true}]);
  assert.equal(res.statusCode,503);assert.equal(res.ends,1);assert.equal(res.json().code,'RUNTIME_SESSION_TOO_LARGE');
  assert.equal(res.getHeader('content-length'),undefined);assert.equal(res.getHeader('location'),undefined);
  assert.equal(res.getHeader('x-content-type-options'),'nosniff');
  assert.deepEqual(await store.openCipher(cloud.row.cipher,sessionHash),{counter:7,events:['durable']});
});

test('a failed persistence operation cannot flush an already prepared successful response',async()=>{
  const cloud=new FakeCloud(),previous=await seed(cloud,{counter:3,events:[]});cloud.rejectCipherCommits=true;
  const res=new FakeResponse();
  await failedResponse(new RuntimeSessionStore({cloud}),request(),res,options,async state=>{state.counter++;reply(res,{success:true,counter:state.counter});});
  assert.equal(res.statusCode,503);assert.deepEqual(res.json(),{code:'RUNTIME_SESSION_UNAVAILABLE'});assert.equal(res.ends,1);
  assert.equal(cloud.row.cipher,previous);assert.equal(cloud.row.owner,null);
});

test('two independent stores serialize the same session and preserve both state changes',async()=>{
  const cloud=new FakeCloud();await seed(cloud,{counter:0,events:[]});
  const entered=deferred(),releaseFirst=deferred(),firstResponse=new FakeResponse(),secondResponse=new FakeResponse();
  const first=new RuntimeSessionStore({cloud}).run(request(),firstResponse,options,async state=>{
    state.counter++;state.events.push('first');entered.resolve();await releaseFirst.promise;reply(firstResponse,{counter:state.counter});
  });
  await entered.promise;
  const second=new RuntimeSessionStore({cloud}).run(request(),secondResponse,options,async state=>{
    state.counter++;state.events.push('second');reply(secondResponse,{counter:state.counter});
  });
  await cloud.busy.promise;releaseFirst.resolve();await Promise.all([first,second]);
  const persisted=await new RuntimeSessionStore({cloud}).openCipher(cloud.row.cipher,sessionHash);
  assert.deepEqual(persisted,{counter:2,events:['first','second']});
  assert.deepEqual(firstResponse.json(),{counter:1});assert.deepEqual(secondResponse.json(),{counter:2});
  assert.equal(cloud.row.owner,null);assert.equal(cloud.row.revision,2);assert.equal(cloud.row.fence,2);
});

test('a request cancelled before acquisition never calls the runtime RPC or operation',async()=>{
  for(const cancelled of ['request','response']){
    const cloud=new FakeCloud(),req=request(),res=new FakeResponse();
    if(cancelled==='request')req.aborted=true;else res.destroyed=true;
    await assert.rejects(new RuntimeSessionStore({cloud}).run(req,res,options,()=>assert.fail('Cancelled operation ran')),
      {status:503,code:'RUNTIME_SESSION_CANCELLED'});
    assert.equal(cloud.calls.length,0);assert.equal(res.ends,0);
  }
});

const authenticatedState=()=>({counter:0,events:[],authGeneration:1,loggedOut:false,parental:{unlocked:false},client:{
  config:{server:'https://fixture.example',username:'fixture'},libraryProvider:'wplay',
  session:{connected:true,account:{status:'Active'}},playbackGeneration:0,playback:null
}});
const readOptions={...options,createState:authenticatedState};

const createPlaybackState=()=>({client:null,authGeneration:3,loggedOut:false,seen:1700000000000,attempts:[],parental:new ParentalControl()});
const playbackClient=config=>new WplayPlaybackProviderClient(config,{webPlayback:true,webPlaybackFactory:webConfig=>{
  const client=new WplayOTTProviderClient(webConfig);
  // A completed source must round-trip without rediscovery or STOP. No fixture
  // is allowed to reach a real provider when this invariant regresses.
  for(const method of ['connect','catalog','stopPlayback','upstreamRequest'])client[method]=()=>assert.fail('Unexpected provider I/O: '+method);
  return client;
}});
const playbackOptions={createState:createPlaybackState,capture:captureRuntimeSession,
  restore:dto=>restoreRuntimeSession(dto,{createState:createPlaybackState,createClient:async({config})=>playbackClient(config)})};
async function seedCompletedPlayback(cloud){
  const state=createPlaybackState(),client=playbackClient({username:'synthetic-user',password:'synthetic-password'});
  client.libraryProvider='wplay';client.authenticatedAt=1700000000000;
  client.session={connected:true,account:{status:'Active'}};
  const dto=client.exportRuntimeState(),source='https://player.wplayott.com/fixture/bootstrap.m3u8?token=synthetic&sid=synthetic&gen=4';
  const manifestURL='https://player.wplayott.com/fixture/resolved/index.m3u8?token=synthetic';
  const sourceId='w_'+'a'.repeat(28),attempt='synthetic-opening';
  dto.playback={key:'live:81',manifestURL};dto.playbackGeneration=4;
  const ott=new WplayOTTProviderClient({username:'synthetic-user',password:'synthetic-password'}).exportRuntimeState();
  ott.session={connected:true,account:{status:'Active'}};ott.ott.liveScreenSID='synthetic-screen';ott.ott.liveGeneration=4;
  ott.ott.liveSource={key:'live:901',attempt:'',selector:'exact:901',url:source,generation:4};
  Object.assign(dto.playbackRuntime,{selectionGeneration:8,pending:false,
    selection:{key:'live:81',attempt,selector:sourceId,sourceId,generation:8,url:source,transport:'web',aborted:false},
    web:{version:1,closed:false,client:ott,current:{opening:false,timedOut:false,sourceId,aborted:false},
      active:true,pending:false,urls:new Set([source,manifestURL]),mappingDiagnostics:new Map()}});
  client.restoreRuntimeState(dto);state.client=client;
  state.playbackIntent={key:'live:81',attempt,sourceId,purpose:'playback',generation:4,authGeneration:3};
  state.liveIntentScope=3;state.retiredLiveAttempts=new Set();
  await seed(cloud,captureRuntimeSession(state));
  return {source,manifestURL,attempt,sourceId};
}

test('restored completed web sources skip unchanged poll checkpoints but always release the writer lease',async()=>{
  const cloud=new FakeCloud(),expected=await seedCompletedPlayback(cloud);
  for(let poll=0;poll<3;poll++){
    cloud.calls.length=0;const res=new FakeResponse();
    await new RuntimeSessionStore({cloud}).run(request(),res,playbackOptions,async state=>{
      const client=state.client,context=runtimeSessionContext();
      const source=await client.playbackURL('live','81',null,{attempt:expected.attempt,sourceId:expected.sourceId});
      assert.equal(source.href,expected.source);assert.equal(client.playback.manifestURL,expected.manifestURL);
      assert.equal(client.playbackGeneration,4);assert.equal(client.exportRuntimeState().playbackRuntime.web.client.ott.liveGeneration,4);
      await context.checkpoint();await context.checkpoint();
      assert.equal(cloud.calls.filter(call=>call.operation==='commit').length,0,'unchanged descriptor committed before upstream');
      assert.notEqual(cloud.row.owner,null,'preflight must retain its exclusive fence');
      await context.beforeStreaming();
      assert.deepEqual(cloud.calls.filter(call=>call.operation==='commit'),[{operation:'commit',hasCipher:false,release:true}]);
      assert.equal(cloud.row.owner,null);res.writeHead(200).end('synthetic manifest');
    });
    assert.equal(res.statusCode,200);assert.equal(cloud.calls.filter(call=>call.operation==='commit').length,1);
    assert.equal(cloud.row.revision,0);assert.match(cloud.row.mediaEpoch,/^[a-f0-9]{64}$/);
  }
});

test('a changed source is durably committed before upstream I/O and release still commits unchanged state',async()=>{
  const cloud=new FakeCloud();await seedCompletedPlayback(cloud);const store=new RuntimeSessionStore({cloud});
  await store.run(request(),new FakeResponse(),playbackOptions,async state=>{
    const context=runtimeSessionContext(),url='https://player.wplayott.com/fixture/new-resolved.m3u8';
    state.client.playback.manifestURL=url;
    await context.checkpoint();
    assert.deepEqual(cloud.calls.filter(call=>call.operation==='commit'),[{operation:'commit',hasCipher:true,release:false}]);
    const persisted=await playbackOptions.restore(await store.openCipher(cloud.row.cipher,sessionHash));
    assert.equal(persisted.client.playback.manifestURL,url,'new source must exist in storage before its upstream can start');
    await context.checkpoint();
    assert.equal(cloud.calls.filter(call=>call.operation==='commit').length,1);
    await context.beforeStreaming();
    assert.deepEqual(cloud.calls.filter(call=>call.operation==='commit'),[
      {operation:'commit',hasCipher:true,release:false},{operation:'commit',hasCipher:false,release:true}]);
    assert.equal(cloud.row.owner,null);
  });
  assert.equal(cloud.row.revision,1);
});

test('unchanged checkpoints still reject an expired lease after draining pending work',async()=>{
  const cloud=new FakeCloud();await seed(cloud,{counter:0,events:[]});let clock=Date.now(),expire=false;
  const store=new RuntimeSessionStore({cloud,now:()=>clock});
  await assert.rejects(store.run(request(),new FakeResponse(),{...options,drain:async()=>{if(expire)clock+=100000;}},async()=>{
    await runtimeSessionContext().checkpoint();
    assert.equal(cloud.calls.filter(call=>call.operation==='commit').length,0);
    expire=true;await runtimeSessionContext().checkpoint();assert.fail('expired checkpoint continued');
  }),{code:'RUNTIME_SESSION_LEASE_LOST',status:503});
  assert.ok(cloud.calls.filter(call=>call.operation==='commit').every(call=>!call.hasCipher&&call.release===true));
});

test('unchanged preflight waits for an in-flight lease renewal before allowing upstream I/O',async t=>{
  for(const accepted of [true,false])await t.test(accepted?'renewal accepted':'renewal denied',async t=>{
    const cloud=new FakeCloud();await seed(cloud,{counter:0,events:[]});
    const finishRenewal=deferred(),rpc=cloud.runtimeSessionRPC.bind(cloud);let renewalStarted=false,upstreamStarted=false;
    cloud.runtimeSessionRPC=async(operation,args)=>{
      if(operation==='renew'){
        renewalStarted=true;await finishRenewal.promise;
        if(!accepted)return {ok:false,conflict:true};
      }
      return rpc(operation,args);
    };
    t.mock.timers.enable({apis:['setInterval']});
    try{
      const run=new RuntimeSessionStore({cloud}).run(request(),new FakeResponse(),options,async()=>{
        const context=runtimeSessionContext();t.mock.timers.tick(15000);assert.equal(renewalStarted,true);
        const preflight=context.checkpoint();let settled=false;
        preflight.then(()=>{settled=true;},()=>{settled=true;});
        await new Promise(resolve=>setImmediate(resolve));
        const waited=!settled;finishRenewal.resolve();
        assert.equal(waited,true,'preflight escaped while its lease renewal was pending');
        await preflight;upstreamStarted=true;
        assert.equal(cloud.calls.filter(call=>call.operation==='commit').length,0);
      });
      if(accepted)await run;else await assert.rejects(run,{status:503,code:'RUNTIME_SESSION_LEASE_LOST'});
      assert.equal(upstreamStarted,accepted);assert.equal(cloud.row.owner,null);
    }finally{finishRenewal.resolve();t.mock.timers.reset();}
  });
});

const parseRuntimeTiming=header=>Object.fromEntries(header.split(', ').map(fragment=>{
  const match=/^(runtime_(?:acquire|wait|read|restore|serialize|codec|commit|validate));dur=(\d+\.\d);count=(\d+)$/.exec(fragment);
  assert.ok(match,'Timing exposed a nonnumeric value or an unexpected name');
  return [match[1],{duration:Number(match[2]),count:Number(match[3])}];
}));

test('runtime timing separates unchanged preflight, serialization, codec and commit and exposes only fixed numeric fields',async()=>{
  const cloud=new FakeCloud();await seed(cloud,{counter:0,events:[],privateSource:'https://synthetic.invalid/media?token=private-fixture'});
  const rpc=cloud.runtimeSessionRPC.bind(cloud);
  cloud.runtimeSessionRPC=async(operation,args)=>{
    if(operation==='acquire'||operation==='commit')await new Promise(resolve=>setTimeout(resolve,5));
    return rpc(operation,args);
  };
  let context;
  await new RuntimeSessionStore({cloud}).run(request(),new FakeResponse(),options,async state=>{
    context=runtimeSessionContext();await context.checkpoint();
    const initial=parseRuntimeTiming(context.timing());
    assert.equal(initial.runtime_acquire.count,1);assert.ok(initial.runtime_acquire.duration>=1);
    assert.equal(initial.runtime_restore.count,1);assert.equal(initial.runtime_serialize.count,2);
    assert.equal(initial.runtime_codec.count,0);assert.equal(initial.runtime_commit.count,0);
    state.counter++;await context.checkpoint();
    const updated=parseRuntimeTiming(context.timing());
    assert.equal(updated.runtime_serialize.count,3);assert.equal(updated.runtime_codec.count,1);
    assert.equal(updated.runtime_commit.count,1);assert.ok(updated.runtime_commit.duration>=1);
    await context.beforeStreaming();
    const released=parseRuntimeTiming(context.timing());
    assert.equal(released.runtime_serialize.count,4);assert.equal(released.runtime_codec.count,1);assert.equal(released.runtime_commit.count,2);
    assert.ok(released.runtime_commit.duration>=updated.runtime_commit.duration);
  });
  const timing=parseRuntimeTiming(context.timing());
  assert.deepEqual(Object.keys(timing),['runtime_acquire','runtime_wait','runtime_read','runtime_restore','runtime_serialize','runtime_codec','runtime_commit','runtime_validate']);
  assert.equal(timing.runtime_wait.count,0);assert.equal(timing.runtime_read.count,0);assert.equal(timing.runtime_validate.count,0);
});

test('runtime timing measures BUSY sleeps separately from acquire RPC duration',async()=>{
  const cloud=new FakeCloud();await seed(cloud,{counter:0,events:[]});
  const rpc=cloud.runtimeSessionRPC.bind(cloud);let acquisitions=0,context;
  cloud.runtimeSessionRPC=async(operation,args)=>{
    if(operation==='acquire'&&++acquisitions===1)return {busy:true,retryAfterMs:250};
    return rpc(operation,args);
  };
  await new RuntimeSessionStore({cloud}).run(request(),new FakeResponse(),options,async()=>{context=runtimeSessionContext();});
  const timing=parseRuntimeTiming(context.timing());
  assert.equal(timing.runtime_acquire.count,2);assert.equal(timing.runtime_wait.count,1);
  assert.ok(timing.runtime_wait.duration>=200,'BUSY sleep was omitted from the timing');
  assert.ok(timing.runtime_acquire.duration<timing.runtime_wait.duration,'RPC duration included the separate BUSY sleep');
  assert.equal(cloud.row.owner,null);
});

test('readonly timing accounts for read and failed mandatory validation without attributing them to restore or commit',async()=>{
  const cloud=new FakeCloud();await seedAuthenticated(cloud);let context;
  await failedResponse(new RuntimeSessionStore({cloud}),request(),new FakeResponse(),{...readOptions,readOnly:true},async()=>{
    context=runtimeSessionContext();cloud.rejectMedia=true;
  });
  const timing=parseRuntimeTiming(context.timing());
  assert.equal(timing.runtime_read.count,1);assert.equal(timing.runtime_restore.count,1);assert.equal(timing.runtime_validate.count,1);
  for(const phase of ['runtime_acquire','runtime_serialize','runtime_codec','runtime_commit'])assert.equal(timing[phase].count,0);
});

test('readonly requests without playback release before I/O, run concurrently and cannot overwrite a later writer',async()=>{
  const cloud=new FakeCloud();await seed(cloud,authenticatedState());
  const firstReady=deferred(),secondReady=deferred(),finish=deferred();
  const firstResponse=new FakeResponse(),secondResponse=new FakeResponse();let firstCaptures=0,secondCaptures=0;
  const first=new RuntimeSessionStore({cloud}).run(request(),firstResponse,{...readOptions,capture:state=>{firstCaptures++;return state;}},async state=>{
    assert.equal(state.client.playback,null);state.counter=1;state.events.push('before-readonly');
    const context=runtimeSessionContext();assert.equal(context.readOnly,false);await context.beforeReadonly();
    assert.equal(context.readOnly,true);context.assert();assert.equal(cloud.row.owner,null);
    state.counter=100;state.events.push('discard-first-local');firstReady.resolve();await finish.promise;reply(firstResponse,{source:'first'});
  });
  await firstReady.promise;
  const second=new RuntimeSessionStore({cloud}).run(request(),secondResponse,{...readOptions,capture:state=>{secondCaptures++;return state;}},async state=>{
    assert.equal(state.counter,1);assert.deepEqual(state.events,['before-readonly']);assert.equal(state.client.playback,null);
    await runtimeSessionContext().beforeReadonly();assert.equal(cloud.row.owner,null);
    state.counter=200;state.events.push('discard-second-local');secondReady.resolve();await finish.promise;reply(secondResponse,{source:'second'});
  });
  await secondReady.promise;assert.equal(firstResponse.ends,0);assert.equal(secondResponse.ends,0);
  const writerResponse=new FakeResponse();
  await new RuntimeSessionStore({cloud}).run(request(),writerResponse,readOptions,async state=>{
    assert.equal(state.counter,1);state.counter=9;state.events.push('writer');reply(writerResponse,{written:true});
  });
  finish.resolve();await Promise.all([first,second]);
  assert.equal(cloud.busyCount,0);assert.equal(firstResponse.statusCode,200);assert.equal(secondResponse.statusCode,200);
  assert.deepEqual(firstResponse.json(),{source:'first'});assert.deepEqual(secondResponse.json(),{source:'second'});
  assert.equal(firstCaptures,1);assert.equal(secondCaptures,1);
  const durable=await new RuntimeSessionStore({cloud}).openCipher(cloud.row.cipher,sessionHash);
  assert.equal(durable.counter,9);assert.deepEqual(durable.events,['before-readonly','writer']);
  assert.equal(cloud.row.revision,2);assert.equal(cloud.row.owner,null);
});

test('an exclusive PIN, logout or authentication change revokes an earlier readonly response before its final flush',async t=>{
  for(const change of ['pin','logout','authentication'])await t.test(change,async()=>{
    const cloud=new FakeCloud();await seed(cloud,authenticatedState());
    const ready=deferred(),finish=deferred(),res=new FakeResponse();let captures=0;
    res.setHeader('X-Content-Type-Options','nosniff');
    const earlier=failedResponse(new RuntimeSessionStore({cloud}),request(),res,{...readOptions,capture:state=>{captures++;return state;}},async state=>{
      assert.equal(state.client.playback,null);await runtimeSessionContext().beforeReadonly();
      ready.resolve();await finish.promise;
      res.writeHead(200,{'Content-Type':'application/json','Content-Length':'9999','Location':'/old-private-destination'});
      res.end(JSON.stringify({stalePrivateResult:true}));
    });
    await ready.promise;
    const writerResponse=new FakeResponse();
    await new RuntimeSessionStore({cloud}).run(request(),writerResponse,readOptions,async state=>{
      if(change==='pin')state.parental.unlocked=true;
      else if(change==='logout'){state.authGeneration++;state.loggedOut=true;state.client=null;}
      else state.authGeneration++;
      state.counter=12;reply(writerResponse,{written:true});
    });
    finish.resolve();const error=await earlier;
    assert.equal(error.code,'RUNTIME_SESSION_SCOPE_CHANGED');assert.equal(error.status,503);
    assert.equal(res.statusCode,503);assert.deepEqual(res.json(),{code:'RUNTIME_SESSION_SCOPE_CHANGED'});assert.equal(res.ends,1);
    assert.equal(res.getHeader('location'),undefined);assert.equal(res.getHeader('content-length'),undefined);
    assert.equal(res.getHeader('x-content-type-options'),'nosniff');assert.equal(captures,1);
    const durable=await new RuntimeSessionStore({cloud}).openCipher(cloud.row.cipher,sessionHash);
    assert.equal(durable.counter,12);assert.equal(cloud.row.owner,null);assert.equal(cloud.busyCount,0);
    if(change==='pin')assert.equal(durable.parental.unlocked,true);
    else assert.equal(durable.authGeneration,2);
  });
});

test('readonly validation transport failure fails closed without releasing its prepared success response',async()=>{
  const cloud=new FakeCloud();await seed(cloud,authenticatedState());const previous=cloud.row.cipher,res=new FakeResponse();let captures=0;
  const error=await failedResponse(new RuntimeSessionStore({cloud}),request(),res,{...readOptions,capture:state=>{captures++;return state;}},async state=>{
    assert.equal(state.client.playback,null);await runtimeSessionContext().beforeReadonly();
    state.counter=99;cloud.rejectMedia=true;
    res.writeHead(200,{'Content-Type':'application/json','Location':'/unvalidated-private-result'});res.end(JSON.stringify({success:true}));
  });
  assert.equal(error.status,503);assert.equal(error.code,'RUNTIME_SESSION_UNAVAILABLE');
  assert.deepEqual(res.json(),{code:'RUNTIME_SESSION_UNAVAILABLE'});assert.equal(res.ends,1);assert.equal(res.getHeader('location'),undefined);
  assert.equal(captures,1);assert.equal(cloud.row.cipher,previous);assert.equal(cloud.row.owner,null);
});

const seedAuthenticated=async cloud=>{
  await seed(cloud,authenticatedState());
  await new RuntimeSessionStore({cloud}).run(request(),new FakeResponse(),readOptions,async()=>{});
  assert.match(cloud.row.mediaEpoch,/^[a-f0-9]{64}$/);
  cloud.calls.length=0;cloud.busyCount=0;
};

test('rejected oversized or malformed snapshots cannot pair a changed epoch with the previous cipher',async t=>{
  for(const reason of ['too-large','format'])await t.test(reason,async()=>{
    const cloud=new FakeCloud();await seedAuthenticated(cloud);
    const previous=cloud.row.cipher,previousEpoch=cloud.row.mediaEpoch,res=new FakeResponse();let captures=0;
    const error=await failedResponse(new RuntimeSessionStore({cloud}),request(),res,{...readOptions,capture:state=>{captures++;return state;}},async state=>{
      state.parental.unlocked=true;state.authGeneration++;state.client.playbackGeneration++;
      if(reason==='too-large')state.payload=randomBytes(3*1024*1024).toString('hex');
      else state.unsupported=new (class UnsupportedCheckpoint {})();
      reply(res,{uncommittedPrivateResult:true});
    });
    assert.equal(error.code,reason==='too-large'?'RUNTIME_SESSION_TOO_LARGE':'RUNTIME_SESSION_FORMAT');
    assert.equal(captures,1);assert.equal(cloud.row.cipher,previous);assert.equal(cloud.row.mediaEpoch,previousEpoch);
    assert.equal(cloud.row.owner,null);assert.equal(res.statusCode,503);
    assert.deepEqual(cloud.calls.filter(call=>call.operation==='commit'),[{operation:'commit',hasCipher:false,release:true}]);
    const next=new FakeResponse();cloud.calls.length=0;
    await new RuntimeSessionStore({cloud}).run(request(),next,{...readOptions,readOnly:true},async state=>{
      assert.equal(runtimeSessionContext().readOnly,true);assert.equal(state.parental.unlocked,false);
      assert.equal(state.authGeneration,1);assert.equal(state.client.playbackGeneration,0);reply(next,{durable:true});
    });
    assert.deepEqual(next.json(),{durable:true});assert.equal(cloud.calls.some(call=>call.operation==='acquire'),false);
  });
});

test('cleanup preserves the last accepted checkpoint epoch after a later snapshot is rejected',async()=>{
  const cloud=new FakeCloud();await seedAuthenticated(cloud);
  let durableCipher,durableEpoch;
  await failedResponse(new RuntimeSessionStore({cloud}),request(),new FakeResponse(),readOptions,async state=>{
    state.parental.unlocked=true;await runtimeSessionContext().checkpoint();
    durableCipher=cloud.row.cipher;durableEpoch=cloud.row.mediaEpoch;
    state.authGeneration++;state.unsupported=new (class UnsupportedCheckpoint {})();
  });
  assert.equal(cloud.row.cipher,durableCipher);assert.equal(cloud.row.mediaEpoch,durableEpoch);assert.equal(cloud.row.owner,null);
  const next=new FakeResponse();
  await new RuntimeSessionStore({cloud}).run(request(),next,{...readOptions,readOnly:true},async state=>{
    assert.equal(state.parental.unlocked,true);assert.equal(state.authGeneration,1);reply(next,{durable:true});
  });
  assert.deepEqual(next.json(),{durable:true});
});

test('restore failure releases the unchanged cipher with its proven row epoch instead of inventing anonymous state',async t=>{
  for(const epochSource of ['acquire','read','legacy-null'])await t.test(epochSource,async()=>{
    const cloud=new FakeCloud();await seedAuthenticated(cloud);
    if(epochSource==='legacy-null')cloud.row.mediaEpoch=null;
    const previous=cloud.row.cipher,previousEpoch=cloud.row.mediaEpoch,rpc=cloud.runtimeSessionRPC.bind(cloud);
    if(epochSource!=='read')cloud.runtimeSessionRPC=async(operation,args)=>{
      const result=await rpc(operation,args);
      return operation==='acquire'?{...result,mediaEpoch:cloud.row.mediaEpoch}:result;
    };
    const error=await failedResponse(new RuntimeSessionStore({cloud}),request(),new FakeResponse(),{
      ...readOptions,restore:()=>{throw Object.assign(new Error('Synthetic restore failure'),{status:503,code:'RUNTIME_SESSION_INVALID'});}
    },()=>assert.fail('Operation ran after restoration failed'));
    assert.equal(error.code,'RUNTIME_SESSION_INVALID');assert.equal(cloud.row.cipher,previous);
    assert.equal(cloud.row.mediaEpoch,previousEpoch);assert.equal(cloud.row.owner,null);
    assert.equal(cloud.calls.filter(call=>call.operation==='read').length,epochSource==='read'?1:0);
    assert.deepEqual(cloud.calls.filter(call=>call.operation==='commit'),[{operation:'commit',hasCipher:false,release:true}]);
  });
});

test('restore failure cannot release an unknown epoch when its recovery read fails or returns another cipher',async t=>{
  for(const reason of ['unavailable','mismatched-cipher'])await t.test(reason,async()=>{
    const cloud=new FakeCloud();await seedAuthenticated(cloud);
    const previous=cloud.row.cipher,previousEpoch=cloud.row.mediaEpoch,rpc=cloud.runtimeSessionRPC.bind(cloud);let recoveryReads=0;
    cloud.runtimeSessionRPC=async(operation,args)=>{
      if(operation==='read'){
        recoveryReads++;
        if(reason==='unavailable')throw new Error('Synthetic read unavailable');
        return {cipher:'different-cipher',mediaEpoch:'b'.repeat(64)};
      }
      return rpc(operation,args);
    };
    await failedResponse(new RuntimeSessionStore({cloud}),request(),new FakeResponse(),{
      ...readOptions,restore:()=>{throw Object.assign(new Error('Synthetic restore failure'),{status:503,code:'RUNTIME_SESSION_INVALID'});}
    },()=>assert.fail('Operation ran after restoration failed'));
    assert.equal(recoveryReads,1);assert.equal(cloud.row.cipher,previous);assert.equal(cloud.row.mediaEpoch,previousEpoch);
    assert.notEqual(cloud.row.owner,null);assert.equal(cloud.calls.some(call=>call.operation==='commit'),false);
  });
});

test('twenty direct readers bypass a held writer lease without acquiring or changing its durable state',async()=>{
  const cloud=new FakeCloud();await seedAuthenticated(cloud);
  const entered=deferred(),release=deferred(),writerResponse=new FakeResponse();
  const writer=new RuntimeSessionStore({cloud}).run(request(),writerResponse,readOptions,async state=>{
    state.counter=9;state.events.push('writer');entered.resolve();await release.promise;reply(writerResponse,{written:true});
  });
  await entered.promise;let captures=0;
  try{
    const responses=await Promise.all(Array.from({length:20},async(_,index)=>{
      const res=new FakeResponse();
      await new RuntimeSessionStore({cloud}).run(request(),res,{...readOptions,readOnly:true,capture:state=>{captures++;return state;}},async state=>{
        const context=runtimeSessionContext();assert.equal(context.readOnly,true);context.assert();
        assert.equal(state.client.playback,null);assert.equal(state.counter,0);
        await Promise.resolve();state.counter=100+index;state.events.push('local-read');reply(res,{index,seenCounter:0});
      });
      return res;
    }));
    assert.equal(captures,0);assert.equal(cloud.busyCount,0);assert.notEqual(cloud.row.owner,null);
    assert.equal(cloud.calls.filter(call=>call.operation==='read').length,20);
    assert.equal(cloud.calls.filter(call=>call.operation==='acquire').length,1);
    assert.equal(cloud.calls.filter(call=>call.operation==='commit').length,0);
    for(let index=0;index<responses.length;index++){
      assert.equal(responses[index].statusCode,200);assert.deepEqual(responses[index].json(),{index,seenCounter:0});
    }
  }finally{release.resolve();await writer;}
  const durable=await new RuntimeSessionStore({cloud}).openCipher(cloud.row.cipher,sessionHash);
  assert.equal(durable.counter,9);assert.deepEqual(durable.events,['writer']);
});

test('a writer PIN or logout change revokes direct readers before their body or redirect can escape',async t=>{
  for(const change of ['pin','logout'])await t.test(change,async()=>{
    const cloud=new FakeCloud();await seedAuthenticated(cloud);
    const entered=deferred(),finish=deferred(),res=new FakeResponse();let captures=0;
    const reader=failedResponse(new RuntimeSessionStore({cloud}),request(),res,{...readOptions,readOnly:true,capture:state=>{captures++;return state;}},async()=>{
      assert.equal(runtimeSessionContext().readOnly,true);entered.resolve();await finish.promise;
      res.writeHead(200,{'Location':'/stale-direct-reader','Content-Length':'1000'});res.end(JSON.stringify({privateOldData:true}));
    });
    await entered.promise;
    await new RuntimeSessionStore({cloud}).run(request(),new FakeResponse(),readOptions,async state=>{
      if(change==='pin')state.parental.unlocked=true;
      else{state.authGeneration++;state.client=null;state.loggedOut=true;}
    });
    finish.resolve();const error=await reader;
    assert.equal(error.code,'RUNTIME_SESSION_SCOPE_CHANGED');assert.equal(res.statusCode,503);
    assert.deepEqual(res.json(),{code:'RUNTIME_SESSION_SCOPE_CHANGED'});assert.equal(res.getHeader('location'),undefined);
    assert.equal(res.getHeader('content-length'),undefined);assert.equal(captures,0);assert.equal(cloud.busyCount,0);
  });
});

test('a false reader selector re-acquires a lease and restores the later writer state before executing',async()=>{
  const cloud=new FakeCloud();await seedAuthenticated(cloud);
  const entered=deferred(),finish=deferred(),writerResponse=new FakeResponse(),fallbackResponse=new FakeResponse();
  const writer=new RuntimeSessionStore({cloud}).run(request(),writerResponse,readOptions,async state=>{
    state.counter=5;entered.resolve();await finish.promise;reply(writerResponse,{written:true});
  });
  await entered.promise;const selectedStates=[];
  const fallback=new RuntimeSessionStore({cloud}).run(request(),fallbackResponse,{...readOptions,readOnly:state=>{
    selectedStates.push(state);return false;
  }},async state=>{
    assert.equal(runtimeSessionContext().readOnly,false);assert.notEqual(state,selectedStates[0]);
    assert.equal(state.counter,5);state.counter++;reply(fallbackResponse,{counter:state.counter});
  });
  await cloud.busy.promise;finish.resolve();await Promise.all([writer,fallback]);
  assert.ok(selectedStates.length>=1);assert.equal(selectedStates[0].counter,0);assert.equal(cloud.calls.filter(call=>call.operation==='read').length,1);
  assert.ok(cloud.calls.filter(call=>call.operation==='acquire').length>=2);assert.equal(fallbackResponse.statusCode,200);
  assert.deepEqual(fallbackResponse.json(),{counter:6});
  assert.equal((await new RuntimeSessionStore({cloud}).openCipher(cloud.row.cipher,sessionHash)).counter,6);
});

test('a missing direct-reader checkpoint remains anonymous without taking a lease',async()=>{
  const cloud=new FakeCloud(),res=new FakeResponse();let captures=0;
  await new RuntimeSessionStore({cloud}).run(request(),res,{...options,readOnly:true,capture:state=>{captures++;return state;}},async state=>{
    assert.equal(state.client,undefined);reply(res,{connected:false});
  });
  assert.deepEqual(res.json(),{connected:false});assert.equal(captures,0);
  assert.deepEqual(cloud.calls.map(call=>call.operation),['read']);assert.equal(cloud.row.owner,null);
});

test('a connected direct reader without a valid persisted epoch fails closed before its operation',async()=>{
  const cloud=new FakeCloud();await seed(cloud,authenticatedState());cloud.row.mediaEpoch='a'.repeat(64);const res=new FakeResponse();
  await assert.rejects(new RuntimeSessionStore({cloud}).run(request(),res,{...readOptions,readOnly:true},()=>assert.fail('Unvalidated reader ran')),{status:503});
  assert.equal(res.ends,0);assert.equal(cloud.calls.some(call=>call.operation==='acquire'),false);
});

test('a legacy null epoch upgrades under a writer lease instead of granting an unvalidated direct read',async()=>{
  const cloud=new FakeCloud();await seed(cloud,authenticatedState());const res=new FakeResponse();
  await new RuntimeSessionStore({cloud}).run(request(),res,{...readOptions,readOnly:true},async()=>{
    assert.equal(runtimeSessionContext().readOnly,false);assert.notEqual(cloud.row.owner,null);reply(res,{upgraded:true});
  });
  assert.deepEqual(res.json(),{upgraded:true});assert.equal(cloud.calls.filter(call=>call.operation==='read').length,1);
  assert.equal(cloud.calls.filter(call=>call.operation==='acquire').length,1);assert.match(cloud.row.mediaEpoch,/^[a-f0-9]{64}$/);
});

test('buffered metadata waits beyond the streaming poll interval without polling but validates once before flush',async()=>{
  const cloud=new FakeCloud();await seedAuthenticated(cloud);
  const store=new RuntimeSessionStore({cloud}),res=new FakeResponse();let signal;
  await store.run(request(),res,{...readOptions,readOnly:true},async()=>{
    signal=runtimeSessionContext().signal;
    assert.equal(store.readers.size,1);
    reply(res,{privateMetadata:true});
    await new Promise(resolve=>setTimeout(resolve,2700));
    assert.equal(signal.aborted,false);assert.equal(res.headersSent,false);assert.equal(res.ends,0);
    assert.equal(cloud.calls.filter(call=>call.operation==='media').length,0);
  });
  assert.equal(signal.aborted,false);assert.deepEqual(res.json(),{privateMetadata:true});
  assert.equal(cloud.calls.filter(call=>call.operation==='media').length,1);
  assert.equal(cloud.calls.some(call=>['acquire','renew','commit'].includes(call.operation)),false);
  assert.equal(store.readers.size,0);
});

test('a registered buffered reader is revoked by a local writer before its final validation without remote polling',async()=>{
  const cloud=new FakeCloud();await seedAuthenticated(cloud);
  const store=new RuntimeSessionStore({cloud}),res=new FakeResponse(),entered=deferred(),finish=deferred();let signal;
  const pending=failedResponse(store,request(),res,{...readOptions,readOnly:true},async()=>{
    signal=runtimeSessionContext().signal;
    assert.equal(store.readers.size,1);
    res.writeHead(200,{'Location':'/private-buffered-data','Content-Length':'1000'});res.end('private metadata');
    entered.resolve();await finish.promise;
  });
  await entered.promise;
  await store.run(request(),new FakeResponse(),readOptions,async state=>{state.parental.unlocked=true;});
  assert.equal(signal.aborted,true);assert.equal(res.headersSent,false);assert.equal(res.ends,0);
  assert.equal(cloud.calls.filter(call=>call.operation==='media').length,0);
  finish.resolve();const error=await pending;
  assert.equal(error.status,503);assert.equal(res.statusCode,503);
  assert.equal(res.getHeader('location'),undefined);assert.equal(res.getHeader('content-length'),undefined);
  assert.match(res.json().code,/^RUNTIME_SESSION_/);assert.equal(store.readers.size,0);
});

test('a buffered direct reader cannot flush if its mandatory final remote validation is unavailable',async()=>{
  const cloud=new FakeCloud();await seedAuthenticated(cloud);
  const res=new FakeResponse(),store=new RuntimeSessionStore({cloud});
  const error=await failedResponse(store,request(),res,{...readOptions,readOnly:true},async()=>{
    reply(res,{privateMetadata:true});cloud.rejectMedia=true;
    assert.equal(cloud.calls.filter(call=>call.operation==='media').length,0);
  });
  assert.equal(error.code,'RUNTIME_SESSION_UNAVAILABLE');assert.equal(res.statusCode,503);
  assert.deepEqual(res.json(),{code:'RUNTIME_SESSION_UNAVAILABLE'});
  assert.equal(cloud.calls.filter(call=>call.operation==='media').length,1);assert.equal(store.readers.size,0);
});

test('a direct streaming reader validates before headers and retains revocation protection while its body is open',async()=>{
  const cloud=new FakeCloud();await seedAuthenticated(cloud);
  const started=deferred(),revoked=deferred(),store=new RuntimeSessionStore({cloud}),res=new FakeResponse();let captures=0,revokedBySignal=false;
  // The production guard unrefs its timer. This fixture has no open HTTP
  // socket to keep Node alive, so retain a bounded test-only deadline.
  const guardDeadline=setTimeout(()=>revoked.resolve(),5000);
  const streaming=store.run(request(),res,{...readOptions,readOnly:true,capture:state=>{captures++;return state;}},async()=>{
    const context=runtimeSessionContext();assert.equal(context.readOnly,true);
    await context.beforeStreaming();
    assert.ok(cloud.calls.some(call=>call.operation==='media'));assert.equal(res.headersSent,false);
    assert.equal(store.readers.size,1);
    context.signal.addEventListener('abort',()=>{revokedBySignal=true;res.destroyed=true;revoked.resolve();},{once:true});
    res.writeHead(200,{'Content-Type':'video/mp4'});res.write('authorized initial bytes');started.resolve();
    await revoked.promise;context.assert();assert.fail('Revoked streaming reader continued');
  });
  const rejected=assert.rejects(streaming,{status:503});
  await started.promise;
  await new RuntimeSessionStore({cloud}).run(request(),new FakeResponse(),readOptions,async state=>{state.parental.unlocked=true;});
  try{await rejected;}finally{clearTimeout(guardDeadline);}
  assert.equal(revokedBySignal,true);
  assert.equal(captures,0);assert.equal(res.destroyed,true);assert.equal(res.ends,0);
  assert.equal(Buffer.concat(res.body).toString(),'authorized initial bytes');assert.equal(store.readers.size,0);
  assert.equal(cloud.busyCount,0);assert.equal(cloud.calls.filter(call=>call.operation==='read').length,1);
  assert.ok(cloud.calls.filter(call=>call.operation==='media').length>=2);
});

const segmentRequest=(id='segment',method='GET')=>({...request(),method,url:'/api/asset/'+id});
const segmentOptions=(id='segment',method='GET')=>({...readOptions,segmentReadCache:true,
  readOnly:runtimeSessionReadPolicy({method},new URL('/api/asset/'+id,'https://fixture.invalid'))});
async function seedSegments(cloud,store=new RuntimeSessionStore({cloud})){
  const state=authenticatedState();state.client.playback={key:'live:42',controller:new AbortController()};
  state.client.assets=new Map([['segment',{key:'live:42',mediaDurationSeconds:6,url:new URL('https://fixture.invalid/first.ts')}]]);
  await seed(cloud,state);await store.run(request(),new FakeResponse(),readOptions,()=>{});
  cloud.calls.length=0;return store;
}

test('completed segment pipelines validate before headers without another RPC after finish',async t=>{
  for(const cached of [false,true])await t.test(cached?'cached checkpoint':'fresh checkpoint',async()=>{
    const cloud=new FakeCloud(),store=await seedSegments(cloud),res=new StreamingResponse();
    const rpc=cloud.runtimeSessionRPC.bind(cloud);let afterFinish=0;
    cloud.runtimeSessionRPC=async(operation,args)=>{
      const result=await rpc(operation,args);
      if(operation==='media'&&res.writableFinished){
        afterFinish++;
        throw Object.assign(new Error('Synthetic post-finish timeout'),{code:'ETIMEDOUT'});
      }
      return result;
    };
    const expected=cached?2:1;
    await store.run(segmentRequest(),res,{...segmentOptions(),segmentReadCache:cached},async()=>{
      await runtimeSessionContext().beforeStreaming();
      assert.equal(cloud.calls.filter(call=>call.operation==='media').length,expected);
      assert.equal(res.headersSent,false);
      res.writeHead(200,{'Content-Type':'video/mp2t'});
      await pipeline(Readable.from([Buffer.from('synthetic-segment')]),res);
      assert.equal(res.writableFinished,true);
    });
    assert.equal(cloud.calls.filter(call=>call.operation==='media').length,expected);
    assert.equal(afterFinish,0);assert.equal(res.statusCode,200);
    assert.equal(Buffer.concat(res.body).toString(),'synthetic-segment');
    assert.equal(store.readers.size,0);
  });
});

test('an unfinished streaming response still requires its final validation',async()=>{
  const cloud=new FakeCloud(),store=await seedSegments(cloud),res=new StreamingResponse();
  try{
    await assert.rejects(store.run(segmentRequest(),res,{...segmentOptions(),segmentReadCache:false},async()=>{
      await runtimeSessionContext().beforeStreaming();
      res.writeHead(200);res.write('synthetic-open-body');
      assert.equal(res.writableFinished,false);cloud.rejectMedia=true;
    }),{status:503,code:'RUNTIME_SESSION_UNAVAILABLE'});
    assert.equal(cloud.calls.filter(call=>call.operation==='media').length,2);
    assert.equal(res.writableFinished,false);assert.equal(store.readers.size,0);
  }finally{res.destroy();}
});

test('streaming authorization failures remain closed before headers or body bytes',async t=>{
  for(const failure of ['transport','changed'])await t.test(failure,async()=>{
    const cloud=new FakeCloud(),store=await seedSegments(cloud),res=new StreamingResponse();
    try{
      await assert.rejects(store.run(segmentRequest(),res,{...segmentOptions(),segmentReadCache:false},async()=>{
        if(failure==='transport')cloud.rejectMedia=true;else cloud.row.mediaEpoch='b'.repeat(64);
        await runtimeSessionContext().beforeStreaming();
        assert.fail('Unvalidated headers or body could escape');
      }),{status:503,code:failure==='transport'?'RUNTIME_SESSION_UNAVAILABLE':'RUNTIME_SESSION_SCOPE_CHANGED'});
      assert.equal(res.headersSent,false);assert.equal(res.body.length,0);assert.equal(res.writableFinished,false);
      assert.equal(store.readers.size,0);
    }finally{res.destroy();}
  });
});

test('segment cache opt-in skips full reads but restores fresh Maps, assets and controllers and still validates twice',async()=>{
  const cloud=new FakeCloud(),store=await seedSegments(cloud),states=[];
  for(const method of ['GET','HEAD']){
    const res=new FakeResponse();cloud.calls.length=0;
    await store.run(segmentRequest('segment',method),res,segmentOptions('segment',method),async state=>{
      states.push(state);assert.equal(runtimeSessionContext().readOnly,true);
      assert.equal(state.counter,0);state.counter=99;
      assert.equal(cloud.calls.filter(call=>call.operation==='media').length,1,'validate cached authorization before operation');
      reply(res,{ok:true});
    });
    assert.deepEqual(res.json(),{ok:true});assert.equal(cloud.calls.filter(call=>call.operation==='read').length,0);
    assert.equal(cloud.calls.filter(call=>call.operation==='media').length,2,'final validation stays mandatory');
    assert.equal(cloud.calls.some(call=>['acquire','renew','commit'].includes(call.operation)),false);
  }
  assert.notEqual(states[0],states[1]);assert.notEqual(states[0].client.assets,states[1].client.assets);
  assert.notEqual(states[0].client.assets.get('segment'),states[1].client.assets.get('segment'));
  assert.notEqual(states[0].client.playback.controller,states[1].client.playback.controller);
  cloud.calls.length=0;
  await store.run(segmentRequest(),new FakeResponse(),{...segmentOptions(),segmentReadCache:false},()=>{});
  assert.equal(cloud.calls.filter(call=>call.operation==='read').length,1,'ordinary read-only requests do not use this cache');
});

test('segment cache expires absolutely and a slow validation cannot use an expired URL snapshot',async()=>{
  let clock=Date.now();const cloud=new FakeCloud(),store=await seedSegments(cloud,new RuntimeSessionStore({cloud,now:()=>clock}));
  const first=store.snapshotCache.get(sessionHash),rpc=cloud.runtimeSessionRPC.bind(cloud);
  clock+=1900;
  await store.run(segmentRequest(),new FakeResponse(),segmentOptions(),()=>{});
  assert.equal(store.snapshotCache.get(sessionHash),first);
  cloud.calls.length=0;let advance=true;
  cloud.runtimeSessionRPC=async(operation,args)=>{
    const result=await rpc(operation,args);if(operation==='media'&&advance){advance=false;clock+=101;}return result;
  };
  await store.run(segmentRequest(),new FakeResponse(),segmentOptions(),()=>{});
  assert.equal(cloud.calls.filter(call=>call.operation==='read').length,1,'expiry during RPC requires a fresh full checkpoint');
  assert.notEqual(store.snapshotCache.get(sessionHash),first);
});

test('same-epoch rotated URLs are retained for at most the original TTL and newly registered assets force a fresh read',async()=>{
  let clock=Date.now();const cloud=new FakeCloud(),store=await seedSegments(cloud,new RuntimeSessionStore({cloud,now:()=>clock}));
  const remote=new RuntimeSessionStore({cloud});
  await remote.run(request(),new FakeResponse(),readOptions,async state=>{
    state.client.assets.get('segment').url=new URL('https://fixture.invalid/rotated.ts');
    state.client.assets.set('new-segment',{key:'live:42',mediaDurationSeconds:6,url:new URL('https://fixture.invalid/new.ts')});
  });
  cloud.calls.length=0;clock+=1999;
  await store.run(segmentRequest(),new FakeResponse(),segmentOptions(),async state=>{
    assert.equal(state.client.assets.get('segment').url.pathname,'/first.ts');
  });
  assert.equal(cloud.calls.filter(call=>call.operation==='read').length,0);
  clock++;
  await store.run(segmentRequest(),new FakeResponse(),segmentOptions(),async state=>{
    assert.equal(state.client.assets.get('segment').url.pathname,'/rotated.ts');
  });
  assert.equal(cloud.calls.filter(call=>call.operation==='read').length,1);
  await remote.run(request(),new FakeResponse(),readOptions,async state=>{
    state.client.assets.set('newest-segment',{key:'live:42',mediaDurationSeconds:6,url:new URL('https://fixture.invalid/newest.ts')});
  });
  cloud.calls.length=0;
  await store.run(segmentRequest('newest-segment'),new FakeResponse(),segmentOptions('newest-segment'),async state=>{
    assert.equal(runtimeSessionContext().readOnly,true);
    assert.equal(state.client.assets.get('newest-segment').url.pathname,'/newest.ts');
  });
  assert.deepEqual(cloud.calls.map(call=>call.operation),['read','media']);
});

test('cached PIN, logout and STOP epochs are rejected and a fresh checkpoint is restored before operation',async t=>{
  for(const change of ['pin','logout','stop'])await t.test(change,async()=>{
    const cloud=new FakeCloud(),store=await seedSegments(cloud);
    await new RuntimeSessionStore({cloud}).run(request(),new FakeResponse(),readOptions,async state=>{
      if(change==='pin')state.parental.unlocked=true;
      else if(change==='logout'){state.authGeneration++;state.loggedOut=true;state.client=null;}
      else{state.client.playbackGeneration++;state.client.playback=null;}
    });
    cloud.calls.length=0;
    await store.run(segmentRequest(),new FakeResponse(),segmentOptions(),async state=>{
      assert.equal(cloud.calls.filter(call=>call.operation==='read').length,1);
      if(change==='pin')assert.equal(state.parental.unlocked,true);
      else if(change==='logout')assert.equal(state.client,null);
      else assert.equal(state.client.playback,null);
    });
    assert.equal(cloud.calls[0].operation,'media');
  });
});

test('segment-cache validation transport failure is a closed 503 without full read or operation',async()=>{
  const cloud=new FakeCloud(),store=await seedSegments(cloud);cloud.rejectMedia=true;
  const res=new FakeResponse();
  const error=await failedResponse(store,segmentRequest(),res,segmentOptions(),()=>assert.fail('Unvalidated segment operation'));
  assert.equal(error.code,'RUNTIME_SESSION_UNAVAILABLE');assert.equal(res.statusCode,503);
  assert.deepEqual(cloud.calls.map(call=>call.operation),['media']);assert.equal(store.snapshotCache.size,0);
});

test('an unknown asset or false selector requires a fresh read before writer fallback; manifests never hit',async t=>{
  for(const kind of ['unknown','predicate','manifest','wrong-owner','zero-duration'])await t.test(kind,async()=>{
    const cloud=new FakeCloud(),store=await seedSegments(cloud);let id='segment';
    if(kind==='unknown')id='new-segment';
    if(['manifest','wrong-owner','zero-duration'].includes(kind)){
      await store.run(request(),new FakeResponse(),readOptions,async state=>{
        const asset=state.client.assets.get('segment');
        if(kind==='manifest')asset.mediaDurationSeconds=null;
        else if(kind==='wrong-owner')asset.key='live:99';else asset.mediaDurationSeconds=0;
      });
    }
    cloud.calls.length=0;const settings=segmentOptions(id);
    if(kind==='predicate')settings.readOnly=()=>false;
    await store.run(segmentRequest(id),new FakeResponse(),settings,async()=>{
      assert.equal(runtimeSessionContext().readOnly,false);
      assert.deepEqual(cloud.calls.slice(0,2).map(call=>call.operation),['read','acquire']);
    });
  });
});

test('missing cache validation results fall back to a full read, never to the cached state',async()=>{
  const cloud=new FakeCloud(),store=await seedSegments(cloud),rpc=cloud.runtimeSessionRPC.bind(cloud);let first=true;
  cloud.runtimeSessionRPC=async(operation,args)=>{
    const result=await rpc(operation,args);if(operation==='media'&&first){first=false;return {missing:true};}return result;
  };
  await store.run(segmentRequest(),new FakeResponse(),segmentOptions(),()=>{
    assert.equal(cloud.calls.filter(call=>call.operation==='read').length,1);
  });
});

test('a late full read cannot overwrite a newer same-epoch URL commit in the segment cache',async()=>{
  const cloud=new FakeCloud(),store=await seedSegments(cloud),rpc=cloud.runtimeSessionRPC.bind(cloud),entered=deferred(),finish=deferred();
  store.snapshotCache.invalidate(sessionHash);let hold=true;
  cloud.runtimeSessionRPC=async(operation,args)=>{
    const result=await rpc(operation,args);if(operation==='read'&&hold){hold=false;entered.resolve();await finish.promise;}return result;
  };
  const pending=store.run(segmentRequest(),new FakeResponse(),segmentOptions(),()=>{});
  await entered.promise;
  await store.run(request(),new FakeResponse(),readOptions,async state=>{
    state.client.assets.get('segment').url=new URL('https://fixture.invalid/rotated.ts');
  });
  finish.resolve();await pending;cloud.calls.length=0;
  await store.run(segmentRequest(),new FakeResponse(),segmentOptions(),async state=>{
    assert.equal(state.client.assets.get('segment').url.pathname,'/rotated.ts');
  });
  assert.equal(cloud.calls.filter(call=>call.operation==='read').length,0);
});

test('segment-cache final validation still rejects a writer raced after its admission',async()=>{
  const cloud=new FakeCloud(),store=await seedSegments(cloud),entered=deferred(),finish=deferred(),res=new FakeResponse();
  const pending=failedResponse(store,segmentRequest(),res,segmentOptions(),async()=>{
    reply(res,{staleSegment:true});entered.resolve();await finish.promise;
  });
  await entered.promise;
  await new RuntimeSessionStore({cloud}).run(request(),new FakeResponse(),readOptions,async state=>{state.parental.unlocked=true;});
  finish.resolve();const error=await pending;
  assert.equal(error.code,'RUNTIME_SESSION_SCOPE_CHANGED');assert.equal(res.statusCode,503);
  assert.deepEqual(res.json(),{code:'RUNTIME_SESSION_SCOPE_CHANGED'});
});

test('readonly failure updates invalidate same-epoch cached backoff state',async()=>{
  const cloud=new FakeCloud(),store=await seedSegments(cloud);
  await store.run(segmentRequest(),new FakeResponse(),segmentOptions(),async()=>{
    await runtimeSessionContext().update(state=>{state.counter=45;});
    assert.equal(store.snapshotCache.size,0);
  });
  cloud.calls.length=0;
  await store.run(segmentRequest(),new FakeResponse(),segmentOptions(),async state=>{assert.equal(state.counter,45);});
  assert.equal(cloud.calls.filter(call=>call.operation==='read').length,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {RuntimeSessionStore} from '../lib/runtime-session-store.mjs';
import {runtimeSessionContext} from '../lib/runtime-session-context.mjs';

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

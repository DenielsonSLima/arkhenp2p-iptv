import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {RuntimeSessionStore} from '../lib/runtime-session-store.mjs';

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
  constructor(){this.row={cipher:null,revision:0,fence:0,owner:null,leaseUntil:0};this.calls=[];this.busy=deferred();this.rejectCipherCommits=false;}
  runtimeSessionKey(){return Buffer.alloc(32,23);}
  async runtimeSessionRPC(operation,args){
    this.calls.push({operation,hasCipher:args.p_cipher!=null,release:args.p_release});
    const row=this.row,now=Date.now();
    if(operation==='acquire'){
      if(row.owner&&row.owner!==args.p_owner&&row.leaseUntil>now){this.busy.resolve();return {busy:true,retryAfterMs:250};}
      row.owner=args.p_owner;row.fence++;row.leaseUntil=now+90000;
      return {cipher:row.cipher,revision:row.revision,fence:row.fence,leaseUntil:new Date(row.leaseUntil).toISOString()};
    }
    if(operation==='media')return {ok:row.mediaEpoch===args.p_media_epoch};
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

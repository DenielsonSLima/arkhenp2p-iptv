import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable,Writable} from 'node:stream';
import {finished} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import {createApp} from '../lib/app-server.mjs';
import {ProviderClient} from '../lib/provider.mjs';
import {RuntimeSessionStore} from '../lib/runtime-session-store.mjs';
import {captureRuntimeSession,restoreRuntimeSession} from '../lib/runtime-session-state.mjs';
import {ParentalControl} from '../lib/parental-control.mjs';

const cookie='D'.repeat(32),hash=createHash('sha256').update(cookie).digest('hex');
const configuration={server:'https://provider.fixture.invalid',username:'fixture',password:'fixture'};
const fresh=()=>({client:null,authGeneration:1,loggedOut:false,seen:Date.now(),attempts:[],parental:new ParentalControl()});
const manifest=sequence=>['#EXTM3U','#EXT-X-TARGETDURATION:2','#EXT-X-MEDIA-SEQUENCE:'+sequence,
  ...[sequence,sequence+1,sequence+2].flatMap(id=>['#EXTINF:1.6,',`segment-${id}.ts`]),''].join('\n');

class ResponseFixture extends Writable{
  constructor(){super();this.headers=new Map();this.statusCode=200;this.headersSent=false;this.chunks=[];}
  _write(chunk,encoding,callback){this.chunks.push(Buffer.from(chunk));callback();}
  setHeader(name,value){this.headers.set(name.toLowerCase(),value);return this;}
  getHeader(name){return this.headers.get(name.toLowerCase());}
  getHeaders(){return Object.fromEntries(this.headers);}
  getHeaderNames(){return [...this.headers.keys()];}
  removeHeader(name){this.headers.delete(name.toLowerCase());}
  writeHead(status,headers={}){this.statusCode=status;for(const [name,value] of Object.entries(headers))this.setHeader(name,value);this.headersSent=true;return this;}
  text(){return Buffer.concat(this.chunks).toString();}
}

test('independent hosted instances poll, stream and STOP through the real app without unchanged cipher uploads or post-finish RPCs',async t=>{
  let sequence=40,postFinishCalls=0,encryptions=0,activeResponse=null,cacheClock=Date.now();
  const calls=[],upstream=[],row={cipher:null,revision:0,fence:0,owner:null,mediaEpoch:null};
  const cloud={runtimeSessionKey:()=>Buffer.alloc(32,17),async runtimeSessionRPC(operation,args){
    assert.equal(args.p_session_hash,hash);calls.push({operation,cipherBytes:Buffer.byteLength(args.p_cipher||'')});
    if(operation==='read')return {cipher:row.cipher,mediaEpoch:row.mediaEpoch,revision:row.revision};
    if(operation==='media'){
      if(activeResponse?.writableFinished){postFinishCalls++;throw new Error('No database work may follow completed media');}
      return {ok:row.mediaEpoch===args.p_media_epoch};
    }
    if(operation==='acquire'){
      assert.equal(row.owner,null,'one writer owns the durable session');row.owner=args.p_owner;row.fence++;
      return {...row,leaseUntil:new Date(Date.now()+90000).toISOString()};
    }
    assert.equal(operation,'commit');assert.equal(row.owner,args.p_owner);assert.equal(row.fence,args.p_fence);assert.equal(row.revision,args.p_revision);
    if(args.p_cipher!==null){row.cipher=args.p_cipher;row.revision++;}
    row.mediaEpoch=args.p_media_epoch;if(args.p_release)row.owner=null;
    return {ok:true,revision:row.revision,fence:row.fence};
  }};
  class MediaClient extends ProviderClient{
    connect(){assert.fail('Synthetic hosted media must not authenticate');}
    playbackURL(){return new URL('https://provider.fixture.invalid/live.m3u8');}
    async upstreamRequest(value){
      const url=String(value),playlist=url.endsWith('.m3u8');upstream.push(playlist?'manifest':'segment');
      return {status:200,url,headers:{'content-type':playlist?'application/vnd.apple.mpegurl':'video/mp2t'},
        body:Readable.from([Buffer.from(playlist?manifest(sequence):'synthetic media bytes')])};
    }
  }
  const client=new MediaClient(configuration);client.libraryProvider='xtream';client.authenticatedAt=Date.now();
  client.session={connected:true,account:{status:'Active'}};
  const state=fresh();state.client=client;state.parental.unlocked=true;
  const seed=new RuntimeSessionStore({cloud,now:()=>cacheClock});
  await seed.run({headers:{cookie:'ORBIT_SID='+cookie}},new ResponseFixture(),{createState:()=>state,capture:captureRuntimeSession,restore:()=>state},async()=>{});
  const stores=[],apps=[];
  for(let index=0;index<3;index++){
    const store=new RuntimeSessionStore({cloud,now:()=>cacheClock}),seal=store.sealJSON.bind(store);
    store.sealJSON=(...args)=>{encryptions++;return seal(...args);};stores.push(store);
    apps.push(createApp({connection:configuration,environment:{},cloud:null,sessionStore:store,
      providerFactory:({config})=>new MediaClient(config)}));
  }
  t.after(()=>Promise.all(apps.map(app=>app.shutdown())));
  const request=async(index,url,method='GET')=>{
    const req=new EventEmitter();Object.assign(req,{method,url,aborted:false,headers:{host:'127.0.0.1',cookie:'ORBIT_SID='+cookie}});
    const response=new ResponseFixture();activeResponse=response;
    await apps[index].listeners('request')[0](req,response);await finished(response);activeResponse=null;
    return response;
  };
  const playlistPath='/api/play/live/81/index.m3u8?attempt=fixture-cycle';
  const first=await request(0,playlistPath);assert.equal(first.statusCode,200);
  const assets=first.text().split('\n').filter(line=>line.startsWith('/api/asset/'));
  assert.equal(assets.length,3);const initialCipher=row.cipher,initialEncryptions=encryptions;
  const assetsAfterOpen=(await seed.openCipher(row.cipher,hash)).client.assets;
  for(let cycle=0;cycle<9;cycle++){
    cacheClock+=100;
    calls.length=0;
    const response=await request(cycle%3,playlistPath);
    assert.equal(response.statusCode,200);assert.equal(response.text(),first.text());
    assert.equal(row.cipher,initialCipher,'an unchanged poll must retain its exact durable ciphertext');
    assert.equal(encryptions,initialEncryptions);assert.equal(row.owner,null);
    assert.equal(calls.filter(call=>call.operation==='commit').length,1);
    assert.equal(calls.reduce((sum,call)=>sum+call.cipherBytes,0),0);
    const segment=await request((cycle+1)%3,assets[cycle%3]);
    assert.equal(segment.statusCode,200);assert.equal(segment.text(),'synthetic media bytes');
    assert.equal(row.owner,null);assert.equal(row.cipher,initialCipher);
  }
  assert.equal(postFinishCalls,0);assert.equal(upstream.filter(kind=>kind==='segment').length,9);
  assert.deepEqual((await seed.openCipher(row.cipher,hash)).client.assets,assetsAfterOpen);
  sequence++;
  const advanced=await request(1,playlistPath);assert.equal(advanced.statusCode,200);
  assert.notEqual(row.cipher,initialCipher);assert.equal(encryptions,initialEncryptions+1);
  const revived=await restoreRuntimeSession(await seed.openCipher(row.cipher,hash),{createState:fresh,createClient:({config})=>new MediaClient(config)});
  assert.equal(revived.client.assets.size,4);assert.equal(revived.playbackIntent.attempt,'fixture-cycle');
  assert.ok(stores[0].snapshotCache.get(hash),'the next request must exercise a still-valid pre-STOP cache');
  const stop=await request(2,'/api/stop?attempt=fixture-cycle','POST');assert.equal(stop.statusCode,200);
  calls.length=0;
  const count=upstream.length,oldSegment=await request(0,assets[0]);
  assert.equal(oldSegment.statusCode,404);assert.equal(upstream.length,count,'a cached pre-STOP checkpoint must never request media');
  assert.deepEqual(calls.slice(0,2).map(call=>call.operation),['media','read']);
  assert.equal(row.owner,null);assert.ok(stores.every(store=>store.readers.size===0));
});

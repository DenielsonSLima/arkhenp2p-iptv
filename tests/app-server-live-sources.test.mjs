import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../lib/app-server.mjs';
import {Readable} from 'node:stream';

async function fixture(t){
 let cloudCalls=0,sourcesCalls=0;
 const client={config:null,session:null,authenticatedAt:Date.now(),playbackGeneration:0,
  async connect(){return this.session;},async logout(){this.session=null;},async stopPlayback(){},
  async catalog(){return{categories:[{id:'safe',name:'Canais'},{id:'restricted',name:'Adultos'}],items:[
   {id:'130',kind:'live',name:'Canal sintético',categoryId:'safe'},
   {id:'543',kind:'live',name:'Canal protegido',categoryId:'restricted'}]};},
  async liveSources(id){sourcesCalls++;return{channelId:id,selectedSourceId:null,sources:[]};}};
 const cloud={enabled:false,ready:Promise.resolve(),publicConfig:()=>null,
  async bootstrap(){cloudCalls++;throw Object.assign(new Error('Synthetic unavailable cloud'),{code:'CLOUD_UNAVAILABLE'});}};
 const app=createApp({connection:{server:'https://synthetic.invalid'},cloud,sharedWorker:{unregisterSource(){},stop(){}},
  providerFactory:({config})=>{client.config=config;client.session={connected:true,account:{status:'Active',expiresAt:'2070-01-01T00:00:00Z'}};return client;}});
 await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
 t.after(()=>app.shutdown());
 const base='http://127.0.0.1:'+app.address().port;
 const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'wplay',username:'synthetic',password:'synthetic'})});
 assert.equal(login.status,200);await login.json();
 const headers={Cookie:login.headers.get('set-cookie').split(';')[0]};cloud.enabled=true;
 return{client,cloud,headers,base,get cloudCalls(){return cloudCalls;},get sourcesCalls(){return sourcesCalls;},
  read:(id='130')=>fetch(base+'/api/live/sources?id='+id,{headers})};
}

test('provider source descriptors do not bootstrap an unavailable cloud library',async t=>{
 const f=await fixture(t),response=await f.read();
 assert.equal(response.status,200);assert.equal((await response.json()).channelId,'130');
 assert.equal(f.cloudCalls,0);assert.equal(f.sourcesCalls,1);
 assert.match(response.headers.get('server-timing'),/^provider;dur=\d+(?:\.\d+)?, sources;dur=\d+(?:\.\d+)?$/);
});

test('source discovery preserves a validated existing provider session instead of refreshing login',async t=>{
 const f=await fixture(t);f.client.authenticatedAt=Date.now()-600000;
 f.client.connect=async()=>{throw new Error('Synthetic login must not run on the descriptor read path.');};
 const response=await f.read();assert.equal(response.status,200);assert.equal(f.sourcesCalls,1);assert.equal(f.cloudCalls,0);
});

test('native source route classifies with the source catalogue and keeps PIN enforcement',async t=>{
 const f=await fixture(t),catalog=await f.client.catalog();let metadataReads=0;
 f.client.liveSourceCatalog=async()=>{metadataReads++;return catalog;};
 f.client.catalog=async()=>{throw new Error('Generic catalogue path would refresh login.');};
 f.client.connect=async()=>{throw new Error('No provider login refresh.');};
 f.client.authenticatedAt=Date.now()-600000;
 assert.equal((await f.read()).status,200);assert.equal(metadataReads,1);
 assert.equal((await f.read('543')).status,403);assert.equal(f.sourcesCalls,1);assert.equal(f.cloudCalls,0);
});

test('expired, inactive and disconnected provider sessions cannot use the cloud-independent source route',async t=>{
 const f=await fixture(t);
 for(const account of [{status:'Active',expiresAt:'2000-01-01T00:00:00Z'},{status:'Disabled'}]){
  f.client.session={connected:true,account};assert.equal((await f.read()).status,401);
 }
 f.client.session={connected:false,account:{status:'Active'}};assert.equal((await f.read()).status,401);
 f.client.session={connected:true,account:{status:'Active'}};f.client.authenticatedAt=Date.now()-86400001;
 assert.equal((await f.read()).status,401);assert.equal(f.sourcesCalls,0);assert.equal(f.cloudCalls,0);
});

test('PIN-protected channels remain forbidden and logout invalidates source readers',async t=>{
 const f=await fixture(t),protectedReply=await f.read('543');
 assert.equal(protectedReply.status,403);assert.equal((await protectedReply.json()).code,'PARENTAL_LOCKED');
 assert.match(protectedReply.headers.get('server-timing'),/^provider;dur=\d+(?:\.\d+)?$/);
 assert.equal(f.sourcesCalls,0);
 await fetch(f.base+'/api/logout',{method:'POST',headers:{...f.headers,'Content-Type':'application/json'},body:'{}'});
 assert.equal((await f.read()).status,401);assert.equal(f.sourcesCalls,0);
});

test('a source descriptor reply from an old authentication generation is discarded',async t=>{
 const f=await fixture(t);let release,entered;
 const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
 f.client.liveSources=async id=>{entered();await gate;return{channelId:id,selectedSourceId:null,sources:[]};};
 const pending=f.read();await ready;
 try{await fetch(f.base+'/api/logout',{method:'POST',headers:{...f.headers,'Content-Type':'application/json'},body:'{}'});}
 finally{release();}
 assert.equal((await pending).status,401);
});

test('playback reports preparation separately from synthetic upstream transport time',async t=>{
 const f=await fixture(t);
 Object.assign(f.client,{
  async playbackURL(){return new URL('https://synthetic.invalid/index.m3u8');},
  beginPlayback(key){return this.playback={key,controller:new AbortController()};},
  async upstreamRequest(){return{status:200,headers:{'content-type':'application/vnd.apple.mpegurl'},
   body:Readable.from([Buffer.from('#EXTM3U\n')]),url:'https://synthetic.invalid/index.m3u8'};},
  rewriteManifest:text=>text,recordTransfer(){}
 });
 const response=await fetch(f.base+'/api/play/live/130/index.m3u8?attempt=synthetic-timing',{headers:f.headers});
 assert.equal(response.status,200);
 assert.match(response.headers.get('server-timing'),/^prepare;dur=\d+(?:\.\d+)?, upstream;dur=\d+(?:\.\d+)?$/);
 assert.equal(await response.text(),'#EXTM3U\n');
 assert.equal(f.cloudCalls,0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createApp} from '../lib/app-server.mjs';
import {ProviderClient} from '../lib/provider.mjs';

function deferred(){let resolve;return {promise:new Promise(done=>{resolve=done;}),resolve:()=>resolve()};}
async function fixture(t){
  const entered=deferred(),release=deferred();let client,calls=0,rewrites=0;
  const app=createApp({connection:{server:'https://fixture.invalid'},environment:{},cloud:null,sharedWorker:{stop(){},unregisterSource(){}},providerFactory:({config})=>{
    client=new ProviderClient({...config,server:'https://fixture.invalid'});
    client.connect=async()=>{client.authenticatedAt=Date.now();return client.session={connected:true,account:{status:'Active'}};};
    client.catalog=async()=>({categories:[{id:'safe',name:'TV'}],items:[{id:'446',kind:'live',name:'Synthetic',categoryId:'safe'}]});
    client.playbackURL=async()=>new URL('https://media.fixture.invalid/live.m3u8');
    const rewrite=client.rewriteManifest.bind(client);client.rewriteManifest=(...args)=>{rewrites++;return rewrite(...args);};
    client.upstreamRequest=async value=>{
      const first=++calls===1;
      return {status:200,url:String(value),headers:{'content-type':'application/vnd.apple.mpegurl'},body:Readable.from((async function*(){
        yield Buffer.from('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXTINF:1,\n');
        if(first){entered.resolve();await release.promise;}
        yield Buffer.from(first?'old.ts?token=old\n':'new.ts?token=new\n');
      })())};
    };
    return client;
  }});
  await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{release.resolve();app.closeAllConnections?.();await app.shutdown();});
  const base='http://127.0.0.1:'+app.address().port;
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'synthetic',password:'synthetic'})});
  assert.equal(login.status,200);await login.json();
  const cookie=login.headers.get('set-cookie').split(';')[0];
  return {entered,release,get client(){return client;},get rewrites(){return rewrites;},read:(route,method='GET')=>fetch(base+route,{method,headers:{Cookie:cookie},signal:AbortSignal.timeout(2500)})};
}

for(const action of ['stop','logout','new-attempt'])test('late live manifest body cannot rewrite assets after '+action,{timeout:5000},async t=>{
  const f=await fixture(t),pending=f.read('/api/play/live/446/index.m3u8?attempt=old');await f.entered.promise;
  if(action==='new-attempt'){
    const current=await f.read('/api/play/live/446/index.m3u8?attempt=new');assert.equal(current.status,200);await current.text();
    assert.equal(f.rewrites,1);assert.equal(f.client.assets.size,1);
  }else{
    const response=await f.read(action==='stop'?'/api/stop':'/api/logout','POST');assert.equal(response.status,200);await response.json();
    assert.equal(f.rewrites,0);assert.equal(f.client.assets.size,0);
  }
  f.release.resolve();const stale=await pending;assert.equal(stale.status,409);await stale.text();
  assert.equal(f.rewrites,action==='new-attempt'?1:0);assert.equal(f.client.assets.size,action==='new-attempt'?1:0);
  assert.ok([...f.client.assets.values()].every(asset=>!String(asset.url).includes('old.ts')));
});

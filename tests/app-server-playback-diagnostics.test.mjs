import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createApp} from '../lib/app-server.mjs';
import {ProviderClient,ProviderError} from '../lib/provider.mjs';

async function fixture(t,{upstreamStatus=404,selectionError,onError,liveManifest=false}={}){
  const events=[],requests=[];
  const app=createApp({connection:{server:'https://fixture.example'},onPlaybackError:event=>{events.push(event);onError?.(event);},providerFactory:({config})=>{
    const client=new ProviderClient({...config,server:'https://fixture.example'});
    client.connect=async()=>client.session={connected:true,account:{provider:'wplay',status:'Active'}};
    client.catalog=async()=>({categories:[{id:'safe',name:'Séries'}],items:[{id:'9',kind:'series',name:'Série de teste',categoryId:'safe'},...(liveManifest?[{id:'405',kind:'live',name:'Canal de teste',categoryId:'safe'}]:[])]});
    client.details=async()=>({id:'9',name:'Série de teste',seasons:[{number:1,episodes:[{id:'12644159'},{id:'12644164'},{id:'1'}]}]});
    client.playbackURL=async()=>{if(selectionError)throw selectionError;return new URL('https://private-media.example/'+(liveManifest?'index.m3u8':'video.mp4')+'?token=private-token');};
    client.upstreamRequest=async(value,options)=>{requests.push({method:options.method,range:options.headers.Range});if(liveManifest&&new URL(value).pathname==='/index.m3u8')return {status:200,url:String(value),headers:{'content-type':'application/vnd.apple.mpegurl'},body:Readable.from([Buffer.from('#EXTM3U\n#EXTINF:4,\nsegment.ts?token=private-token\n')])};return {status:upstreamStatus,url:String(value),headers:{'content-type':'video/mp4'},body:Readable.from(['synthetic'])};};
    return client;
  }});
  await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});t.after(async()=>{app.closeAllConnections?.();await app.shutdown();});
  const base='http://127.0.0.1:'+app.address().port,login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:'private-user',password:'private-password'})});
  assert.equal(login.status,200);await login.json();const headers={Cookie:login.headers.get('set-cookie').split(';')[0]};assert.equal((await fetch(base+'/api/details?type=series&id=9',{headers})).status,200);return {app,base,events,requests,headers};
}

test('a registered episode with upstream 404 returns 502 and emits only sanitized playback diagnostics',async t=>{
  const f=await fixture(t),response=await fetch(f.base+'/api/play/series/12644159.mp4',{headers:{...f.headers,Range:'bytes=0-1023'}});
  assert.equal(response.status,502);assert.match((await response.json()).error,/HTTP 404/);
  assert.deepEqual(f.events,[{kind:'series',code:'PLAYBACK_UPSTREAM_HTTP',status:502,upstreamStatus:404}]);
  assert.deepEqual(f.requests,[{method:'GET',range:'bytes=0-1023'}]);assert.doesNotMatch(JSON.stringify(f.events),/private|https:|12644159|token|Cookie|password|Range/);
});

test('source-selection failures retain their distinct code while diagnostic callback failures cannot change the response',async t=>{
  const f=await fixture(t,{selectionError:new ProviderError('Abra a série antes de reproduzir.','EPISODE_NOT_REGISTERED',400),onError:()=>{throw new Error('Consumer failed');}});
  const response=await fetch(f.base+'/api/play/series/12644164.mp4',{headers:f.headers});assert.equal(response.status,400);assert.equal((await response.json()).code,'EPISODE_NOT_REGISTERED');
  assert.deepEqual(f.events,[{kind:'series',code:'EPISODE_NOT_REGISTERED',status:400,upstreamStatus:null}]);assert.equal(f.requests.length,0);
});

test('transport errors use an allowed code and successful playback emits no failure event',async t=>{
  const failed=await fixture(t,{selectionError:Object.assign(new Error('Synthetic connection failure'),{code:'ECONNRESET'})});
  assert.equal((await fetch(failed.base+'/api/play/series/1.mp4',{headers:failed.headers})).status,502);assert.equal(failed.events[0].code,'ECONNRESET');
  const healthy=await fixture(t,{upstreamStatus:200}),response=await fetch(healthy.base+'/api/play/series/1.mp4',{headers:healthy.headers});assert.equal(response.status,200);await response.text();assert.deepEqual(healthy.events,[]);
});

test('repeated cooldown readers neither contact the provider nor flood playback diagnostics',async t=>{
  const f=await fixture(t,{upstreamStatus:429}),url=f.base+'/api/play/series/1.mp4?attempt=cooldown-fixture';
  for(let i=0;i<12;i++){
    const response=await fetch(url,{headers:f.headers});assert.equal(response.status,429);await response.json();
  }
  assert.equal(f.requests.length,1);assert.equal(f.events.length,1);
  assert.equal(f.events[0].upstreamStatus,429);
});

test('a live segment failure is observable without leaking its source or account',async t=>{
  const f=await fixture(t,{upstreamStatus:503,liveManifest:true});
  const manifest=await fetch(f.base+'/api/play/live/405/index.m3u8',{headers:f.headers});assert.equal(manifest.status,200);
  const segment=(await manifest.text()).split('\n').find(line=>line.startsWith('/api/asset/'));assert.ok(segment);assert.equal(f.events.length,0);
  const response=await fetch(f.base+segment,{headers:f.headers});assert.equal(response.status,502);await response.json();
  assert.deepEqual(f.events,[{kind:'live',code:'PLAYBACK_SEGMENT_HTTP',status:502,upstreamStatus:503}]);
  assert.doesNotMatch(JSON.stringify(f.events),/private|https:|405|token|Cookie|password|Range/);
});

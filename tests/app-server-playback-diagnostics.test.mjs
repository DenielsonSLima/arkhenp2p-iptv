import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createApp} from '../lib/app-server.mjs';
import {ProviderClient,ProviderError} from '../lib/provider.mjs';

async function fixture(t,{upstreamStatus=404,selectionError,onError}={}){
  const events=[],requests=[];
  const app=createApp({nativeBridge:null,connection:{server:'https://fixture.example'},onPlaybackError:event=>{events.push(event);onError?.(event);},providerFactory:({config})=>{
    const client=new ProviderClient({...config,server:'https://fixture.example'});
    client.connect=async()=>client.session={connected:true,account:{provider:'wplay',status:'Active'}};
    client.playbackURL=async()=>{if(selectionError)throw selectionError;return new URL('https://private-media.example/video.mp4?token=private-token');};
    client.upstreamRequest=async(value,options)=>{requests.push({method:options.method,range:options.headers.Range});return {status:upstreamStatus,url:String(value),headers:{'content-type':'video/mp4'},body:Readable.from(['synthetic'])};};
    return client;
  }});
  await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});t.after(async()=>{app.closeAllConnections?.();await app.shutdown();});
  const base='http://127.0.0.1:'+app.address().port,login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:'private-user',password:'private-password'})});
  assert.equal(login.status,200);await login.json();return {app,base,events,requests,headers:{Cookie:login.headers.get('set-cookie').split(';')[0]}};
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

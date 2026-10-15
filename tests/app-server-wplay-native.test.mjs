import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../lib/app-server.mjs';
import { WplayPlaybackProviderClient } from '../lib/wplay-playback.mjs';
import { WPLAY_AUTH_URLS } from '../lib/wplay-provider.mjs';

test('the application defaults to native WPlay and dispatches its registered category pages',async t=>{
  const calls=[];
  t.mock.method(WplayPlaybackProviderClient.prototype,'connect',async function(){
    calls.push({method:'connect',provider:this.config.provider,authURLs:this.authURLs});
    this.session={connected:true,account:{provider:'wplay',status:'Active'}};return this.session;
  });
  const snapshot={categories:[{id:'50',name:'Lançamentos'}],items:[{id:'101',kind:'movie',name:'Filme',categoryId:'50'}],pagination:{mode:'category',byCategory:{'50':{nextPage:2,hasMore:true,loaded:true}}}};
  t.mock.method(WplayPlaybackProviderClient.prototype,'catalog',async function(type){calls.push({method:'catalog',type});return snapshot;});
  t.mock.method(WplayPlaybackProviderClient.prototype,'catalogPage',async function(type,category,page){calls.push({method:'catalogPage',type,category,page});return {...snapshot,pagination:{mode:'category',byCategory:{'50':{nextPage:page+1,hasMore:true,loaded:true}}}};});
  const app=createApp({connection:{server:'https://unrelated-fixture.invalid'},nativeBridge:null});
  await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
  const base=`http://127.0.0.1:${app.address().port}`;
  try{
    const fresh=await fetch(base+'/api/session');
    assert.deepEqual(await fresh.json(),{connected:false,capabilities:{games:true,accountLibrary:true,cloud:false},login:{configuredServer:true,defaultProvider:'wplay'},cloud:null,cloudStatus:{state:'disabled'}});
    const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:'native-fixture',password:'synthetic-private-password'})});
    assert.equal(login.status,200);const account=await login.json();assert.equal(account.connected,true);assert.equal(account.account.provider,'wplay');
    const headers={Cookie:login.headers.get('set-cookie').split(';')[0]};
    const catalog=await fetch(base+'/api/catalog?type=movies',{headers});assert.deepEqual(await catalog.json(),snapshot);
    const page=await fetch(base+'/api/catalog?type=movies&category=50&page=2',{headers});assert.equal(page.status,200);
    assert.equal((await page.json()).pagination.byCategory['50'].nextPage,3);
    assert.deepEqual(calls,[
      {method:'connect',provider:'wplay',authURLs:[WPLAY_AUTH_URLS[1],WPLAY_AUTH_URLS[0]]},
      {method:'catalog',type:'movies'},
      {method:'catalogPage',type:'movies',category:'50',page:2}
    ]);
    const exposed=JSON.stringify(account);for(const secret of ['native-fixture','synthetic-private-password','unrelated-fixture.invalid',...WPLAY_AUTH_URLS])assert.ok(!exposed.includes(secret));
    const logout=await fetch(base+'/api/logout',{method:'POST',headers:{...headers,Origin:base},body:'{}'});assert.equal(logout.status,200);
    const denied=await fetch(base+'/api/catalog?type=movies&category=50&page=3',{headers});assert.equal(denied.status,401);
  }finally{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));}
});

test('graceful shutdown waits for native session cleanup and can be called twice',async t=>{
  let finishLogout,startedLogout;
  const events=[];
  const waiting=new Promise(resolve=>{startedLogout=resolve;});
  const released=new Promise(resolve=>{finishLogout=resolve;});
  t.mock.method(WplayPlaybackProviderClient.prototype,'connect',async function(){
    this.session={connected:true,account:{provider:'wplay',status:'Active'}};return this.session;
  });
  t.mock.method(WplayPlaybackProviderClient.prototype,'logout',async function(){
    startedLogout();await released;this.session=null;events.push('logout');
  });
  const app=createApp({connection:{},nativeBridge:{async shutdown(){events.push('bridge-shutdown');}}});
  await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
  const base='http://127.0.0.1:'+app.address().port;
  try{
    const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:'fixture',password:'synthetic-private-password'})});
    assert.equal(login.status,200);await login.json();
    let finished=false;
    const closing=app.shutdown().then(()=>{finished=true;});
    await waiting;
    assert.equal(finished,false);
    assert.deepEqual(events,[]);
    finishLogout();
    await closing;await app.shutdown();
    assert.equal(finished,true);assert.equal(app.listening,false);
    assert.deepEqual(events,['logout','bridge-shutdown']);
  }finally{finishLogout();await app.shutdown();}
});

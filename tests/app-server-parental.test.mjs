import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../lib/app-server.mjs';

test('parental API enforces PIN and session isolation before details, direct playback, EPG and old assets',async t=>{
  let playCalls=0,clients=[];
  const categories=[{id:'safe',name:'Cinema'},{id:'adult',name:'Adultos +18'}],items=[{id:'1',kind:'movie',name:'Filme',categoryId:'safe'},{id:'2',kind:'movie',name:'Reservado',categoryId:'adult'}];
  const server=createApp({connection:{server:'https://provider.test'},providerFactory:async({config})=>{
    const client={config,authenticatedAt:Date.now(),playbackGeneration:0,session:{connected:true,account:{status:'Active'}},assets:new Map([['old',{url:'https://stream.test/movie',key:'movie:2'}]]),playback:{key:'movie:2'},
      async connect(){return this.session;},async catalog(type){return {categories,items:items.map(item=>({...item,kind:type==='live'?'live':type==='series'?'series':'movie'}))};},
      async details(kind,id){return {...items.find(item=>item.id===id),kind,seasons:kind==='series'?[{episodes:[{id:'22'}]}]:[]};},
      async playbackURL(){playCalls++;throw new Error('fake playback reached');},async stopPlayback(){this.playbackGeneration++;},async logout(){this.session=null;},async epg(){return {list:[]};}};clients.push(client);return client;
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.shutdown());const origin='http://127.0.0.1:'+server.address().port;
  async function login(){const response=await fetch(origin+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'xtream',username:'fixture',password:'fixture-password'})});assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];}
  const first=await login(),second=await login(),call=(cookie,path,body)=>fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.equal((await (await call(first,'/api/parental')).json()).locked,true);
  for(const path of ['/api/details?type=movie&id=2','/api/play/movie/2.mp4','/api/play/series/22.mp4','/api/epg?id=2','/api/asset/old']){const response=await call(first,path);assert.equal(response.status,403,path);assert.equal((await response.json()).code,'PARENTAL_LOCKED');}
  assert.equal(playCalls,0);assert.equal((await call(first,'/api/details?type=movie&id=1')).status,200);
  for(let index=0;index<4;index++)assert.equal((await call(first,'/api/parental/unlock',{pin:'1234'})).status,403);
  assert.equal((await call(first,'/api/parental/unlock',{pin:'9999'})).status,429);assert.equal((await call(first,'/api/parental/unlock',{pin:'0000'})).status,429);
  assert.equal((await call(second,'/api/parental/unlock',{pin:'0000'})).status,200);assert.equal((await call(second,'/api/details?type=movie&id=2')).status,200);
  assert.equal((await call(first,'/api/details?type=movie&id=2')).status,403);
  assert.equal((await call(second,'/api/parental/lock',{})).status,200);assert.equal((await call(second,'/api/details?type=movie&id=2')).status,403);
  assert.equal((await call(second,'/api/parental/unlock',{pin:'0000'})).status,200);await call(second,'/api/logout',{});
  assert.equal((await call(second,'/api/parental')).status,401);
});

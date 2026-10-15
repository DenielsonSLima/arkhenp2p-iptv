import test from 'node:test';
import assert from 'node:assert/strict';
import {QueryClient} from '@tanstack/query-core';
import {HomeCloudModel} from '../web/home-cloud-model.js';
const result=name=>({schemaVersion:1,counts:{live:1,movie:1,series:1},favoriteChannels:[],history:{live:[],movie:[],series:[]},recommendations:{items:[{id:'1',kind:'movie',name}],personalized:true}});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function ready(model){for(let i=0;i<30&&model.pending;i++)await tick();assert.equal(model.pending,null);}
function fixture(t,options={}){let scope={account:'A',includeAdult:false,hidden:{},hiddenItems:{}},revision=1,calls=0;const model=new HomeCloudModel({getScope:()=>scope,getRevision:()=>revision,loadQueryCore:async()=>({QueryClient}),request:async()=>{calls++;return result('Saved');},...options});t.after(()=>model.dispose());return {model,setScope:value=>{scope=value;},setRevision:value=>{revision=value;},get calls(){return calls;}};}
test('home RPC is lazy, private and deduplicated across ordinary renders',async t=>{
  const f=fixture(t);assert.equal(f.calls,0);f.model.ensure();f.model.ensure();await ready(f.model);assert.equal(f.calls,1);
  for(let i=0;i<10;i++)f.model.ensure();assert.equal(f.calls,1);assert.equal(f.model.state.data.recommendations.items[0].name,'Saved');
});
test('an RPC error preserves the previous home projection for the same account',async t=>{
  const f=fixture(t);f.model.ensure();await ready(f.model);const previous=f.model.state.data;
  f.model.request=async()=>{throw new Error('remote');};f.setRevision(2);f.model.ensure({force:true});await ready(f.model);
  assert.equal(f.model.state.data,previous);assert.match(f.model.state.error,/atualizar/);
});
test('account and parental scope changes cancel late home responses and clear private shelves',async t=>{
  const f=fixture(t);f.model.ensure();await ready(f.model);const releases=[];
  f.model.request=async()=>new Promise(resolve=>{releases.push(resolve);});f.setRevision(2);f.model.ensure({force:true});await tick();
  f.setScope({account:'B',includeAdult:false});f.model.ensure();assert.equal(f.model.state.data,null);await tick();
  releases[1](result('B'));await ready(f.model);releases[0](result('A late'));await tick();assert.equal(f.model.state.data.recommendations.items[0].name,'B');
  f.setScope({account:'B',includeAdult:true});f.model.ensure();assert.equal(f.model.state.data,null);
});
test('rapid progress revisions schedule one refresh rather than a request per tick',async t=>{
  let now=100000;const f=fixture(t,{now:()=>now,minRefreshMs:15000});f.model.ensure();await ready(f.model);
  for(let i=2;i<30;i++){f.setRevision(i);f.model.ensure();}assert.equal(f.calls,1);assert.ok(f.model.timer);
  f.model.pause();assert.equal(f.model.timer,null);now+=16000;f.model.ensure();await ready(f.model);assert.equal(f.calls,2);
});

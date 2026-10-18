import test from 'node:test';
import assert from 'node:assert/strict';
import {NeighborProgramFeeds} from '../web/tv/canais/guia-vizinhos.js';
import {LiveProgramFeed} from '../web/tv/canais/feed.js';
import {channel,projection,fixture,flush} from './helpers/tv-guide-fixture.mjs';

test('both neighbours and the playing channel subscribe to one shared projection without per-ID requests',async t=>{
 const f=fixture(t,{request:async()=>projection({'10':channel('Anterior'),'20':channel('Atual'),'30':channel('Próximo')})}),updates=[];
 const feeds=new NeighborProgramFeeds({guide:f.guide,onUpdate:data=>updates.push(data)}),active=new LiveProgramFeed({guide:f.guide,onUpdate:()=>{}});t.after(()=>{feeds.destroy();active.destroy();});
 active.start('20');feeds.select({previous:'10',next:'30'});await f.ready();assert.deepEqual(f.calls.map(call=>call.url),['/api/tv/guide?ids=10%2C20%2C30']);
 for(const [slot,title]of [['previous','Anterior'],['next','Próximo']])assert.equal(updates.findLast(data=>data.slot===slot).window.current.title,title);
 const count=updates.length;feeds.select({previous:'10',next:'30'});assert.equal(updates.length,count);
 feeds.destroy();assert.equal(f.guide.listeners.size,1);active.stop();assert.equal(f.time.size,0);
});

test('two-channel cycling reuses the same snapshot on both sides and rejects invalid IDs',async t=>{
 const f=fixture(t,{request:async()=>projection({'20':channel('Vizinho')})}),updates=[],feeds=new NeighborProgramFeeds({guide:f.guide,onUpdate:data=>updates.push(data)});t.after(()=>feeds.destroy());
 feeds.select({previous:'20',next:'20'});await f.ready();for(const slot of ['previous','next'])assert.equal(updates.findLast(data=>data.slot===slot).window.current.title,'Vizinho');assert.equal(f.calls.length,1);
 feeds.select({previous:'bad',next:'20'});assert.equal(feeds.selection.previous,null);assert.equal(f.calls.length,1);
});

test('rapid tuning discards old slots while the one shared in-flight response supplies only the new selection',async t=>{
 let resolve;const f=fixture(t,{request:()=>new Promise(done=>{resolve=done;})}),updates=[],feeds=new NeighborProgramFeeds({guide:f.guide,onUpdate:data=>updates.push(data)});t.after(()=>feeds.destroy());
 feeds.select({previous:'10',next:'30'});await f.ready();feeds.select({previous:'20',next:'40'});const boundary=updates.length;
 resolve(projection({'10':channel('Antigo'),'20':channel('Vinte'),'30':channel('Antigo'),'40':channel('Quarenta')}));await f.ready();
 assert.equal(f.calls.length,1);assert.deepEqual(updates.slice(boundary).map(data=>data.id),['20','40']);
 assert.equal(updates.findLast(data=>data.slot==='previous').window.current.title,'Vinte');
});

test('namespace changes suppress prior account callbacks and stop releases the shared refresh timer',async t=>{
 let namespace='account-a',resolve;const f=fixture(t,{request:()=>new Promise(done=>{resolve=done;})}),updates=[],feeds=new NeighborProgramFeeds({guide:f.guide,getNamespace:()=>namespace,onUpdate:data=>updates.push(data)});t.after(()=>feeds.destroy());
 feeds.select({previous:'10'});await f.ready();const count=updates.length;namespace='account-b';resolve(projection());await flush();assert.equal(updates.length,count);
 feeds.stop();assert.equal(f.guide.listeners.size,0);assert.equal(f.time.size,0);
});

test('unavailable channels remain empty and failures expose stale real metadata without invented schedule',async t=>{
 let fail=false;const f=fixture(t,{request:async()=>{if(fail)throw new Error('temporary');return projection();}}),updates=[],feeds=new NeighborProgramFeeds({guide:f.guide,onUpdate:data=>updates.push(data)});t.after(()=>feeds.destroy());
 feeds.select({previous:'10',next:'99'});await f.ready();assert.equal(updates.findLast(data=>data.slot==='next').status,'unavailable');assert.deepEqual(updates.findLast(data=>data.slot==='next').list,[]);
 fail=true;await f.guide.ensure({force:true});const previous=updates.findLast(data=>data.slot==='previous');assert.equal(previous.window.current.title,'Agora');assert.equal(previous.stale,true);
});

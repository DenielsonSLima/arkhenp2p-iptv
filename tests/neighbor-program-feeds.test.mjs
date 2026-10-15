import test from 'node:test';
import assert from 'node:assert/strict';
import {NeighborProgramFeeds} from '../web/neighbor-program-feeds.js';
import {ImmersivePlayer} from '../web/immersive-player.js';

const NOW=Date.parse('2026-10-14T12:00:00Z');
const program=(id, now=NOW)=>({title:`Programação ${id}`,start:new Date(now-10000).toISOString(),end:new Date(now+120000).toISOString()});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function clock() {
  let time=NOW,next=0;const timers=new Map();
  return {now:()=>time,schedule:(callback,delay)=>{const id=++next;timers.set(id,{at:time+delay,callback});return id;},cancel:id=>timers.delete(id),
    async advance(duration){const end=time+duration;while(true){const due=[...timers].filter(([,task])=>task.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;time=due[1].at;timers.delete(due[0]);due[1].callback();await flush();}time=end;await flush();},get size(){return timers.size;}};
}

test('neighbor slots request their own real EPG IDs and stable selections do not restart feeds', async () => {
  const timer=clock(),requests=[],updates=[];
  const feeds=new NeighborProgramFeeds({...timer,getNamespace:()=> 'provider:user:1',request:async url=>{requests.push(url);const id=new URL(url,'http://local').searchParams.get('id');return {list:[program(id)]};},onUpdate:data=>updates.push(data)});
  feeds.select({previous:'10',next:'30'});await flush();
  assert.deepEqual(requests,['/api/epg?id=10','/api/epg?id=30']);
  assert.equal(updates.findLast(data=>data.slot==='previous').list[0].title,'Programação 10');
  assert.equal(updates.findLast(data=>data.slot==='next').list[0].title,'Programação 30');
  feeds.select({previous:'10',next:'30'});await timer.advance(15000);
  assert.equal(requests.length,2);assert.equal(feeds.jobs.size,2);
  feeds.destroy();assert.equal(timer.size,0);
});

test('two-channel cycling shares one neighboring EPG request across both visible slots', async () => {
  const timer=clock(),requests=[],updates=[];
  const feeds=new NeighborProgramFeeds({...timer,request:async url=>{requests.push(url);return {list:[program(url)]};},onUpdate:data=>updates.push(data)});
  feeds.select({previous:'20',next:'20'});await flush();
  assert.deepEqual(requests,['/api/epg?id=20']);assert.equal(feeds.jobs.size,1);
  for(const slot of ['previous','next'])assert.equal(updates.findLast(data=>data.slot===slot).list[0].title,'Programação /api/epg?id=20');
  feeds.select({previous:'20',next:'30'});await flush();
  assert.deepEqual(requests,['/api/epg?id=20','/api/epg?id=30']);
  feeds.destroy();
});

test('rapid tuning aborts removed requests and stale responses cannot repaint new neighbors', async () => {
  const timer=clock(),requests=[],updates=[];
  const feeds=new NeighborProgramFeeds({...timer,request:(url,{signal})=>new Promise(resolve=>requests.push({url,signal,resolve})),onUpdate:data=>updates.push(data)});
  feeds.select({previous:'10',next:'30'});feeds.select({previous:'20',next:'40'});
  assert.equal(requests[0].signal.aborted,true);assert.equal(requests[1].signal.aborted,true);
  requests[2].resolve({list:[program('canal20')]});requests[3].resolve({list:[program('canal40')]});await flush();
  requests[0].resolve({list:[program('antigo10')]});requests[1].resolve({list:[program('antigo30')]});await flush();
  assert.equal(updates.some(data=>data.list.some(value=>value.title.includes('antigo'))),false);
  assert.equal(updates.findLast(data=>data.slot==='previous').list[0].title,'Programação canal20');
  assert.equal(updates.findLast(data=>data.slot==='next').list[0].title,'Programação canal40');
  feeds.stop();assert.equal(timer.size,0);assert.ok(requests.every(value=>value.signal.aborted));
});

test('the brief cache expires within a minute and never crosses connection namespaces', async () => {
  const timer=clock(),requests=[];let namespace='wplay:user:1';
  const feeds=new NeighborProgramFeeds({...timer,getNamespace:()=>namespace,request:async url=>{requests.push({url,namespace});return {list:[program(namespace,timer.now())]};},onUpdate:()=>{}});
  feeds.select({previous:'10'});await flush();feeds.stop();
  feeds.select({next:'10'});await flush();assert.equal(requests.length,1,'Same connection can reuse a fresh EPG on another side.');
  feeds.stop();await timer.advance(60001);feeds.select({next:'10'});await flush();assert.equal(requests.length,2);
  namespace='wplay:user:2';feeds.select({next:'10'});await flush();assert.equal(requests.length,3);
  assert.equal(feeds.cache.size,1);assert.ok([...feeds.cache.keys()][0].startsWith(namespace+':'));
  feeds.destroy();assert.equal(timer.size,0);assert.equal(feeds.cache.size,0);
});

test('logout revokes late updates immediately and stop cancels deadlines and retry timers', async () => {
  const timer=clock(),requests=[],updates=[];let namespace='account:1';
  const feeds=new NeighborProgramFeeds({...timer,getNamespace:()=>namespace,request:(url,{signal})=>new Promise(resolve=>requests.push({url,signal,resolve})),onUpdate:data=>updates.push(data)});
  feeds.select({previous:'10',next:'30'});namespace='account:2';
  requests[0].resolve({list:[program('old-account')]});requests[1].resolve({list:[program('old-account')]});await flush();
  assert.equal(updates.some(data=>data.list.length),false);assert.equal(feeds.cache.size,0);
  feeds.stop();assert.equal(timer.size,0);assert.ok(requests.every(value=>value.signal.aborted));
  await timer.advance(120000);assert.equal(requests.length,2);
});

test('initial errors expose unavailability while later errors retain still-valid real EPG', async () => {
  const timer=clock(),updates=[];let calls=0;
  const feeds=new NeighborProgramFeeds({...timer,request:async()=>{if(++calls===2)return {list:[program('real',timer.now())]};throw new Error('temporary');},onUpdate:data=>updates.push(data)});
  feeds.select({previous:'10'});await flush();assert.equal(updates.at(-1).status,'unavailable');assert.deepEqual(updates.at(-1).list,[]);
  await timer.advance(30000);assert.equal(updates.at(-1).status,'ready');assert.equal(updates.at(-1).list[0].title,'Programação real');
  await timer.advance(60000);assert.equal(calls,3);assert.equal(updates.at(-1).list[0].title,'Programação real');
  feeds.destroy();
});

test('neighbor rendering keeps distinct schedules and ignores an obsolete channel update', () => {
  const nodes=id=>({id,schedule:{},status:{},programs:Object.fromEntries(['previous','current','next'].map(period=>[period,{row:{},name:{},time:{}}]))});
  const view={current:{item:{kind:'live'}},channelNeighborNodes:{previous:nodes('10'),next:nodes('30')},neighborPrograms:{previous:null,next:null},neighborFeeds:{},renderNeighborPrograms:ImmersivePlayer.prototype.renderNeighborPrograms};
  ImmersivePlayer.prototype.setNeighborProgram.call(view,{slot:'previous',id:'old',status:'ready',list:[program('obsolete',Date.now())]});
  assert.equal(view.neighborPrograms.previous,null);
  for (const [slot,id]of [['previous','10'],['next','30']])ImmersivePlayer.prototype.setNeighborProgram.call(view,{slot,id,status:'ready',list:[program(id,Date.now())]});
  assert.equal(view.channelNeighborNodes.previous.programs.current.name.textContent,'Programação 10');
  assert.equal(view.channelNeighborNodes.next.programs.current.name.textContent,'Programação 30');
  assert.equal(view.channelNeighborNodes.previous.status.hidden,true);
});

test('an empty HTTP200 neighbor refresh does not erase an active schedule and expires naturally',async()=>{
  const timer=clock(),updates=[];let calls=0;
  const feeds=new NeighborProgramFeeds({...timer,request:async()=>({list:++calls===1?[program('real')]:[]}),onUpdate:data=>updates.push(data)});
  feeds.select({previous:'10'});await flush();assert.equal(updates.at(-1).list[0].title,'Programação real');
  await timer.advance(60000);assert.equal(calls,2);assert.equal(updates.at(-1).list[0].title,'Programação real');
  await timer.advance(75000);assert.equal(updates.at(-1).list.length,0);
  feeds.destroy();assert.equal(timer.size,0);
});

test('returning a cached neighbor paints no empty frame and a namespace change stops its polling',async()=>{
  const timer=clock(),updates=[];let calls=0,namespace='account-a';
  const feeds=new NeighborProgramFeeds({...timer,getNamespace:()=>namespace,request:async()=>{calls++;return {list:[program('real')]};},onUpdate:data=>updates.push(data)});
  feeds.select({previous:'10'});await flush();feeds.stop();const checkpoint=updates.length;
  feeds.select({next:'10'});assert.equal(updates.at(-1).list[0].title,'Programação real');await flush();
  assert.ok(updates.slice(checkpoint).every(data=>data.list.length===1));assert.equal(calls,1);
  namespace='account-b';await timer.advance(120000);assert.equal(calls,1,'Old account must not schedule EPG requests in the new account.');
  feeds.destroy();assert.equal(timer.size,0);
});

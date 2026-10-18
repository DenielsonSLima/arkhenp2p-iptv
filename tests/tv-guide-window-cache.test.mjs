import test from 'node:test';
import assert from 'node:assert/strict';
import {TVProgramWindowCache} from '../web/tv/canais/cache-programacao.js';
import {TVPlayerPrograms} from '../web/tv/player/programacao.js';
import {LiveProgramFeed} from '../web/tv/canais/feed.js';
import {NOW,channel,projection,fixture,flush} from './helpers/tv-guide-fixture.mjs';

const requested=url=>new URL(url,'http://localhost').searchParams.get('ids')?.split(',');
const selectedProjection=url=>projection(Object.fromEntries((requested(url)||[]).map(id=>[id,channel('Canal '+id)])));

test('player browsing preserves previous subsets and revisiting a valid channel needs no RPC',async t=>{
  const f=fixture(t,{request:async url=>selectedProjection(url)}),programs=new TVPlayerPrograms({guide:f.guide});t.after(()=>programs.destroy());
  programs.start(['10','20','30']);await f.ready();assert.deepEqual(requested(f.calls[0].url),['10','20','30']);
  programs.start(['20','30','40']);await f.ready();assert.equal(f.calls.length,2);
  assert.equal(programs.peek('10').window.current.title,'Canal 10','A later subset does not erase an earlier channel window.');
  programs.start(['10','20','30']);await f.ready();assert.equal(f.calls.length,2);assert.equal(programs.peek('20').stale,false);
});

test('closing a guide view and reopening it reuses unexpired session memory',async t=>{
  const f=fixture(t,{request:async url=>selectedProjection(url)});
  const first=f.guide.subscribe(()=>{},{ids:['10','20']});await f.ready();first();assert.equal(f.time.size,0);
  const second=f.guide.subscribe(()=>{},{ids:['10','20']});t.after(second);await f.ready();assert.equal(f.calls.length,1);assert.equal(f.guide.peek('10').stale,false);
  await f.time.advance(60000);assert.equal(f.calls.length,2,'The server expiry still revalidates the mounted selection.');
});

test('the current video and navigation share a metadata batch while catalog surfaces are paused',async t=>{
  const f=fixture(t,{request:async url=>selectedProjection(url)}),updates=[];
  const player=new LiveProgramFeed({guide:f.guide,onUpdate:value=>updates.push(value)}),navigation=new TVPlayerPrograms({guide:f.guide});t.after(()=>{player.destroy();navigation.destroy();});
  const catalog=f.guide.subscribe(()=>{},{ids:['1','2','3']});await f.ready();catalog();
  player.start('20');navigation.start(['10','20','30']);await f.ready();assert.equal(f.calls.length,2);
  assert.deepEqual(requested(f.calls[1].url),['10','20','30']);assert.equal(updates.at(-1).window.current.title,'Canal 20');
  assert.ok(f.calls.every(call=>call.url.startsWith('/api/tv/guide?')),'No catalog, WPLAY playback or per-card endpoint is requested.');
});

test('an authoritative empty subset clears only its requested channels, and denial clears all cached channels',async t=>{
  let next=projection({'10':channel('Dez'),'20':channel('Vinte')});const f=fixture(t,{request:async()=>next});
  const stop=f.guide.subscribe(()=>{},{ids:['10','20']});t.after(stop);await f.ready();
  stop.updateIds(['10']);next=projection({});await f.guide.ensure({force:true});assert.equal(f.guide.peek('10'),null);assert.equal(f.guide.peek('20').window.current.title,'Vinte');
  f.guide.request=async()=>{throw Object.assign(new Error('Denied'),{status:401});};await f.guide.ensure({force:true});assert.equal(f.guide.peek('20'),null);
});

test('new EPG publication and account scope do not reuse previous windows',async t=>{
  let revision='revision-a';const f=fixture(t,{request:async url=>({...selectedProjection(url),revision})}),programs=new TVPlayerPrograms({guide:f.guide});t.after(()=>programs.destroy());
  programs.start(['10']);await f.ready();revision='revision-b';programs.start(['20']);await f.ready();assert.equal(programs.peek('10'),null);assert.equal(programs.peek('20').window.current.title,'Canal 20');
  f.setScope({account:'another-account',epoch:2});assert.equal(f.guide.peek('20'),null);await f.ready();assert.equal(f.calls.length,3);
});

test('in-flight selection change uses newly supplied coverage without a redundant immediate RPC',async t=>{
  let resolve;const f=fixture(t,{request:()=>new Promise(done=>{resolve=done;})}),stop=f.guide.subscribe(()=>{},{ids:['10']});t.after(stop);
  await f.ready();stop.updateIds(['20']);resolve(projection({'10':channel('Dez'),'20':channel('Vinte')}));await f.ready();await f.time.advance(0);await flush();
  assert.equal(f.calls.length,1);assert.equal(f.guide.peek('20').window.current.title,'Vinte');
});

test('publication invalidation during a read cannot certify the older response as fresh',async t=>{
  let resolve,calls=0;const f=fixture(t,{request:()=>++calls===1?new Promise(done=>{resolve=done;}):Promise.resolve(projection({'10':channel('After invalidation'),'20':channel('Vinte')}))});
  const stop=f.guide.subscribe(()=>{},{ids:['10']});t.after(stop);await f.ready();
  f.guide.invalidate();stop.updateIds(['10','20']);f.guide.invalidate();
  resolve(projection({'10':channel('Before invalidation'),'20':channel('Vinte antigo')}));await f.ready();
  assert.equal(f.guide.peek('10').stale,true,'An older in-flight response is displayable but cannot reset validity.');
  await f.time.advance(0);await f.ready();
  assert.equal(f.calls.length,2);assert.equal(new URL(f.calls[1].url,'http://localhost').searchParams.get('fresh'),'1');
  assert.equal(f.guide.peek('10').window.current.title,'After invalidation');assert.equal(f.guide.peek('10').stale,false);
});

test('memory entries are bounded and visits cannot extend server validity',()=>{
  let now=NOW;const cache=new TVProgramWindowCache({now:()=>now,maxEntries:2});
  cache.remember(projection({'1':channel('Um'),'2':channel('Dois')}),{ids:['1','2'],delay:1000});now+=500;cache.peek('1');
  cache.remember(projection({'3':channel('Três')}),{ids:['3'],delay:1000});assert.equal(cache.entries.size,2);assert.equal(cache.peek('2'),null);assert.equal(cache.peek('1').stale,false);
  now+=501;assert.equal(cache.peek('1').stale,true);assert.equal(cache.freshUntil(['1']),NOW+1000);assert.equal(cache.peek('3').stale,false);
  cache.invalidate();assert.equal(cache.peek('3').stale,true);cache.clear();assert.equal(cache.peek('3'),null);
});

test('a partial update never certifies a fresh full-map projection',()=>{
  const cache=new TVProgramWindowCache({now:()=>NOW});
  cache.remember(projection({'1':channel('Um'),'2':channel('Dois')}),{delay:1000});assert.equal(cache.freshUntil(null),NOW+1000);
  cache.remember(projection({'1':channel('Um atualizado')}),{ids:['1'],delay:1000});
  assert.equal(cache.freshUntil(null),0);assert.equal(cache.freshUntil(['1','2']),NOW+1000);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveProgramFeed} from '../web/tv/canais/feed.js';
import {ChannelGuide} from '../web/tv/canais/guia-cards.js';
import {TVGuideClient} from '../web/tv/tanstack-query.js';
import {parseProgramTime,programWindow,normalizeGuideChannel,validateGuideProjection} from '../web/tv/canais/programacao.js';
import {NOW,program,channel,projection,fixture,flush} from './helpers/tv-guide-fixture.mjs';

test('EPG metadata interprets epoch units and explicit offsets as the same instant',()=>{
 for(const value of [NOW,NOW/1000,String(NOW),String(NOW/1000),'2026-10-14T12:00:00Z','2026-10-14T09:00:00-03:00'])assert.equal(parseProgramTime(value),NOW);
 for(const value of [null,undefined,'','invalid',0])assert.ok(Number.isNaN(parseProgramTime(value)));
});

test('server window, labels and progress are authoritative even when the browser clock disagrees',t=>{
 t.mock.method(Date,'now',()=>NOW+86400000);
 const normalized=normalizeGuideChannel(channel('Servidor'));
 assert.equal(programWindow(normalized).current.title,'Servidor');assert.equal(programWindow(normalized).current.startLabel,'09:00');assert.equal(normalized.progressPercent,37);
 assert.equal(programWindow([program('Lista sem projeção')]).current,null);assert.equal(normalizeGuideChannel({list:[program('Legado')]}),null);
 assert.equal(normalizeGuideChannel({...channel(),progressPercent:200}).progressPercent,100);
});

test('malformed projections are rejected and scheduled entries require absolute timestamps',()=>{
 const value=channel();value.schedule=[program('Válido'),{title:'Sem fuso',start:'2026-10-14T12:00:00',end:'2026-10-14T13:00:00'},program('Invertido',10,0)];
 assert.ok(normalizeGuideChannel(value).schedule.every(entry=>entry.title!=='Sem fuso'&&entry.title!=='Invertido'));
 for(const invalid of [{},{...projection(),channels:[]},{...projection(),serverTime:'bad'},projection({'private-id':channel()}),projection({'10':{list:[]}})])assert.throws(()=>validateGuideProjection(invalid),/TV_GUIDE_RESPONSE_INVALID/);
});

test('current channel and cards share one map request and selections do not issue per-channel EPG calls',async t=>{
 const f=fixture(t,{request:async()=>projection({'10':channel('Dez'),'20':channel('Vinte')})}),updates=[];
 const feed=new LiveProgramFeed({guide:f.guide,onUpdate:data=>updates.push(data)});
 t.after(()=>feed.destroy());feed.start('10');await f.ready();assert.equal(updates.at(-1).window.current.title,'Dez');
 const cards=new ChannelGuide({guide:f.guide,connectionGeneration:()=>1});t.after(()=>cards.destroy());assert.equal(cards.peek('20').window.current.title,'Vinte');
 feed.start('20');await f.ready();assert.equal(updates.at(-1).window.current.title,'Vinte');assert.deepEqual(f.calls.map(call=>call.url),['/api/tv/guide?ids=10']);
 feed.stop();assert.equal(f.time.size,0);
});

test('refresh uses the server delay and transient errors retain the complete snapshot as stale',async t=>{
 let calls=0;const f=fixture(t,{request:async()=>{if(++calls>1)throw new Error('temporary');return projection();}}),stop=f.guide.subscribe(()=>{});t.after(stop);await f.ready();
 await f.time.advance(59999);assert.equal(calls,1);await f.time.advance(1);assert.equal(calls,2);
 assert.equal(f.guide.peek('10').window.current.title,'Agora');assert.equal(f.guide.peek('10').stale,true);
 await f.time.advance(15000);assert.equal(calls,3);stop();assert.equal(f.time.size,0);
});

test('a validated empty map is an authoritative correction while an invalid HTTP200 cannot erase a snapshot',async t=>{
 let result=projection();const f=fixture(t,{request:async()=>result}),stop=f.guide.subscribe(()=>{});t.after(stop);await f.ready();
 result={list:[]};await f.guide.ensure({force:true});assert.equal(f.guide.peek('10').window.current.title,'Agora');assert.equal(f.guide.state.stale,true);
 result=projection({});await f.guide.ensure({force:true});assert.equal(f.guide.peek('10'),null);assert.equal(f.guide.state.error,null);
});

test('account, PIN and epoch changes abort old work and late snapshots cannot cross their scope',async t=>{
 const pending=[];const f=fixture(t,{request:(_url,{signal})=>new Promise(resolve=>pending.push({signal,resolve}))}),updates=[];
 const stop=f.guide.subscribe(state=>updates.push(state.data));t.after(stop);await f.ready();
 for(const scope of [{account:'account-b',epoch:1},{account:'account-b',epoch:1,includeAdult:true},{account:'account-b',epoch:2,includeAdult:true}]){
  const old=pending.at(-1);f.setScope(scope);assert.equal(f.guide.peek('10'),null);await f.ready();assert.equal(old.signal.aborted,true);old.resolve(projection({'10':channel('Antigo')}));await flush();assert.equal(f.guide.peek('10'),null);
 }
 pending.at(-1).resolve(projection({'10':channel('Atual')}));await f.ready();assert.equal(f.guide.peek('10').window.current.title,'Atual');assert.equal(updates.some(data=>data?.channels['10']?.window.current.title==='Antigo'),false);
});

test('deadline retry is bounded, denied access clears data and disposal cancels pending signals',async t=>{
 let active=0,max=0;const f=fixture(t,{request:(_,{signal})=>new Promise((resolve,reject)=>{active++;max=Math.max(max,active);signal.addEventListener('abort',()=>{active--;reject(new Error('aborted'));},{once:true});})});
 f.guide.subscribe(()=>{});await f.ready();await f.time.advance(10000);assert.equal(active,0);await f.time.advance(15000);assert.equal(f.calls.length,2);assert.equal(max,1);f.guide.dispose();await flush();assert.equal(active,0);assert.equal(f.time.size,0);
 let denied=false;const secure=fixture(t,{request:async()=>{if(denied)throw Object.assign(new Error('Denied'),{status:403});return projection();}});secure.guide.subscribe(()=>{});await secure.ready();denied=true;await secure.guide.ensure({force:true});assert.equal(secure.guide.peek('10'),null);await secure.time.advance(300000);assert.equal(secure.calls.length,2);
});

test('card rendering uses server labels and exposes stale state without recalculating progress',()=>{
 const record={root:{dataset:{}},placeholder:{},rows:{},nodes:{current:{title:{},time:{}},next:{title:{},time:{}}},progress:{}};
 ChannelGuide.prototype.render.call({},record,{...normalizeGuideChannel(channel('Atual')),stale:true});
 assert.equal(record.root.dataset.state,'ready');assert.equal(record.root.dataset.stale,'true');assert.equal(record.nodes.current.time.textContent,'09:00 — 09:02');assert.equal(record.progress.value,37);
 ChannelGuide.prototype.render.call({},record,null,{error:true});assert.equal(record.root.dataset.state,'error');assert.equal(record.rows.hidden,true);
});


test('default guide timers preserve the browser global receiver required by Safari',async t=>{
 const timers=new Map();let next=0;
 t.mock.method(globalThis,'setTimeout',function(callback,delay){assert.equal(this,globalThis);const id=++next;timers.set(id,{callback,delay});return id;});
 t.mock.method(globalThis,'clearTimeout',function(id){assert.equal(this,globalThis);timers.delete(id);});
 const guide=new TVGuideClient({getScope:()=>({account:'account-a'}),request:async()=>projection(),loadQueryCore:async()=>{throw new Error('No SDK');}});t.after(()=>guide.dispose());
 const feed=new LiveProgramFeed({guide,onUpdate:()=>{}});t.after(()=>feed.destroy());feed.start('10');await flush();await flush();
 assert.equal(feed.peek('10').window.current.title,'Agora');assert.equal(timers.size,1);feed.stop();assert.equal(timers.size,0);guide.dispose();assert.equal(timers.size,0);
});

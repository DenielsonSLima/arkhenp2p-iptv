import test from 'node:test';
import assert from 'node:assert/strict';
import {WplayWebPlayback} from '../lib/wplay/ao-vivo/transporte-web.mjs';
import {WplayOTTProviderClient} from '../lib/wplay/ott/provedor.mjs';
import {WplayPlaybackProviderClient} from '../lib/wplay/conexao/reproducao.mjs';

const deferred=()=>{let resolve,reject;return{promise:new Promise((yes,no)=>{resolve=yes;reject=no;}),resolve:value=>resolve(value),reject:error=>reject(error)};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const item={id:'405',name:'Globo SP',kind:'live'};
const payload={rows:[{title:'Canais',kind:'Canal',items:[{id:'synthetic',title:'Globo SP',kind:'Canal',liveVariants:[{quality:'FHD',playbackUrl:'https://synthetic.invalid/fhd.m3u8'}]}]}]};
function fixture(t,{startupTimeoutMs=80}={}){
 const gate=deferred(),entered=deferred();let calls=0,aborts=0;
 const client=new WplayOTTProviderClient({server:'https://synthetic.invalid',username:'synthetic',password:'synthetic'},{allowPrivate:true});
 client.session={connected:true};client.logout=async()=>{};
 client.rpc.call=async(_id,{signal}={})=>{
  calls++;entered.resolve();return new Promise((resolve,reject)=>{
   const abort=()=>{aborts++;reject(new DOMException('Synthetic catalogue cancelled','AbortError'));};
   signal.addEventListener('abort',abort,{once:true});
   gate.promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},reject);
  });
 };
 const transport=new WplayWebPlayback({username:'synthetic',password:'synthetic'},{createClient:()=>client,startupTimeoutMs});
 t.after(()=>transport.close());return{transport,client,gate,entered,get calls(){return calls;},get aborts(){return aborts;}};
}

test('cancelled source reader does not restart the same account catalogue for the next reader',async t=>{
 const f=fixture(t),controller=new AbortController(),first=f.transport.sources(item,{signal:controller.signal});
 const rejected=assert.rejects(first,{code:'PLAYBACK_CANCELLED'});await f.entered.promise;controller.abort();await rejected;
 assert.equal(f.aborts,0,'Only the reader ended; the bounded metadata flight can finish for its account.');
 const next=f.transport.sources(item);await tick();assert.equal(f.calls,1);
 f.gate.resolve(payload);assert.equal((await next).sources.length,1);assert.equal(f.calls,1);assert.equal(f.transport.active,false);
});

test('closing the account aborts the shared source catalogue and prevents a late descriptor response',async t=>{
 const f=fixture(t),pending=f.transport.sources(item),rejected=assert.rejects(pending,{code:'PLAYBACK_CANCELLED'});
 await f.entered.promise;await f.transport.close();await rejected;f.gate.resolve(payload);await tick();
 assert.equal(f.aborts,1);assert.equal(f.transport.active,false);assert.equal(f.client.session,null);
});

test('shared source discovery still has one total metadata deadline',async t=>{
 const f=fixture(t,{startupTimeoutMs:20}),pending=f.transport.sources(item);
 // The production deadline is unref'd; this synthetic lease keeps Node alive.
 const lease=setTimeout(()=>{},1000);try{await assert.rejects(pending,{code:'WPLAY_WEB_START_TIMEOUT',status:504});}finally{clearTimeout(lease);}
 assert.equal(f.calls,1);assert.equal(f.aborts,1);assert.equal(f.transport.active,false);
});

test('logout retires discovery before waiting for an active stream STOP queue',async t=>{
 const f=fixture(t);f.gate.resolve(payload);f.client.stopPlayback=async()=>{};
 f.client.playbackURL=async()=>new URL('https://synthetic.invalid/fhd.m3u8');
 const owner=new WplayPlaybackProviderClient({username:'synthetic',password:'synthetic'},
  {webPlayback:true,webPlaybackFactory:()=>f.client});
 owner.item=async()=>item;owner.rawItems.set('live:405',{sources:[{address:'tvbus://synthetic'}]});
 await owner.playbackURL('live','405',null,{attempt:'synthetic'});
 f.client.invalidateCatalog('live');const next=deferred(),entered=deferred();let aborted=0;
 f.client.rpc.call=async(_id,{signal}={})=>{entered.resolve();return new Promise((resolve,reject)=>{
  signal.addEventListener('abort',()=>{aborted++;reject(new DOMException('Synthetic cancellation','AbortError'));},{once:true});next.promise.then(resolve,reject);
 });};
 const reading=Promise.allSettled([owner.liveSources('405')]);await entered.promise;const leaving=Promise.allSettled([owner.logout()]);await tick();
 try{assert.equal(aborted,1,'Logout must cancel account metadata before awaiting the queued STOP.');}
 finally{next.resolve(payload);await Promise.all([reading,leaving]);}
});

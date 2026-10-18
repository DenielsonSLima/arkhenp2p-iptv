import test from 'node:test';
import assert from 'node:assert/strict';
import {HomeRealtime} from '../web/inicio/realtime.js';
import {HomeServices} from '../web/inicio/services.js';
const tick=()=>new Promise(done=>queueMicrotask(done));
test('TV progress and publication do not refresh the VOD home projection',async()=>{
 let calls=0;const model={ensure(){calls++;}},realtime=new HomeRealtime({model,getScope:()=>({account:'synthetic'})});
 assert.equal(realtime.libraryUpdated({ready:true},{progress:['live'],favorites:['live']}),false);
 assert.equal(realtime.sharedUpdated({table:'catalog_visible_generations',type:'live'}),false);
 await tick();assert.equal(calls,0);
 assert.equal(realtime.libraryUpdated({ready:true},{progress:['movie']}),true);await tick();assert.equal(calls,1);
});
test('Home service ignores changed TV filters while an authorized VOD read completes',async()=>{
 let scope={account:'synthetic',hidden:{live:['1']}},resolve;
 const services=new HomeServices({getScope:()=>scope,request:()=>new Promise(done=>{resolve=done;})});
 const pending=services.library();scope={...scope,hidden:{live:['2']}};
 resolve({marker:'vod'});assert.deepEqual(await pending,{marker:'vod'});services.dispose();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {requestP2PWebShutdown,P2P_SHUTDOWN_MESSAGE,wireP2PServerShutdown} from '../tools/p2p-web-process.mjs';
function fixture(){const child=new EventEmitter(),jobs=new Map(),sent=[],killed=[];let id=0;Object.assign(child,{exitCode:null,connected:true,send:value=>sent.push(value),kill:value=>killed.push(value)});const options={schedule:(fn,delay)=>{const key=++id;jobs.set(key,{fn,delay});return key;},cancel:key=>jobs.delete(key)};return{child,jobs,sent,killed,options};}
test('portable launcher shutdown uses private IPC and cancels fallback after graceful child exit',()=>{
 const f=fixture(),cleanup=requestP2PWebShutdown(f.child,f.options);assert.deepEqual(f.sent,[{type:P2P_SHUTDOWN_MESSAGE}]);assert.deepEqual(f.killed,[]);assert.deepEqual([...f.jobs.values()].map(value=>value.delay),[20000,24000]);f.child.exitCode=0;f.child.emit('exit',0);assert.equal(f.jobs.size,0);cleanup();assert.deepEqual(f.killed,[]);
});
test('unresponsive child has bounded terminate/force fallback without touching another process',()=>{
 const f=fixture();f.child.connected=false;const cleanup=requestP2PWebShutdown(f.child,{...f.options,graceMs:100,forceMs:10});assert.deepEqual(f.sent,[]);for(const job of f.jobs.values())job.fn();assert.deepEqual(f.killed,['SIGTERM','SIGKILL']);cleanup();assert.equal(f.jobs.size,0);assert.equal(f.child.listenerCount('exit'),0);
});

test('an IPC send failure keeps the bounded child-only cleanup fallback',()=>{
 const f=fixture();f.child.send=()=>{throw new Error('IPC channel closed');};const cleanup=requestP2PWebShutdown(f.child,f.options);assert.equal(f.jobs.size,2);for(const job of f.jobs.values())job.fn();assert.deepEqual(f.killed,['SIGTERM','SIGKILL']);cleanup();assert.equal(f.jobs.size,0);
});

test('the owned server disconnects IPC even when shutdown fails, without accepting messages in ordinary web mode',async()=>{
 const hostProcess=new EventEmitter();Object.assign(hostProcess,{env:{ARKHEN_P2P_LAUNCHER:'1'},send(){},connected:true,disconnect(){this.connected=false;}});let calls=0,errors=0;
 wireP2PServerShutdown({shutdown:async()=>{calls++;throw new Error('Synthetic cleanup failure');}},{hostProcess,onError:()=>{errors++;hostProcess.exitCode=1;}});
 hostProcess.emit('message',{type:'unknown'});assert.equal(calls,0);hostProcess.emit('message',{type:P2P_SHUTDOWN_MESSAGE});await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);assert.equal(errors,1);assert.equal(hostProcess.connected,false);assert.equal(hostProcess.exitCode,1);
 const ordinary=new EventEmitter();Object.assign(ordinary,{env:{},connected:true,send(){},disconnect:()=>assert.fail('Ordinary server has no owned launcher channel.')});wireP2PServerShutdown({shutdown:async()=>assert.fail('No launcher message may stop the ordinary server.')},{hostProcess:ordinary});ordinary.emit('message',{type:P2P_SHUTDOWN_MESSAGE});assert.equal(ordinary.listenerCount('message'),0);
});

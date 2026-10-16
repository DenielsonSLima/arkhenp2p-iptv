import test from 'node:test';
import assert from 'node:assert/strict';
import {HeroRotation} from '../web/inicio/bannerprincipal/rotacao.js';

test('default browser timers keep the global receiver required by Safari',t=>{
  const schedule=globalThis.setTimeout,cancel=globalThis.clearTimeout,calls=[];
  t.after(()=>{globalThis.setTimeout=schedule;globalThis.clearTimeout=cancel;});
  globalThis.setTimeout=function(_callback,delay){assert.equal(this,globalThis);calls.push(delay);return 7;};
  globalThis.clearTimeout=function(timer){assert.equal(this,globalThis);calls.push(timer);};
  const items=[{kind:'movie',id:'1'},{kind:'series',id:'2'}];
  const rotation=new HeroRotation({getItems:()=>items,getCurrent:()=>items[0],select:()=>{}});
  rotation.start();rotation.stop();assert.deepEqual(calls,[5000,7]);
});

const titles=()=>Array.from({length:6},(_,index)=>({id:String(index+1),kind:index%2?'series':'movie'}));
function clock() {
  let now=0,serial=0;const pending=new Map();
  return {
    pending,setTimer:(fn,delay)=>{const id=++serial;pending.set(id,{fn,time:now+delay,delay});return id;},clearTimer:id=>pending.delete(id),
    advance(ms){
      const end=now+ms;
      for (;;) {
        const next=[...pending].filter(([,job])=>job.time<=end).sort((first,second)=>first[1].time-second[1].time)[0];
        if(!next)break;
        pending.delete(next[0]);now=next[1].time;next[1].fn();
      }
      now=end;
    }
  };
}
function fixture() {
  const time=clock(),selected=[];let items=titles(),current=items[0],visible=true;
  const rotation=new HeroRotation({getItems:()=>items,getCurrent:()=>current,select:item=>{selected.push(item);current=item;},isVisible:()=>visible,setTimer:time.setTimer,clearTimer:time.clearTimer});
  return {time,selected,rotation,setItems:value=>{items=value;},setCurrent:value=>{current=value;},setVisible:value=>{visible=value;}};
}

test('all six highlights rotate every five seconds and wrap back to the first title',()=>{
  const f=fixture();f.rotation.start();
  assert.equal([...f.time.pending.values()][0].delay,5000);
  f.time.advance(4999);assert.equal(f.selected.length,0);
  f.time.advance(1);assert.equal(f.selected[0].id,'2');
  f.time.advance(25000);assert.deepEqual(f.selected.map(item=>item.id),['2','3','4','5','6','1']);
});

test('frequent catalog renders and repeated starts keep one timer without postponing the next highlight',()=>{
  const f=fixture();f.rotation.start();
  for(let elapsed=0;elapsed<4800;elapsed+=160){f.time.advance(160);f.rotation.sync();f.rotation.start();assert.equal(f.time.pending.size,1);}
  assert.equal(f.selected.length,0);f.time.advance(200);assert.equal(f.selected[0].id,'2');
});

test('manual selection restarts a full five-second reading interval',()=>{
  const f=fixture();f.rotation.start();f.time.advance(4000);f.setCurrent(titles()[3]);f.rotation.restart();
  f.time.advance(4999);assert.equal(f.selected.length,0);
  f.time.advance(1);assert.equal(f.selected[0].id,'5');
});

test('hover or focus pause and visibility changes stop rotation until a fresh visible interval',()=>{
  const f=fixture();f.rotation.start();f.time.advance(1000);f.rotation.setPaused(true);
  assert.equal(f.time.pending.size,0);f.time.advance(20000);assert.equal(f.selected.length,0);
  f.rotation.setPaused(false);f.time.advance(4999);assert.equal(f.selected.length,0);
  f.time.advance(1);assert.equal(f.selected[0].id,'2');
  f.setVisible(false);f.rotation.sync();assert.equal(f.time.pending.size,0);f.time.advance(20000);
  f.setVisible(true);f.rotation.sync();f.time.advance(5000);assert.equal(f.selected.at(-1).id,'3');
});

test('timer callbacks recheck visibility and ignore queued work after stop',()=>{
  const f=fixture();f.rotation.start();const stale=[...f.time.pending.values()][0].fn;
  f.rotation.stop();stale();assert.equal(f.selected.length,0);assert.equal(f.time.pending.size,0);
  f.rotation.start();f.setVisible(false);f.time.advance(5000);
  assert.equal(f.selected.length,0);assert.equal(f.time.pending.size,0);
});

test('new catalog snapshots use the current title identity, and empty or single-item lists never create a timer',()=>{
  const f=fixture();f.rotation.start();f.time.advance(4000);
  f.setItems([{id:'9',kind:'movie'},titles()[0],{id:'7',kind:'series'}]);f.rotation.sync();f.time.advance(1000);
  assert.equal(f.selected[0].id,'7');
  f.setItems([{id:'20',kind:'movie'},{id:'21',kind:'series'}]);f.rotation.sync();f.time.advance(5000);
  assert.equal(f.selected.at(-1).id,'20');
  f.setItems([{id:'20',kind:'movie'}]);f.rotation.sync();assert.equal(f.time.pending.size,0);
  f.setItems([]);f.rotation.sync();assert.equal(f.time.pending.size,0);
  f.setItems(titles());f.rotation.sync();assert.equal(f.time.pending.size,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {liveLoadPolicies} from '../web/tv/buffer.js';

const hlsSource=readFileSync(new URL('../web/assets/vendor/hls.min.js',import.meta.url),'utf8');

// Exercise the shipped XHR loader with delayed headers/body, without HTTP or
// media. A virtual clock also proves terminal deadlines and cancellation.
function fixture(policy=liveLoadPolicies().playlistLoadPolicy.default){
  let now=1000,serial=0;const timers=new Map(),requests=[],events=[];
  const setTimeout=(callback,delay)=>{const id=++serial;timers.set(id,{callback,at:now+delay});return id;};
  const clearTimeout=id=>timers.delete(id);
  const tick=duration=>{
    const end=now+duration;
    for(;;){const next=[...timers].filter(([,value])=>value.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;
      timers.delete(next[0]);now=next[1].at;next[1].callback();}
    now=end;
  };
  class XHR{
    constructor(){this.readyState=0;this.status=0;this.aborted=false;requests.push(this);}
    open(){this.readyState=1;}
    send(){}
    abort(){this.aborted=true;}
    setRequestHeader(){}
    headers(){this.status=200;this.readyState=2;this.onreadystatechange?.();}
    complete(){this.responseText='#EXTM3U\n#EXTINF:2,\nsegment.ts\n';this.readyState=4;this.onreadystatechange?.();}
  }
  const sandbox={self:null,console,status:'',XMLHttpRequest:XHR,performance:{now:()=>now},setTimeout,clearTimeout};
  sandbox.self=sandbox;vm.createContext(sandbox);vm.runInContext(hlsSource,sandbox);
  const loader=new sandbox.Hls.DefaultConfig.loader({});
  loader.load({url:'https://fixture.invalid/live.m3u8',responseType:'text'},
    {loadPolicy:policy,timeout:policy.maxLoadTimeMs},{
      onSuccess:()=>events.push('success'),onTimeout:()=>events.push('timeout'),onError:()=>events.push('error')
    });
  return {loader,requests,events,tick};
}

test('TV playlist tolerates seven-second response headers without aborting a valid request',()=>{
  const f=fixture();f.tick(7000);
  assert.equal(f.requests.length,1,'A valid slow response must not have been replaced by a retry.');
  assert.equal(f.requests[0].aborted,false);
  f.requests[0].headers();f.tick(500);f.requests[0].complete();
  assert.deepEqual(f.events,['success']);assert.equal(f.loader.stats.retry,0);f.loader.destroy();
});

test('TV playlist still terminates after one retry when no response headers arrive',()=>{
  const f=fixture();f.tick(10000);assert.equal(f.requests[0].aborted,true);
  f.tick(500);assert.equal(f.requests.length,2);f.tick(10000);
  assert.deepEqual(f.events,['timeout']);assert.equal(f.loader.stats.retry,1);
  assert.equal(f.requests[1].aborted,true);f.tick(60000);assert.equal(f.requests.length,2);f.loader.destroy();
});

test('TV playlist body deadline includes time already spent waiting for headers',()=>{
  const f=fixture();f.tick(7000);f.requests[0].headers();f.tick(7999);
  assert.equal(f.requests[0].aborted,false);f.tick(1);
  assert.equal(f.requests[0].aborted,true,'Headers must not restart the fifteen-second total deadline.');
  f.tick(500);assert.equal(f.requests.length,2);f.tick(10000);
  assert.deepEqual(f.events,['timeout']);f.loader.destroy();
});

test('retiring a TV playlist cancels both its deadline and a scheduled retry',()=>{
  for(const before of [7000,10000]){
    const f=fixture();f.tick(before);f.loader.destroy();f.tick(60000);
    assert.equal(f.requests.length,1);assert.equal(f.requests[0].aborted,true);assert.deepEqual(f.events,[]);
  }
});

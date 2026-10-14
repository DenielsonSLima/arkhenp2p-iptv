import test from 'node:test';
import assert from 'node:assert/strict';
import { preloadArtwork } from '../web/session-loader.js';

test('opening artwork preloader deduplicates private image refs and limits concurrent work',async()=>{
  let active=0,peak=0;const requested=[];
  const createImage=()=>({decode:async()=>{},set src(value){requested.push(value);active++;peak=Math.max(peak,active);setImmediate(()=>{active--;value.includes('fail')?this.onerror?.():this.onload?.();});}});
  const result=await preloadArtwork(['/api/image?ref=a','/api/image?ref=a','https://external.example/art','/api/image?ref=b','/api/image?ref=fail'],{createImage,concurrency:2});
  assert.deepEqual(requested,['/api/image?ref=a','/api/image?ref=b','/api/image?ref=fail']);assert.equal(peak,2);assert.deepEqual(result,{completed:3,loaded:2,total:3});
});
test('cancelled preparation stops queued images, and missing covers do not hold the application open',async()=>{
  const controller=new AbortController();let requests=0;
  const createImage=()=>({set src(value){requests++;},removeAttribute(){}});
  const pending=preloadArtwork(['/api/image?ref=a','/api/image?ref=b','/api/image?ref=c'],{createImage,concurrency:1,signal:controller.signal});controller.abort();
  assert.deepEqual(await pending,{completed:1,loaded:0,total:3});assert.equal(requests,1);
  assert.deepEqual(await preloadArtwork(['/api/image?ref=a'],{createImage,timeoutMs:5}),{completed:1,loaded:0,total:1});
});

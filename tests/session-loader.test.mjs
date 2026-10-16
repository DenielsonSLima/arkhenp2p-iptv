import test from 'node:test';
import assert from 'node:assert/strict';
import {openingArtwork,preloadArtwork} from '../web/login/capas.js';

test('opening selection fairly warms thirty real covers per type after the hero',()=>{
  const items=(kind,count)=>Array.from({length:count},(_,id)=>({id,kind,poster:`/api/image?ref=${kind}-${id}`}));
  const movies=items('movie',35),series=items('series',34),live=items('live',32);
  live[0]={...live[0],poster:'https://external.example/logo',logo:'/api/image?ref=live-0'};
  const shelves=[{items:movies.slice(0,10)},{items:movies},{items:series},{items:live},{items:[{kind:'series',poster:'https://external.example/cover'}]}];
  const urls=openingArtwork({hero:['/api/image?ref=hero','/api/image?ref=hero'],shelves,resolveArtwork:item=>item.logo||item.poster});
  assert.equal(urls.length,91);assert.equal(new Set(urls).size,91);
  assert.deepEqual(urls.slice(0,7),['/api/image?ref=hero','/api/image?ref=movie-0','/api/image?ref=series-0','/api/image?ref=live-0','/api/image?ref=movie-1','/api/image?ref=series-1','/api/image?ref=live-1']);
  for(const kind of ['movie','series','live'])assert.equal(urls.filter(url=>url.includes(`ref=${kind}-`)).length,30);
  assert.ok(!urls.includes('/api/image?ref=movie-30'));
  assert.deepEqual(openingArtwork({shelves:[{items:[movies[0],movies[0]]}],perType:30}),[movies[0].poster]);
  assert.deepEqual(openingArtwork({hero:['/api/image?ref=hero'],shelves,perType:0}),['/api/image?ref=hero']);
});

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

test('opening preparation supports ninety-six images and an explicit smaller cap',async()=>{
  const urls=Array.from({length:105},(_,index)=>`/api/image?ref=cover-${index}`),requested=[];
  const createImage=()=>({set src(value){requested.push(value);setImmediate(()=>this.onload?.());}});
  assert.deepEqual(await preloadArtwork(urls,{createImage}),{completed:96,loaded:96,total:96});
  assert.equal(requested.length,96);
  requested.length=0;
  assert.deepEqual(await preloadArtwork(urls,{createImage,maxItems:3}),{completed:3,loaded:3,total:3});
  assert.equal(requested.length,3);
});

test('a preparation deadline cancels in-flight covers and leaves the remaining queue untouched',async()=>{
  let requests=0,cancelled=0;
  const createImage=()=>({set src(value){requests++;},removeAttribute(){cancelled++;}});
  const urls=Array.from({length:90},(_,index)=>`/api/image?ref=cover-${index}`);
  assert.deepEqual(await preloadArtwork(urls,{createImage,concurrency:4,timeoutMs:1000,deadlineMs:5}),{completed:4,loaded:0,total:90});
  assert.equal(requests,4);assert.equal(cancelled,4);
});

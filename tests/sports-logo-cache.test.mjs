import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {SportsLogoCache,sportsLogoContentType} from '../lib/sports-logo-cache.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBqkAAAAASUVORK5CYII=','base64');
const response=(bytes=png,contentType='image/png',status=200)=>({status,headers:{'content-type':contentType,'content-length':String(bytes.length)},body:Readable.from([bytes])});
const scope='https://auth.example/api/v2/auth';
const ref=route=>route.split('/').at(-1);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,options={}){
  const directory=await mkdtemp(join(tmpdir(),'arkhen-sports-logos-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  return {directory,cache:new SportsLogoCache({directory,...options})};
}

test('provider logos download once per shared identity, persist without addresses or tokens, and survive a cold process',async t=>{
  const calls=[],{directory,cache}=await fixture(t,{request:async(url,options)=>{calls.push({url,options});return response();}});
  const first=cache.queue('https://images.example/team.png?t=private-one',{scope,headers:{'User-Agent':'provider'}});
  const second=cache.queue('https://images.example/team.png?t=private-two',{scope});assert.equal(first,second);assert.match(first,/^\/api\/sports-image\/[a-f0-9]{64}$/);
  const logo=await cache.read(ref(first));assert.deepEqual(logo.bytes,png);assert.equal(logo.contentType,'image/png');await cache.idle();assert.equal(calls.length,1);
  const metadata=await readFile(join(directory,ref(first)+'.json'),'utf8');assert.doesNotMatch(metadata,/private|https:|User-Agent|token/);
  const files=await readdir(join(directory,'content'));assert.equal(files.length,1);assert.match(files[0],/^[a-f0-9]{64}$/);
  const cold=new SportsLogoCache({directory,request:()=>assert.fail('A cached logo cannot require provider or network access.')});
  assert.deepEqual((await cold.read(ref(first))).bytes,png);assert.equal(cold.queue('https://images.example/team.png?t=renewed',{scope}),first);await cold.idle();
});

test('source identities separate provider origins and preserve noncredential query IDs',async t=>{
  const {cache}=await fixture(t,{request:async()=>response()});
  const first=cache.queue('https://images.example/logo?id=1&t=private',{scope});
  assert.notEqual(first,cache.queue('https://images.example/logo?id=2&t=private',{scope}));
  assert.notEqual(first,cache.queue('https://images.example/logo?id=1&t=private',{scope:'https://other-provider.example'}));await cache.idle();
});

test('download concurrency is bounded and matching content is stored once',async t=>{
  let active=0,peak=0,release;const gate=new Promise(resolve=>{release=resolve;});
  const {directory,cache}=await fixture(t,{concurrency:2,request:async()=>{active++;peak=Math.max(peak,active);await gate;active--;return response();}});
  const routes=Array.from({length:8},(_,index)=>cache.queue(`https://images.example/team-${index}.png`,{scope}));
  for(let tries=0;tries<20&&active<2;tries++)await tick();assert.equal(active,2);release();await cache.idle();assert.equal(peak,2);
  assert.equal((await readdir(join(directory,'content'))).length,1);for(const route of routes)assert.deepEqual((await cache.read(ref(route))).bytes,png);
});

test('untrusted formats, MIME mismatches and oversized files cannot become cached logos',async t=>{
  const {cache}=await fixture(t,{maxBytes:128,request:async url=>{
    if(url.includes('html'))return response(Buffer.from('<html>not an image</html>'),'image/png');
    if(url.includes('wrong-mime'))return response(png,'image/jpeg');
    if(url.includes('svg'))return response(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),'image/svg+xml');
    return response(Buffer.alloc(129),'image/png');
  }});
  for(const name of ['html','wrong-mime','svg','large']){const route=cache.queue(`https://images.example/${name}`,{scope});assert.equal(await cache.read(ref(route)),null);}
  assert.equal(await cache.read('../../private'),null);assert.equal(cache.queue('http://127.0.0.1/private',{scope}),'');assert.equal(cache.queue('file:///etc/passwd',{scope}),'');assert.equal(cache.queue('https://user:private@images.example/logo.png',{scope}),'');
});

test('a failed logo has a cooldown and no rejected request escapes the background queue',async t=>{
  let calls=0;const {cache}=await fixture(t,{request:async()=>{calls++;throw new Error('private provider detail');}});
  const route=cache.queue('https://images.example/team.png',{scope});assert.equal(await cache.read(ref(route)),null);await cache.idle();
  assert.equal(cache.queue('https://images.example/team.png',{scope}),route);await cache.idle();assert.equal(calls,1);
  assert.equal(sportsLogoContentType(Buffer.from('<svg>')) ,null);
});

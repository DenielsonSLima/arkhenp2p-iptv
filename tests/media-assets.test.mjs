import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaAssets } from '../lib/media-assets.mjs';
import { ProviderClient } from '../lib/provider.mjs';
import {RuntimeSessionStore} from '../lib/runtime-session-store.mjs';
import {runtimeSessionContext} from '../lib/runtime-session-context.mjs';

const base = 'https://provider.invalid/live/private/index.m3u8';
const makeClient = () => new ProviderClient({ server: 'https://provider.invalid', username: 'fixture-user', password: 'fixture-password' });
const playlist = (sequence, segments) => ['#EXTM3U', '#EXT-X-TARGETDURATION:1',
  '#EXT-X-MEDIA-SEQUENCE:' + sequence, ...segments.flatMap(id => ['#EXTINF:1,', `hls-seg-${id}.ts`]), ''].join('\n');
const segments = value => value.split('\n').filter(line => line && !line.startsWith('#'));

test('live playlist reloads retain each overlapping segment URI and do not grow the registry', () => {
  const client = makeClient(); client.beginPlayback('live:12');
  const first = segments(client.rewriteManifest(playlist(40, [40, 41, 42]), base, 'live:12'));
  const same = segments(client.rewriteManifest(playlist(40, [40, 41, 42]), base, 'live:12'));
  assert.deepEqual(same, first);
  assert.equal(client.assets.size, 3);
  const next = segments(client.rewriteManifest(playlist(41, [41, 42, 43]), base, 'live:12'));
  assert.deepEqual(next.slice(0, 2), first.slice(1));
  assert.equal(client.assets.size, 4);
  assert.doesNotMatch(next.join(''), /provider|private|hls-seg|fixture/);
});

test('segment name reuse at a new sequence or discontinuity does not reuse cached media identity', () => {
  const client = makeClient(); client.beginPlayback('live:12');
  const a = client.rewriteManifest(playlist(40, [1]), base, 'live:12');
  const b = client.rewriteManifest(playlist(41, [1]), base, 'live:12');
  const c = client.rewriteManifest(playlist(40, [1]).replace('#EXTINF', '#EXT-X-DISCONTINUITY\n#EXTINF'), base, 'live:12');
  assert.notEqual(segments(a)[0], segments(b)[0]);
  assert.notEqual(segments(a)[0], segments(c)[0]);
});

test('keys, init sections and variant playlists also have stable private URIs', () => {
  const client = makeClient(); client.beginPlayback('live:12');
  const manifest = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin?secret=fixture"\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nvideo.m3u8\n';
  const a = client.rewriteManifest(manifest, base, 'live:12');
  assert.equal(client.rewriteManifest(manifest, base, 'live:12'), a);
  assert.equal(client.assets.size, 3);
  assert.doesNotMatch(a, /provider|secret|fixture|key.bin|init.mp4|video.m3u8/);
});

test('tokens are isolated by account instance and revoked on stop, channel change or clear', () => {
  const client = makeClient(), other = makeClient();
  client.beginPlayback('live:12'); other.beginPlayback('live:12');
  const create = instance => segments(instance.rewriteManifest(playlist(40, [40]), base, 'live:12'))[0];
  const a = create(client);
  assert.notEqual(create(other), a);
  client.stopPlayback();
  assert.equal(client.assets.get(a.slice('/api/asset/'.length)), undefined);
  client.beginPlayback('live:12'); assert.notEqual(create(client), a);
  const b = create(client); client.beginPlayback('live:13'); client.beginPlayback('live:12');
  assert.notEqual(create(client), b);
  const c = create(client); client.assets.clear(); assert.notEqual(create(client), c);
});

test('registry has a hard bound and keeps recently reloaded assets', () => {
  const assets = new MediaAssets();
  const first = assets.register('https://provider.invalid/0.ts', 'live:1');
  for (let i = 1; i < 3000; i++) assets.register(`https://provider.invalid/${i}.ts`, 'live:1');
  assert.equal(assets.register('https://provider.invalid/0.ts', 'live:1'), first);
  assets.register('https://provider.invalid/3000.ts', 'live:1');
  assert.equal(assets.size, 3000);
  assert.ok(assets.has(first.slice('/api/asset/'.length)));
});

test('an identical playlist keeps its exported descriptors and timestamps stable while preserving LRU touches',t=>{
  t.mock.timers.enable({apis:['Date'],now:1700000000000});
  const client=makeClient();client.beginPlayback('live:12');
  const text=playlist(40,[40,41,42]);client.rewriteManifest(text,base,'live:12');
  const snapshot=structuredClone(client.assets.exportRuntimeState()),first=client.assets.values().next().value;
  t.mock.timers.tick(5000);client.rewriteManifest(text,base,'live:12');
  assert.deepEqual(client.assets.exportRuntimeState(),snapshot);
  assert.equal(client.assets.values().next().value,first);
  const oldest=client.assets.keys().next().value;client.assets.register(first.url,first.key,first.mediaDurationSeconds,first.cacheKey);
  assert.equal([...client.assets.keys()].at(-1),oldest,'stable descriptors still become most recently used');
});

test('URL rotation, duration and cache key changes update an existing opaque descriptor and timestamp',t=>{
  t.mock.timers.enable({apis:['Date'],now:1700000000000});
  const assets=new MediaAssets(),identity='same-web-sequence';let url='https://provider.invalid/a.ts?token=first',duration=1,cacheKey='first';
  const token=assets.register(url,'live:12',duration,cacheKey,identity),id=token.slice('/api/asset/'.length);
  const snapshots=[structuredClone(assets.exportRuntimeState())];
  for(const change of ['url','duration','cacheKey']){
    const previous=assets.get(id);t.mock.timers.tick(1000);
    if(change==='url')url='https://provider.invalid/a.ts?token=rotated';else if(change==='duration')duration=2;else cacheKey='changed';
    assert.equal(assets.register(url,'live:12',duration,cacheKey,identity),token);
    const current=assets.get(id);assert.notEqual(current,previous);assert.equal(current.time,Date.now());
    assert.equal(current.url,url);assert.equal(current.mediaDurationSeconds,duration);assert.equal(current.cacheKey,cacheKey);
    const snapshot=structuredClone(assets.exportRuntimeState());assert.notDeepEqual(snapshot,snapshots.at(-1));snapshots.push(snapshot);
  }
  assert.notEqual(assets.register(url,'live:13',duration,cacheKey,identity),token,'channel ownership remains part of the token');
});

test('unchanged manifest reloads release their writer fence without encrypting or replacing the durable cipher',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1700000000000});
  const row={cipher:null,revision:0,fence:0},commits=[];
  const cloud={runtimeSessionKey:()=>Buffer.alloc(32,12),runtimeSessionRPC:async(operation,args)=>{
    if(operation==='acquire'){row.fence++;return {...row,leaseUntil:new Date(Date.now()+90000).toISOString()};}
    assert.equal(operation,'commit');assert.equal(args.p_fence,row.fence);assert.equal(args.p_revision,row.revision);
    commits.push({cipher:args.p_cipher,release:args.p_release});
    if(args.p_cipher!==null){row.cipher=args.p_cipher;row.revision++;}
    return {ok:true,revision:row.revision,fence:row.fence};
  }};
  const response=()=>({statusCode:200,headersSent:false,destroyed:false,headers:{},
    setHeader(name,value){this.headers[name]=value;},getHeaders(){return this.headers;},getHeaderNames(){return Object.keys(this.headers);},
    removeHeader(name){delete this.headers[name];},writeHead(){return this;},write(){return true;},end(){return this;}});
  const store=new RuntimeSessionStore({cloud});let encryptions=0;
  const seal=store.sealJSON.bind(store);store.sealJSON=(...args)=>{encryptions++;return seal(...args);};
  const options={create:true,createState:makeClient,capture:client=>client.exportRuntimeState(),restore:dto=>makeClient().restoreRuntimeState(dto)};
  const req=()=>({headers:{cookie:'ORBIT_SID='+'A'.repeat(32)},aborted:false});
  const run=async text=>store.run(req(),response(),options,async client=>{
    client.beginPlayback('live:12');await runtimeSessionContext().checkpoint();
    client.rewriteManifest(text,base,'live:12');await runtimeSessionContext().beforeStreaming();
  });
  await run(playlist(40,[40,41,42]));const initialCipher=row.cipher;
  assert.equal(typeof initialCipher,'string');const initialEncryptions=encryptions;
  commits.length=0;t.mock.timers.tick(5000);await run(playlist(40,[40,41,42]));
  assert.equal(encryptions,initialEncryptions,'identical descriptors require no additional gzip/AES');
  assert.equal(row.cipher,initialCipher);assert.deepEqual(commits,[{cipher:null,release:true}]);
  commits.length=0;t.mock.timers.tick(5000);await run(playlist(41,[41,42,43]));
  assert.equal(encryptions,initialEncryptions+1);assert.notEqual(row.cipher,initialCipher);
  assert.equal(commits.length,1);assert.equal(typeof commits[0].cipher,'string');assert.equal(commits[0].release,true);
});

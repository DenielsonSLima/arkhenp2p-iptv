import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createApp} from '../lib/app-server.mjs';
import {ProviderClient} from '../lib/provider.mjs';
import {WplayPlaybackProviderClient} from '../lib/wplay/conexao/reproducao.mjs';
import {WplayOTTProviderClient} from '../lib/wplay/ott/provedor.mjs';
import {WebLiveSegmentIdentity} from '../lib/tv/web-segment-identity.mjs';

const urls=value=>value.split('\n').filter(line=>line&&!line.startsWith('#'));
const manifest=(segments,{sequence=10,disc=0,tags=''}={})=>`#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXT-X-DISCONTINUITY-SEQUENCE:${disc}\n${tags}`+
  segments.map(([uri,duration=1])=>`#EXTINF:${duration},\n${uri}\n`).join('');
const body=(token='a',options)=>manifest([[`segment.ts?token=${token}&format=ts`]],options);
const entry=client=>client.assets.get(urls(client.output)[0].slice('/api/asset/'.length));
async function webFixture(t){
  let ott;
  const client=new WplayPlaybackProviderClient({username:'fixture',password:'synthetic'},{webPlayback:true,webPlaybackFactory:config=>{
    ott=new WplayOTTProviderClient(config);ott.session={connected:true,account:{status:'Active'}};
    ott.rawCatalog=async()=>({rows:[{title:'TV',kind:'Canal',items:[{id:'fixture-web',title:'Record TV BA',kind:'Canal',
      liveVariants:[{quality:'FHD',playbackUrl:'https://media.example/live/index.m3u8?token=entry'}]}]}]});
    ott.queueRemoteStop=async()=>{ott.liveSource=null;ott.liveStopTarget=null;};
    ott.rpc.call=async()=>({success:true});return ott;
  }});
  client.item=async(_type,id)=>({id:String(id),kind:'live',name:'Record TV BA',categoryId:'1'});
  client.rawItems.set('live:446',{sources:[{address:'tvbus://synthetic'}]});
  const prepare=async({attempt='one',sourceId}={})=>{
    if(ott)ott.lastLiveGenerationStartedAt=null;
    const source=await client.playbackURL('live','446',null,{attempt,sourceId});client.beginPlayback('live:446');return source.href;
  };
  const base=await prepare();t.after(()=>client.logout());
  return{client,base,prepare,rewrite(text,playlist=base,key='live:446'){
    client.output=client.rewriteManifest(text,playlist,key);return urls(client.output);
  }};
}

test('web-OTT token rotation preserves overlapping local segment URIs and refreshes the full authorized target',async t=>{
  const f=await webFixture(t),first=f.rewrite(body('private-a'))[0],old=entry(f.client);
  const second=f.rewrite(body('private-b'))[0],current=entry(f.client);
  assert.equal(second,first);assert.equal(f.client.assets.size,1);
  assert.match(current.url,/token=private-b&format=ts$/);assert.notEqual(current.cacheKey,old.cacheKey);
  assert.equal(current.mediaDurationSeconds,1);assert.doesNotMatch(second,/private|media\.example|token/);
  f.client.cacheSegment(old.cacheKey,'live:446',Buffer.from('old-body'),'video/mp2t');
  assert.equal(f.client.cachedSegment(current.cacheKey,'live:446'),null);
});

test('only token is excluded: semantic query bytes, order, path, origin, sequence and discontinuity retain distinct identities',async t=>{
  const f=await webFixture(t),initial=f.rewrite(body('a'))[0];
  assert.equal(f.rewrite(body('b'))[0],initial);
  for(const text of [
    manifest([['segment.ts?token=c&format=other']]),manifest([['segment.ts?format=ts&token=c&flag=1']]),
    manifest([['segment.ts?token=c&format=%74s']]),manifest([['other.ts?token=c&format=ts']]),
    manifest([['https://other.example/live/segment.ts?token=c&format=ts']]),body('c',{sequence:11}),body('c',{disc:1}),
  ])assert.notEqual(f.rewrite(text)[0],initial);
  const ordered=f.rewrite(manifest([['segment.ts?token=x&format=ts&lang=pt']]))[0];
  assert.notEqual(f.rewrite(manifest([['segment.ts?lang=pt&token=y&format=ts']]))[0],ordered);
});

test('a duration change in an overlapping segment resets the complete playlist identity epoch',async t=>{
  const f=await webFixture(t),first=f.rewrite(manifest([['one.ts?token=a',1],['two.ts?token=a',1]]));
  const changed=f.rewrite(manifest([['one.ts?token=a',2],['two.ts?token=a',1]]));
  assert.notEqual(changed[0],first[0]);assert.notEqual(changed[1],first[1]);
});

test('media and discontinuity sequence regressions cannot revive a previously registered segment URI',async t=>{
  for(const kind of ['media','discontinuity']){
    const f=await webFixture(t),first=f.rewrite(body('a',{sequence:10,disc:1}))[0];
    f.rewrite(body('a',{sequence:kind==='media'?11:10,disc:kind==='discontinuity'?2:1}));
    assert.notEqual(f.rewrite(body('a',{sequence:10,disc:1}))[0],first);
  }
});

test('exact playlist URL, source attempt, stop and account define separate private namespaces',async t=>{
  const f=await webFixture(t),first=f.rewrite(body('a'))[0];assert.equal(f.rewrite(body('b'))[0],first);
  const otherBase=f.client.mediaURL(f.base+'&playlist=other');assert.notEqual(f.rewrite(body('b'),otherBase)[0],first);
  const secondBase=await f.prepare({attempt:'two'}),second=f.rewrite(body('a'),secondBase)[0];assert.notEqual(second,first);
  f.client.stopPlayback();const thirdBase=await f.prepare({attempt:'three'});assert.notEqual(f.rewrite(body('a'),thirdBase)[0],second);
  const other=await webFixture(t);assert.notEqual(other.rewrite(body('a'))[0],first);
});

test('KEY, MAP, byte ranges, variables and LL-HLS keep ordinary full-URL identities',async t=>{
  for(const tags of ['#EXT-X-KEY:METHOD=NONE\n','#EXT-X-MAP:URI="init.mp4"\n','#EXT-X-BYTERANGE:10@0\n',
    '#EXT-X-DEFINE:NAME="v",VALUE="private"\n','#EXT-X-PART-INF:PART-TARGET=0.5\n','#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES\n',
    '#EXT-X-SKIP:SKIPPED-SEGMENTS=1\n','#EXT-X-RENDITION-REPORT:URI="other.m3u8"\n']){
    const f=await webFixture(t),first=f.rewrite(body('a',{tags}))[0];assert.notEqual(f.rewrite(body('b',{tags}))[0],first);
  }
});

test('returning from an unsupported contract starts a new epoch instead of reviving the old token',async t=>{
  for(const tags of ['#EXT-X-KEY:METHOD=NONE\n','#EXT-X-MAP:URI="init.mp4"\n','#EXT-X-BYTERANGE:10@0\n',
    '#EXT-X-DEFINE:NAME="v",VALUE="private"\n','#EXT-X-PART-INF:PART-TARGET=0.5\n']){
    const f=await webFixture(t),first=f.rewrite(body('a'))[0];f.rewrite(body('a',{tags}));
    assert.notEqual(f.rewrite(body('a'))[0],first);
  }
});

test('expired owner callbacks cannot register identities after a selection, reset or playlist eviction',()=>{
  const model=new WebLiveSegmentIdentity(),owner={},next={},base='https://media.example/live/index.m3u8',text=body('a');
  const first=model.manifest({text,base,owner}),source='https://media.example/live/segment.ts?token=a&format=ts',id=first(source,10,0,1);
  assert.ok(id);const second=model.manifest({text,base,owner:next});assert.equal(first(source,10,0,1),null);assert.notEqual(second(source,10,0,1),id);
  model.reset();assert.equal(second(source,10,0,1),null);
  const current=model.manifest({text,base,owner}),before=current(source,10,0,1);
  for(let i=0;i<8;i++)model.manifest({text,base:base+'?playlist='+i,owner});
  assert.equal(current(source,10,0,1),null);assert.notEqual(model.manifest({text,base,owner})(source,10,0,1),before);
});

test('oversized, incomplete or ambiguous media windows remain conservative and invalidate prior epochs',async t=>{
  const f=await webFixture(t),first=f.rewrite(body('a'))[0];
  const oversized=manifest(Array.from({length:257},(_,i)=>[`segment-${i}.ts?token=a`]));
  f.rewrite(oversized);assert.notEqual(f.rewrite(body('a'))[0],first);
  const model=new WebLiveSegmentIdentity(),owner={},base=f.base;
  for(const text of ['#EXTM3U\n#EXTINF:1,\nsegment.ts?token=a\n',body('a')+'#EXTINF:1,\n',
    body('a').replace('#EXTINF:1,','#EXTINF:NaN,'),body('a').replace('#EXT-X-MEDIA-SEQUENCE:10','#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-MEDIA-SEQUENCE:10'),
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nvariant.m3u8?token=a\n'])assert.equal(model.manifest({text,base,owner}),null);
});

test('token must be single, nonempty and literally named token before identity stabilization',async t=>{
  for(const [a,b]of [['token=a&token=b','token=c&token=d'],['token=&x=a','token=&x=b'],['Token=a','Token=b'],
    ['to%6ben=a','to%6ben=b'],['auth=a','auth=b'],['x=a','x=b']]){
    const f=await webFixture(t),first=f.rewrite(manifest([['segment.ts?'+a]]))[0];assert.notEqual(f.rewrite(manifest([['segment.ts?'+b]]))[0],first);
  }
});

test('generic providers, direct OTT and native HTTP do not opt into web-OTT segment identity',async t=>{
  const clients=[new ProviderClient({server:'https://fixture.example',username:'fixture',password:'synthetic'}),
    new WplayOTTProviderClient({username:'fixture',password:'synthetic'}),
    new WplayPlaybackProviderClient({username:'fixture',password:'synthetic'})];
  for(const client of clients){
    client.beginPlayback('live:446');const a=urls(client.rewriteManifest(body('a'),'https://media.example/live/index.m3u8','live:446'))[0];
    assert.notEqual(urls(client.rewriteManifest(body('b'),'https://media.example/live/index.m3u8','live:446'))[0],a);client.stopPlayback();
  }
  const f=await webFixture(t);for(const key of ['movie:1','series:1']){
    f.client.beginPlayback(key);assert.notEqual(f.rewrite(body('a'),f.base,key)[0],f.rewrite(body('b'),f.base,key)[0]);
  }
  const native=new WplayPlaybackProviderClient({username:'fixture',password:'synthetic'},
    {webPlayback:true,webPlaybackFactory:()=>{throw new Error('Native HTTP must not initialize OTT');}});
  native.item=async()=>({id:'446',kind:'live',name:'Record TV BA'});native.rawItems.set('live:446',{sources:[{address:'https://media.example/native.m3u8'}]});
  try{
    const base=await native.playbackURL('live','446',null,{attempt:'native'});native.beginPlayback('live:446');
    const first=urls(native.rewriteManifest(body('a'),base,'live:446'))[0];assert.notEqual(urls(native.rewriteManifest(body('b'),base,'live:446'))[0],first);
  }finally{await native.logout();}
});

test('a URI returned before rotation requests the latest complete upstream address through the existing asset endpoint',async t=>{
  const f=await webFixture(t),requests=[];let polls=0;
  f.client.connect=async()=>f.client.session||={connected:true,account:{status:'Active'}};
  f.client.catalog=async()=>({categories:[{id:'1',name:'TV'}],items:[{id:'446',kind:'live',name:'Record TV BA',categoryId:'1'}]});
  f.client.upstreamRequest=async value=>{
    requests.push(String(value));const playlist=new URL(value).pathname.endsWith('.m3u8');
    return{status:200,url:String(value),headers:{'content-type':playlist?'application/vnd.apple.mpegurl':'video/mp2t'},
      body:Readable.from([Buffer.from(playlist?body(++polls===1?'old-private':'new-private'):'synthetic-segment')])};
  };
  const events=[],app=createApp({connection:{server:'https://fixture.example'},providerFactory:()=>f.client,
    sharedWorker:{stop(){},unregisterSource(){}},onPlaybackTransport:event=>events.push(event)});
  await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{app.closeAllConnections();await app.shutdown();});const base='http://127.0.0.1:'+app.address().port;
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'fixture',password:'synthetic'})});
  assert.equal(login.status,200);await login.json();const headers={Cookie:login.headers.get('set-cookie').split(';')[0]},path='/api/play/live/446/index.m3u8?attempt=one';
  const first=await fetch(base+path,{headers});assert.equal(first.status,200,await first.clone().text());const initial=urls(await first.text())[0];
  const second=await fetch(base+path,{headers});assert.equal(second.status,200);assert.equal(urls(await second.text())[0],initial);
  const segment=await fetch(base+initial,{headers});assert.equal(segment.status,200);assert.equal(await segment.text(),'synthetic-segment');
  assert.equal(requests.length,3);assert.match(requests.at(-1),/token=new-private&format=ts$/);
  assert.doesNotMatch(initial,/private|token|media\.example/);assert.doesNotMatch(JSON.stringify(events),/old-private|new-private|token=|media\.example/);
});

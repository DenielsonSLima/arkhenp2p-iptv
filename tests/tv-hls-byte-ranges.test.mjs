import test from 'node:test';
import assert from 'node:assert/strict';
import {ProviderClient} from '../lib/provider.mjs';

const client=()=>new ProviderClient({server:'https://fixture.example',username:'fixture',password:'fixture'});
function rewrite(lines,key='live:42'){
  return client().rewriteManifest(['#EXTM3U','#EXT-X-MEDIA-SEQUENCE:10',...lines].join('\n'),'https://fixture.example/live/index.m3u8',key);
}
// Independent HLS consumer: an implicit range may only continue the previous
// byte-range segment of the SAME resource (RFC 8216 section 4.3.2.2).
function ranges(manifest){
  let pending=null,previous=null;const result=[];
  for(const line of manifest.split('\n')){
    if(line.startsWith('#EXT-X-BYTERANGE:'))pending=line.slice(17).split('@').map(BigInt);
    else if(line&&!line.startsWith('#')){
      if(!pending){previous=null;continue;}
      const [length,offset]=pending;
      assert.ok(offset!==undefined||previous?.uri===line,'implicit byte-range changed resource URI');
      const start=offset??previous.end;result.push([start,start+length-1n]);previous={uri:line,end:start+length};pending=null;
    }
  }
  return result;
}
test('live rewrite preserves implicit ranges despite opaque per-segment URLs',()=>{
  const body=rewrite(['#EXTINF:4,','#EXT-X-BYTERANGE:100@20','stream.mp4','#EXTINF:4,','#EXT-X-BYTERANGE:80','stream.mp4','#EXTINF:3,','#EXT-X-BYTERANGE:50','./stream.mp4']);
  assert.deepEqual(ranges(body),[[20n,119n],[120n,199n],[200n,249n]]);
  assert.doesNotMatch(body,/fixture\.example|stream\.mp4/);
});
test('live ranges keep explicit offsets and do not borrow across another resource or full segment',()=>{
  const body=rewrite(['#EXTINF:4,','#EXT-X-BYTERANGE:100@20','stream.mp4','#EXTINF:4,','#EXT-X-BYTERANGE:80@1000','other.mp4','#EXTINF:3,','#EXT-X-BYTERANGE:50','other.mp4']);
  assert.deepEqual(ranges(body),[[20n,119n],[1000n,1079n],[1080n,1129n]]);
  for(const lines of [
    ['#EXTINF:4,','#EXT-X-BYTERANGE:100@20','stream.mp4','#EXTINF:4,','#EXT-X-BYTERANGE:80','other.mp4'],
    ['#EXTINF:4,','#EXT-X-BYTERANGE:100@20','stream.mp4','#EXTINF:4,','stream.mp4','#EXTINF:4,','#EXT-X-BYTERANGE:80','stream.mp4'],
  ])assert.throws(()=>ranges(rewrite(lines)),/implicit byte-range changed resource URI/);
});
test('live offsets retain integer precision and ordinary TS playlists are unchanged',()=>{
  const body=rewrite(['#EXTINF:4,','#EXT-X-BYTERANGE:100@9007199254740993','stream.mp4','#EXTINF:4,','#EXT-X-BYTERANGE:80','stream.mp4']);
  assert.deepEqual(ranges(body),[[9007199254740993n,9007199254741092n],[9007199254741093n,9007199254741172n]]);
  assert.doesNotMatch(rewrite(['#EXTINF:4,','segment.ts']),/BYTERANGE/);
});
test('live normalization never synthesizes offsets outside uint64 or carries a malformed range forward',()=>{
  for(const invalid of ['2@18446744073709551615','1@18446744073709551616','18446744073709551616@0','-1@0','0@0','2@x']){
    const body=rewrite([`#EXT-X-BYTERANGE:${invalid}`,'stream.mp4','#EXT-X-BYTERANGE:1','stream.mp4']);
    assert.match(body,/#EXT-X-BYTERANGE:1\n/,'An invalid predecessor cannot supply a synthesized continuation.');
  }
  const limit=rewrite(['#EXT-X-BYTERANGE:1@18446744073709551614','stream.mp4','#EXT-X-BYTERANGE:1','stream.mp4','#EXT-X-BYTERANGE:1','stream.mp4']);
  assert.match(limit,/#EXT-X-BYTERANGE:1@18446744073709551615\n/);
  assert.match(limit,/#EXT-X-BYTERANGE:1\n/,'A continuation past uint64 remains invalid instead of being invented.');
});
test('movie and series manifests retain their previous range handling',()=>{
  for(const key of ['movie:42','series:42']){
    const body=rewrite(['#EXTINF:4,','#EXT-X-BYTERANGE:100@20','stream.mp4','#EXTINF:4,','#EXT-X-BYTERANGE:80','stream.mp4'],key);
    assert.match(body,/#EXT-X-BYTERANGE:80\n/);assert.doesNotMatch(body,/#EXT-X-BYTERANGE:80@/);
  }
});

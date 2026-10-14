import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { parsePlaylist, mediaURL } from '../web/playlist.js';
import { parseRange, server } from '../server.mjs';

test('M3U preserves accents and commas inside quoted metadata',() => {
  const result = parsePlaylist('\uFEFF#EXTM3U\r\n#EXTINF:-1 group-title="Filmes, séries",São João\r\nhttps://example.com/a.mp4\r\n#EXTINF:-1,Segundo\n#EXTGRP:Esportes\nhttps://example.com/live.m3u8');
  assert.equal(result.items[0].title,'São João'); assert.equal(result.items[0].group,'Filmes, séries'); assert.equal(result.items[1].group,'Esportes');
});
test('M3U rejects executable URLs and distinguishes an HLS manifest',() => {
  assert.equal(mediaURL('javascript:alert(1)'),null); assert.equal(mediaURL('file:///etc/passwd'),null);
  const result=parsePlaylist('#EXTM3U\n#EXTINF:-1,Malicious\njavascript:alert(1)\n#EXTINF:-1,Valid\nhttps://example.com/test');
  assert.equal(result.skipped,1);assert.equal(result.items.length,1);assert.equal(result.items[0].title,'Valid');
  assert.throws(() => parsePlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:5\npart.ts'),/HLS/);
});
test('HTTP ranges support seeking and reject malformed requests',() => {
  assert.deepEqual(parseRange('bytes=100-199',1000),{start:100,end:199});
  assert.deepEqual(parseRange('bytes=-100',1000),{start:900,end:999});
  assert.deepEqual(parseRange('bytes=990-',1000),{start:990,end:999});
  for(const input of ['bytes=1000-','bytes=300-100','bytes=-0','bytes=','bytes=0-5,10-20'])assert.equal(parseRange(input,1000),null);
});
test('server serves media ranges and confines file access to the web directory',async () => {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  try {
    const page=await fetch(url);assert.equal(page.status,200);assert.match(await page.text(),/ARKHEN P2 IPTV/);
    const video=await fetch(url+'/assets/demo.mp4',{headers:{Range:'bytes=0-63'}});assert.equal(video.status,206);assert.equal((await video.arrayBuffer()).byteLength,64);
    const outside=await fetch(url+'/%2e%2e%2fpackage.json');assert.ok([403,404].includes(outside.status));
    const apk=await fetch(url+'/WPlay%20P2P%20BinStream.apk');assert.equal(apk.status,404);
    const rebinding=await new Promise((resolve,reject) => { get(url,{headers:{Host:'untrusted.example'}},response => {response.resume();resolve(response.statusCode);}).on('error',reject); });assert.equal(rebinding,403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

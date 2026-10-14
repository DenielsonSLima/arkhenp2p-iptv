import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {gzipSync} from 'node:zlib';
import {WplayProviderClient} from '../lib/wplay-provider.mjs';
import {epgTimestamp,normalizeWplayEPG,WPLAY_EPG_MAX_BYTES,WPLAY_EPG_CACHE_MS,WPLAY_EPG_FAILURE_BACKOFF_MS} from '../lib/wplay-epg.mjs';

const program=(name='Programa &amp; atual',time='2026-10-14T10:00:00.000Z',endTime='2026-10-14T11:00:00.000Z')=>
  ({id:'private-id',name,time,endTime,playbackUrl:'https://replay.example/private-token',extra:'private'});
function fixture() {
  const client=new WplayProviderClient({username:'fixture',password:'private'});
  client.session={connected:true};client.authenticatedAt=Date.now();
  client.authInfo={service:{epg_url:'https://epg.example/all?region=br',token:'private-token'}};
  client.rawItems.set('live:1',{chid:1,epgSameAs:91});client.rawItems.set('live:2',{chid:2});
  client.catalog=async()=>({items:[{id:'1',kind:'live'},{id:'2',kind:'live'}]});
  let requests=0;const options=[];
  client.requestJSON=async(url,settings)=>{
    requests++;options.push(settings);
    assert.equal(url,'https://epg.example/all?region=br&t=private-token');
    return [{id:91,epg:[program()]},{id:2,epg:[program('Outro programa')]}];
  };
  return {client,options,requests:()=>requests};
}

test('EPG requests share one global per-session index, preserve alias and expose no replay metadata',async()=>{
  const {client,requests,options}=fixture();
  const [alias,direct,again]=await Promise.all([client.epg('1'),client.epg('2'),client.epg('1')]);
  assert.equal(requests(),1);assert.equal(options[0].maxBytes,WPLAY_EPG_MAX_BYTES);
  assert.equal(alias.list[0].title,'Programa & atual');assert.equal(direct.list[0].title,'Outro programa');
  assert.deepEqual(again,alias);
  assert.deepEqual(Object.keys(alias.list[0]).sort(),['description','end','start','title']);
  assert.doesNotMatch(JSON.stringify(alias),/private|https:|playbackUrl/);
  client.invalidateCatalog('live');await client.epg('2');assert.equal(requests(),2);
});

test('EPG cache lasts five minutes and failures have a short backoff without becoming empty success',async()=>{
  const {client,requests}=fixture();await client.epg('1');
  assert.equal(WPLAY_EPG_CACHE_MS,300000);
  assert.ok(client.cache.get('epg:wplay:global').expiresAt-Date.now()>299000);
  client.cache.get('epg:wplay:global').expiresAt=Date.now()-1;await client.epg('2');assert.equal(requests(),2);
  client.invalidateCatalog('live');const original=client.requestJSON;
  let failures=0;client.requestJSON=async()=>{failures++;return {error:'upstream unavailable'};};
  await assert.rejects(client.epg('1'),{code:'WPLAY_INVALID_EPG'});
  await assert.rejects(client.epg('2'),{code:'WPLAY_INVALID_EPG'});
  assert.equal(failures,1);assert.equal(WPLAY_EPG_FAILURE_BACKOFF_MS,30000);
  assert.ok(client.cache.get('epg:wplay:global').expiresAt-Date.now()<=30000);
  client.cache.get('epg:wplay:global').expiresAt=Date.now()-1;
  client.requestJSON=original;assert.equal((await client.epg('1')).list.length,1);
});

test('EPG uses the renewed service URL instead of an old in-flight index or failure backoff',async()=>{
  const {client}=fixture();
  let releaseOld;const requested=[];
  client.requestJSON=async url=>{
    requested.push(url);
    if(url.includes('region=br'))return new Promise(resolve=>{releaseOld=()=>resolve([{id:91,epg:[program('Antigo')]}]);});
    return [{id:91,epg:[program('Atualizado')]}];
  };
  const old=client.epg('1');
  while(!releaseOld)await new Promise(resolve=>setImmediate(resolve));
  client.authInfo.service.epg_url='https://epg.example/all?region=updated';
  assert.equal((await client.epg('1')).list[0].title,'Atualizado');
  releaseOld();assert.equal((await old).list[0].title,'Antigo');
  assert.equal((await client.epg('1')).list[0].title,'Atualizado');
  assert.equal(requested.length,2);
  client.invalidateCatalog('live');
  client.requestJSON=async()=>{throw new Error('temporary');};
  await assert.rejects(client.epg('1'),/temporary/);
  client.authInfo.service.token='renewed-token';
  client.requestJSON=async url=>{assert.ok(url.endsWith('&t=renewed-token'));return [{id:91,epg:[program('Recuperado')]}];};
  assert.equal((await client.epg('1')).list[0].title,'Recuperado');
});

test('EPG absence is empty, channels must be registered, and nonpositive aliases use chid',async()=>{
  const {client,requests}=fixture();
  await assert.rejects(client.epg('999'),/Mídia não disponível/);assert.equal(requests(),0);
  client.authInfo.service.epg_url='';assert.deepEqual(await client.epg('1'),{list:[]});assert.equal(requests(),0);
  client.authInfo.service.epg_url='https://epg.example/all?region=br';
  client.rawItems.set('live:2',{chid:2,epgSameAs:0});assert.equal((await client.epg('2')).list[0].title,'Outro programa');
  client.rawItems.set('live:1',{chid:1,epgSameAs:-1});assert.deepEqual(await client.epg('1'),{list:[]});
});

test('EPG normalizes absolute timestamps, midnight crossings, sorting and invalid calendar data',()=>{
  assert.equal(epgTimestamp('2026-10-13T23:30:00.000-0300'),Date.parse('2026-10-14T02:30:00.000Z'));
  assert.equal(epgTimestamp('2026-10-14T06:00:00.000+02:00'),Date.parse('2026-10-14T04:00:00.000Z'));
  for(const value of ['2026-02-30T10:00:00.000Z','2026-10-14T25:00:00.000Z','2026-10-14T10:00:00',1791972000,null])assert.equal(epgTimestamp(value),null);
  const midnight=program('Madrugada','2026-10-13T23:30:00.000-0300','2026-10-14T00:30:00.000-0300');
  const result=normalizeWplayEPG([{id:1,epg:[program(),midnight,program(),program('Inválido','2026-02-30T10:00:00.000Z')]},
    {id:0,epg:[program()]},{id:2,epg:null},{id:1,epg:[program('Reverso','2026-10-14T12:00:00.000Z','2026-10-14T11:00:00.000Z')]}]);
  assert.equal(result.size,1);assert.equal(result.get('1').length,2);
  assert.equal(result.get('1')[0].title,'Madrugada');assert.equal(result.get('1')[0].start,'2026-10-14T02:30:00.000Z');
});

test('EPG HTTP status, JSON and decoded body limits use the existing Android transport boundary',async t=>{
  let mode='ok';const agents=[];
  const largeJSON=JSON.stringify([{id:1,epg:[{...program(),extra:'x'.repeat(4096)}]}]);
  const compressed=gzipSync(largeJSON);assert.ok(compressed.length<1024);
  const server=http.createServer((req,res)=>{
    agents.push(req.headers['user-agent']);
    if(mode==='status'){res.writeHead(503).end();return;}
    if(mode==='invalid'){res.end('not-json');return;}
    if(mode==='compressed'){res.writeHead(200,{'Content-Encoding':'gzip'}).end(compressed);return;}
    res.end(JSON.stringify([{id:1,epg:[program()]}]));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(()=>{server.closeAllConnections?.();return new Promise(resolve=>server.close(resolve));});
  const client=new WplayProviderClient({username:'fixture',password:'private'},{allowPrivate:true});
  const url=`http://127.0.0.1:${server.address().port}/epg`;
  assert.ok(Array.isArray(await client.requestJSON(url,{maxBytes:1024})));
  assert.equal(agents[0],client.userAgent);
  await assert.rejects(client.requestJSON(url,{maxBytes:8}),/excedeu o tamanho/);
  mode='compressed';await assert.rejects(client.requestJSON(url,{maxBytes:1024}),/excedeu o tamanho/);
  mode='invalid';await assert.rejects(client.requestJSON(url,{maxBytes:1024}),{code:'WPLAY_INVALID_RESPONSE'});
  mode='status';await assert.rejects(client.requestJSON(url,{maxBytes:1024}),{code:'WPLAY_UPSTREAM_HTTP'});
});

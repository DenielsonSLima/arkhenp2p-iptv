import test from 'node:test';
import assert from 'node:assert/strict';
import {WplayFilmes} from '../lib/wplay/filmes/servicos.mjs';
import {WplaySeries} from '../lib/wplay/series/servicos.mjs';
import {WplayAoVivo} from '../lib/wplay/ao-vivo/servicos.mjs';

function fixture({native=true}={}){
  const calls=[],cache=new Map(),episodes=new Map(),rawItems=new Map();
  const client={cache,episodes,rawItems,authInfo:{service:native?{vod_tag_url:'registered-tags'}:{}},
    connect:async()=>calls.push(['connect']),sources:raw=>raw?.sources||[],
    memo(key,fn){if(!cache.has(key))cache.set(key,Promise.resolve().then(fn));return cache.get(key);},
    normalizeItems(rows,kind){calls.push(['normalize',kind]);return {categories:[],items:rows.map(raw=>({id:String(raw.chid),name:raw.name,kind}))};},
    serviceURL:field=>field,image:value=>typeof value==='string'?'/api/image?ref=opaque':'',
    durationForSource:()=>assert.fail('Series must not probe movie/media duration.'),
    nativeVOD:{catalog:async type=>{calls.push(['catalog',type]);return {items:[]};},
      page:async(type,category,page)=>{calls.push(['page',type,category,page]);return {items:[]};},
      invalidate:type=>calls.push(['invalidate',type]),
      detail:async(type,id)=>{calls.push(['detail',type,id]);return {id,kind:type,name:'Selected title'};}},
  };
  const movies=new WplayFilmes(client),series=new WplaySeries(client),live=new WplayAoVivo(client,value=>value);
  client.isSeries=raw=>series.isSeries(raw);
  return {client,movies,series,live,calls};
}

test('native movie and series readers share the injected client with independent catalog types',async()=>{
  const f=fixture();await Promise.all([f.movies.catalog(),f.series.catalog()]);
  await f.movies.page('50',2);await f.series.page('1010',3);
  f.movies.invalidate();f.series.invalidate();
  assert.equal(f.movies.client,f.series.client);
  assert.deepEqual(f.calls.filter(([kind])=>kind!=='connect'),[
    ['catalog','movies'],['catalog','series'],['page','movies','50',2],['page','series','1010',3],
    ['invalidate','movies'],['invalidate','series']
  ]);
});

test('legacy VOD fetch is shared and domain readers expose only their own titles',async()=>{
  const f=fixture({native:false});let requests=0;
  f.client.requestJSON=async field=>{assert.equal(field,'vod_url');requests++;return [
    {chid:1,name:'Movie',sources:[]},
    {chid:2,name:'Series',sources:[{subTitle:'S01E001'}]},
  ];};
  const [movies,series]=await Promise.all([f.movies.catalog(),f.series.catalog()]);
  assert.equal(requests,1);assert.deepEqual(movies.items.map(item=>[item.id,item.kind]),[['1','movie']]);
  assert.deepEqual(series.items.map(item=>[item.id,item.kind]),[['2','series']]);
});

test('series time remains independent of episode duration and exact episode sources stay private',async()=>{
  const f=fixture();f.client.rawItems.set('series:2',{name:'Series',tags:[],sources:[
    {_id:21,subTitle:'S01E001',duration:'00:42:00',address:'https://media.example/episode.mp4',thumbnail:'https://art.example/episode.jpg'},
    {_id:22,subTitle:'S01E001',duration:'00:42:00',address:'https://media.example/duplicate.mp4'},
  ]});
  const result=await f.series.details('2',{probeDuration:true});
  assert.equal(result.durationSeconds,null);assert.equal(result.seasons.length,1);
  assert.equal(result.seasons[0].episodes.length,1);assert.equal(result.seasons[0].episodes[0].id,'21');
  assert.equal(result.seasons[0].episodes[0].durationSeconds,2520);
  assert.equal(f.client.episodes.get('21').source.address,'https://media.example/episode.mp4');
  assert.ok(!JSON.stringify(result).includes('media.example'));
  assert.ok(!JSON.stringify(result).includes('art.example'));
});

test('live catalog never initializes VOD or loads provider games/EPG',async()=>{
  const f=fixture();f.client.nativeVOD.catalog=()=>assert.fail('Live must not initialize VOD.');
  f.client.requestJSON=async field=>{assert.equal(field,'ch_url');return [{chid:81,name:'Channel'}];};
  const result=await f.live.catalog();
  assert.deepEqual(result.items.map(item=>[item.id,item.kind]),[['81','live']]);
  assert.equal(f.client.cache.has('wplay:vod'),false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogReadLimiter,readCatalogSnapshot} from '../lib/catalog-snapshot-reader.mjs';
import {catalogReadFixture} from './helpers/catalog-read-fixture.mjs';
const providerKey='a'.repeat(64),scopeHash='b'.repeat(64);
const movies=count=>Array.from({length:count},(_,id)=>({id:String(id),kind:'movie',name:'Movie '+id,categoryId:'one',genre:'Drama',poster:'/assets/poster.svg',isAdult:id===5}));
const options=()=>({providerKey,scopeHash,type:'movies',limitRead:catalogReadLimiter(2)});

test('bounded transport returns every item only after assembling and checking the complete generation',async()=>{
  const items=movies(2501),categories=[{id:'one',name:'Cinema'}],fixture=catalogReadFixture({items,categories}),calls=[];
  const full=await readCatalogSnapshot({...options(),read:async path=>{calls.push(path);return fixture(path);}});
  assert.equal(full.items.length,2501);assert.deepEqual(full.items,items);assert.deepEqual(full.categories,[{id:'one',name:'Cinema',isAdult:false}]);assert.equal(full.catalogComplete,true);assert.equal(full.pagination.safeTotal,2500);
  assert.equal(calls.filter(path=>path.includes('/catalog_media?')).length,3);assert.equal(calls.filter(path=>path.includes('/provider_catalog_cache?')).length,2);
  for(const path of calls){const p=new URL(path,'https://example.test').searchParams;assert.ok(Number(p.get('limit'))<=1000);assert.doesNotMatch(p.get('select'),/payload/);assert.equal(p.get('provider_key'),'eq.'+providerKey);assert.equal(p.get('scope_hash'),'eq.'+scopeHash);}
});
test('an empty complete publication is valid without requesting media batches',async()=>{
  const calls=[],fixture=catalogReadFixture();const full=await readCatalogSnapshot({...options(),read:async path=>{calls.push(path);return fixture(path);}});
  assert.equal(full.catalogComplete,true);assert.equal(full.items.length,0);assert.equal(calls.filter(path=>path.includes('/catalog_media?')).length,0);
});
test('the category safety limit includes exactly 10000 entries and rejects an extra one',async()=>{
  const categories=Array.from({length:10000},(_,id)=>({id:String(id),name:'Category '+id}));
  const full=await readCatalogSnapshot({...options(),read:async path=>catalogReadFixture({categories})(path)});assert.equal(full.categories.length,10000);
  categories.push({id:'extra',name:'Extra'});
  await assert.rejects(readCatalogSnapshot({...options(),read:async path=>catalogReadFixture({categories})(path)}),{code:'CLOUD_CATALOG_SNAPSHOT_INVALID'});
});
for(const failure of ['missing-batch','duplicate','wrong-kind','wrong-generation','wrong-safe-count','revision-change'])test('rejects an inconsistent full transport: '+failure,async()=>{
  const fixture=catalogReadFixture({items:movies(1001)});let headers=0;
  await assert.rejects(readCatalogSnapshot({...options(),read:async path=>{
    const rows=fixture(path);if(path.includes('/provider_catalog_cache?')){headers++;if(failure==='wrong-safe-count')rows[0].safe_item_count++;if(failure==='revision-change'&&headers===2)rows[0].updated_at='2026-10-15T16:00:00Z';}
    if(path.includes('/catalog_media?')&&path.includes('offset=1000')){
      if(failure==='missing-batch')return[];
      if(failure==='duplicate'){rows[0].media_id='0';rows[0].metadata={...rows[0].metadata,id:'0'};}
      if(failure==='wrong-kind')rows[0].metadata={...rows[0].metadata,kind:'series'};
      if(failure==='wrong-generation')rows[0].generation_id='00000000-0000-0000-0000-000000000000';
    }return rows;
  }}),{code:'CLOUD_CATALOG_SNAPSHOT_INVALID'});
});
test('leaving an account stops queued batches and never returns its assembled data',async()=>{
  let current=true;const fixture=catalogReadFixture({items:movies(1001)}),calls=[];
  await assert.rejects(readCatalogSnapshot({...options(),current:()=>current,read:async path=>{calls.push(path);if(path.includes('/catalog_media?'))current=false;return fixture(path);}}),{code:'CLOUD_CATALOG_SNAPSHOT_INVALID'});
  assert.equal(calls.filter(path=>path.includes('/catalog_media?')).length,1);
});
test('the shared limiter bounds load and lets TV run before all movie batches finish',async()=>{
  const limitRead=catalogReadLimiter(2),requests=[];let active=0,max=0;
  const run=type=>{const items=type==='movies'?movies(2501):[{id:'tv',kind:type,name:type}],fixture=catalogReadFixture({items});return readCatalogSnapshot({...options(),type,limitRead,read:async path=>{
    const media=path.includes('/catalog_media?');if(media){active++;max=Math.max(max,active);requests.push(type+':'+new URL(path,'https://example.test').searchParams.get('offset'));await new Promise(resolve=>setTimeout(resolve,5));}
    const rows=fixture(path);if(media)active--;return rows;
  }});};
  const results=await Promise.all([run('movies'),run('series'),run('live')]);assert.deepEqual(results.map(data=>data.items.length),[2501,1,1]);assert.ok(max<=2);assert.ok(requests.indexOf('live:0')<requests.indexOf('movies:2000'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {CatalogCache,IndexedDBCatalogStorage,CATALOG_CACHE_TTL_MS} from '../web/catalog-cache.js';
const NOW=Date.parse('2026-10-15T12:00:00Z'),scope={providerKey:'a'.repeat(64),scopeHash:'b'.repeat(64),type:'movies',includeAdult:false};
const catalog=(extra={})=>({catalogComplete:true,categories:[{id:'1',name:'Cinema'},{id:'18',name:'VIP',isAdult:true}],items:[{id:'1',kind:'movie',name:'Safe movie',categoryId:'1',poster:'/api/shared-image/'+'c'.repeat(64),backdrop:'https://private.example/cover?token=secret',sources:[{address:'secret'}],password:'secret'},{id:'2',kind:'movie',name:'Protected movie',categoryId:'18'}],...extra});
class MemoryStorage{constructor(){this.rows=new Map();}async get(key){return structuredClone(this.rows.get(key));}async put(key,value){this.rows.set(key,structuredClone(value));}async delete(key){this.rows.delete(key);}}
test('complete global snapshots survive another cache instance without storing secrets, session refs or Map/Set',async()=>{
  const storage=new MemoryStorage(),cache=new CatalogCache({storage,now:()=>NOW}),data=catalog();data.sourceCategories=[...data.categories,{id:'combined',name:'Two genres',ids:new Set(['1','18'])}];data.itemMap=new Map();data.items[0].libraryId='private-account';
  assert.equal(await cache.write(scope,data),true);const saved=await new CatalogCache({storage,now:()=>NOW}).read(scope);assert.equal(saved.fresh,true);assert.equal(saved.savedAt,NOW);assert.equal(saved.catalog.items.length,1);assert.match(saved.catalog.items[0].poster,/^\/api\/shared-image\//);assert.equal(saved.catalog.items[0].backdrop,'');
  const stored=[...storage.rows.values()][0];assert.deepEqual(stored.catalog.categories.find(row=>row.id==='combined').ids,['1','18']);assert.doesNotMatch(JSON.stringify(stored),/secret|password|sources|address|private-account|https:\/\/private|itemMap|user_id|favorites/);
});
test('TTL is exactly24hours, reads never renew it and stale snapshots remain available when offline',async()=>{
  let now=NOW;const cache=new CatalogCache({storage:new MemoryStorage(),now:()=>now});await cache.write(scope,catalog());now+=CATALOG_CACHE_TTL_MS-1;assert.equal((await cache.read(scope)).fresh,true);now++;const stale=await cache.read(scope);assert.equal(stale.fresh,false);assert.equal(stale.savedAt,NOW);assert.equal(stale.catalog.items.length,1);now+=CATALOG_CACHE_TTL_MS;assert.equal((await cache.read(scope)).savedAt,NOW);
});

test('a fresh v1 four-title snapshot is a miss and upgrades atomically at the same key without inheriting its age',async()=>{
  const storage=new MemoryStorage(),cache=new CatalogCache({storage,now:()=>NOW}),items=Array.from({length:4},(_,i)=>({id:String(i+1),kind:'movie',name:`Legacy title ${i+1}`,categoryId:'1'}));
  await cache.write(scope,catalog({items}));const key=[...storage.rows.keys()][0],legacy=storage.rows.get(key);legacy.version=1;legacy.savedAt=NOW+30000;delete legacy.catalog.pagination.revisionAt;
  assert.equal(legacy.catalog.items.length,4);assert.equal(await cache.read(scope),null,'A v1 timestamp cannot make unversioned legacy metadata authoritative for another day.');
  const published=catalog({pagination:{revisionAt:'2026-10-15T12:00:00Z'}});assert.equal(await cache.write(scope,published,{fetchedAt:NOW}),true);
  assert.equal(storage.rows.size,1);assert.equal([...storage.rows.keys()][0],key);assert.equal(storage.rows.get(key).version,2);
  const current=await cache.read(scope);assert.equal(current.fresh,true);assert.equal(current.savedAt,NOW);assert.equal(current.catalog.items.length,1);
  assert.equal(await cache.write(scope,catalog({pagination:{revisionAt:'2026-10-15T11:00:00Z'}}),{fetchedAt:NOW+1000}),false,'Same-version publication order remains enforced after upgrade.');assert.equal((await cache.read(scope)).savedAt,NOW);
});
test('project, provider, partition, media type and adult mode have independent cache keys',async()=>{
  const cache=new CatalogCache({storage:new MemoryStorage(),now:()=>NOW});await cache.write(scope,catalog());for(const other of [{providerKey:'d'.repeat(64)},{scopeHash:'d'.repeat(64)},{type:'series'},{includeAdult:true},{project:'https://different.supabase.co'}])assert.equal(await cache.read({...scope,...other}),null);
  assert.equal(await cache.read({...scope,libraryId:'some-private-user'}).then(Boolean),true,'The shared catalog has no user-specific cache key.');
});
test('incomplete, preparing, failed or older replacements preserve the last atomically complete snapshot',async()=>{
  const storage=new MemoryStorage(),cache=new CatalogCache({storage,now:()=>NOW+1000});await cache.write(scope,catalog(),{fetchedAt:NOW});for(const data of [catalog({catalogComplete:false}),catalog({preparing:true}),catalog({pagination:{complete:false}}),catalog({pagination:{preparing:true}}),{categories:[],items:[]}])assert.equal(await cache.write(scope,data),false);
  assert.equal(await cache.write(scope,catalog({items:[]}),{fetchedAt:NOW-1}),false);storage.put=async()=>{throw new Error('Quota exceeded');};assert.equal(await cache.write(scope,catalog({items:[]}),{fetchedAt:NOW+1}),false);assert.equal((await cache.read(scope)).catalog.items[0].id,'1');assert.equal((await cache.read(scope)).savedAt,NOW);
});
test('locked snapshots filter adult categories/items and relock clears every adult media partition without deleting safe data',async()=>{
  const cache=new CatalogCache({storage:new MemoryStorage(),now:()=>NOW});await cache.write(scope,catalog());await cache.write({...scope,includeAdult:true},catalog());assert.equal((await cache.read({...scope,includeAdult:true})).catalog.items.length,2);assert.equal((await cache.read(scope)).catalog.items.length,1);assert.equal(await cache.clearAdult(scope),true);assert.equal(await cache.read({...scope,includeAdult:true}),null);assert.equal((await cache.read(scope)).catalog.items.length,1);
});
test('clearing adult data also removes a write already in flight before lock',async()=>{
  const storage=new MemoryStorage(),original=storage.put.bind(storage);let release,started;const waiting=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});storage.put=async(...args)=>{started();await gate;return original(...args);};const cache=new CatalogCache({storage,now:()=>NOW}),writing=cache.write({...scope,includeAdult:true},catalog());await waiting;const clearing=cache.clearAdult(scope);release();await writing;await clearing;assert.equal(await cache.read({...scope,includeAdult:true}),null);
});
test('IndexedDB unavailable, malformed storage and invalid scopes fail safely without poisoning an existing entry',async()=>{
  const absent=new CatalogCache({storage:new IndexedDBCatalogStorage({indexedDB:null}),now:()=>NOW});assert.equal(await absent.read(scope),null);assert.equal(await absent.write(scope,catalog()),false);const storage=new MemoryStorage(),cache=new CatalogCache({storage,now:()=>NOW});assert.equal(await cache.write({...scope,providerKey:'user/password'},catalog()),false);assert.equal(await cache.read({...scope,includeAdult:undefined}),null);await cache.write(scope,catalog());const key=[...storage.rows.keys()][0];storage.rows.get(key).savedAt=NOW+120000;assert.equal(await cache.read(scope),null);
});

test('Set memberships are normalized before classification and malformed memberships cannot throw during a cache write',async()=>{
  const cache=new CatalogCache({storage:new MemoryStorage(),now:()=>NOW}),data=catalog();data.items[0].categoryIds=new Set(['1']);assert.equal(await cache.write(scope,data),true);assert.deepEqual((await cache.read(scope)).catalog.items[0].categoryIds,['1']);data.items[0].categoryIds='malformed';assert.equal(await cache.write(scope,data),true);assert.deepEqual((await cache.read(scope)).catalog.items[0].categoryIds,['1']);
});

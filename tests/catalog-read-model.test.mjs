import test from 'node:test';
import assert from 'node:assert/strict';
import {CatalogBrowseIndex,sanitizeCatalogReadModel} from '../web/catalog-read-model.js';
import {sanitizeCatalogCache} from '../web/catalog-cache.js';
import {ADULT_CATEGORY,RELEASES_CATEGORY} from '../web/catalog-navigation.js';

const snapshotId='12345678-1234-1234-1234-123456789012',revisionAt='2026-10-15T16:00:00Z';
function fixture(){
  const items=[{id:'1',name:'Zulu',kind:'movie',rating:1,categoryId:'a',categoryIds:['a'],groupKey:'cinema',groupKeys:['cinema']},{id:'2',name:'Alfa',kind:'movie',rating:9,categoryId:'b',categoryIds:['b'],groupKey:'cinema',groupKeys:['cinema']},{id:'3',name:'Beta',kind:'movie',rating:8,categoryId:'c',categoryIds:['c'],groupKey:'drama',groupKeys:['drama']}];
  const catalog={catalogComplete:true,items,itemMap:new Map(items.map(item=>[item.id,item])),categories:[{id:'cinema',name:'Cinema',ids:new Set(['a','b'])},{id:'drama',name:'Drama',ids:new Set(['c'])}],sourceCategories:[{id:'a',name:'Cinema'},{id:'b',name:'Cinema'},{id:'c',name:'Drama'}],pagination:{snapshotId,revisionAt}};
  const model={schemaVersion:1,mediaType:'movies',snapshotId,generation:'22345678-1234-1234-1234-123456789012',revisionAt,expiresAt:'2026-10-16T16:00:00Z',includeAdult:false,total:3,orders:{name:['2','3','1'],date:['1','3','2'],rating:['2','3','1'],releases:['3','1','2'],featured:['1','3']},categories:[{id:'a',name:'Cinema',itemIds:['1'],count:1},{id:'b',name:'Cinema',itemIds:['2'],count:1},{id:'c',name:'Drama',itemIds:['3'],count:1}],genres:[{id:'acao',name:'Ação',itemIds:['1','2'],count:2},{id:'drama',name:'Drama',itemIds:['2','3'],count:2}]};
  return {catalog,model};
}
test('read model preserves exact SQL orders and merges source categories without double counting',()=>{
  const {catalog,model}=fixture();catalog.readModel=sanitizeCatalogReadModel(model,catalog,{type:'movies'});assert.ok(catalog.readModel);const index=new CatalogBrowseIndex(catalog).project('all',()=>true);
  assert.equal(index.source,'supabase');assert.deepEqual(index.select({sort:'date'}).map(item=>item.id),['1','3','2']);assert.deepEqual(index.select({category:'cinema',genre:'drama',sort:'name'}).map(item=>item.id),['2']);assert.deepEqual(index.categories().map(group=>group.count),[2,1]);assert.equal(index.categories('drama')[0].count,1);assert.deepEqual(index.genreIndex.choices.map(genre=>genre.count),[3,2,2]);
});
test('repeated rendering uses identical selections and does not evaluate visibility again',()=>{
  const {catalog,model}=fixture();catalog.readModel=model;let calls=0;const visible=item=>{calls++;return item.id!=='3';},index=new CatalogBrowseIndex(catalog).project('hidden3',visible),items=index.select();index.project('hidden3',visible);
  assert.equal(index.select(),items);assert.equal(calls,3);assert.equal(index.categories()[0].count,2);index.project('none',()=>false);assert.equal(index.select().length,0);assert.equal(index.genreIndex.choices[0].count,0);assert.equal(items.length,2);
});
test('publication, scope, incomplete IDs, duplicate IDs and unsafe metadata are rejected',()=>{
  const {catalog,model}=fixture();for(const change of [{snapshotId:'32345678-1234-1234-1234-123456789012'},{mediaType:'series'},{includeAdult:true},{revisionAt:'2026-10-15T17:00:00Z'},{total:2},{orders:{...model.orders,name:['1','2']}},{orders:{...model.orders,name:['1','1','3']}},{genres:[{id:'drama',name:'Drama',itemIds:['unknown'],count:1}]}])assert.equal(sanitizeCatalogReadModel({...model,...change},catalog,{type:'movies'}),null);
  assert.ok(sanitizeCatalogReadModel({...model,revisionAt:'2026-10-15T16:00:00.000Z'},catalog,{type:'movies'}));
});
test('daily cache keeps the coherent projection without private fields and discards only a mismatched model',()=>{
  const {catalog,model}=fixture();catalog.readModel={...model,secret:'private',orders:{...model.orders,password:'private'}};let cached=sanitizeCatalogCache(catalog,{type:'movies'});assert.deepEqual(cached.readModel.orders,model.orders);assert.doesNotMatch(JSON.stringify(cached),/secret|password|private/);
  catalog.readModel={...model,total:999};cached=sanitizeCatalogCache(catalog,{type:'movies'});assert.equal(cached.items.length,3);assert.equal(cached.readModel,undefined);
});
test('older offline catalogs retain one prepared compatibility index',()=>{
  const {catalog}=fixture();const index=new CatalogBrowseIndex(catalog).project('all',()=>true);assert.equal(index.source,'offline');const sorted=index.select({sort:'name'});assert.deepEqual(sorted.map(item=>item.id),['2','3','1']);assert.equal(index.select({sort:'name'}),sorted);
});

test('fallback Releases preserves the daily SQL order instead of sorting again in the browser',()=>{
  const {catalog,model}=fixture();catalog.readModel=model;
  const index=new CatalogBrowseIndex(catalog).project('all',()=>true);
  assert.deepEqual(index.select({category:RELEASES_CATEGORY,sort:'releases'}).map(item=>item.id),['3','1','2']);
  assert.deepEqual(index.select({category:RELEASES_CATEGORY,sort:'rating'}).map(item=>item.id),['2','3','1']);
});

test('adult metadata stays out of All, releases, genres and normal category counts even after PIN unlock',()=>{
  const {catalog,model}=fixture();
  catalog.sourceCategories[2]={id:'c',name:'VIP',isAdult:true};catalog.categories[1]={...catalog.categories[1],name:'VIP',isAdult:true};catalog.readModel=model;
  const index=new CatalogBrowseIndex(catalog).project('unlocked',()=>true);
  assert.deepEqual(index.select({sort:'name'}).map(item=>item.id),['2','1']);
  assert.deepEqual(index.select({category:RELEASES_CATEGORY,sort:'releases'}).map(item=>item.id),['1','2']);
  assert.deepEqual(index.select({category:ADULT_CATEGORY}).map(item=>item.id),['3']);
  assert.deepEqual(index.categories().map(group=>[group.id,group.count]),[['cinema',2]]);
  assert.equal(index.genreIndex.choices.find(genre=>genre.id==='drama').count,1);
  index.project('locked',item=>item.id!=='3');assert.deepEqual(index.select({category:ADULT_CATEGORY}),[]);
});

test('offline compatibility index retains the same adult restriction and explicit category',()=>{
  const {catalog}=fixture();catalog.items[0].isAdult=true;
  const index=new CatalogBrowseIndex(catalog).project('unlocked',()=>true);
  assert.deepEqual(index.select({sort:'name'}).map(item=>item.id),['2','3']);
  assert.deepEqual(index.select({category:ADULT_CATEGORY}).map(item=>item.id),['1']);
  assert.equal(index.select({category:RELEASES_CATEGORY,sort:'releases'}).some(item=>item.id==='1'),false);
});

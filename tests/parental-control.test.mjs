import test from 'node:test';
import assert from 'node:assert/strict';
import {ParentalControl} from '../lib/parental-control.mjs';
import {hasAdultMarker,isAdultCategory,isAdultItem} from '../web/parental-classification.js';

const categories=[{id:'safe',name:'Ação'},{id:'adult',name:'Adultos +18'},{id:'cartoons',name:'Adult Swim'}];
const movie=(id,categoryId,name='Um filme')=>({kind:'movie',id,categoryId,name});
const catalog={categories,items:[movie('1','safe'),movie('2','adult'),movie('3','cartoons','Adult Swim Ao Vivo')],pagination:{mode:'category',byCategory:{safe:{loaded:true},adult:{loaded:false},cartoons:{loaded:true}}}};

test('explicit adult markers match whole tokens while Adult Swim and innocent title numbers stay visible',()=>{
  for(const name of ['Adultos','ADULT','Filmes XXX','Erótico','Pornografia','+18','18+'])assert.equal(hasAdultMarker(name),true,name);
  assert.equal(isAdultCategory({name:'Filmes | 18'}),true);
  for(const name of ['Adult Swim','ADULT SWIM HD','18 Again','Adultério','Extraordinário','Aventura 2018','XXXtreme Sports'])assert.equal(hasAdultMarker(name),false,name);
  assert.equal(isAdultItem(movie('2','adult'),categories),true);assert.equal(isAdultItem(movie('3','cartoons','Adult Swim'),categories),false);
});

test('default lock filters every catalog item, adult category and pagination metadata without mutating global data',()=>{
  const control=new ParentalControl(),filtered=control.filterCatalog(catalog,'movies');
  assert.equal(control.unlocked,false);assert.deepEqual(filtered.items.map(item=>item.id),['1','3']);assert.deepEqual(filtered.categories.map(group=>group.id),['safe','cartoons']);assert.deepEqual(Object.keys(filtered.pagination.byCategory),['safe','cartoons']);assert.equal(catalog.items.length,3);
  assert.throws(()=>control.assertItem('movie','2'),{code:'PARENTAL_LOCKED'});assert.throws(()=>control.assertItem('movie','unknown'),{code:'PARENTAL_LOCKED'});control.assertItem('movie','1');
});

test('legacy malformed category lists cannot crash classification or erase a valid adult category',()=>{
  for(const categoryIds of ['old-format',{},42])assert.equal(isAdultItem({...movie('2','adult'),categoryIds},categories),true);
  assert.equal(isAdultItem(movie('2','adult'),[{id:'adult',name:'Adultos',ids:42}]),true);
  assert.equal(isAdultItem(movie('1','safe'),null),false);
  assert.equal(isAdultItem(movie('2','adult'),[{id:'merged',name:'Adultos',ids:new Set(['adult'])}]),true);
});

test('PIN unlock and relock are isolated per browser session and reset removes all authorizations',()=>{
  const first=new ParentalControl(),second=new ParentalControl();first.filterCatalog(catalog,'movies');second.filterCatalog(catalog,'movies');
  first.unlock('0000');assert.equal(first.filterCatalog(catalog,'movies').items.length,3);first.assertItem('movie','2');assert.throws(()=>second.assertItem('movie','2'),{code:'PARENTAL_LOCKED'});
  first.lock();assert.throws(()=>first.assertItem('movie','2'),{code:'PARENTAL_LOCKED'});first.unlock('0000');first.reset();assert.equal(first.status().locked,true);assert.equal(first.items.size,0);
  assert.doesNotMatch(JSON.stringify(first.status()),/0000|pin|password/i);
});

test('invalid and malformed PINs have a shared attempt limit and cooldown enforced before the correct PIN',()=>{
  let now=1000;const control=new ParentalControl({now:()=>now});for(const pin of ['1','000','12345',0])assert.throws(()=>control.unlock(pin),{code:'PARENTAL_PIN_INVALID'});
  assert.throws(()=>control.unlock('1111'),{status:429});assert.throws(()=>control.unlock('0000'),{code:'PARENTAL_RATE_LIMITED'});assert.equal(control.status().retryAfterSeconds,60);
  now+=60000;assert.equal(control.unlock('0000').unlocked,true);
});

test('episode playback needs a registered allowed parent and relock revokes adult episodes even if the provider remembers them',()=>{
  const control=new ParentalControl();control.filterCatalog({categories,items:[{...movie('s1','safe'),kind:'series'},{...movie('s2','adult'),kind:'series'}]},'series');
  control.registerDetails('series','s1',{seasons:[{episodes:[{id:'ep1'}]}]});control.registerDetails('series','s2',{seasons:[{episodes:[{id:'ep2'}]}]});
  control.assertPlayback('series','ep1');assert.throws(()=>control.assertPlayback('series','ep2'),{code:'PARENTAL_LOCKED'});assert.throws(()=>control.assertPlayback('series','unknown'),{code:'PARENTAL_LOCKED'});
  control.unlock('0000');control.assertPlayback('series','ep2');control.lock();assert.throws(()=>control.assertPlayback('series','ep2'),{code:'PARENTAL_LOCKED'});
});

test('a direct movie ID is classified from provider metadata before any details or playback may be returned',async()=>{
  const control=new ParentalControl(),client={catalog:async()=>({...catalog,items:[]}),details:async()=>movie('2','adult')};
  await assert.rejects(control.authorize(client,'movie','2'),{code:'PARENTAL_LOCKED'});control.unlock('0000');await control.authorize(client,'movie','2');
});

test('filtered cloud categories cannot hide the adult classification of a direct unknown provider ID',async()=>{
  const control=new ParentalControl();control.filterCatalog({categories:[categories[0]],items:[movie('1','safe')]},'movies');
  const client={catalog:async()=>({...catalog,items:[]})};await assert.rejects(control.authorize(client,'movie','2',{details:movie('2','adult')}),{code:'PARENTAL_LOCKED'});
  await assert.rejects(control.authorize(client,'movie','99',{details:{id:'99',name:'Unknown'}}),{code:'PARENTAL_LOCKED'});
});

test('filtered Supabase pages retain their global continuation cursor',()=>{
  const control=new ParentalControl(),data={...catalog,pagination:{source:'supabase',byCategory:{__all:{hasMore:true,nextPage:2},adult:{hasMore:true}}}};
  assert.deepEqual(control.filterCatalog(data,'movies').pagination.byCategory,{__all:{hasMore:true,nextPage:2}});
});

test('direct artwork and episode thumbnails require an allowed owner and relock revokes cached adult artwork',async()=>{
  const control=new ParentalControl(),safe={...movie('1','safe'),poster:'/api/image?ref=safe'},adult={...movie('2','adult'),poster:'/api/shared-image/'+ 'a'.repeat(64)};
  control.filterCatalog({categories,items:[safe,adult]},'movies');await control.authorizeArtwork(safe.poster);await assert.rejects(control.authorizeArtwork(adult.poster),{code:'PARENTAL_LOCKED'});await assert.rejects(control.authorizeArtwork('/api/image?ref=unknown'),{code:'PARENTAL_LOCKED'});
  const url='/api/shared-image/'+ 'b'.repeat(64);await control.authorizeArtwork(url,async()=>({kind:'movie',id:'3',catalog:{categories:[],items:[{...movie('3','safe'),poster:url,isAdult:false}]}}));
  control.unlock('0000');await control.authorizeArtwork(adult.poster);control.lock();await assert.rejects(control.authorizeArtwork(adult.poster),{code:'PARENTAL_LOCKED'});
});

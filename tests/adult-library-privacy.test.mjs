import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudItem,cloudProgress,librarySnapshot} from '../web/cloud-library-records.js';
import {CloudOutbox} from '../web/cloud-outbox.js';
import {MediaLibrary} from '../web/media-library.js';
import {isAdultItem} from '../web/parental-classification.js';

const NOW=Date.parse('2026-10-15T17:20:00Z'),STAMP=new Date(NOW).toISOString();
const A='a'.repeat(64),B='b'.repeat(64);
const scope={url:'https://fixture.supabase.co',provider:'wplay',userId:'account-a'};
const item=(id,extra={})=>({kind:'movie',id:String(id),name:`Título ${id}`,...extra});
const progress=(value,extra={})=>({item:value,time:120,duration:1800,updated:NOW,episode:null,...extra});
const row=(entry,extra={})=>({user_id:scope.userId,provider:scope.provider,item_key:`${entry.item.kind}:${entry.item.id}`,episode_id:entry.episode?.id||'',entry,updated_at:STAMP,deleted_at:null,...extra});
const favorite=value=>({user_id:scope.userId,provider:scope.provider,item_key:`${value.kind}:${value.id}`,item:value,updated_at:STAMP,deleted_at:null});
function mediaFixture(initial={},options={}){
  const storage=new Map(Object.entries(structuredClone(initial))),writes=[],favorites=new Map(),history=new Map();
  const library=new MediaLibrary({read:(key,fallback)=>structuredClone(storage.get(key)??fallback),save:(key,value)=>{writes.push(key);storage.set(key,structuredClone(value));},favorites,history,...options});
  return {library,storage,writes,favorites,history};
}

test('progress rejects positive item, envelope and episode flags before sanitization; favorites keep explicit metadata',()=>{
  const safe=item('safe'),series=item('series',{kind:'series'}),episode={id:'ep-1',season:1,number:1};
  for(const flag of ['adult','isAdult','is_adult']){
    assert.equal(cloudProgress(progress({...safe,[flag]:true})),null,`item.${flag}`);
    assert.equal(cloudProgress(progress(safe,{[flag]:true})),null,`entry.${flag}`);
    assert.equal(cloudProgress(progress(series,{episode:{...episode,[flag]:true}})),null,`episode.${flag}`);
    assert.equal(cloudItem({...safe,[flag]:true}).isAdult,true,'Explicit favorites remain supported.');
  }
  const categories=[{id:'reserved',name:'Reservado',isAdult:true}];
  const protectedItem=item('category-only',{categoryIds:['reserved']});
  assert.equal(cloudProgress(progress(protectedItem),{canRemember:value=>!isAdultItem(value,categories)}),null);
  assert.equal(cloudProgress(progress(safe)).time,120);
  assert.equal(cloudProgress(progress(item('brand',{name:'Adult Swim'}))).time,120);
});

test('snapshot removes all adult progress records while preserving ordinary tombstones and favorites',()=>{
  const adult=item('adult',{isAdult:true}),safe=item('safe'),series=item('series',{kind:'series'});
  const entries=[row(progress(adult)),row(progress(item('envelope'),{adult:true})),row(progress(series,{episode:{id:'ep',isAdult:true}})),row(progress(item('category',{categoryId:'reserved'}))),row(progress(safe))];
  const tombstone=row(progress(item('removed')),{deleted_at:STAMP});
  const minimalTombstone={...tombstone,item_key:'movie:missing',entry:null};
  const result=librarySnapshot({user_progress:[...entries,tombstone,minimalTombstone],user_favorites:[favorite(adult)]},{...scope,libraryId:A,canRemember:value=>value.categoryId!=='reserved'});
  assert.deepEqual(result.history.map(entry=>entry.item.id),['safe']);assert.deepEqual(result.episodes,[]);
  assert.deepEqual(result.progressRecords.map(entry=>entry.item_key),['movie:safe','movie:removed','movie:missing']);
  assert.equal(result.favorites[0].id,'adult');assert.equal(result.favoriteRecords.length,1);
  assert.equal(result.history[0].libraryId,A);
});

test('reloading a legacy outbox physically removes adult records without removing favorites or crossing accounts',()=>{
  const data=new Map(),storage={getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value)};
  const queue=new CloudOutbox({storage});queue.setScope(scope);const key=queue.key();
  const adult=item('adult',{isAdult:true}),series=item('series',{kind:'series'});
  const entries=[
    {table:'user_progress',row:row(progress(adult))},
    {table:'user_progress',row:row(progress(item('envelope'),{isAdult:true}))},
    {table:'user_progress',row:row(progress(series,{episode:{id:'ep',adult:true}}))},
    {table:'user_progress',row:row(progress(item('safe')))},
    {table:'user_favorites',row:favorite(adult)}
  ];
  data.set(key,JSON.stringify({version:1,...scope,entries}));queue.setScope(scope);
  assert.deepEqual(queue.entries().map(value=>`${value.table}:${value.row.item_key}`),['user_progress:movie:safe','user_favorites:movie:adult']);
  const persisted=JSON.parse(data.get(key));assert.equal(persisted.entries.length,2);assert.equal(persisted.entries.some(value=>value.row.item_key==='movie:envelope'),false);
  const saved=data.get(key);queue.setScope({...scope,userId:'account-b'});assert.deepEqual(queue.entries(),[]);assert.equal(data.get(key),saved);
  queue.setScope(scope);assert.equal(queue.entries().length,2);
});

test('activating an account removes explicit adult history from storage, preserving normal history and favorites',()=>{
  const prefix=`orbit.library.v3.wplay.${A}`,other=`orbit.library.v3.wplay.${B}`;
  const adult=item('adult',{isAdult:true}),safe=item('safe'),series=item('series',{kind:'series'}),foreign=progress(item('foreign'),{libraryId:B});
  const initial={
    [`${prefix}.favorites`]:[adult,safe],
    [`${prefix}.history`]:[progress(adult),progress(item('envelope'),{isAdult:true}),progress(series,{episode:{id:'ep',is_adult:true}}),progress(safe,{libraryId:A}),foreign],
    [`${other}.history`]:[foreign]
  };
  const f=mediaFixture(initial);f.library.activate('wplay',A);
  assert.deepEqual([...f.history.keys()],['movie:safe']);assert.deepEqual([...f.favorites.keys()],['movie:adult','movie:safe']);
  assert.deepEqual(f.storage.get(`${prefix}.history`).map(value=>value.item.id),['safe']);assert.deepEqual(f.storage.get(`${other}.history`),initial[`${other}.history`]);
  f.library.activate('wplay',B);assert.deepEqual([...f.history.keys()],['movie:foreign']);
});

test('late category classification and later writes cannot restore adult history or remove its favorite',()=>{
  const prefix=`orbit.library.v3.wplay.${A}`,protectedItem=item('category',{categoryIds:['reserved']}),safe=item('safe');
  const f=mediaFixture({[`${prefix}.favorites`]:[protectedItem,safe],[`${prefix}.history`]:[progress(protectedItem),progress(safe)]});
  f.library.activate('wplay',A);assert.equal(f.history.size,2);
  f.library.migrate({categories:[{id:'reserved',name:'Reservado',is_adult:true}],items:[protectedItem,safe]});
  assert.deepEqual([...f.history.keys()],['movie:safe']);assert.equal(f.favorites.size,2);
  f.history.set('movie:category',progress(protectedItem));f.history.set('movie:envelope',progress(item('envelope'),{adult:true}));
  f.history.set('series:episode',progress(item('episode',{kind:'series'}),{episode:{id:'ep',isAdult:true}}));f.library.saveHistory();
  assert.deepEqual(f.storage.get(`${prefix}.history`).map(value=>value.item.id),['safe']);assert.equal(f.favorites.size,2);
});

test('authorized legacy import adopts adult favorites but never their history, including old category-only records',()=>{
  const protectedItem=item('reserved',{categoryId:'adult-category'}),safe=item('safe');
  const f=mediaFixture({'orbit.library.v2.wplay.favorites':[protectedItem,safe],'orbit.library.v2.wplay.history':[progress(protectedItem),progress(safe)]});
  f.library.activate('wplay',A);f.library.migrate({categories:[{id:'adult-category',name:'Reservado',isAdult:true}],items:[protectedItem,safe]});
  f.library.importLegacy();assert.deepEqual([...f.favorites.keys()],['movie:reserved','movie:safe']);assert.deepEqual([...f.history.keys()],['movie:safe']);
  assert.deepEqual(f.storage.get(`orbit.library.v3.wplay.${A}.history`).map(value=>value.item.id),['safe']);
});

test('current metadata cannot erase the old category evidence supplied to the account policy',()=>{
  const categories=[{id:'reserved',isAdult:true}],f=mediaFixture({}, {canRemember:value=>!isAdultItem(value,categories)});
  const current=item('1',{categoryId:'safe'}),previous={...current,categoryId:'reserved'};
  f.library.activate('wplay',A);f.library.migrate({items:[current],categories});
  f.history.set('movie:1',progress(previous));f.library.saveHistory();assert.equal(f.history.size,0);
});

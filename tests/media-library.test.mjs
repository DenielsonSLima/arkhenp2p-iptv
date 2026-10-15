import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaLibrary } from '../web/media-library.js';
import { rememberedTitles } from '../web/catalog-pagination.js';

function fixture(initial={}) {
  const storage=new Map(Object.entries(structuredClone(initial))),favorites=new Map(),history=new Map();
  const library=new MediaLibrary({favorites,history,read:(key,fallback)=>structuredClone(storage.has(key)?storage.get(key):fallback),save:(key,value)=>storage.set(key,structuredClone(value))});
  return {library,storage,favorites,history};
}

test('saved OTT IDs and progress never enter the native provider library',()=>{
  const {library,favorites,history}=fixture();
  library.activate('wplay-ott');
  const old={id:'309206683028',kind:'series',name:'Título do player antigo',poster:'/api/image?ref=old'};
  favorites.set('series:'+old.id,old);history.set('series:'+old.id,{item:old,time:200,duration:1800,updated:10});
  library.saveFavorites();library.saveHistory();
  library.activate('wplay');assert.equal(favorites.size,0);assert.equal(history.size,0);
  assert.deepEqual(rememberedTitles(()=>({pagination:{mode:'category'},itemMap:new Map()}),favorites,history),[]);
  library.activate('wplay-ott');assert.equal(favorites.size,1);assert.equal(history.values().next().value.time,200);
  assert.equal(favorites.values().next().value.poster,'');
});

test('legacy migration requires current ID, kind and title while retaining unmatched legacy data',()=>{
  const legacy=[{id:'11',kind:'movie',name:'Cinema',poster:'/api/image?ref=old'},{id:'12',kind:'series',name:'Série antiga'}];
  const {library,storage,favorites,history}=fixture({'orbit.favorites.v1':legacy,'orbit.history.v1':[{item:legacy[0],time:420,duration:3600,updated:10}]});
  library.activate('wplay');assert.equal(favorites.size,0);assert.equal(history.size,0);
  library.migrate({items:[{id:'12',kind:'series',name:'Outra série'},{id:'11',kind:'series',name:'Cinema'}]});
  assert.equal(favorites.size,0);
  library.migrate({items:[{id:'11',kind:'movie',name:'CINEMA',poster:'/api/image?ref=current'}]});
  assert.equal(favorites.size,1);assert.equal(favorites.get('movie:11').name,'CINEMA');assert.equal(favorites.get('movie:11').poster,'');
  assert.equal(history.get('movie:11').time,420);assert.deepEqual(storage.get('orbit.favorites.v1'),legacy);
});

test('late category pages can adopt legacy history but never recreate a removed migrated favorite',()=>{
  const item={id:'42',name:'Série',kind:'series'};
  const {library,favorites,history,storage}=fixture({'orbit.favorites.v1':[item],'orbit.history.v1':[{item,time:300,duration:900,updated:1}]});
  library.activate('wplay');library.migrate({items:[]});assert.equal(history.size,0);
  library.migrate({items:[item]});assert.equal(history.size,1);assert.equal(favorites.size,1);
  favorites.clear();library.saveFavorites();library.activate('wplay');library.migrate({items:[item]});
  assert.equal(favorites.size,0);assert.equal(history.size,1);
  assert.deepEqual(storage.get('orbit.favorites.v1'),[item]);
});

test('migration keeps newer provider-specific progress and does not persist obsolete image refs',()=>{
  const item={id:'1',name:'Filme',kind:'movie'},newer={item:{...item,poster:'/api/image?ref=old-saved'},time:900,updated:100};
  const {library,history,storage}=fixture({'orbit.history.v1':[{item,time:20,updated:1}],'orbit.library.v2.wplay.history':[newer]});
  library.activate('wplay');library.migrate({items:[item]});library.saveHistory();
  assert.equal(history.get('movie:1').time,900);
  assert.equal(storage.get('orbit.library.v2.wplay.history')[0].item.poster,'');
});

const accountA='a'.repeat(64),accountB='b'.repeat(64);
const film={id:'1',name:'Filme',kind:'movie'};

test('accounts sharing one provider have separate favorites and playback history',()=>{
  const {library,favorites,history,storage}=fixture();
  library.activate('wplay',accountA);favorites.set('movie:1',film);history.set('movie:1',{item:film,time:500,updated:1});library.saveFavorites();library.saveHistory();
  library.activate('wplay',accountB);assert.equal(favorites.size,0);assert.equal(history.size,0);
  const series={id:'2',kind:'series',name:'Série B'};favorites.set('series:2',series);library.saveFavorites();
  library.activate('wplay',accountA);assert.deepEqual([...favorites.keys()],['movie:1']);assert.equal(history.get('movie:1').time,500);
  assert.equal(history.get('movie:1').libraryId,accountA);assert.equal(storage.get(`orbit.library.v3.wplay.${accountA}.history`)[0].libraryId,accountA);
  library.activate('wplay-ott',accountA);assert.equal(favorites.size,0);assert.equal(history.size,0);
});

test('untagged provider and global legacy records are never assigned to an account automatically',()=>{
  const initial={'orbit.favorites.v1':[film],'orbit.history.v1':[{item:film,time:10}],
    'orbit.library.v2.wplay.favorites':[film],'orbit.library.v2.wplay.history':[{item:film,time:200}]};
  const {library,favorites,history,storage}=fixture(initial);
  for(const account of [accountA,accountB]){
    library.activate('wplay',account);library.migrate({items:[film]});assert.equal(favorites.size,0);assert.equal(history.size,0);
    assert.deepEqual(library.legacySummary(),{available:true,favorites:1,history:1,authorized:false});
  }
  for(const [name,value] of Object.entries(initial))assert.deepEqual(storage.get(name),value);
});

test('only exact account-tagged history migrates automatically, even beside newer untagged history',()=>{
  const initial={'orbit.library.v2.wplay.history':[{item:film,time:600,libraryId:accountA,updated:5}],
    'orbit.history.v1':[{item:film,time:900,updated:10},{item:{id:'2',name:'Outro',kind:'movie'},time:300,libraryId:accountB}]};
  const {library,favorites,history}=fixture(initial);
  library.activate('wplay',accountA);assert.equal(favorites.size,0);assert.equal(history.size,1);assert.equal(history.get('movie:1').time,600);
  history.clear();library.saveHistory();library.activate('wplay',accountA);assert.equal(history.size,0,'A removed migrated record stays removed');
  library.activate('wplay',accountB);assert.equal(history.size,1);assert.equal(history.get('movie:2').time,300);
});

test('explicit import copies only real matching titles and follows later pages without recreating removals',()=>{
  const late={id:'2',kind:'series',name:'Série'},mismatch={id:'3',kind:'movie',name:'Outro filme'};
  const initial={'orbit.library.v2.wplay.favorites':[film,late,mismatch],
    'orbit.library.v2.wplay.history':[{item:film,time:700,updated:1},{item:late,time:100,updated:1}]};
  const {library,favorites,history,storage}=fixture(initial);
  library.activate('wplay',accountA);library.migrate({items:[film,{...mismatch,name:'Não é o mesmo título'}]});assert.equal(favorites.size,0);
  assert.deepEqual(library.importLegacy(),{favorites:1,history:1,pending:3});assert.equal(history.get('movie:1').libraryId,accountA);assert.equal(library.legacySummary().available,false);
  favorites.clear();history.clear();library.saveFavorites();library.saveHistory();
  library.activate('wplay',accountA);library.migrate({items:[film,late]});assert.deepEqual([...favorites.keys()],['series:2']);assert.deepEqual([...history.keys()],['series:2']);
  library.importLegacy();assert.equal(favorites.has('movie:1'),false);assert.equal(history.has('movie:1'),false);
  library.activate('wplay',accountB);library.migrate({items:[film,late]});assert.equal(favorites.size,0);assert.equal(history.size,0);
  for(const [name,value] of Object.entries(initial))assert.deepEqual(storage.get(name),value);
});

test('scoped import excludes history proven to belong to another account and preserves newer scoped records',()=>{
  const {library,favorites,history}=fixture({'orbit.library.v2.wplay.favorites':[film],
    'orbit.library.v2.wplay.history':[{item:film,time:300,libraryId:accountB}],
    [`orbit.library.v3.wplay.${accountA}.history`]:[{item:film,time:800,libraryId:accountA}]});
  library.activate('wplay',accountA);library.migrate({items:[film]});library.importLegacy();assert.equal(favorites.size,1);assert.equal(history.get('movie:1').time,800);
});

test('a missing or invalid account identity keeps the existing v2 compatibility contract',()=>{
  const {library,favorites}=fixture({'orbit.favorites.v1':[film]});
  for(const identity of [undefined,'', 'masked-user', 'a'.repeat(63)]){
    library.activate('wplay',identity);assert.equal(library.prefix,'orbit.library.v2.wplay');assert.equal(library.legacySummary().available,false);
    library.migrate({items:[film]});assert.equal(favorites.size,1);library.saveFavorites();
  }
  library.activate('wplay',accountA.toUpperCase());assert.equal(library.prefix,`orbit.library.v3.wplay.${accountA}`);
});

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

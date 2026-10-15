import test from 'node:test';
import assert from 'node:assert/strict';
import {ADULT_CATEGORY,DAILY_GAMES_CATEGORY,RELEASES_CATEGORY,defaultCatalogCategory,orderCatalogCategories,releaseCatalogCategory} from '../web/catalog-navigation.js';

const all=Object.freeze({id:'__all',name:'Todos',count:20});
const favorites=Object.freeze({id:'__favorites',name:'Favoritos',count:3});
const action=Object.freeze({id:'acao',name:'Ação',ids:new Set(['80','900']),count:5});
const release=Object.freeze({id:'lancamentos',name:'Lançamentos',ids:new Set(['50','600']),count:10});
const custom=Object.freeze({id:'custom:personal',name:'Lançamentos',count:2});
const adult=Object.freeze({id:ADULT_CATEGORY,name:'Adulto',protected:true,locked:true,count:0});

test('movies and series pin Favorites, native Releases and All; other categories stay alphabetic and Adult stays last',()=>{
  const groups=Object.freeze([all,adult,favorites,custom,action,release]);
  for(const type of ['movies','series']){
    const ordered=orderCatalogCategories(type,groups);
    assert.deepEqual(ordered.map(group=>group.id),['__favorites','lancamentos','__all','acao','custom:personal',ADULT_CATEGORY]);
    assert.equal(ordered[1],release);assert.equal(ordered[1].ids,release.ids);
    assert.equal(defaultCatalogCategory(type,groups),'__favorites');
    assert.equal(defaultCatalogCategory(type,groups,{favoritesCount:0}),'lancamentos');
  }
  assert.deepEqual(groups.map(group=>group.id),['__all',ADULT_CATEGORY,'__favorites','custom:personal','acao','lancamentos']);
});

test('release defaults recognize provider accents and decoration without replacing native IDs',()=>{
  for(const [name,id]of [['FILMES/LANÇAMENTOS','50'],['Séries | Estréias','1010'],['★ Lançamento 2026','release-2026'],['Filmes - Estreia','90']]){
    const group={id,name,ids:new Set([id,`${id}-second`]),unloaded:true};
    assert.equal(defaultCatalogCategory('movies',[all,favorites,group],{favoritesCount:0}),id);
    assert.equal(orderCatalogCategories('movies',[all,favorites,group])[1],group);
  }
});

test('native releases take precedence over a previous fallback, and other distinct provider categories remain usable',()=>{
  const fallback={id:RELEASES_CATEGORY,name:'Lançamentos',fallback:true},premieres={id:'estreias',name:'Estreias'};
  assert.equal(releaseCatalogCategory([fallback,premieres,release]),release);
  assert.deepEqual(orderCatalogCategories('movies',[all,favorites,fallback,action,release,premieres]).map(group=>group.id),['__favorites','lancamentos','__all','acao','estreias']);
});

test('missing native releases use a single fallback view without repurposing personal or unrelated categories',()=>{
  for(const name of ['Novelas','Estreias do terror','Lançamentos adultos','O último lançamento','Lançamentos favoritos']){
    const groups=[all,{...favorites,count:0},custom,{id:'other',name}];
    assert.equal(defaultCatalogCategory('movies',groups),RELEASES_CATEGORY);
    const ordered=orderCatalogCategories('movies',groups);
    assert.deepEqual(ordered.slice(0,3).map(group=>group.id),['__favorites',RELEASES_CATEGORY,'__all']);
    assert.equal(ordered.filter(group=>group.id===RELEASES_CATEGORY).length,1);
    assert.equal(ordered.find(group=>group.id===custom.id),custom);
  }
  assert.equal(defaultCatalogCategory('movies',[]),RELEASES_CATEGORY);
});

test('live opens favorites when present, otherwise All, and never generates a Releases view',()=>{
  assert.deepEqual(orderCatalogCategories('live',[all,adult,action,favorites,release]).map(group=>group.id),['__favorites','__all','acao','lancamentos',ADULT_CATEGORY]);
  assert.equal(orderCatalogCategories('live',[all,favorites]).some(group=>group.id===RELEASES_CATEGORY),false);
  assert.equal(defaultCatalogCategory('live',[all,favorites,action]),'__favorites');
  assert.equal(defaultCatalogCategory('live',[all,favorites,action],{favoritesCount:0}),'__all');
  assert.equal(defaultCatalogCategory('live',[all,{...favorites,count:0}],{favoritesCount:2}),'__favorites');
  assert.equal(defaultCatalogCategory('live',[all,action],{favoritesCount:2}),'__all');
  for(const count of [0,-1,NaN,Infinity,'invalid'])assert.equal(defaultCatalogCategory('live',[all,favorites],{favoritesCount:count}),'__all');
});

test('live games are an explicit utility category and do not disturb alphabetical provider categories',()=>{
  const games={id:DAILY_GAMES_CATEGORY,name:'Jogos de hoje',utility:'games'},groups=[release,games,adult,action,all,favorites];
  assert.deepEqual(orderCatalogCategories('live',groups).map(group=>group.id),['__favorites','__all','__games','acao','lancamentos',ADULT_CATEGORY]);
  assert.equal(orderCatalogCategories('live',groups)[2],games);
});

test('categories are deduplicated by ID while native IDs and personal collections remain unchanged',()=>{
  const duplicate={...release,name:'Outra cópia'},raw={id:80,name:'Drama',ids:new Set(['raw-80'])};
  assert.deepEqual(orderCatalogCategories('series',[all,favorites,release,duplicate,action,raw,{id:'80',name:'Drama repetido'}]),[favorites,release,all,action,raw]);
});

test('Portuguese labels sort with accents, decorations and numeric ordering after pinned entries',()=>{
  const groups=[{id:'z',name:'Zona'},{id:'c10',name:'Canal 10'},{id:'c2',name:'Canal 2'},{id:'a',name:'★ Filmes / Ação'},{id:'ag',name:'Água'},{id:'co',name:'Comédia'}];
  for(const type of ['live','movies','series'])assert.deepEqual(orderCatalogCategories(type,[all,favorites,...groups]).map(group=>group.id),['__favorites',...(type==='live'?[]:[RELEASES_CATEGORY]),'__all','a','ag','c2','c10','co','z']);
});

test('adult source flag is sufficient for last position even when the provider uses an opaque label',()=>{
  const flagged={id:'99',name:'VIP',isAdult:true};
  const ordered=orderCatalogCategories('movies',[flagged,all,release,favorites,{id:'z',name:'Zona'}]);
  assert.equal(ordered.at(-1),flagged);
  assert.notEqual(defaultCatalogCategory('movies',[{...flagged,name:'Lançamentos'},all]),'99');
  const legacy={id:'custom:old',name:'XXX'};
  assert.equal(orderCatalogCategories('movies',[adult,all,favorites,release,legacy]).at(-1),adult);
});

test('non-catalog contexts keep source ordering and never choose a release default',()=>{
  const groups=[all,action,favorites,release];
  for(const type of ['home','favorites','search',undefined]){
    assert.deepEqual(orderCatalogCategories(type,groups),groups);assert.notEqual(orderCatalogCategories(type,groups),groups);
    assert.equal(defaultCatalogCategory(type,groups),'__all');
  }
});

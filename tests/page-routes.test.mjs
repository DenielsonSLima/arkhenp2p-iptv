import test from 'node:test';
import assert from 'node:assert/strict';
import { contentRoute, parseContentRoute, fallbackContentRoute, catalogView, restoreCatalogPosition } from '../web/page-routes.js';

test('movie and series previews retain their identity when opening and returning from playback',()=>{
  for(const item of [{kind:'movie',id:'234'},{kind:'series',id:'987654321000'}]){
    const preview=contentRoute('preview',item),watch=contentRoute('watch',item,item.kind==='series'?{id:'456'}:null);
    const route=parseContentRoute(watch);assert.equal(route.kind,item.kind);assert.equal(route.id,item.id);assert.equal(route.episodeId,item.kind==='series'?'456':null);assert.equal(fallbackContentRoute(route),preview);
  }
});

test('live playback returns to the catalog and never creates a movie preview for a channel',()=>{
  const watch=contentRoute('watch',{kind:'live',id:'55'});assert.equal(fallbackContentRoute(parseContentRoute(watch)),'#live');assert.equal(fallbackContentRoute(parseContentRoute('#preview/movie/123')),'#home');assert.throws(()=>contentRoute('preview',{kind:'live',id:'55'}));
});

test('a catalog URL wins over a stale home snapshot when closing live playback',()=>{
  const home={view:'home',category:'outros',query:'antiga',visibleLimit:96,scrollY:900};
  assert.equal(catalogView('#live'),'live');
  assert.deepEqual(restoreCatalogPosition('#live',home,home),{view:'live',category:'__all',genre:'__all',query:'',visibleLimit:48,scrollY:0});
  assert.equal(catalogView('#watch/live/3797'),null);
  assert.equal(catalogView('#live?invalid'),null);
});

test('returning to the same catalog retains its filters and scroll, not another section state',()=>{
  const movies={view:'movies',category:'lancamentos',genre:'acao',query:'',visibleLimit:96,scrollY:600};
  assert.deepEqual(restoreCatalogPosition('#movies',movies),movies);
  assert.deepEqual(restoreCatalogPosition('#movies',{view:'home',scrollY:500},movies),movies);
  assert.equal(restoreCatalogPosition('#home',movies).view,'home');
  assert.equal(restoreCatalogPosition('',null,{view:'series'}).view,'series');
});

test('movie and series returns preserve the genre intersecting the selected category',()=>{
  for(const view of ['movies','series']){
    const saved={view,category:'__favorites',genre:'drama',query:'',visibleLimit:144,scrollY:780};
    assert.deepEqual(restoreCatalogPosition('#'+view,saved),saved);
    assert.deepEqual(restoreCatalogPosition('',saved),saved);
    assert.equal(saved.genre,'drama');
  }
});

test('older history without a genre restores all genres and never borrows another catalog filter',()=>{
  const legacy={view:'movies',category:'lancamentos',query:'',visibleLimit:96,scrollY:640};
  const unrelated={view:'series',category:'__favorites',genre:'terror',query:'',visibleLimit:48,scrollY:200};
  assert.deepEqual(restoreCatalogPosition('#movies',unrelated,legacy),{...legacy,genre:'__all'});
  assert.equal(restoreCatalogPosition('#live',unrelated).genre,'__all');
  assert.equal(restoreCatalogPosition('#movies',{...legacy,genre:''}).genre,'__all');
});

test('deep links reject invalid identifiers and episodes attached to the wrong content kind',()=>{
  for(const hash of ['#preview/live/1','#preview/movie/1/2','#watch/movie/1/2','#watch/live/1/2','#watch/series/abc/2','#watch/series/1234567890123/2','#watch/series/1/../../2','#preview/movie/1?password=secret','#settings/profile'])assert.equal(parseContentRoute(hash),null);
  assert.throws(()=>contentRoute('watch',{kind:'series',id:'1'},{id:'../2'}));assert.throws(()=>contentRoute('watch',{kind:'movie',id:'not-a-number'}));
});

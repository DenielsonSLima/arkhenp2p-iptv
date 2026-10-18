import test from 'node:test';
import assert from 'node:assert/strict';
import {homeRecommendations} from './fixtures/home-recommendations-legacy.js';

const movie = (id, extra = {}) => ({id:String(id), kind:'movie', name:`Filme ${id}`, rating:8, ...extra});
const series = (id, extra = {}) => ({id:String(id), kind:'series', name:`Série ${id}`, rating:8, ...extra});
const seen = (item, updated = 1, extra = {}) => ({item, time:120, updated, ...extra});
const ids = result => result.items.map(item => `${item.kind}:${item.id}`);

test('new accounts see real highly rated movies and series, interleaved by type', () => {
  const result = homeRecommendations({movies:[movie(1, {rating:7}), movie(2, {rating:9})], series:[series(1, {rating:9.5}), series(2, {rating:8.5})]});
  assert.deepEqual(ids(result), ['series:1', 'movie:2', 'series:2', 'movie:1']);
  assert.equal(result.personalized, false);
});

test('only valid ratings from 7 to 10 qualify, including a real comma decimal', () => {
  const ratings = [null, undefined, '', 'N/A', '7/10', '80%', true, Infinity, NaN, 0, 6.99, 10.1, -8, '7,4', 7, 10];
  const result = homeRecommendations({movies:ratings.map((rating, index) => movie(index, {rating}))});
  assert.deepEqual(result.items.map(item => item.rating), [10, '7,4', 7]);
});

test('actual watched genres outrank a higher rating and apply across movies and series', () => {
  const watched = movie('watched', {genre:'Filmes/Ação'});
  const result = homeRecommendations({movies:[watched, movie('drama', {rating:10, genre:'Drama'}), movie('action', {rating:7.1, genre:'Action'})], series:[series('drama', {rating:9.8, genre:'Drama'}), series('action', {rating:7, genres:[{name:'Séries/Ação'}]})], history:new Map([['movie:watched', seen({id:watched.id, kind:'movie', name:watched.name})]])});
  assert.deepEqual(ids(result).slice(0, 2), ['movie:action', 'series:action']);
  assert.equal(result.items.includes(watched), false);
  assert.equal(result.personalized, true);
});

test('native category IDs supply genre affinity when history snapshots have no genres', () => {
  const watched = movie('watched', {categoryId:'action'}), match = movie('match', {categoryIds:['launches', 'action']});
  const result = homeRecommendations({movies:[watched, movie('other', {rating:10, genre:'Drama'}), match], movieCatalog:{sourceCategories:[{id:'action', name:'Filmes/Ação'}, {id:'launches', name:'Lançamentos'}]}, history:[seen({id:watched.id, kind:watched.kind, name:watched.name})]});
  assert.deepEqual(ids(result), ['movie:match', 'movie:other']);
  assert.equal(result.personalized, true);
});

test('words in titles, platforms and launch shelves never become a preference', () => {
  const watched = movie('watched', {name:'Drama de ação', genre:'Netflix/Ação', group:'Lançamentos'});
  const result = homeRecommendations({movies:[watched, movie('action', {rating:7, genre:'Action'}), movie('best', {rating:9, genre:'Drama'})], history:[seen(watched)]});
  assert.deepEqual(ids(result), ['movie:best', 'movie:action']);
  assert.equal(result.personalized, false);
});

test('more recent distinct viewing choices carry more affinity than older choices', () => {
  const old = movie('old', {genre:'Drama'}), recent = series('recent', {genre:'Comédia'});
  const result = homeRecommendations({movies:[old, movie('drama', {rating:10, genre:'Drama'}), movie('comedy', {rating:7, genre:'Comédia'})], series:[recent], history:[seen(old, 1), seen(recent, 20)]});
  assert.deepEqual(ids(result), ['movie:comedy', 'movie:drama']);
});

test('brief openings and invalid playback records are not treated as watched choices', () => {
  const brief = movie('brief', {genre:'Drama', rating:7}), other = movie('other', {genre:'Comédia', rating:9});
  for (const extra of [{time:0}, {time:5}, {time:Infinity}, {time:-10}, {updated:0}, {updated:Infinity}]) {
    const result = homeRecommendations({movies:[brief, other], history:[seen(brief, 1, extra)]});
    assert.deepEqual(ids(result), ['movie:other', 'movie:brief']);
    assert.equal(result.personalized, false);
  }
});

test('watched quality/audio copies are excluded, recommendation copies collapse and remakes remain distinct', () => {
  const watched = movie('watched', {name:'Título (2025) HD'});
  const result = homeRecommendations({movies:[watched, movie('copy', {name:'Título DUB (2025) FHD', rating:10}), movie('remake', {name:'Título (2000)', rating:9}), movie('a', {name:'Outro título [4K] (2026) DUAL', rating:8}), movie('b', {name:'Outro título (2026) HD', rating:8.5})], history:[seen(watched)]});
  assert.deepEqual(ids(result), ['movie:remake', 'movie:b']);
});

test('one watched work represented by several quality variants does not inflate genre affinity', () => {
  const oldA = movie('old-a', {name:'Assistido HD', genre:'Drama'}), oldB = movie('old-b', {name:'Assistido FHD', genre:'Drama'}), recent = movie('recent', {genre:'Comédia'});
  const result = homeRecommendations({movies:[oldA, oldB, recent, movie('drama', {rating:10, genre:'Drama'}), movie('comedy', {rating:7, genre:'Comédia'})], history:[seen(oldA, 1), seen(oldB, 2), seen(recent, 3)]});
  assert.deepEqual(ids(result), ['movie:comedy', 'movie:drama']);
});

test('removed or hidden history cannot supply stale taste metadata or hidden candidates', () => {
  const hidden = movie('hidden', {genre:'Drama', rating:10});
  const result = homeRecommendations({movies:[movie('drama', {genre:'Drama', rating:7}), movie('best', {genre:'Comédia', rating:9})], movieCatalog:{items:[hidden]}, history:[seen(hidden)]});
  assert.deepEqual(ids(result), ['movie:best', 'movie:drama']);
  assert.equal(result.personalized, false);
});

test('favorites remain eligible when unwatched, same names across types stay separate and sparse types use actual available titles', () => {
  const favorite = movie('favorite', {name:'Homônimo', savedAt:100}), show = series('show', {name:'Homônimo'});
  const result = homeRecommendations({movies:[favorite, movie('second'), movie('third')], series:[show], limit:30});
  assert.deepEqual(ids(result), ['movie:favorite', 'series:show', 'movie:second', 'movie:third']);
  assert.equal(result.items[0], favorite);
});

test('the default limit is 30, bounded custom limits work and malformed collections add no manufactured titles', () => {
  const movies = Array.from({length:40}, (_, index) => movie(index));
  assert.equal(homeRecommendations({movies}).items.length, 30);
  assert.equal(homeRecommendations({movies, limit:3.8}).items.length, 3);
  assert.deepEqual(homeRecommendations({movies, limit:0}), {items:[], personalized:false});
  assert.deepEqual(homeRecommendations({movies:null, series:[null, {}, {id:1, name:'Canal', kind:'live', rating:10}], history:{bad:'shape'}}), {items:[], personalized:false});
});

test('supplied objects and ordering remain untouched and results retain actual catalog objects', () => {
  const watched = Object.freeze(movie('watched', {genre:'Drama'})), first = Object.freeze(movie('first', {genre:'Drama'})), second = Object.freeze(movie('second', {rating:9}));
  const movies = Object.freeze([second, watched, first]), history = Object.freeze([Object.freeze(seen(watched))]);
  const before = structuredClone({movies, history});
  const result = homeRecommendations({movies, history});
  assert.equal(result.items[0], first);
  assert.deepEqual({movies, history}, before);
});

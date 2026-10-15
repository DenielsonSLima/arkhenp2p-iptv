import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogGenres} from '../web/catalog-genres.js';

const movie = (id, extra = {}) => ({id:String(id), kind:'movie', name:`Título ${id}`, ...extra});
const choice = (index, id) => index.choices.find(item => item.id === id);

test('real native tag metadata supplies every known genre without opening its category', () => {
  const item = movie(1, {genre:'Filmes/Ação, Filmes/Comédia, Filmes/Aventura, Filmes/Lançamentos, PrimeVideo/PrimeVideos', categoryId:'releases'});
  const index = catalogGenres({items:[item], sourceCategories:[{id:'releases', name:'Lançamentos'}]});
  assert.deepEqual(index.choices.map(item => item.name), ['Todos', 'Ação', 'Aventura', 'Comédia']);
  for (const genre of ['acao', 'aventura', 'comedia']) assert.equal(index.matches(item, genre), true);
  assert.equal(index.matches(item, 'drama'), false);
  assert.equal(index.matches(item, '__all'), true);
});

test('accent, case, singular and known equivalent names collapse to one real choice', () => {
  const item = movie(1, {genre:'FILMES/ACAO, filmes/Ação, Action, COMÉDIAS, comedia, Filmes/Documentários, Documentary'});
  const index = catalogGenres({items:[item]});
  assert.equal(choice(index, 'acao').count, 1);
  assert.equal(choice(index, 'comedia').count, 1);
  assert.equal(choice(index, 'documentario').count, 1);
  assert.equal(index.choices.length, 4);
});

test('provider shelves, platforms, years, quality and unrelated taxonomy paths never become genres', () => {
  const item = movie(1, {name:'Drama de ação e terror', genre:'Filmes/Lançamentos, Filmes/Netflix, Filmes/2026, Filmes/4K, PrimeVideo/Drama, Netflix/Ação, English/Comédia, Filmes/Drama/2026, Desconhecido', group:'Lançamentos', groupNames:['HBO Max', 'Top 10']});
  const index = catalogGenres({items:[item]});
  assert.deepEqual(index.choices, [{id:'__all', name:'Todos', count:1}]);
  assert.deepEqual(index.genreIdsFor(item), []);
});

test('real raw category IDs and all normalized category memberships supply a metadata fallback', () => {
  const action = movie(1, {categoryId:'native-action', group:'Lançamentos'});
  const many = movie(2, {categoryId:'releases', categoryIds:['releases', 'native-drama', 'native-comedy']});
  const index = catalogGenres({items:[action, many], sourceCategories:[{id:'native-action', name:'Filmes/Ação'}], categories:[
    {id:'drama', name:'Drama', ids:new Set(['native-drama'])}, {id:'comedia', name:'Comédia', ids:['native-comedy']},
    {id:'releases', name:'Lançamentos'}
  ]});
  assert.equal(index.matches(action, 'acao'), true);
  assert.equal(index.matches(many, 'drama'), true);
  assert.equal(index.matches(many, 'comedia'), true);
  assert.equal(index.matches(many, 'acao'), false);
  assert.deepEqual(index.genreIdsFor(many), ['drama', 'comedia']);
});

test('choice counts only visible supplied titles and does not expose unloaded or hidden genres', () => {
  const visible = movie(1, {genre:'Ação'}), hidden = movie(2, {genre:'Terror'}), unknown = movie(3);
  const catalog = {items:[visible, hidden, unknown], sourceCategories:[{id:'unloaded', name:'Drama'}]};
  const index = catalogGenres(catalog, {items:[visible, unknown]});
  assert.deepEqual(index.choices, [{id:'__all', name:'Todos', count:2}, {id:'acao', name:'Ação', count:1}]);
});

test('genre filtering intersects releases, favorites and platform shelves rather than replacing them', () => {
  const release = movie(1, {genre:'Filmes/Ação, Filmes/Lançamentos', groupKeys:['releases']}),
    archive = movie(2, {genre:'Filmes/Ação', groupKeys:['archive']}),
    comedy = movie(3, {genre:'Filmes/Comédia', groupKeys:['releases']}),
    platform = movie(4, {genre:'Filmes/Ação, Netflix/Filmes', groupKeys:['netflix']});
  const index = catalogGenres({items:[release, archive, comedy, platform]});
  const filter = items => items.filter(item => index.matches(item, 'acao')).map(item => item.id);
  assert.deepEqual(filter([release, archive, comedy, platform].filter(item => item.groupKeys.includes('releases'))), ['1']);
  assert.deepEqual(filter([archive, comedy]), ['2']);
  assert.deepEqual(filter([platform]), ['4']);
  assert.equal(choice(index, 'acao').count, 3);
});

test('duplicate categories and title snapshots count a genre once while equal IDs in different media types stay distinct', () => {
  const items = [movie(1, {genre:'Ação, Ação', groupNames:['Ação']}), movie(1, {genre:'Drama'}), {id:'1', kind:'series', name:'Outra obra', genre:'Séries/Ação'}, {id:'2', kind:'live', name:'Canal', genre:'Ação'}];
  const index = catalogGenres({items});
  assert.equal(choice(index, '__all').count, 2);
  assert.equal(choice(index, 'acao').count, 2);
  assert.equal(choice(index, 'drama').count, 1);
});

test('fresh catalogue snapshots reveal genuinely arriving genres with no cached or invented memberships', () => {
  const before = {items:[movie(1, {genre:'Drama'})], sourceCategories:[{id:'late', name:'Comédia'}]};
  assert.equal(choice(catalogGenres(before), 'comedia'), undefined);
  const late = movie(2, {categoryId:'late'}), after = {...before, items:[...before.items, late]};
  assert.equal(choice(catalogGenres(after), 'comedia').count, 1);
  assert.equal(catalogGenres(after).matches(late, 'comedia'), true);
});

test('explicit genre arrays and supplied group names are supported without changing item objects', () => {
  const item = Object.freeze(movie(1, {genres:Object.freeze(['Séries/Fantasia', Object.freeze({name:'Mistério'})]), group:'Lançamentos', groupNames:Object.freeze(['Filmes - Ficção Científica'])}));
  const items = Object.freeze([item]), catalog = Object.freeze({items});
  const index = catalogGenres(catalog), returned = index.genreIdsFor(item);
  assert.deepEqual(returned, ['fantasia', 'misterio', 'ficcao-cientifica']);
  returned.length = 0;
  assert.equal(index.matches(item, 'fantasia'), true);
  assert.equal(items[0], item);
});

test('empty and malformed metadata do not add fake genre choices', () => {
  assert.deepEqual(catalogGenres(null).choices, [{id:'__all', name:'Todos', count:0}]);
  const item = movie(1, {genre:{unexpected:'Ação'}, genres:[null, false, 1], categoryIds:null, groupNames:[{}, false]});
  const index = catalogGenres({items:[null, item, {name:'Missing ID'}], categories:[null]});
  assert.deepEqual(index.choices, [{id:'__all', name:'Todos', count:1}]);
  assert.equal(index.matches(item, 'unknown'), false);
});

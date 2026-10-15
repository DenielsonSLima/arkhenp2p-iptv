import test from 'node:test';
import assert from 'node:assert/strict';
import { globalSearchPageChoices, normalizeSearchText, searchCatalogs } from '../web/global-search.js';

const complete = items => ({items, categories:[]});
const paged = (items, states) => ({items, categories:[], pagination:{mode:'category', byCategory:states}});
const next = (page = 1) => ({nextPage:page, loaded:page > 1, hasMore:true});
const allCatalogs = (overrides = {}) => new Map(Object.entries({live:complete([]), movies:complete([]), series:complete([]), ...overrides}));

test('global search matches accents, case and multiple words across channels, movies and series', () => {
  const catalogs = allCatalogs({
    live:complete([{id:'1', name:'SÃO PAULO TV', kind:'live'}]),
    movies:complete([{id:'2', name:'São Paulo: uma história', kind:'movie'}]),
    series:complete([{id:'3', name:'Histórias de São Paulo', kind:'series'}])
  });
  const result = searchCatalogs(catalogs, '  sao   PAULO ');
  assert.equal(normalizeSearchText('  SÉRIES  '), 'series');
  assert.deepEqual(result.items.map(item => item.id), ['1','2','3']);
  assert.deepEqual(result.counts, {live:1, movie:1, series:1});
  assert.equal(result.partial, false);
  assert.equal(searchCatalogs(catalogs, 'paulo historias').items.length, 1);
  assert.equal(searchCatalogs(catalogs, '   ').items.length, 0);
});

test('matching titles rank before category matches, exact names before prefixes, with stable numeric title order', () => {
  const catalogs = allCatalogs({movies:complete([
    {id:'1', name:'Outro título', group:'Dramas de ação', kind:'movie'},
    {id:'2', name:'Ação 10', kind:'movie'},
    {id:'3', name:'Ação', kind:'movie'},
    {id:'4', name:'Ação 2', kind:'movie'},
    {id:'5', name:'Um filme de ação', kind:'movie'}
  ])});
  assert.deepEqual(searchCatalogs(catalogs, 'acao').items.map(item => item.id), ['3','4','2','5','1']);
});

test('duplicates collapse by type and ID while a movie and a channel may share an ID', () => {
  const movie = {id:'1', name:'Filme especial', kind:'movie'};
  const catalogs = allCatalogs({live:complete([{id:'1', name:'Especial TV', kind:'live'}]), movies:complete([movie, {...movie}]), series:complete([{id:'1', name:'Especial', kind:'series'}])});
  const result = searchCatalogs(catalogs, 'especial');
  assert.equal(result.items.length, 3);
  assert.deepEqual(result.counts, {live:1, movie:1, series:1});
  assert.equal(result.items.find(item => item.kind === 'movie'), movie);
});

test('missing catalogs and unfinished allowed categories keep counts explicitly partial', () => {
  const catalogs = new Map([
    ['live', complete([{id:'1', name:'Ação TV', kind:'live'}])],
    ['movies', paged([{id:'2', name:'Ação', kind:'movie'}], {drama:next(), hidden:next(), complete:{hasMore:false, loaded:true, nextPage:2}})]
  ]);
  const result = searchCatalogs(catalogs, 'acao', {isCategoryAllowed:(_, id) => id !== 'hidden'});
  assert.equal(result.items.length, 2);
  assert.equal(result.partial, true);
  assert.deepEqual(result.missingTypes, ['series']);
  assert.deepEqual(result.partialTypes, ['movies','series']);
  assert.equal(result.remainingCategories, 1);
  assert.equal(searchCatalogs(allCatalogs({movies:paged([], {hidden:next()})}), 'inexistente', {isCategoryAllowed:() => false}).partial, false);
});

test('hidden titles never enter results and search does not mutate catalog snapshots', () => {
  const catalogs = allCatalogs({movies:complete([{id:'1', name:'Filme', kind:'movie'}, {id:'2', name:'Filme oculto', kind:'movie'}])});
  const before = structuredClone(catalogs);
  assert.deepEqual(searchCatalogs(catalogs, 'filme', {isItemVisible:item => item.id !== '2'}).items.map(item => item.id), ['1']);
  assert.deepEqual(catalogs, before);
});

test('page expansion balances catalog types, respects hidden categories and never exceeds four requests', () => {
  const catalogs = allCatalogs({
    movies:paged([], {1:next(2), 2:next(), 3:next(), 4:next(), hidden:next()}),
    series:paged([], {10:next(3), 11:next(), 12:next()})
  });
  const options = {isCategoryAllowed:(_, id) => id !== 'hidden', limit:100};
  assert.deepEqual(globalSearchPageChoices(catalogs, options), [
    {type:'movies', category:'2', page:1}, {type:'series', category:'11', page:1},
    {type:'movies', category:'3', page:1}, {type:'series', category:'12', page:1}
  ]);
  assert.equal(globalSearchPageChoices(catalogs, {...options, limit:0}).length, 0);
  assert.equal(globalSearchPageChoices(catalogs, {...options, limit:1}).length, 1);
  assert.deepEqual(globalSearchPageChoices(allCatalogs()), []);
});

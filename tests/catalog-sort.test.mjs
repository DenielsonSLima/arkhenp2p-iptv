import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSortMode, sortCatalogItems} from '../web/catalog-sort.js';

test('saved rating, name and date modes survive normalization, unknown values use recent additions', () => {
  for (const mode of ['name', 'date', 'rating']) assert.equal(normalizeSortMode(mode), mode);
  for (const mode of [undefined, null, '', 'random', {}, true]) assert.equal(normalizeSortMode(mode), 'date');
});

test('rating sorts highest first and understands numeric scores plus decimal commas and points', () => {
  const items = [
    {id:'comma', name:'Vírgula', rating:'8,7'},
    {id:'decimal', name:'Decimal', rating:'9.25'},
    {id:'integer', name:'Inteira', rating:10},
    {id:'low', name:'Menor', rating:' 6,5 '}
  ];
  assert.deepEqual(sortCatalogItems(items, 'rating').map(item => item.id), ['integer', 'decimal', 'comma', 'low']);
});

test('unrated placeholders and malformed or out-of-range scores follow every valid rating', () => {
  const unknown = [undefined, null, '', ' ', 0, '0,0', false, true, NaN, Infinity, -1, '-2', 11, '10.1', '8abc', '8/10', {}];
  const items = unknown.map((rating, index) => ({id:String(index), name:`Sem nota ${index}`, rating}));
  const valid = {id:'valid', name:'Z válido', rating:0.1};
  assert.equal(sortCatalogItems([...items, valid], 'rating')[0], valid);
  assert.equal(sortCatalogItems(items, 'rating').length, unknown.length);
});

test('equal ratings keep a deterministic title, type and ID order across arriving pages', () => {
  const items = [
    {id:'10', name:'Árvore', kind:'movie', rating:8},
    {id:'2', name:'Arvore', kind:'movie', rating:'8,0'},
    {id:'2', name:'Árvore', kind:'series', rating:'8.0'},
    {id:'a', name:'Antes', kind:'movie', rating:8},
    {id:'b', name:'Depois', kind:'movie', rating:8}
  ];
  const keys = values => values.map(item => `${item.kind}:${item.id}`);
  const expected = ['movie:a', 'movie:2', 'movie:10', 'series:2', 'movie:b'];
  assert.deepEqual(keys(sortCatalogItems(items, 'rating')), expected);
  assert.deepEqual(keys(sortCatalogItems([...items].reverse(), 'rating')), expected);
});

test('name sorting preserves locale, numeric names and stable equivalent-name ordering', () => {
  const items = [
    {id:'ten', name:'Arvore 10'},
    {id:'two', name:'Árvore 2'},
    {id:'same', name:'arvore 2'},
    {id:'first', name:'Antes'}
  ];
  assert.deepEqual(sortCatalogItems(items, 'name').map(item => item.id), ['first', 'two', 'same', 'ten']);
});

test('recent additions preserve seconds, milliseconds, unknown-last and stable date ties', () => {
  const old = Date.parse('2026-01-01T12:00:00Z'), recent = Date.parse('2026-10-14T12:00:00Z');
  const items = [
    {id:'unknown', name:'Sem data', added:''},
    {id:'old', name:'Anterior', added:String(old / 1000)},
    {id:'recent-ms', name:'Recente ms', added:recent},
    {id:'recent-seconds', name:'Recente segundos', added:String(recent / 1000)},
    {id:'invalid', name:'Inválida', added:'not-a-date'}
  ];
  const expected = ['recent-ms', 'recent-seconds', 'old', 'unknown', 'invalid'];
  assert.deepEqual(sortCatalogItems(items, 'date').map(item => item.id), expected);
  assert.deepEqual(sortCatalogItems(items, undefined).map(item => item.id), expected);
});

test('sorting never changes the input array or title objects', () => {
  const items = Object.freeze([
    Object.freeze({id:'1', name:'B', added:'1', rating:2}),
    Object.freeze({id:'2', name:'A', added:'2', rating:9})
  ]);
  for (const mode of ['name', 'date', 'rating']) {
    const sorted = sortCatalogItems(items, mode);
    assert.notEqual(sorted, items);
    assert.equal(sorted[0], items[1]);
    assert.equal(sorted[1], items[0]);
  }
  assert.deepEqual(items.map(item => item.id), ['1', '2']);
  assert.deepEqual(sortCatalogItems([], 'rating'), []);
});

test('favorite dates can override provider dates and invalid saved dates fall back to additions', () => {
  const items = [
    {id:'provider-new', name:'Novo no provedor', added:200},
    {id:'favorite-new', name:'Novo favorito', added:100},
    {id:'invalid-favorite', name:'Favorito sem data válida', added:150}
  ];
  const saved = new Map([['favorite-new', 300], ['invalid-favorite', 0]]);
  const sorted = sortCatalogItems(items, 'date', {getAdded:item => saved.get(item.id) ?? item.added});
  assert.deepEqual(sorted.map(item => item.id), ['favorite-new', 'provider-new', 'invalid-favorite']);
  assert.equal(sorted[0], items[1]);
  assert.equal(items[1].added, 100);
});

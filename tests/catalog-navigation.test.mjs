import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultCatalogCategory, orderCatalogCategories} from '../web/catalog-navigation.js';

const all = Object.freeze({id:'__all', name:'Todos', count:20});
const favorites = Object.freeze({id:'__favorites', name:'Favoritos', count:3});
const action = Object.freeze({id:'acao', name:'Ação', ids:new Set(['80', '900']), count:5});
const release = Object.freeze({id:'lancamentos', name:'Lançamentos', ids:new Set(['50', '600']), count:10});
const custom = Object.freeze({id:'custom:personal', name:'Lançamentos', count:2});

test('movie and series categories begin with native releases, favorites, all and preserve the remaining order', () => {
  const groups = Object.freeze([all, favorites, custom, action, release]);
  for (const type of ['movies', 'series']) {
    assert.deepEqual(orderCatalogCategories(type, groups).map(group => group.id), ['lancamentos', '__favorites', '__all', 'custom:personal', 'acao']);
    assert.equal(defaultCatalogCategory(type, groups), 'lancamentos');
  }
  assert.deepEqual(groups.map(group => group.id), ['__all', '__favorites', 'custom:personal', 'acao', 'lancamentos']);
  const ordered = orderCatalogCategories('movies', groups);
  assert.equal(ordered[0], release);
  assert.equal(ordered[0].ids, release.ids);
  assert.deepEqual([...release.ids], ['50', '600']);
});

test('release defaults recognize accented provider labels and grouped slugs without replacing raw ID sets', () => {
  for (const [name, id] of [['FILMES/LANÇAMENTOS', '50'], ['Séries | Estréias', '1010'], ['★ Lançamento 2026', 'release-2026'], ['Filmes - Estreia', '90']]) {
    const group = {id, name, ids:new Set([id, `${id}-second`]), unloaded:true};
    assert.equal(defaultCatalogCategory('movies', [all, favorites, group]), id);
    assert.equal(orderCatalogCategories('movies', [all, favorites, group])[0], group);
  }
  assert.equal(defaultCatalogCategory('series', [all, {id:'lancamentos', ids:new Set(['1010'])}]), 'lancamentos');
});

test('only the first native release category moves, so favorites remains second', () => {
  const moreReleases = {id:'estreias', name:'Estreias'};
  assert.deepEqual(orderCatalogCategories('movies', [all, favorites, action, release, moreReleases]).map(group => group.id), ['lancamentos', '__favorites', '__all', 'acao', 'estreias']);
});

test('no release group is synthesized from custom collections, title-like labels or unrelated categories', () => {
  for (const name of ['Novelas', 'Estreias do terror', 'Lançamentos adultos', 'O último lançamento', 'Lançamentos favoritos']) {
    const groups = [all, favorites, custom, {id:'other', name}];
    assert.equal(defaultCatalogCategory('movies', groups), '__all');
    assert.deepEqual(orderCatalogCategories('movies', groups).map(group => group.id), ['__favorites', '__all', 'custom:personal', 'other']);
  }
  assert.equal(defaultCatalogCategory('movies', []), '__all');
});

test('live categories show favorites first, opening them only when favorites exist', () => {
  assert.deepEqual(orderCatalogCategories('live', [all, action, favorites, release]).map(group => group.id), ['__favorites', '__all', 'acao', 'lancamentos']);
  assert.equal(defaultCatalogCategory('live', [all, favorites, action]), '__favorites');
  assert.equal(defaultCatalogCategory('live', [all, favorites, action], {favoritesCount:0}), '__all');
  assert.equal(defaultCatalogCategory('live', [all, {...favorites, count:0}], {favoritesCount:2}), '__favorites');
  assert.equal(defaultCatalogCategory('live', [all, action], {favoritesCount:2}), '__all');
  for (const count of [0, -1, NaN, Infinity, 'invalid']) assert.equal(defaultCatalogCategory('live', [all, favorites], {favoritesCount:count}), '__all');
});

test('groups are deduplicated by effective ID while distinct native IDs remain selectable', () => {
  const duplicate = {...release, name:'Outra cópia'};
  const rawId = {id:80, name:'Drama', ids:new Set(['raw-80'])};
  const rawDuplicate = {id:'80', name:'Drama repetido'};
  assert.deepEqual(orderCatalogCategories('series', [all, favorites, release, duplicate, action, rawId, rawDuplicate]), [release, favorites, all, action, rawId]);
});

test('non-catalog contexts keep source ordering and never choose a release default', () => {
  const groups = [all, action, favorites, release];
  for (const type of ['home', 'favorites', 'search', undefined]) {
    assert.deepEqual(orderCatalogCategories(type, groups), groups);
    assert.notEqual(orderCatalogCategories(type, groups), groups);
    assert.equal(defaultCatalogCategory(type, groups), '__all');
  }
});

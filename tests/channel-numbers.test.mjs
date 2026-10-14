import test from 'node:test';
import assert from 'node:assert/strict';
import { SettingsTools } from '../web/settings-tools.js';

const channels = [
  { id: '101', kind: 'live', name: 'Esportes atual', categoryId: '1' },
  { id: '102', kind: 'live', name: 'Cinema atual', categoryId: '2' },
  { id: '103', kind: 'live', name: 'Infantil atual', categoryId: '3' },
  { id: '104', kind: 'live', name: 'Categoria oculta', categoryId: '9' }
];

function preferences({ favorites = [], numbers = [], items = channels, hiddenItems = {} } = {}) {
  const catalogs = new Map([['live', { items }]]);
  let savedFavorites = favorites;
  const snapshots = [], messages = [];
  let changes = 0;
  const tools = Object.create(SettingsTools.prototype);
  tools.channelNumbers = new Map(numbers);
  tools.hidden = { live: new Set(['9']), movies: new Set(), series: new Set() };
  tools.hiddenItems = { live: new Set(hiddenItems.live || []), movies: new Set(hiddenItems.movies || []), series: new Set(hiddenItems.series || []) };
  tools.groups = [];
  tools.isOpen = false;
  tools.options = {
    getCatalogs: () => catalogs,
    getFavorites: () => savedFavorites,
    toast: message => messages.push(message),
    onChange: () => { changes++; }
  };
  tools.store = function () { snapshots.push(new Map(this.channelNumbers)); };
  return {
    tools, catalogs, snapshots, messages,
    setFavorites(value) { savedFavorites = value; },
    get changes() { return changes; }
  };
}

test('numbered favorites use current catalog entries and omit hidden, missing and non-live titles', () => {
  const fixture = preferences({ favorites: [
    { ...channels[0], name: 'Nome antigo', categoryId: '9' },
    channels[1], channels[3],
    { id: '999', kind: 'live', name: 'Canal removido', categoryId: '1' },
    { id: '103', kind: 'movie', name: 'Filme favorito', categoryId: '3' }
  ] });
  const numbered = fixture.tools.getNumberedChannels({ favoritesOnly: true, fallbackToAll: false });
  assert.deepEqual(numbered.map(entry => entry.item.id), ['101', '102']);
  assert.equal(numbered[0].item, channels[0]);
  assert.equal(numbered[0].item.name, 'Esportes atual');
  assert.ok(numbered.every(entry => entry.item.kind === 'live'));
  assert.equal(fixture.tools.getChannelNumber('999', 'indisponível'), 'indisponível');
});

test('empty favorite navigation falls back to visible channels only when requested', () => {
  const fixture = preferences({ favorites: new Map([['live:999', { id: '999', kind: 'live' }], ['live:104', channels[3]]]), numbers: [['101', 10]] });
  assert.deepEqual(fixture.tools.getNumberedChannels({ favoritesOnly: true, fallbackToAll: false }), []);
  const fallback = fixture.tools.getNumberedChannels();
  assert.deepEqual(new Set(fallback.map(entry => entry.item.id)), new Set(['101', '102', '103']));
  assert.equal(new Set(fallback.map(entry => entry.number)).size, fallback.length);
  assert.ok(fallback.every(entry => Number.isInteger(entry.number) && entry.number >= 1 && entry.number <= 9999));
  assert.ok(fallback.every((entry, index) => index === 0 || entry.number > fallback[index - 1].number));
  fixture.catalogs.delete('live');
  assert.deepEqual(fixture.tools.getNumberedChannels(), []);
});

test('favorite numbers survive reordered catalogs, new favorites and saved-preference reloads', () => {
  const fixture = preferences({ favorites: [channels[0], channels[1]], numbers: [['reserved-channel', 1]] });
  const original = new Map(fixture.tools.getNumberedChannels().map(entry => [entry.item.id, entry.number]));
  assert.equal(original.size, 2);
  assert.ok([...original.values()].every(number => number !== 1));
  const refreshed = [{ ...channels[1], name: 'Cinema renovado' }, channels[2], { ...channels[0], name: 'Esportes renovado' }];
  fixture.catalogs.set('live', { items: refreshed });
  fixture.setFavorites([channels[1], channels[0], channels[2]]);
  const updated = fixture.tools.getNumberedChannels();
  for (const [id, number] of original) assert.equal(updated.find(entry => entry.item.id === id).number, number);
  assert.equal(updated.find(entry => entry.item.id === '101').item.name, 'Esportes renovado');
  assert.equal(new Set(updated.map(entry => entry.number)).size, 3);
  const reloaded = preferences({ favorites: [channels[2], channels[0], channels[1]], numbers: fixture.snapshots.at(-1), items: refreshed });
  assert.deepEqual(reloaded.tools.getNumberedChannels().map(entry => [entry.item.id, entry.number]), updated.map(entry => [entry.item.id, entry.number]));
});

test('custom channel numbers accept the boundaries and reject collisions and invalid values without saving', () => {
  const fixture = preferences();
  assert.equal(fixture.tools.setChannelNumber('101', 1), true);
  assert.equal(fixture.tools.setChannelNumber('102', '9999'), true);
  assert.equal(fixture.tools.getChannelNumber('101'), 1);
  assert.equal(fixture.tools.getChannelNumber('102'), 9999);
  const saves = fixture.snapshots.length;
  assert.equal(fixture.tools.setChannelNumber('102', 1), false);
  for (const value of [0, 10000, 1.5, '', 'inválido']) assert.equal(fixture.tools.setChannelNumber('101', value), false);
  assert.equal(fixture.snapshots.length, saves);
  assert.equal(fixture.changes, 2);
  assert.equal(fixture.messages.length, 6);
  assert.equal(fixture.tools.getChannelNumber('101'), 1);
  assert.equal(fixture.tools.getChannelNumber('102'), 9999);
});

test('removing a favorite persists its visibility separately and restoring it keeps its channel number', () => {
  const fixture = preferences({ favorites: channels.slice(0,3), numbers: [['101', 7], ['102', 8]] });
  fixture.catalogs.set('movies', { items: [{ id: '101', kind: 'movie', categoryId: 'films', name: 'Filme com o mesmo ID' }] });
  fixture.tools.groups = [{ id: 'personal-1', name: 'Minha categoria', type: 'live', itemKeys: ['live:101'] }];
  fixture.tools.store = SettingsTools.prototype.store;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let persisted;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { setItem(key, value) { persisted = JSON.parse(value); } } });
  try {
    fixture.tools.getNumberedChannels();
    assert.equal(fixture.tools.setItemVisible('live', '101', false), true);
    assert.equal(fixture.tools.isItemVisible('live', '101'), false);
    assert.equal(fixture.tools.countVisibleItems('live'), 2);
    assert.ok(!fixture.tools.getNumberedChannels().some(entry => entry.item.id === '101'));
    assert.deepEqual(persisted.hiddenItems.live, ['101']);
    assert.deepEqual(persisted.hidden.live, ['9']);
    assert.deepEqual(persisted.groups, fixture.tools.groups);
    assert.equal(persisted.channelNumbers['101'], 7);
    fixture.tools.setItemVisible('movies', '101', false);
    assert.equal(fixture.tools.setItemVisible('live', '101', true), true);
    assert.equal(fixture.tools.isItemVisible('movies', '101'), false, 'Visibility must be scoped to the media type.');
    assert.equal(fixture.tools.countVisibleItems('live'), 3);
    assert.equal(fixture.tools.getNumberedChannels().find(entry => entry.item.id === '101').number, 7);
    assert.deepEqual(persisted.hiddenItems.live, []);
    assert.deepEqual(persisted.hiddenItems.movies, ['101']);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
});

test('restoring a merged provider category restores only its removed items and preserves category visibility', () => {
  const fixture = preferences({ favorites: channels.slice(0,3), hiddenItems: { live: ['101', '102', '103'] } });
  fixture.catalogs.set('live', { items: channels, categories: [{ id: 'combined', ids: ['1', '3'], name: 'Categoria combinada' }, { id: 'cinema', ids: ['2'], name: 'Cinema' }] });
  fixture.tools.hidden.live.add('1');
  assert.deepEqual(fixture.tools.getProviderCategoryItems('live', 'combined').map(item => item.id), ['101', '103']);
  assert.equal(fixture.tools.restoreCategoryItems('live', 'combined'), 2);
  assert.equal(fixture.tools.isItemVisible('live', '101'), true);
  assert.equal(fixture.tools.isItemVisible('live', '103'), true);
  assert.equal(fixture.tools.isItemVisible('live', '102'), false);
  assert.equal(fixture.tools.isCategoryVisible('live', '1'), false);
  assert.equal(fixture.tools.countVisibleItems('live'), 1);
  assert.deepEqual(fixture.tools.getNumberedChannels({ favoritesOnly: true, fallbackToAll: false }).map(entry => entry.item.id), ['103']);
  assert.equal(fixture.tools.restoreCategoryItems('live', 'combined'), 0);
});


test('provider category settings accept Set identifiers and include native titles in every returned category',()=>{
  const fixture=preferences();
  const movie={id:'201',kind:'movie',name:'Filme em duas coleções',categoryId:'1',categoryIds:['1','2']};
  fixture.catalogs.set('movies',{items:[movie],categories:[{id:'lancamentos',ids:new Set(['1'])},{id:'acao',ids:new Set(['2'])}]});
  fixture.tools.hidden.movies.add('1');
  assert.deepEqual(fixture.tools.getProviderCategoryItems('movies','acao'),[movie]);
  assert.equal(fixture.tools.countVisibleItems('movies'),1,'A visible secondary collection keeps the title available.');
  fixture.tools.hidden.movies.add('2');assert.equal(fixture.tools.countVisibleItems('movies'),0);
  fixture.tools.hiddenItems.movies.add('201');assert.equal(fixture.tools.restoreCategoryItems('movies','acao'),1);
  assert.equal(fixture.tools.countVisibleItems('movies'),0,'Restoring an item must not silently expose hidden categories.');
});

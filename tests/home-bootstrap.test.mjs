import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareHomeCatalogs} from '../web/inicio/hooks.js';
import {CatalogPager} from '../web/catalog-pagination.js';

const item = (kind, id, extra = {}) => ({id: String(id), kind, name: `Título ${id} HD`, year: 2026, ...extra});
const page = (kind, start = 0) => Array.from({length: 10}, (_, index) => item(kind, start + index));
const catalog = (items = [], hasMore = true) => ({items, sourceCategories: [{id: '1'}], categories: [{id: '1', ids: new Set(['1'])}], pagination: {mode: 'category', byCategory: {'1': {loaded: true, nextPage: 2, hasMore}}}});

test('preparation reaches thirty distinct visible titles per kind using the shared pager budget', async () => {
  const data = new Map([['movies', catalog(page('movie'))], ['series', catalog(page('series'))]]), calls = [];
  let active = 0, peak = 0;
  const pager = new CatalogPager({limit: 1, getCatalog: type => data.get(type), onData: (type, value) => data.set(type, value), request: async raw => {
    const url = new URL(raw, 'http://localhost'), type = url.searchParams.get('type'), number = Number(url.searchParams.get('page'));
    calls.push({type, number}); active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve)); active--;
    const entries = page(type === 'movies' ? 'movie' : 'series', (number - 1) * 10);
    const copies = entries.map(entry => ({...entry, id: `copy-${entry.id}`, name: entry.name.replace('HD', 'FHD')}));
    return {categories: [], items: [...entries, ...copies, item(entries[0].kind, `hidden-${number}`, {hidden: true})], pagination: {mode: 'category', byCategory: {'1': {loaded: true, nextPage: number + 1, hasMore: true}}}};
  }});
  const result = await prepareHomeCatalogs({getCatalog: type => data.get(type), pager, isItemVisible: entry => !entry.hidden});
  assert.deepEqual(result, {movies: 30, series: 30}); assert.equal(calls.length, 4); assert.equal(peak, 1);
  assert.equal(pager.activeRequests, 0); assert.equal(pager.pending.size, 0);
  assert.deepEqual(calls.filter(call => call.type === 'movies').map(call => call.number), [2, 3]);
});

test('non-paged, exhausted and already sufficient catalogs do not start extra requests', async () => {
  let calls = 0;
  const pager = {load: () => {calls++; assert.fail('No page is needed');}};
  const first = await prepareHomeCatalogs({getCatalog: type => type === 'movies' ? {items: page('movie')} : catalog(page('series'), false), pager});
  assert.deepEqual(first, {movies: 10, series: 10}); assert.equal(calls, 0);
  const sufficient = catalog([...page('movie'), ...page('movie', 10), ...page('movie', 20)]);
  assert.deepEqual(await prepareHomeCatalogs({getCatalog: () => sufficient, pager}), {movies: 30, series: 30});
});

test('duplicate-only pages may advance to a later page with a new real title', async () => {
  const data = catalog([item('movie', 1)]); let calls = 0;
  const pager = {load: async () => {
    calls++; data.pagination.byCategory['1'].nextPage++;
    data.items.push(calls === 1 ? item('movie', 'copy', {name: 'Título 1 FHD'}) : item('movie', 2));
    return [{status: 'fulfilled'}];
  }};
  assert.deepEqual(await prepareHomeCatalogs({getCatalog: type => type === 'movies' ? data : null, pager, target: 2}), {movies: 2, series: 0});
  assert.equal(calls, 2);
});

test('unchanged pages and page errors stop each type without a retry loop', async () => {
  const data = catalog([item('movie', 1)]), calls = [];
  const pager = {load: async type => {calls.push(type); return type === 'movies' ? [{status: 'fulfilled'}] : [{status: 'rejected', reason: new Error('Unavailable')}];}};
  assert.deepEqual(await prepareHomeCatalogs({getCatalog: () => data, pager}), {movies: 1, series: 1});
  assert.deepEqual(calls.sort(), ['movies', 'series']);
  const failing = {load: async () => {throw new Error('Offline');}};
  assert.deepEqual(await prepareHomeCatalogs({getCatalog: () => data, pager: failing}), {movies: 1, series: 1});
});

test('deadline bounds stalled pages and aborts only the preparation subscriptions', async () => {
  const signals = [], external = new AbortController();
  const pager = {load: (_type, category, {signal}) => {assert.equal(category, '__all'); signals.push(signal); return new Promise(() => {});}};
  assert.deepEqual(await prepareHomeCatalogs({getCatalog: () => catalog(), pager, signal: external.signal, deadlineMs: 5}), {movies: 0, series: 0});
  assert.equal(signals.length, 2); assert.ok(signals.every(signal => signal.aborted)); assert.equal(external.signal.aborted, false);
});

test('preparation timeout preserves a shared page still required by another consumer', async () => {
  let data = catalog(), resolvePage, requestSignal;
  const pager = new CatalogPager({getCatalog: () => data, onData: (_type, value) => {data = value;}, request: (_url, {signal}) => {
    requestSignal = signal;
    return new Promise(resolve => {resolvePage = resolve;});
  }});
  const otherConsumer = pager.load('movies'); await Promise.resolve();
  assert.deepEqual(await prepareHomeCatalogs({getCatalog: type => type === 'movies' ? data : null, pager, deadlineMs: 5}), {movies: 0, series: 0});
  assert.equal(requestSignal.aborted, false);
  resolvePage({categories: [], items: [item('movie', 1)], pagination: {mode: 'category', byCategory: {'1': {loaded: true, nextPage: 3, hasMore: false}}}});
  await otherConsumer;
  assert.equal(data.items.length, 1); assert.equal(pager.activeRequests, 0);
});

test('login cancellation stops pending preparation and an already cancelled login starts no pages', async () => {
  const external = new AbortController(), signals = [];
  const pager = {load: (_type, _category, {signal}) => {signals.push(signal); return new Promise(() => {});}};
  const pending = prepareHomeCatalogs({getCatalog: () => catalog(), pager, signal: external.signal});
  await Promise.resolve(); external.abort();
  assert.deepEqual(await pending, {movies: 0, series: 0}); assert.ok(signals.every(signal => signal.aborted));
  signals.length = 0;
  assert.deepEqual(await prepareHomeCatalogs({getCatalog: () => catalog(), pager, signal: external.signal}), {movies: 0, series: 0});
  assert.equal(signals.length, 0);
});

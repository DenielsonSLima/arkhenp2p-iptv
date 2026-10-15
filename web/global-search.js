import { pageChoices } from './catalog-pagination.js';

const catalogTypes = ['live', 'movies', 'series'];
const kinds = {live:'live', movies:'movie', series:'series'};
const titleOrder = new Intl.Collator('pt-BR', {sensitivity:'base', numeric:true});
const catalogFor = (catalogs, type) => catalogs instanceof Map ? catalogs.get(type) : catalogs?.[type];

export function normalizeSearchText(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function remainingChoices(catalogs, isCategoryAllowed) {
  return catalogTypes.map(type => pageChoices(catalogFor(catalogs, type))
    .filter(state => isCategoryAllowed(type, state.id))
    .map(state => ({type, category:state.id, page:Math.max(1, Number(state.nextPage) || 1)})));
}

// These choices describe known next pages, never a guessed total page count.
// Round-robin selection lets one large movie catalog share the budget with series.
export function globalSearchPageChoices(catalogs, {isCategoryAllowed = () => true, limit = 4} = {}) {
  const queues = remainingChoices(catalogs, isCategoryAllowed), choices = [];
  const budget = Math.max(0, Math.min(4, Math.floor(Number(limit) || 0)));
  while (choices.length < budget && queues.some(queue => queue.length)) {
    for (const queue of queues) {
      if (queue.length) choices.push(queue.shift());
      if (choices.length === budget) break;
    }
  }
  return choices;
}

function matchRank(item, query, words) {
  const title = normalizeSearchText(item.name);
  const searchable = `${title} ${normalizeSearchText(item.group)} ${normalizeSearchText(item.genre)}`;
  if (!words.every(word => searchable.includes(word))) return -1;
  if (title === query) return 0;
  if (title.startsWith(query)) return 1;
  if (title.includes(query)) return 2;
  return words.every(word => title.includes(word)) ? 3 : 4;
}

/**
 * Search only the current snapshots. Fetching and cancellation remain with the app.
 * `counts` and `items.length` count matching, visible, loaded titles, not the provider's total.
 * A partial result means an expected catalog is absent or an allowed category has more pages.
 */
export function searchCatalogs(catalogs, input, {isItemVisible = () => true, isCategoryAllowed = () => true} = {}) {
  const query = normalizeSearchText(input), words = query.split(' ').filter(Boolean), found = new Map();
  const missingTypes = catalogTypes.filter(type => !catalogFor(catalogs, type));
  const choices = remainingChoices(catalogs, isCategoryAllowed);
  const partialTypes = catalogTypes.filter((type, index) => missingTypes.includes(type) || choices[index].length);
  for (const type of catalogTypes) {
    for (const item of catalogFor(catalogs, type)?.items || []) {
      if (!query || !item || item.id == null || !isItemVisible(item, type)) continue;
      const kind = item.kind || kinds[type];
      if (!Object.values(kinds).includes(kind)) continue;
      const rank = matchRank(item, query, words);
      if (rank < 0) continue;
      const key = `${kind}:${item.id}`, previous = found.get(key);
      // Catalog snapshots may overlap categories. Prefer the better title match.
      if (!previous || rank < previous.rank) found.set(key, {item:item.kind ? item : {...item, kind}, rank});
    }
  }
  const items = [...found.values()].sort((first, second) => first.rank - second.rank
    || titleOrder.compare(first.item.name || '', second.item.name || '')
    || catalogTypes.indexOf(first.item.kind === 'movie' ? 'movies' : first.item.kind) - catalogTypes.indexOf(second.item.kind === 'movie' ? 'movies' : second.item.kind)
    || titleOrder.compare(String(first.item.id), String(second.item.id))).map(result => result.item);
  const counts = {live:0, movie:0, series:0};
  for (const item of items) counts[item.kind]++;
  return {query, items, counts, missingTypes, partialTypes, partial:partialTypes.length > 0, remainingCategories:choices.reduce((sum, queue) => sum + queue.length, 0)};
}

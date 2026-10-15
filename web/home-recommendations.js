import {catalogGenres} from './catalog-genres.js';

const list = value => Array.isArray(value) ? value : [];
const values = value => value instanceof Map ? [...value.values()] : list(value);
const key = item => `${item.kind}:${item.id}`;
const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const validTitle = item => item && ['movie', 'series'].includes(item.kind) && item.id != null && typeof item.name === 'string' && item.name.trim();
const variants = /(?:\s+|\s*[-[({])(?:full\s*hd|sd|hd|fhd|uhd|4k|hevc|h[ .]?26[45]|leg(?:endad[oa]s?)?|dub(?:lad[oa]s?)?|dual(?:\s+audio)?)[\])}]?\s*$/i;

function identity(item) {
  let name = normalize(item.name).trim(), previous;
  const explicit = String(item.year || item.releaseDate || item.release_date || '').match(/\b(?:19|20)\d{2}\b/);
  let year = Number(explicit?.[0]) || 0;
  // Quality/audio labels can sit before or after the supplied release year.
  do {
    previous = name;
    name = name.replace(variants, '').trim();
    const ending = name.match(/\s*[([]((?:19|20)\d{2})[)\]]\s*$/);
    if (ending) { year ||= Number(ending[1]); name = name.slice(0, ending.index).trim(); }
  } while (name !== previous);
  return `${item.kind}:${name.replace(/[^a-z0-9]+/g, ' ').trim()}:${year}`;
}

function rating(item) {
  const value = item.rating;
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\s*\d+(?:[.,]\d+)?\s*$/.test(value))) return 0;
  const number = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(number) && number >= 7 && number <= 10 ? number : 0;
}

function year(item) {
  return Number(String(item.year || item.releaseDate || item.release_date || '').match(/\b(?:19|20)\d{2}\b/)?.[0]) ||
    Number(String(item.name).match(/[([]((?:19|20)\d{2})[)\]]/)?.[1]) || 0;
}

/**
 * Recommend only supplied, visible titles using real catalogue genres and the
 * caller's account-filtered history. There are no requests or invented genres.
 * Without a matching history signal, the same row falls back to rating order.
 */
export function homeRecommendations({movies = [], series = [], history, movieCatalog, seriesCatalog, limit = 30} = {}) {
  const maximum = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : 30;
  if (!maximum) return {items:[], personalized:false};
  const titles = [...list(movies).filter(item => validTitle(item) && item.kind === 'movie'), ...list(series).filter(item => validTitle(item) && item.kind === 'series')];
  const currentByKey = new Map(titles.map(item => [key(item), item])), currentByIdentity = new Map();
  const genres = {
    movie:catalogGenres(movieCatalog, {items:list(movies)}),
    series:catalogGenres(seriesCatalog, {items:list(series)})
  };
  const genresByIdentity = new Map();
  for (const item of titles) {
    const id = identity(item), known = genresByIdentity.get(id) || new Set();
    currentByIdentity.set(id, item);
    for (const genre of genres[item.kind].genreIdsFor(item)) known.add(genre);
    genresByIdentity.set(id, known);
  }

  const watchedKeys = new Set(), watchedTitles = new Set(), preferences = new Map(), signalled = new Set();
  const watched = values(history).filter(entry => validTitle(entry?.item) && Number.isFinite(Number(entry.time)) && Number(entry.time) > 5 && Number.isFinite(Number(entry.updated)) && Number(entry.updated) > 0)
    .sort((first, second) => Number(second.updated) - Number(first.updated));
  for (const entry of watched) {
    watchedKeys.add(key(entry.item));
    watchedTitles.add(identity(entry.item));
    const current = currentByKey.get(key(entry.item)) || currentByIdentity.get(identity(entry.item));
    if (!current) continue;
    const id = identity(current);
    watchedTitles.add(id);
    if (signalled.has(id)) continue;
    signalled.add(id);
    const known = genresByIdentity.get(id);
    if (!known?.size) continue;
    // Recent distinct viewing choices count more; one broad genre list does not
    // outweigh several actual viewing choices with fewer supplied genres.
    const weight = 1 / (1 + (signalled.size - 1) / 4) / known.size;
    for (const genre of known) preferences.set(genre, (preferences.get(genre) || 0) + weight);
  }

  const ranked = titles.map((item, index) => {
    const id = identity(item), score = [...genresByIdentity.get(id)].reduce((sum, genre) => sum + (preferences.get(genre) || 0), 0);
    return {item, id, score, rating:rating(item), year:year(item), index};
  }).filter(entry => entry.rating && !watchedKeys.has(key(entry.item)) && !watchedTitles.has(entry.id));
  const compare = (first, second) => second.score - first.score || second.rating - first.rating || second.year - first.year || first.index - second.index;
  ranked.sort(compare);
  const seen = new Set(), byKind = {movie:[], series:[]};
  for (const entry of ranked) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    byKind[entry.item.kind].push(entry);
  }
  const items = [], offsets = {movie:0, series:0};
  let kind = !byKind.movie.length || byKind.series.length && compare(byKind.series[0], byKind.movie[0]) < 0 ? 'series' : 'movie';
  while (items.length < maximum) {
    let entry = byKind[kind][offsets[kind]++];
    if (!entry) { kind = kind === 'movie' ? 'series' : 'movie'; entry = byKind[kind][offsets[kind]++]; }
    if (!entry) break;
    items.push(entry);
    kind = kind === 'movie' ? 'series' : 'movie';
  }
  return {items:items.map(entry => entry.item), personalized:items.some(entry => entry.score > 0)};
}

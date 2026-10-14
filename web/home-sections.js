// Home selections use the current visible catalog, never stale or hidden titles.
const list = value => Array.isArray(value) ? value : [];
const values = value => value instanceof Map ? [...value.values()] : list(value);
const key = item => `${item.kind}:${item.id}`;
const text = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

export function releaseYear(item) {
  const explicit = String(item?.year || item?.releaseDate || item?.release_date || '').match(/\b(?:19|20)\d{2}\b/);
  const title = String(item?.name || '').replace(/(?:\s+(?:sd|hd|fhd|uhd|4k|leg|dub|dual))+\s*$/i, '').match(/\(((?:19|20)\d{2})\)\s*$/);
  return Number(explicit?.[0] || title?.[1]) || 0;
}
function addedTime(item) {
  const value = item?.added || item?.releaseDate || item?.release_date;
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(String(value))) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number < 1e12 ? number * 1000 : number : 0;
  }
  return /^\d{4}-\d{2}-\d{2}/.test(String(value)) ? Date.parse(value) || 0 : 0;
}
function launchCategory(item) { return /\b(?:lancamentos?|estreias?|recentes?)\b/.test(text(item?.group)); }
function titleIdentity(item) {
  return text(item.name).replace(/(?:\s+(?:sd|hd|fhd|uhd|4k|leg|dub|dual))+\s*$/, '')
    .replace(/\s*\((?:19|20)\d{2}\)\s*$/, '').replace(/[^a-z0-9]+/g, ' ').trim() + ':' + releaseYear(item);
}
export function latestReleases(items, limit = 16) {
  const ordered = list(items).filter(item => item && item.name && item.id !== undefined).map((item, index) => ({item, index}));
  ordered.sort((first, second) => releaseYear(second.item) - releaseYear(first.item) ||
    Number(launchCategory(second.item)) - Number(launchCategory(first.item)) || addedTime(second.item) - addedTime(first.item) || first.index - second.index);
  const seen = new Set();
  return ordered.map(entry => entry.item).filter(item => {
    const identity = titleIdentity(item); if (seen.has(identity)) return false; seen.add(identity); return true;
  }).slice(0, Math.max(0, limit));
}
export function featuredMovies(items, limit = 3) {
  const recent = latestReleases(list(items).filter(item => item.kind === 'movie'), Math.max(limit, 36));
  const newestYear = releaseYear(recent[0]);
  const ready = recent.filter(item => releaseYear(item) >= newestYear - 1 && item.backdrop && item.poster && Number(item.rating) > 0);
  // Within the current release window, prefer titles with real artwork and
  // metadata over entries that only have a name. Keep three distinct movies.
  const selected = new Set();
  return [...ready, ...recent].filter(item => {const id = key(item);if (selected.has(id)) return false;selected.add(id);return true;}).slice(0, limit);
}

export function playbackProgress(entry) {
  const time = Number(entry?.time), duration = Number(entry?.duration);
  const hasTime = Number.isFinite(time) && time > 0;
  const hasDuration = Number.isFinite(duration) && duration > 0;
  const percent = hasTime && hasDuration ? Math.max(0, Math.min(100, time / duration * 100)) : null;
  const completed = percent !== null && percent >= 95;
  const episode = entry?.item?.kind === 'series' ? entry.episode : null;
  const season = Number(episode?.season), number = Number(episode?.number);
  const episodeLabel = Number.isInteger(season) && season > 0 && Number.isInteger(number) && number > 0 ? `T${season} · E${number}` : '';
  return {percent, completed, resumable:hasTime && time > 5 && !completed, episodeLabel};
}
function watched(items, history, kind, limit) {
  const current = new Map(list(items).map(item => [key(item), item]));
  const seen = new Set();
  return values(history).filter(entry => entry?.item?.kind === kind && Number(entry.updated) > 0)
    .sort((first, second) => Number(second.updated) - Number(first.updated))
    .map(entry => current.get(key(entry.item))).filter(item => {
      if (!item || seen.has(key(item))) return false; seen.add(key(item)); return true;
    }).slice(0, limit);
}
function channelIdentity(item) {
  return text(item.name).replace(/[^a-z0-9+]+/g, ' ').trim()
    .replace(/(?:\s+(?:sd|hd|fhd|uhd|4k|hevc|h ?265))+$/, '').replace(/\s*\+\s*/g, '+');
}
export function homeShelves({movies = [], series = [], live = [], favorites, history, limit = 16} = {}) {
  const sections = [], add = (shelfKey, title, type, items) => {
    if (items.length) sections.push({key:shelfKey, title, type, items});
  };
  const liveByKey = new Map(list(live).map(item => [key(item), item]));
  const favoriteChannels = values(favorites).filter(item => item?.kind === 'live')
    .sort((first, second) => Number(second.savedAt || 0) - Number(first.savedAt || 0)).map(item => liveByKey.get(key(item))).filter(Boolean);
  const recentChannels = watched(live, history, 'live', limit), seenChannels = new Set();
  const fallback = list(live).filter(item => /\sHD$/i.test(item.name)).concat(list(live));
  const channels = [...favoriteChannels, ...recentChannels, ...(!favoriteChannels.length && !recentChannels.length ? fallback : [])].filter(item => {
    const identity = channelIdentity(item); if (seenChannels.has(identity)) return false; seenChannels.add(identity); return true;
  }).slice(0, limit);
  add('home:live', favoriteChannels.length ? 'Seus canais favoritos e recentes' : recentChannels.length ? 'Últimos canais assistidos' : 'TV ao vivo', 'live', channels);
  add('home:movie-history', 'Últimos filmes assistidos', 'movies', watched(movies, history, 'movie', limit));
  add('home:movie-releases', 'Lançamentos de filmes', 'movies', latestReleases(movies, limit));
  add('home:series-history', 'Últimas séries assistidas', 'series', watched(series, history, 'series', limit));
  add('home:series-releases', 'Lançamentos de séries', 'series', latestReleases(series, limit));
  return sections;
}

// Legacy pure API for compatibility; the active home uses server projection selectors.
import {homeRecommendations} from './recomendados/legado.js';
import {latestReleases,HOME_SHELF_LIMIT} from './ordens.js';
const list=value=>Array.isArray(value)?value:[];
const values=value=>value instanceof Map?[...value.values()]:list(value);
const key=item=>`${item.kind}:${item.id}`;
const text=value=>String(value||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase();

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
export function homeShelves({movies = [], series = [], live = [], favorites, history, movieCatalog, seriesCatalog, limit = HOME_SHELF_LIMIT} = {}) {
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
  const recommendations = homeRecommendations({movies, series, history, movieCatalog, seriesCatalog, limit});
  add('home:recommendations', recommendations.personalized ? 'Recomendados para você' : 'Filmes e séries bem avaliados', 'mixed', recommendations.items);
  return sections;
}

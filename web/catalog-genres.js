const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\uFE0E\u200D\u20E3]/gu, '')
  .replace(/[^a-z0-9&+]+/g, ' ').trim().replace(/\s+/g, ' ');
const order = new Intl.Collator('pt-BR', {sensitivity:'base'});
const definitions = [
  ['acao', 'Ação', 'action'], ['aventura', 'Aventura', 'adventure'], ['animacao', 'Animação', 'animações', 'animation'],
  ['biografia', 'Biografia', 'biografias', 'biography'], ['comedia', 'Comédia', 'comédias', 'comedy'],
  ['crime', 'Crime', 'crimes'], ['documentario', 'Documentário', 'documentários', 'documentary'], ['drama', 'Drama', 'dramas'],
  ['esporte', 'Esporte', 'esportes', 'sport', 'sports'], ['familia', 'Família', 'family'], ['fantasia', 'Fantasia', 'fantasy'],
  ['faroeste', 'Faroeste', 'western'], ['ficcao-cientifica', 'Ficção científica', 'ficção', 'ficção científica', 'science fiction', 'sci-fi'],
  ['guerra', 'Guerra', 'war'], ['historia', 'História', 'history', 'histórico'], ['infantil', 'Infantil', 'infantis', 'kids'],
  ['misterio', 'Mistério', 'mistérios', 'mystery'], ['musica', 'Música', 'music'], ['musical', 'Musical', 'musicais'],
  ['novela', 'Novela', 'novelas', 'soap'], ['policial', 'Policial', 'policiais'], ['reality', 'Reality', 'reality show'],
  ['romance', 'Romance', 'romances'], ['suspense', 'Suspense', 'suspenses', 'thriller'], ['terror', 'Terror', 'horror'],
  ['acao-aventura', 'Ação e aventura', 'ação & aventura', 'action & adventure'],
  ['ficcao-fantasia', 'Ficção e fantasia', 'ficção & fantasia', 'sci-fi & fantasy']
];
const names = new Map(definitions.map(([id, name]) => [id, name]));
const aliases = new Map(definitions.flatMap(([id, name, ...values]) => [id, name, ...values].map(value => [normalize(value), id])));
const list = value => Array.isArray(value) ? value : [];

function canonical(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  // A slash denotes the provider's taxonomy path. Only its real film/series
  // families are genres; e.g. "PrimeVideo/Drama" is not a genre assertion.
  if (text.includes('/')) {
    const parts = text.split('/').map(part => part.trim());
    if (parts.length !== 2 || !/^(?:filmes?|series?)$/.test(normalize(parts[0]))) return null;
    text = parts[1];
  } else {
    text = text.replace(/^(?:filmes?|s[ée]ries?)\s*[-:›>]+\s*/i, '');
  }
  return aliases.get(normalize(text)) || null;
}

function metadataGenres(value) {
  if (Array.isArray(value)) return value.flatMap(metadataGenres);
  if (value && typeof value === 'object') return metadataGenres(value.name);
  if (typeof value !== 'string') return [];
  return value.split(/[,;|]/).map(canonical).filter(Boolean);
}

function categoryGenres(catalog) {
  const categories = new Map();
  for (const category of [...list(catalog?.sourceCategories), ...list(catalog?.categories)]) {
    if (!category || typeof category !== 'object') continue;
    const genres = metadataGenres(category.name);
    if (!genres.length) continue;
    const ids = category.ids instanceof Set || Array.isArray(category.ids) ? [...category.ids] : [];
    if (category.id != null) ids.push(category.id);
    for (const id of ids) {
      const current = categories.get(String(id)) || new Set();
      for (const genre of genres) current.add(genre);
      categories.set(String(id), current);
    }
  }
  return categories;
}

/**
 * Build from the current visible snapshot, independently of its selected shelf.
 * Counts describe loaded, visible titles. Apply matches AFTER sidebar filtering
 * so Ação intersects Lançamentos/Favoritos/collections instead of replacing them.
 */
export function catalogGenres(catalog, {items = catalog?.items || []} = {}) {
  const categories = categoryGenres(catalog), cache = new WeakMap(), byTitle = new Map();
  const forItem = item => {
    if (!item || typeof item !== 'object' || item.kind === 'live') return new Set();
    if (cache.has(item)) return cache.get(item);
    const genres = new Set([
      ...metadataGenres(item.genre), ...metadataGenres(item.genres),
      ...metadataGenres(item.group), ...metadataGenres(item.groupNames)
    ]);
    const ids = [...list(item.categoryIds), item.categoryId];
    for (const id of ids) for (const genre of categories.get(String(id)) || []) genres.add(genre);
    cache.set(item, genres);
    return genres;
  };
  for (const item of list(items)) {
    if (!item || typeof item !== 'object' || item.id == null || item.kind === 'live') continue;
    const key = `${item.kind || 'vod'}:${item.id}`, genres = byTitle.get(key) || new Set();
    for (const genre of forItem(item)) genres.add(genre);
    byTitle.set(key, genres);
  }
  const counts = new Map();
  for (const genres of byTitle.values()) for (const genre of genres) counts.set(genre, (counts.get(genre) || 0) + 1);
  const choices = [{id:'__all', name:'Todos', count:byTitle.size}, ...[...counts].map(([id, count]) => ({id, name:names.get(id), count}))
    .sort((a, b) => order.compare(a.name, b.name))];
  return {
    choices,
    matches:(item, genreId) => genreId === '__all' || forItem(item).has(genreId),
    genreIdsFor:item => [...forItem(item)]
  };
}

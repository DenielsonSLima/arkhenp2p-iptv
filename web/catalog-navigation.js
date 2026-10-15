const allCategory = '__all';
const favoritesCategory = '__favorites';

function uniqueCategories(groups) {
  const seen = new Set();
  return (Array.isArray(groups) ? groups : []).filter(group => {
    if (!group || typeof group !== 'object') return false;
    if (group.id === undefined || group.id === null) return true;
    const id = String(group.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function categoryName(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u2605\u2606\uFE0F\uFE0E\u200D\u20E3]/gu, '')
    .toLowerCase().replace(/^[\s›>»|•●○◆◇─═┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬-]+/, '')
    .replace(/^(?:filmes?|series?|coletanea)\s*[-/|:›>»]+\s*/, '')
    .replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function releaseCategory(groups) {
  return groups.find(group => {
    const id = String(group.id ?? '');
    // Personal collections named "Lançamentos" must not become a provider default.
    if (!id || id.startsWith('custom:') || id === allCategory || id === favoritesCategory) return false;
    const name = categoryName(group.name ?? group.id);
    return /^(?:lancamentos?|estreias?)(?:\s+20\d{2})?$/.test(name);
  });
}

/** Reorder existing groups only; IDs, provider ID sets and source objects stay intact. */
export function orderCatalogCategories(type, groups) {
  const categories = uniqueCategories(groups);
  if (!['live', 'movies', 'series'].includes(type)) return categories;
  const releases = type === 'live' ? null : releaseCategory(categories);
  const favorites = categories.find(group => String(group.id) === favoritesCategory);
  const all = categories.find(group => String(group.id) === allCategory);
  const leading = [releases, favorites, all].filter(Boolean);
  const moved = new Set(leading);
  return [...leading, ...categories.filter(group => !moved.has(group))];
}

/** Choose an available category once when entering a catalog, before user selection. */
export function defaultCatalogCategory(type, groups, {favoritesCount} = {}) {
  const categories = uniqueCategories(groups);
  if (type === 'movies' || type === 'series') return releaseCategory(categories)?.id ?? allCategory;
  if (type === 'live') {
    const favorites = categories.find(group => String(group.id) === favoritesCategory);
    const count = favoritesCount ?? favorites?.count;
    if (favorites && Number.isFinite(Number(count)) && Number(count) > 0) return favorites.id;
  }
  return allCategory;
}

import {isAdultCategory} from './parental-classification.js';
const allCategory = '__all';
const favoritesCategory = '__favorites';
export const DAILY_GAMES_CATEGORY = '__games';
export const RELEASES_CATEGORY = '__releases';
export const ADULT_CATEGORY = '__adult';
const categoryCollator = new Intl.Collator('pt-BR', {sensitivity:'base',numeric:true});

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

export function releaseCatalogCategory(groups) {
  const candidates=uniqueCategories(groups).filter(group => {
    const id = String(group.id ?? '');
    // Personal collections named "Lançamentos" must not become a provider default.
    if (!id || id.startsWith('custom:') || id === allCategory || id === favoritesCategory || isAdultCategory(group)) return false;
    const name = categoryName(group.name ?? group.id);
    return /^(?:lancamentos?|estreias?)(?:\s+20\d{2})?$/.test(name);
  });
  const native=candidates.filter(group=>group.id!==RELEASES_CATEGORY);
  return native.find(group=>/^lancamentos?/.test(categoryName(group.name??group.id)))||native[0]||candidates[0];
}

/** Native releases retain their IDs. The fallback is a view of the daily SQL
 * release order, never a new provider category or a personal collection. */
export function orderCatalogCategories(type, groups) {
  const categories = uniqueCategories(groups);
  if (!['live', 'movies', 'series'].includes(type)) return categories;
  const favorites = categories.find(group => String(group.id) === favoritesCategory);
  const all = categories.find(group => String(group.id) === allCategory);
  const games = type === 'live' ? categories.find(group => String(group.id) === DAILY_GAMES_CATEGORY) : null;
  const releases=type==='live'?null:releaseCatalogCategory(categories)||{id:RELEASES_CATEGORY,name:'Lançamentos',fallback:true};
  const leading = [favorites, releases, all, games].filter(Boolean);
  const moved = new Set(leading);
  const others=categories.filter(group=>!moved.has(group)&&!(group.id===RELEASES_CATEGORY&&releases?.id!==RELEASES_CATEGORY));
  const byName=(first,second)=>categoryCollator.compare(categoryName(first.name??first.id),categoryName(second.name??second.id));
  return [...leading,...others.filter(group=>group.id!==ADULT_CATEGORY&&!isAdultCategory(group)).sort(byName),...others.filter(group=>group.id!==ADULT_CATEGORY&&isAdultCategory(group)).sort(byName),...others.filter(group=>group.id===ADULT_CATEGORY)];
}

/** Choose an available category once when entering a catalog, before user selection. */
export function defaultCatalogCategory(type, groups, {favoritesCount} = {}) {
  const categories = uniqueCategories(groups);
  if (['live','movies','series'].includes(type)) {
    const favorites = categories.find(group => String(group.id) === favoritesCategory);
    const count = favoritesCount ?? favorites?.count;
    if (favorites && Number.isFinite(Number(count)) && Number(count) > 0) return favorites.id;
  }
  if(type==='movies'||type==='series')return releaseCatalogCategory(categories)?.id??RELEASES_CATEGORY;
  return allCategory;
}

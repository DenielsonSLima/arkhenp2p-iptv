export const HOME_SHELF_LIMIT=30;
const list=value=>Array.isArray(value)?value:[];
const text=value=>String(value||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase();

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
export function latestReleases(items, limit = HOME_SHELF_LIMIT) {
  const ordered = list(items).filter(item => item && item.name && item.id !== undefined).map((item, index) => ({item, index}));
  ordered.sort((first, second) => releaseYear(second.item) - releaseYear(first.item) ||
    Number(launchCategory(second.item)) - Number(launchCategory(first.item)) || addedTime(second.item) - addedTime(first.item) || first.index - second.index);
  const seen = new Set();
  return ordered.map(entry => entry.item).filter(item => {
    const identity = titleIdentity(item); if (seen.has(identity)) return false; seen.add(identity); return true;
  }).slice(0, Math.max(0, limit));
}

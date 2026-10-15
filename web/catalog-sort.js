const titleOrder = new Intl.Collator('pt-BR', {sensitivity:'base', numeric:true});
const modes = new Set(['name', 'date', 'rating']);

export function normalizeSortMode(value) {
  return modes.has(value) ? value : 'date';
}

function addedTime(value) {
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const time = number < 100000000000 ? number * 1000 : number;
  return Number.isFinite(new Date(time).getTime()) ? time : null;
}

function ratingValue(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value).trim();
  if (!/^\d+(?:[.,]\d+)?$/.test(text)) return null;
  const number = Number(text.replace(',', '.'));
  // Providers use zero for an unrated title, as does the card's rating display.
  return Number.isFinite(number) && number > 0 && number <= 10 ? number : null;
}

function ratingTie(first, second) {
  return titleOrder.compare(first.item.name || '', second.item.name || '')
    || titleOrder.compare(first.item.kind || '', second.item.kind || '')
    || titleOrder.compare(String(first.item.id ?? ''), String(second.item.id ?? ''))
    || first.index - second.index;
}

/** Sort loaded titles without mutating them or the provider's catalogue order. */
export function sortCatalogItems(items, value, {getAdded = item => item.added} = {}) {
  const mode = normalizeSortMode(value);
  return items.map((item, index) => ({
    item, index,
    score:mode === 'rating' ? ratingValue(item.rating) : mode === 'date' ? addedTime(getAdded(item)) ?? addedTime(item.added) : null
  })).sort((first, second) => {
    if (mode === 'name') return titleOrder.compare(first.item.name, second.item.name) || first.index - second.index;
    if (first.score === null && second.score !== null) return 1;
    if (first.score !== null && second.score === null) return -1;
    const difference = first.score === null ? 0 : second.score - first.score;
    return difference || (mode === 'rating' ? ratingTie(first, second) : first.index - second.index);
  }).map(entry => entry.item);
}

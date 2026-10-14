// Keep mounted posters and channel cards when a catalog changes locally.
// Moving only the changed children also preserves image decoding, focus and EPG.
const cardCaches = new WeakMap();

export function reconcileChildren(parent, children) {
  const wanted = new Set(children);
  for (const child of Array.from(parent.children)) if (!wanted.has(child)) child.remove();
  children.forEach((child, index) => {
    const current = parent.children[index];
    if (current !== child) parent.insertBefore(child, current || null);
  });
}

export function reconcileCards(grid, items, {key, signature, create, mounted}) {
  let cache = cardCaches.get(grid);
  if (!cache) { cache = new Map(); cardCaches.set(grid, cache); }
  const cards = items.map(item => {
    const id = key(item), version = signature(item);
    let record = cache.get(id);
    if (!record || record.version !== version) {
      record = {card:create(item), version};
      record.card.dataset.itemKey = id;
    }
    // A small LRU retains decoded posters when revisiting a category.
    cache.delete(id); cache.set(id, record);
    return record.card;
  });
  reconcileChildren(grid, cards);
  cards.forEach((card, index) => mounted?.(card, items[index]));
  for (const [id, record] of cache) {
    if (cache.size <= 256) break;
    if (!record.card.isConnected) cache.delete(id);
  }
}

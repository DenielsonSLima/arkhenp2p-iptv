/** Keep the existing channel-list contract independent of the player DOM. */
export function numberedChannels(entries = []) {
  const seen = new Set(), identities = new Set();
  return (Array.isArray(entries) ? entries : []).filter(entry => {
    const number = Number(entry?.number), id = String(entry?.item?.id ?? '').trim();
    if (!entry?.item || entry.item.kind !== 'live' || !id || !Number.isSafeInteger(number) || number < 1 || number > 999999 || seen.has(number) || identities.has(id)) return false;
    seen.add(number); identities.add(id); return true;
  }).map(entry => ({ item: entry.item, number: Number(entry.number) }));
}

export function channelNeighbors(entries, current) {
  const channels = numberedChannels(entries);
  const identity = String(current?.item?.id ?? '');
  let index = channels.findIndex(entry => String(entry.item.id) === identity);
  if (index < 0) index = channels.findIndex(entry => entry.number === Number(current?.channelNumber));
  const selected = channels[index] || null;
  if (!channels.length || channels.length === 1 && selected) return { previous: null, current: selected, next: null };
  return {
    previous: channels[index < 0 ? channels.length - 1 : (index - 1 + channels.length) % channels.length],
    current: selected,
    next: channels[index < 0 ? 0 : (index + 1) % channels.length]
  };
}

import { artworkURL } from '../channel-artwork.js';

const list = value => Array.isArray(value) ? value : [];

// Prioritize the banner, then give movies, series and channels equal turns.
// Only current visible shelf items can contribute artwork to preparation.
export function openingArtwork({hero = [], shelves = [], perType = 30, resolveArtwork = item => item.poster} = {}) {
  const limit = Number.isInteger(perType) && perType >= 0 ? perType : 30;
  const urls = [...new Set(list(hero).map(artworkURL).filter(Boolean))], seen = new Set(urls);
  const queues = new Map(['movie', 'series', 'live'].map(kind => [kind, []]));
  for (const shelf of list(shelves)) for (const item of list(shelf?.items)) {
    const queue = queues.get(item?.kind);
    if (!queue) continue;
    const url = artworkURL(resolveArtwork(item));
    if (url) queue.push(url);
  }
  const positions = new Map([...queues.keys()].map(kind => [kind, 0]));
  for (let index = 0; index < limit; index++) for (const [kind, queue] of queues) {
    let position = positions.get(kind);
    while (position < queue.length && seen.has(queue[position])) position++;
    if (position < queue.length) { const url = queue[position++]; seen.add(url); urls.push(url); }
    positions.set(kind, position);
  }
  return urls;
}

// Warm opening artwork without starting media; deadlines keep login bounded.
export async function preloadArtwork(values, {signal, maxItems = 96, concurrency = 4, timeoutMs = 4000, deadlineMs = 8000, createImage = () => new Image(), onProgress = () => {}} = {}) {
  const limit = Number.isInteger(maxItems) && maxItems >= 0 ? maxItems : 96;
  const urls = [...new Set(list(values).filter(artworkURL))].slice(0, limit);
  const externalSignal = signal, controller = new AbortController(), cancelAll = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener('abort', cancelAll, {once:true});
  signal = controller.signal;
  const deadline = setTimeout(cancelAll, deadlineMs);
  let cursor = 0, completed = 0, loaded = 0;
  const warm = url => new Promise(resolve => {
    if (signal?.aborted) { resolve(false); return; }
    const picture = createImage(); let settled = false;
    const settle = success => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      picture.onload = null; picture.onerror = null;
      if (!success) picture.removeAttribute?.('src');
      resolve(success);
    };
    const cancel = () => settle(false);
    const timer = setTimeout(cancel, timeoutMs);
    signal?.addEventListener('abort', cancel, {once:true});
    picture.onload = async () => {
      try { await picture.decode?.(); } catch { /* A loaded image can still be displayed. */ }
      settle(!signal?.aborted);
    };
    picture.onerror = () => settle(false);
    picture.decoding = 'async'; picture.loading = 'eager'; picture.src = url;
  });
  const worker = async () => {
    while (!signal?.aborted && cursor < urls.length) {
      const url = urls[cursor++], success = await warm(url);
      completed++; if (success) loaded++;
      onProgress({completed, loaded, total:urls.length});
    }
  };
  try {
    await Promise.all(Array.from({length:Math.min(Math.max(1, concurrency), urls.length)}, worker));
    return {completed, loaded, total:urls.length};
  } finally { clearTimeout(deadline); externalSignal?.removeEventListener('abort', cancelAll); }
}

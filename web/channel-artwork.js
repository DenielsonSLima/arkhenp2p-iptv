const CHANNEL_ID = /^\d{1,12}$/;
const LOCAL_LOGO = /^\/assets\/channels\/([a-z0-9]+(?:-[a-z0-9]+)*)-([a-f0-9]{8,64})\.webp$/;
const SHARED_IMAGE = /^\/api\/(?:shared|sports)-image\/[a-f0-9]{64}$/;
const QUALITY_SUFFIX = /(?:^|\s)(?:sd|hd|fhd|uhd|4k|hevc|h\s?265)$/;
// Explicit spellings observed in the OTT and APK catalogs; no partial matching.
const CHANNEL_ALIASES = new Map([['redetv', 'rede tv'], ['sportv 1', 'sportv']]);
const EMPTY_LOGOS = Object.freeze({resolve: () => '', geometry: () => null});

// These bounds describe the visible pixels of an existing asset. The WebP is
// kept intact; only its presentation is framed inside a 3:2 dark logo tile.
export function logoGeometry(artwork) {
  const {width, height, bounds} = artwork || {};
  if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 4096) ||
      !Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isInteger)) return null;
  const [x, y, w, h] = bounds;
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > width || y + h > height) return null;
  const scale = Math.min(0.82 * 3 / w, 0.82 * 2 / h);
  const percent = value => `${Number(value.toFixed(4))}%`;
  return {
    width: percent(width * scale / 3 * 100), height: percent(height * scale / 2 * 100),
    left: percent((3 - w * scale) / 6 * 100 - x * scale / 3 * 100),
    top: percent((2 - h * scale) / 4 * 100 - y * scale / 2 * 100)
  };
}

function localArtworkURL(value) {
  if (typeof value !== 'string' || value.length > 180) return '';
  const match = LOCAL_LOGO.exec(value);
  return match && match[1].length <= 70 && !/\s/.test(value) ? value : '';
}

// Both image proxies enforce the active account on the backend. Shared hashes
// are opaque identifiers, never the original provider URL or its credentials.
export function artworkURL(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\#\u0000-\u001f\u007f]/u.test(value)) return '';
  return localArtworkURL(value) || (SHARED_IMAGE.test(value) || value.startsWith('/api/image?') && value.length > 11 ? value : '');
}

export function fallbackArtworkURL(source, fallback) {
  const current=artworkURL(source),next=artworkURL(fallback);
  return current.startsWith('/assets/channels/')&&next.startsWith('/api/')&&next!==current?next:'';
}

function channelName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 300) return '';
  let name = value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}+]+/gu, ' ').replace(/\s+/g, ' ').trim();
  let suffix;
  while ((suffix = QUALITY_SUFFIX.exec(name))) name = name.slice(0, suffix.index).trim();
  // Regions, camera numbers and time-shift markers remain part of the identity.
  name = name.replace(/\s*\+\s*/g, '+');
  return CHANNEL_ALIASES.get(name) || name;
}

function itemID(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  return typeof value === 'string' && CHANNEL_ID.test(value) ? value : '';
}

function onlyFile(files) {
  return files?.size === 1 ? files.values().next().value : '';
}

function buildResolver(manifest) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.channels) || manifest.channels.length > 10000) return EMPTY_LOGOS;
  const byID = new Map(), byName = new Map(), geometries = new Map();
  for (const entry of manifest.channels) {
    const file = localArtworkURL(entry?.file), ids = entry?.ids, names = entry?.names;
    if (!file || !Array.isArray(ids) || !ids.length || ids.length > 10000 ||
        !ids.every(id => typeof id === 'string' && CHANNEL_ID.test(id)) ||
        !Array.isArray(names) || !names.length || names.length > 10000 || !names.every(channelName)) continue;
    const canonicalNames = new Set(names.map(channelName));
    const geometry = logoGeometry(entry.artwork);
    if (geometry) geometries.set(file, geometry);
    for (const id of new Set(ids)) {
      if (!byID.has(id)) byID.set(id, []);
      byID.get(id).push({file, names: canonicalNames});
    }
    for (const name of canonicalNames) {
      if (!byName.has(name)) byName.set(name, new Set());
      byName.get(name).add(file);
    }
  }
  return Object.freeze({
    geometry(file) { return geometries.get(file) || null; },
    resolve(item) {
      if (item?.kind !== 'live') return '';
      const id = itemID(item.id), name = channelName(item.name);
      if (!id || !name) return '';
      if (byID.has(id)) {
        const files = new Set(byID.get(id).filter(entry => entry.names.has(name)).map(entry => entry.file));
        // A known ID with an incompatible name keeps the provider's artwork.
        return onlyFile(files);
      }
      return onlyFile(byName.get(name));
    }
  });
}

// The caller owns the request deadline; unavailable manifests are optional.
export async function loadChannelLogos(fetchFn = globalThis.fetch) {
  if (typeof fetchFn !== 'function') return EMPTY_LOGOS;
  try {
    const response = await fetchFn('/assets/channels/manifest.json', {cache: 'no-store'});
    return response?.ok ? buildResolver(await response.json()) : EMPTY_LOGOS;
  } catch {
    return EMPTY_LOGOS;
  }
}

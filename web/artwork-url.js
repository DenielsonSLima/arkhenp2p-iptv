const LOCAL_LOGO = /^\/assets\/channels\/([a-z0-9]+(?:-[a-z0-9]+)*)-([a-f0-9]{8,64})\.webp$/;
const GROUPED_LOGO = /^\/tv\/logos\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)-([a-f0-9]{8,64})\.webp$/;
const SHARED_IMAGE = /^\/api\/(?:shared|sports)-image\/[a-f0-9]{64}$/;

export function localArtworkURL(value) {
  if (typeof value !== 'string' || value.length > 260) return '';
  const legacy = LOCAL_LOGO.exec(value), grouped = GROUPED_LOGO.exec(value);
  const validLegacy=legacy&&legacy[1].length<=70;
  const validGrouped=grouped&&grouped[1].length<=100&&grouped[2].length<=70;
  return validLegacy||validGrouped?value:'';
}

// Both image proxies enforce the active account on the backend. Shared hashes
// are opaque identifiers, never the original provider URL or its credentials.
export function artworkURL(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\#\u0000-\u001f\u007f]/u.test(value)) return '';
  return localArtworkURL(value) || (SHARED_IMAGE.test(value) || value.startsWith('/api/image?') && value.length > 11 ? value : '');
}

export function fallbackArtworkURL(source, fallback) {
  const current=artworkURL(source),next=artworkURL(fallback);
  return localArtworkURL(current)&&next.startsWith('/api/')&&next!==current?next:'';
}

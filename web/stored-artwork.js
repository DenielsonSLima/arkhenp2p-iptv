import { artworkURL } from './channel-artwork.js';

// Session handles belong to one provider client. Shared hashes identify public
// catalog artwork; the backend still checks the active partition and parental
// permission before resolving their source. Neither form stores provider URLs.
export function storedArtworkURL(value) {
  const url=artworkURL(value);
  return url.startsWith('/assets/channels/')||url.startsWith('/tv/logos/')||/^\/api\/shared-image\/[a-f0-9]{64}$/.test(url)?url:'';
}

export function withoutSessionArtwork(item) {
  const saved = {...item};
  for (const field of ['poster', 'posterOriginal', 'backdrop']) {
    if (!(field in saved)) continue;
    saved[field] = storedArtworkURL(saved[field]);
  }
  return saved;
}

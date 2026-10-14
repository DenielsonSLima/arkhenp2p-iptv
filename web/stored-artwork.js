import { artworkURL } from './channel-artwork.js';

// Proxy references belong to one authenticated client, not to a saved title.
// Only bundled assets remain valid after a login or server restart.
export function withoutSessionArtwork(item) {
  const saved = {...item};
  for (const field of ['poster', 'posterOriginal', 'backdrop']) {
    if (!(field in saved)) continue;
    const value = artworkURL(saved[field]);
    saved[field] = value.startsWith('/assets/channels/') ? value : '';
  }
  return saved;
}

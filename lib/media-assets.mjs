import { createHmac, randomBytes } from 'node:crypto';

// HLS clients identify overlapping live segments by sequence AND URI. Give the
// same resource a stable opaque URI during one playback, without exposing the
// provider URL. Clearing the registry revokes every token and rotates its key.
export class MediaAssets extends Map {
  #secret = randomBytes(32);
  register(url, key, mediaDurationSeconds = null, cacheKey = null, identity = null) {
    const namespace=typeof identity==='string'&&identity?[key,'web-live-segment-v1',identity]:[key,String(url),cacheKey];
    const token = createHmac('sha256', this.#secret)
      .update(JSON.stringify(namespace)).digest('base64url').slice(0, 32);
    // Refresh LRU order on a reload, keeping the token itself unchanged.
    this.delete(token);
    this.set(token, { url, key, time: Date.now(), mediaDurationSeconds, cacheKey });
    while (this.size > 3000) this.delete(this.keys().next().value);
    return '/api/asset/' + token;
  }
  clear() { super.clear(); this.#secret = randomBytes(32); }
}

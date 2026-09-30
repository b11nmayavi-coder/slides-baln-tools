// Cloudflare Worker entry: static assets from ./public, media in R2, edge cache for whole-object media GETs.
import { createApp } from './app.js';

function r2Media(bucket) {
  if (!bucket) return null;
  return {
    async head(key) {
      const o = await bucket.head(key);
      return o && { size: o.size, type: o.httpMetadata?.contentType || 'application/octet-stream', etag: o.httpEtag };
    },
    async get(key, range) {
      const o = await bucket.get(key, range ? { range } : undefined);
      return o ? o.body : null;
    },
    async put(key, bytes, type) {
      await bucket.put(key, bytes, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } });
    },
  };
}

export default {
  async fetch(req, env, ctx) {
    const handle = createApp({
      env,
      media: r2Media(env.MEDIA),
      assets: (r) => env.ASSETS.fetch(r),
      cache: caches.default,
    });
    return handle(req, (p) => ctx.waitUntil(p));
  },
};

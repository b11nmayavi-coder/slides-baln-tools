// Media storage: upload to R2 through the worker when available, otherwise keep blobs in IndexedDB.
// src forms: "/a/<key>" (R2), "local:<key>" (IndexedDB blob), "data:..." / "https://..." (inline / remote).
import { db } from './db.js';
import { settings, server } from './settings.js';
import { hashStr, readAsDataURL } from './util.js';

const urls = new Map(); // local key -> object URL
const pending = new Map();
const listeners = new Set();

export const onMediaReady = (fn) => listeners.add(fn);

export async function putMedia(blob) {
  if (server.uploads && (settings.accessToken || !server.auth)) {
    try {
      const r = await fetch('/api/assets', {
        method: 'PUT',
        headers: { 'content-type': blob.type, 'x-slides-token': settings.accessToken || '' },
        body: blob,
      });
      if (r.ok) return (await r.json()).url;
    } catch {}
  }
  const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
  let s = blob.type + ':' + blob.size + ':';
  for (let i = 0; i < head.length; i += 97) s += head[i];
  const key = hashStr(s) + blob.size.toString(36);
  await db.put('media', key, blob);
  urls.set(key, URL.createObjectURL(blob));
  return 'local:' + key;
}

// Synchronous resolve for rendering; kicks off an async load for unseen local keys.
export function resolveSrc(src) {
  if (!src || !src.startsWith('local:')) return src || '';
  const key = src.slice(6);
  const u = urls.get(key);
  if (u) return u;
  if (!pending.has(key)) {
    pending.set(key, db.get('media', key).then((blob) => {
      pending.delete(key);
      if (!blob) return;
      urls.set(key, URL.createObjectURL(blob));
      listeners.forEach((fn) => fn(src));
    }));
  }
  return '';
}

export async function mediaBlob(src) {
  if (src.startsWith('local:')) return db.get('media', src.slice(6));
  const r = await fetch(src);
  return r.blob();
}

// For export: inline local media as data URLs so a deck file is self-contained.
export async function inlineLocalMedia(deckJson) {
  const keys = [...new Set((deckJson.match(/local:[a-z0-9]+/g) || []))];
  const map = {};
  for (const k of keys) {
    const blob = await db.get('media', k.slice(6));
    if (blob) map[k] = await readAsDataURL(blob);
  }
  return map;
}

export async function importInlineMedia(map) {
  for (const k in map || {}) {
    const blob = await (await fetch(map[k])).blob();
    await db.put('media', k.slice(6), blob);
  }
}

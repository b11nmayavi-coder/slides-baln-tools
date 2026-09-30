// Persistence. Decks and chats live in IndexedDB by default, or on the server when it has a database
// (the Node server with SQLite or Firebase: see /api/status `storage`). Local media blobs always use IndexedDB.
import { settings } from './settings.js';

const DB_NAME = 'slides-balan-tools';
const STORES = ['decks', 'chats', 'media'];
const REMOTE_STORES = new Set(['decks', 'chats']);
let dbp;
let remote = false;

export function useRemoteStorage(on) { remote = on; }
export const isRemote = () => remote;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 2);
    r.onupgradeneeded = () => {
      for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => res(out && 'result' in out ? out.result : out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export const local = {
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  put: (store, key, val) => tx(store, 'readwrite', (s) => { s.put(val, key); }),
  del: (store, key) => tx(store, 'readwrite', (s) => { s.delete(key); }),
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
};

async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: { 'x-slides-token': settings.accessToken || '', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 404 && method === 'GET') return undefined;
  if (!r.ok) {
    let msg = `${r.status}`;
    try { msg = (await r.json()).error?.message || msg; } catch {}
    throw new Error(`Server storage: ${msg}`);
  }
  return r.json();
}

export const db = {
  get: (store, key) => (remote && REMOTE_STORES.has(store) ? api('GET', `/api/${store}/${encodeURIComponent(key)}`) : local.get(store, key)),
  put: (store, key, val) => (remote && REMOTE_STORES.has(store) ? api('PUT', `/api/${store}/${encodeURIComponent(key)}`, val) : local.put(store, key, val)),
  del: (store, key) => (remote && REMOTE_STORES.has(store) ? api('DELETE', `/api/${store}/${encodeURIComponent(key)}`) : local.del(store, key)),
  // Deck summaries, newest first.
  async listDecks() {
    if (remote) return api('GET', '/api/decks');
    const all = await local.all('decks');
    return all.map((d) => ({ id: d.id, title: d.title, updated: d.updated, slides: d.slides.length })).sort((a, b) => b.updated - a.updated);
  },
};

// First run against a server database: copy decks (and chats) this browser already has, if the server is empty.
export async function migrateLocalToServer() {
  if (!remote) return 0;
  const server = await api('GET', '/api/decks');
  if (server.length) return 0;
  const decks = await local.all('decks');
  for (const d of decks) {
    await api('PUT', `/api/decks/${encodeURIComponent(d.id)}`, d);
    const c = await local.get('chats', d.id);
    if (c) await api('PUT', `/api/chats/${encodeURIComponent(d.id)}`, c);
  }
  return decks.length;
}

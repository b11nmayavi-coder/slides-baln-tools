// Request handling shared by both backends:
//   src/worker.js     Cloudflare Worker, media in R2
//   server/node.js    plain Node server, media in SQLite
//
// Routes:
//   /api/status               what the server offers
//   /api/chat                 LLM proxy in Ollama's /api/chat format (see src/llm.js; Ollama or Gemini)
//   /api/assets               PUT an image/video (content-addressed)
//   /a/<key>                  public, immutable media (supports range requests for video seeking)
//   /api/decks[/<id>]         deck storage (only when a `store` adapter is configured, e.g. SQLite/Firebase)
//   /api/chats/<id>           assistant history per deck (same)
// Everything except /a/<key> and static files is gated by ACCESS_TOKEN when it is set.
//
// `media` adapter:  head(key) -> {size, type, etag} | null · get(key, {offset, length}?) -> body · put(key, bytes, type)
// `store` adapter:  name · listDecks() -> [{id, title, updated, slides}] · getDeck(id) · putDeck(id, deck) · deleteDeck(id)
//                   getChat(id) · putChat(id, chat) · deleteChat(id)      (all may be async; missing -> null)
import { chat, llmInfo } from './llm.js';

const MAX_UPLOAD = 100 * 1024 * 1024;
const ALLOWED_MEDIA = /^(image\/(png|jpeg|gif|webp|avif|svg\+xml)|video\/(mp4|webm|quicktime))$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';

export function createApp({ env, media, assets, cache = null, store = null }) {
  return async function handle(req, waitUntil = () => {}) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/api/status') return status(env, media, store);
      if (url.pathname === '/api/chat') return await proxyChat(req, env);
      if (url.pathname === '/api/assets') return await upload(req, env, media);
      if (url.pathname === '/api/decks' || url.pathname.startsWith('/api/decks/') || url.pathname.startsWith('/api/chats/')) return await storage(req, env, url, store);
      if (url.pathname.startsWith('/a/')) return await serveMedia(req, url, media, cache, waitUntil);
    } catch (err) {
      return json({ error: { type: 'server_error', message: String((err && err.message) || err) } }, 500);
    }
    if (url.pathname.startsWith('/api/')) return json({ error: { type: 'not_found' } }, 404);
    return assets(req);
  };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function authorized(req, env) {
  if (!env.ACCESS_TOKEN) return true; // no token configured (e.g. local use): open
  const token = req.headers.get('x-slides-token') || '';
  if (token.length !== env.ACCESS_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ env.ACCESS_TOKEN.charCodeAt(i);
  return diff === 0;
}

function status(env, media, store) {
  const llm = llmInfo(env);
  return json({
    ai: llm.configured,
    provider: llm.provider,
    defaultModel: llm.model,
    uploads: Boolean(media),
    storage: store ? store.name : null,
    auth: Boolean(env.ACCESS_TOKEN),
  });
}

async function proxyChat(req, env) {
  if (req.method !== 'POST') return json({ error: { type: 'method_not_allowed' } }, 405);
  const llm = llmInfo(env);
  if (!llm.configured) return json({ error: { type: 'ai_disabled', message: llm.problem } }, 503);
  if (!authorized(req, env)) return json({ error: { type: 'authentication_error', message: 'Missing or wrong access token (Settings → Access token).' } }, 401);
  let body;
  try { body = await req.json(); } catch { return json({ error: { type: 'bad_request', message: 'Body must be JSON' } }, 400); }
  return chat(env, body);
}

const MAX_JSON = 60 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

async function storage(req, env, url, store) {
  if (!store) return json({ error: { type: 'storage_disabled', message: 'This server keeps decks in the browser.' } }, 404);
  if (!authorized(req, env)) return json({ error: { type: 'authentication_error', message: 'Missing or wrong access token (Settings → Access token).' } }, 401);
  const [, , kind, id] = url.pathname.split('/'); // ['', 'api', 'decks'|'chats', id?]
  if (kind === 'decks' && !id) {
    if (req.method !== 'GET') return json({ error: { type: 'method_not_allowed' } }, 405);
    return json(await store.listDecks());
  }
  if (!ID.test(id || '')) return json({ error: { type: 'bad_id' } }, 400);
  const ops = kind === 'decks'
    ? { get: (i) => store.getDeck(i), put: (i, v) => store.putDeck(i, v), del: (i) => store.deleteDeck(i) }
    : { get: (i) => store.getChat(i), put: (i, v) => store.putChat(i, v), del: (i) => store.deleteChat(i) };
  if (req.method === 'GET') {
    const v = await ops.get(id);
    return v == null ? json({ error: { type: 'not_found' } }, 404) : json(v);
  }
  if (req.method === 'PUT') {
    const text = await req.text();
    if (text.length > MAX_JSON) return json({ error: { type: 'too_large' } }, 413);
    let v;
    try { v = JSON.parse(text); } catch { return json({ error: { type: 'bad_request', message: 'Body must be JSON' } }, 400); }
    if (kind === 'decks' && (!v || v.id !== id || !Array.isArray(v.slides))) return json({ error: { type: 'bad_request', message: 'Not a deck' } }, 400);
    await ops.put(id, v);
    return json({ ok: true });
  }
  if (req.method === 'DELETE') { await ops.del(id); return json({ ok: true }); }
  return json({ error: { type: 'method_not_allowed' } }, 405);
}

async function upload(req, env, media) {
  if (req.method !== 'PUT' && req.method !== 'POST') return json({ error: { type: 'method_not_allowed' } }, 405);
  if (!media) return json({ error: { type: 'uploads_disabled' } }, 503);
  if (!authorized(req, env)) return json({ error: { type: 'authentication_error' } }, 401);

  const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_MEDIA.test(type)) return json({ error: { type: 'unsupported_media', message: type } }, 415);
  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_UPLOAD) return json({ error: { type: 'too_large' } }, 413);

  const digest = await crypto.subtle.digest('SHA-256', buf);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const key = `${hex.slice(0, 32)}.${extFor(type)}`;
  if (!(await media.head(key))) await media.put(key, buf, type);
  return json({ key, url: `/a/${key}`, size: buf.byteLength, type });
}

function extFor(type) {
  return {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/avif': 'avif', 'image/svg+xml': 'svg', 'video/mp4': 'mp4', 'video/webm': 'webm',
    'video/quicktime': 'mov',
  }[type] || 'bin';
}

// "bytes=a-b" | "bytes=a-" | "bytes=-n" -> { offset, length } within size, or null if unsatisfiable
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return undefined; // not a single simple range: ignore
  let start, end;
  if (m[1] === '') { const n = +m[2]; start = Math.max(0, size - n); end = size - 1; }
  else { start = +m[1]; end = m[2] === '' ? size - 1 : Math.min(+m[2], size - 1); }
  if (start >= size || start > end) return null;
  return { offset: start, length: end - start + 1 };
}

async function serveMedia(req, url, media, cache, waitUntil) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405 });
  const key = url.pathname.slice(3);
  if (!media || !/^[0-9a-f]{32}\.[a-z0-9]+$/.test(key)) return new Response('Not found', { status: 404 });

  const rangeHeader = req.headers.get('range');
  if (cache && !rangeHeader) {
    const hit = await cache.match(req);
    if (hit) return hit;
  }
  const meta = await media.head(key);
  if (!meta) return new Response('Not found', { status: 404 });

  const headers = new Headers({
    'content-type': meta.type,
    etag: meta.etag,
    'accept-ranges': 'bytes',
    'cache-control': IMMUTABLE,
    'access-control-allow-origin': '*',
  });

  const range = rangeHeader ? parseRange(rangeHeader, meta.size) : undefined;
  if (range === null) {
    headers.set('content-range', `bytes */${meta.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) {
    headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${meta.size}`);
    headers.set('content-length', String(range.length));
    const body = req.method === 'HEAD' ? null : await media.get(key, range);
    return new Response(body, { status: 206, headers });
  }
  headers.set('content-length', String(meta.size));
  const body = req.method === 'HEAD' ? null : await media.get(key);
  const res = new Response(body, { headers });
  if (cache && req.method === 'GET') waitUntil(cache.put(req, res.clone()));
  return res;
}

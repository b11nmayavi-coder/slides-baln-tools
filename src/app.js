// Request handling shared by both backends:
//   src/worker.js     Cloudflare Worker, media in R2
//   server/node.js    plain Node server, media in SQLite
//
// Routes:
//   /api/status         what the server offers
//   /api/ollama/chat    Ollama chat proxy (Ollama Cloud by default, or OLLAMA_URL); the key stays server-side
//   /api/assets         PUT an image/video (content-addressed)
//   /a/<key>            public, immutable media (supports range requests for video seeking)
// The chat proxy and uploads are gated by ACCESS_TOKEN when it is set (always set it on a public deployment).
//
// `media` is a small storage adapter:
//   head(key)                   -> { size, type, etag } | null
//   get(key, { offset, length}) -> body (ReadableStream | Uint8Array); range optional
//   put(key, bytes, type)       -> void

const MAX_UPLOAD = 100 * 1024 * 1024;
const ALLOWED_MEDIA = /^(image\/(png|jpeg|gif|webp|avif|svg\+xml)|video\/(mp4|webm|quicktime))$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';

export function createApp({ env, media, assets, cache = null }) {
  return async function handle(req, waitUntil = () => {}) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/api/status') return status(env, media);
      if (url.pathname === '/api/ollama/chat') return await proxyOllama(req, env);
      if (url.pathname === '/api/assets') return await upload(req, env, media);
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

function status(env, media) {
  return json({
    ai: Boolean(env.OLLAMA_API_KEY || env.OLLAMA_URL),
    uploads: Boolean(media),
    auth: Boolean(env.ACCESS_TOKEN),
  });
}

async function proxyOllama(req, env) {
  if (req.method !== 'POST') return json({ error: { type: 'method_not_allowed' } }, 405);
  if (!env.OLLAMA_API_KEY && !env.OLLAMA_URL) return json({ error: { type: 'ai_disabled', message: 'The server has no OLLAMA_API_KEY (or OLLAMA_URL) configured.' } }, 503);
  if (!authorized(req, env)) return json({ error: { type: 'authentication_error', message: 'Missing or wrong access token (Settings → Access token).' } }, 401);

  const base = (env.OLLAMA_URL || 'https://ollama.com').replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json' };
  if (env.OLLAMA_API_KEY) headers.authorization = `Bearer ${env.OLLAMA_API_KEY}`;
  let upstream;
  try {
    upstream = await fetch(base + '/api/chat', { method: 'POST', headers, body: await req.text() });
  } catch (err) {
    return json({ error: { type: 'upstream_unreachable', message: `Could not reach Ollama at ${base}: ${err.message}` } }, 502);
  }
  // Stream NDJSON straight through; surface upstream errors verbatim (a retired model fails here).
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') || 'application/x-ndjson', 'cache-control': 'no-store' },
  });
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

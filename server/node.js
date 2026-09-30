// Plain Node server: no Cloudflare needed. Serves ./public, proxies Ollama, and stores uploaded
// images/videos in a local SQLite file (Node's built-in node:sqlite, Node 22.5+).
//
//   npm start                      -> http://localhost:8787
//   PORT=3000 SLIDES_DB=./my.db npm start
//
// Configuration is read from environment variables, or from .dev.vars / .env in the project root.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

for (const f of ['.dev.vars', '.env']) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) process.loadEnvFile(p);
}
const env = process.env;
const PORT = Number(env.PORT) || 8787;
const DB_PATH = path.resolve(ROOT, env.SLIDES_DB || 'data/slides.db');

// ---------- SQLite media storage ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS media (
    key     TEXT PRIMARY KEY,
    type    TEXT NOT NULL,
    size    INTEGER NOT NULL,
    data    BLOB NOT NULL,
    created INTEGER NOT NULL
  );
`);
const qHead = db.prepare('SELECT type, size FROM media WHERE key = ?');
const qAll = db.prepare('SELECT data FROM media WHERE key = ?');
const qPart = db.prepare('SELECT substr(data, ?, ?) AS data FROM media WHERE key = ?'); // 1-based offset
const qPut = db.prepare('INSERT OR IGNORE INTO media (key, type, size, data, created) VALUES (?, ?, ?, ?, ?)');

const sqliteMedia = {
  head(key) {
    const r = qHead.get(key);
    return r ? { size: r.size, type: r.type, etag: `"${key.split('.')[0]}"` } : null;
  },
  get(key, range) {
    const r = range ? qPart.get(range.offset + 1, range.length, key) : qAll.get(key);
    return r ? new Uint8Array(r.data) : null;
  },
  put(key, bytes, type) {
    qPut.run(key, type, bytes.byteLength, new Uint8Array(bytes), Date.now());
  },
};

// ---------- static files ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

async function assets(req) {
  const url = new URL(req.url);
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(PUBLIC, '.' + rel);
  if (!file.startsWith(PUBLIC + path.sep)) return new Response('Not found', { status: 404 });
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw new Error('not a file');
    const body = req.method === 'HEAD' ? null : Readable.toWeb(fs.createReadStream(file));
    return new Response(body, {
      headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': String(stat.size), 'cache-control': 'no-cache' },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

// ---------- HTTP bridge (node:http <-> fetch Request/Response) ----------
const handle = createApp({ env, media: sqliteMedia, assets });

const server = http.createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host || 'localhost'}${req.url}`;
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(url, {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])),
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: hasBody ? 'half' : undefined,
    });
    const response = await handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) return res.end();
    Readable.fromWeb(response.body).on('error', () => res.destroy()).pipe(res);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(err?.stack || err));
  }
});

server.listen(PORT, () => {
  const ai = env.OLLAMA_URL ? `local Ollama at ${env.OLLAMA_URL}` : env.OLLAMA_API_KEY ? 'Ollama Cloud' : 'not configured (set OLLAMA_API_KEY or OLLAMA_URL)';
  console.log(`Slides running at http://localhost:${PORT}`);
  console.log(`  media: SQLite ${path.relative(ROOT, DB_PATH)}`);
  console.log(`  AI:    ${ai}`);
  console.log(`  auth:  ${env.ACCESS_TOKEN ? 'ACCESS_TOKEN required' : 'open (no ACCESS_TOKEN set)'}`);
});

process.on('SIGINT', () => { db.close(); process.exit(0); });

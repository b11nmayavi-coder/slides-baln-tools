// Plain Node server (no Cloudflare): serves ./public, proxies the LLM, and keeps decks, chats and
// uploaded media in SQLite or Firebase. Started by server/start.js, which handles configuration.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { llmInfo } from '../src/llm.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

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

async function openStorage(env) {
  if (env.SLIDES_STORAGE === 'firebase') {
    const { createFirebase } = await import('./storage/firebase.js');
    return createFirebase(env);
  }
  const { createSqlite } = await import('./storage/sqlite.js');
  return createSqlite(path.resolve(ROOT, env.SLIDES_DB || 'data/slides.db'));
}

export async function startServer(env) {
  const storage = await openStorage(env);
  const handle = createApp({ env, media: storage.media, store: storage.store, assets });
  const port = Number(env.PORT) || 8787;

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

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, resolve);
  });

  const llm = llmInfo(env);
  const ai = !llm.configured ? `not configured (${llm.problem})`
    : llm.provider === 'gemini' ? `Gemini · ${llm.model}`
    : env.OLLAMA_URL ? `local Ollama at ${env.OLLAMA_URL} · ${llm.model}` : `Ollama Cloud · ${llm.model}`;
  console.log(`\n  Slides running at http://localhost:${port}\n`);
  console.log(`  storage  ${storage.describe}`);
  console.log(`  AI       ${ai}`);
  console.log(`  auth     ${env.ACCESS_TOKEN ? 'ACCESS_TOKEN required' : 'open (no ACCESS_TOKEN set)'}`);
  console.log(`\n  Change these answers any time with: npm run setup\n`);

  process.on('SIGINT', () => { storage.close(); process.exit(0); });
  return server;
}

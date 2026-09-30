// Entry point for `npm start` / `npm run setup`.
// On first run (or with --setup) it asks where to store data and which LLM to use, saves the answers
// to .dev.vars, then starts the Node server.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { ROOT, startServer } from './node.js';
import { llmInfo, DEFAULT_MODELS } from '../src/llm.js';

const CONFIG = path.join(ROOT, '.dev.vars');
const force = process.argv.includes('--setup');

for (const f of ['.dev.vars', '.env']) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) process.loadEnvFile(p);
}

const OLLAMA_CLOUD_MODELS = ['kimi-k3', 'kimi-k2.7-code', 'minimax-m3', 'gemma4:31b', 'mistral-large-3:675b', 'glm-5.3', 'deepseek-v4-pro:0813', 'gpt-oss:120b'];
const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3.7-flash', 'gemini-3.5-flash-lite'];

// ---------- tiny prompt helpers ----------
const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m` };
let rl, muted = false;
function openPrompt() {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Mask secret input.
  const write = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (s) => { if (!muted) return write(s); if (s.includes('\n') || s.includes('\r')) process.stdout.write('\n'); else process.stdout.write('*'.repeat(s.length)); };
}
const question = (q) => new Promise((res) => rl.question(q, res));

async function ask(label, def = '') {
  const a = (await question(`  ${label}${def ? c.dim(` [${def}]`) : ''}: `)).trim();
  return a || def;
}

async function askSecret(label, existing) {
  const hint = existing ? c.dim(` [Enter keeps …${existing.slice(-4)}]`) : '';
  process.stdout.write(`  ${label}${hint}: `);
  muted = true;
  const a = (await question('')).trim();
  muted = false;
  return a || existing || '';
}

async function choose(title, options, defIndex = 0) {
  console.log(`\n${c.bold(title)}`);
  options.forEach((o, i) => console.log(`  ${c.cyan(String(i + 1))}) ${o.label}${o.hint ? c.dim('  ' + o.hint) : ''}`));
  for (;;) {
    const a = (await question(`  Choose 1-${options.length}${c.dim(` [${defIndex + 1}]`)}: `)).trim();
    if (!a) return options[defIndex].value;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value;
    const byName = options.find((o) => o.value === a);
    if (byName) return byName.value;
    console.log(c.red('  Please enter one of the numbers.'));
  }
}

async function yes(label, def = true) {
  const a = (await question(`  ${label} ${c.dim(def ? '[Y/n]' : '[y/N]')}: `)).trim().toLowerCase();
  return a ? a.startsWith('y') : def;
}

const ok = (s) => console.log(`  ${c.green('✓')} ${s}`);
const fail = (s) => console.log(`  ${c.red('✗')} ${s}`);

async function chooseModel(title, list, current) {
  const options = list.map((m) => ({ label: m, value: m }));
  options.push({ label: 'Other…', value: '__other' });
  const def = Math.max(0, list.indexOf(current));
  const v = await choose(title, options, def);
  return v === '__other' ? ask('Model name', current) : v;
}

// ---------- questions ----------
async function setupStorage(cfg) {
  const storage = await choose('1) Where should decks and uploaded media be stored?', [
    { label: 'SQLite', value: 'sqlite', hint: 'a single local file, nothing to set up' },
    { label: 'Firebase', value: 'firebase', hint: 'Firestore + Cloud Storage in your Firebase project' },
  ], cfg.SLIDES_STORAGE === 'firebase' ? 1 : 0);
  cfg.SLIDES_STORAGE = storage;

  if (storage === 'sqlite') {
    cfg.SLIDES_DB = await ask('Database file', cfg.SLIDES_DB || 'data/slides.db');
    ok(`Using SQLite at ${cfg.SLIDES_DB}`);
    return;
  }

  // Firebase
  try { await import('firebase-admin/app'); } catch {
    console.log(c.dim('  firebase-admin (the Firebase server SDK) is not installed.'));
    if (await yes('Install it now with npm?')) {
      const r = spawnSync('npm', ['install', 'firebase-admin', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
      if (r.status !== 0) throw new Error('npm install firebase-admin failed');
    } else {
      throw new Error('firebase-admin is required for Firebase storage (npm install firebase-admin).');
    }
  }
  console.log(c.dim('  Create a key in the Firebase console: Project settings → Service accounts → Generate new private key.'));
  const hasEnvCreds = cfg.FIREBASE_PROJECT_ID && cfg.FIREBASE_CLIENT_EMAIL && cfg.FIREBASE_PRIVATE_KEY;
  for (;;) {
    const p = await ask('Path to the service-account JSON file' + (hasEnvCreds ? c.dim(' (Enter to use FIREBASE_PRIVATE_KEY from env)') : ''), cfg.FIREBASE_SERVICE_ACCOUNT || '');
    if (!p && hasEnvCreds) { delete cfg.FIREBASE_SERVICE_ACCOUNT; break; }
    const full = path.resolve(ROOT, p.replace(/^~(?=\/)/, process.env.HOME || '~'));
    try {
      const sa = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!sa.project_id || !sa.private_key) throw new Error('not a service-account key file');
      cfg.FIREBASE_SERVICE_ACCOUNT = full;
      cfg.FIREBASE_PROJECT_ID = sa.project_id;
      ok(`Service account for project ${sa.project_id}`);
      break;
    } catch (err) {
      fail(`Couldn't read ${full}: ${err.message}`);
    }
  }
  cfg.FIREBASE_STORAGE_BUCKET = await ask('Cloud Storage bucket', cfg.FIREBASE_STORAGE_BUCKET || `${cfg.FIREBASE_PROJECT_ID}.firebasestorage.app`);

  process.stdout.write('  Checking Firebase… ');
  try {
    const { createFirebase } = await import('./storage/firebase.js');
    const fb = await createFirebase({ ...process.env, ...cfg });
    await fb.store.listDecks();
    console.log(c.green('connected'));
  } catch (err) {
    console.log(c.red('failed'));
    fail(err.message.split('\n')[0]);
    console.log(c.dim('  Make sure Firestore and Storage are enabled in the Firebase console. You can re-run: npm run setup'));
  }
}

async function setupLLM(cfg) {
  const provider = await choose('2) Which LLM provider should the assistant use?', [
    { label: 'Ollama', value: 'ollama', hint: 'Ollama Cloud or Ollama running on this machine' },
    { label: 'Gemini', value: 'gemini', hint: 'Google Gemini API key from aistudio.google.com' },
  ], cfg.LLM_PROVIDER === 'gemini' ? 1 : 0);
  cfg.LLM_PROVIDER = provider;

  if (provider === 'gemini') {
    console.log(c.dim('  Get a key at https://aistudio.google.com/apikey'));
    for (;;) {
      cfg.GEMINI_API_KEY = await askSecret('Gemini API key', cfg.GEMINI_API_KEY);
      if (!cfg.GEMINI_API_KEY) { fail('A key is required.'); continue; }
      process.stdout.write('  Checking key… ');
      try {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': cfg.GEMINI_API_KEY } });
        if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`);
        const names = ((await r.json()).models || []).map((m) => m.name.replace(/^models\//, ''));
        console.log(c.green('valid'));
        const offered = GEMINI_MODELS.filter((m) => !names.length || names.includes(m));
        cfg.GEMINI_MODEL = await chooseModel('   Model', offered.length ? offered : GEMINI_MODELS, cfg.GEMINI_MODEL || DEFAULT_MODELS.gemini);
        break;
      } catch (err) {
        console.log(c.red('rejected'));
        fail(err.message);
        cfg.GEMINI_API_KEY = '';
      }
    }
    return;
  }

  const where = await choose('   Ollama Cloud or local Ollama?', [
    { label: 'Ollama Cloud', value: 'cloud', hint: 'needs an API key from ollama.com/settings/keys' },
    { label: 'Ollama on this machine', value: 'local', hint: 'no key; uses models you have pulled' },
  ], cfg.OLLAMA_URL ? 1 : 0);

  if (where === 'local') {
    for (;;) {
      cfg.OLLAMA_URL = await ask('Ollama URL', cfg.OLLAMA_URL || 'http://localhost:11434');
      process.stdout.write('  Looking for models… ');
      try {
        const base = cfg.OLLAMA_URL.replace(/\/+$/, '');
        const tags = await (await fetch(base + '/api/tags')).json();
        const models = [];
        for (const m of tags.models || []) {
          let caps = [];
          try { caps = (await (await fetch(base + '/api/show', { method: 'POST', body: JSON.stringify({ model: m.name }) })).json()).capabilities || []; } catch {}
          models.push({ name: m.name, caps });
        }
        console.log(c.green(`${models.length} found`));
        const usable = models.filter((m) => m.caps.includes('tools'));
        if (!usable.length) {
          fail('No local model supports tool calling. Try: ollama pull qwen3-vl  (or gemma4, gpt-oss)');
          cfg.OLLAMA_MODEL = await ask('Model to use anyway', cfg.OLLAMA_MODEL || '');
        } else {
          const opts = usable.map((m) => ({ label: m.name, value: m.name, hint: m.caps.includes('vision') ? 'tools · vision' : 'tools · no vision' }));
          const cur = opts.findIndex((o) => o.value === cfg.OLLAMA_MODEL);
          cfg.OLLAMA_MODEL = await choose('   Model', opts, Math.max(0, cur));
        }
        break;
      } catch (err) {
        console.log(c.red('unreachable'));
        fail(`${err.message}. Is Ollama running? (ollama serve)`);
      }
    }
    return;
  }

  delete cfg.OLLAMA_URL;
  for (;;) {
    cfg.OLLAMA_API_KEY = await askSecret('Ollama Cloud API key', cfg.OLLAMA_API_KEY);
    if (!cfg.OLLAMA_API_KEY) { fail('A key is required.'); continue; }
    cfg.OLLAMA_MODEL = await chooseModel('   Model', OLLAMA_CLOUD_MODELS, cfg.OLLAMA_MODEL || DEFAULT_MODELS.ollama);
    process.stdout.write('  Checking key… ');
    try {
      const r = await fetch('https://ollama.com/api/chat', {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.OLLAMA_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.OLLAMA_MODEL, stream: false, think: false, messages: [{ role: 'user', content: 'Reply with: ok' }] }),
      });
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`);
      console.log(c.green('valid'));
      break;
    } catch (err) {
      console.log(c.red('rejected'));
      fail(err.message);
      cfg.OLLAMA_API_KEY = '';
    }
  }
}

// ---------- config file ----------
const KEYS = ['SLIDES_STORAGE', 'SLIDES_DB', 'FIREBASE_SERVICE_ACCOUNT', 'FIREBASE_PROJECT_ID', 'FIREBASE_STORAGE_BUCKET',
  'LLM_PROVIDER', 'OLLAMA_API_KEY', 'OLLAMA_URL', 'OLLAMA_MODEL', 'GEMINI_API_KEY', 'GEMINI_MODEL'];

function saveConfig(cfg) {
  const lines = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, 'utf8').split('\n') : ['# Written by `npm run setup`. Keep this file private (it is gitignored).'];
  const seen = new Set();
  const out = [];
  for (const ln of lines) {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(ln);
    if (m && KEYS.includes(m[1])) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      if (cfg[m[1]]) out.push(`${m[1]}=${quote(cfg[m[1]])}`);
      continue;
    }
    out.push(ln);
  }
  for (const k of KEYS) if (!seen.has(k) && cfg[k]) out.push(`${k}=${quote(cfg[k])}`);
  fs.writeFileSync(CONFIG, out.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
}
const quote = (v) => (/[\s#"']/.test(v) ? JSON.stringify(v) : v);

function complete(env) {
  if (!env.SLIDES_STORAGE || !env.LLM_PROVIDER) return false;
  if (!llmInfo(env).configured) return false;
  return true;
}

// ---------- main ----------
async function main() {
  if (force || !complete(process.env)) {
    if (!process.stdin.isTTY) {
      console.error('Slides needs a one-time setup. Run `npm run setup` in a terminal,');
      console.error('or set SLIDES_STORAGE (sqlite|firebase) and LLM_PROVIDER (ollama|gemini) plus its key in .dev.vars.');
      process.exit(1);
    }
    console.log(`\n${c.bold('Slides · local setup')}  ${c.dim('(answers are saved to .dev.vars; re-run with npm run setup)')}`);
    openPrompt();
    const cfg = Object.fromEntries(KEYS.map((k) => [k, process.env[k] || '']));
    try {
      await setupStorage(cfg);
      await setupLLM(cfg);
    } finally {
      rl.close();
    }
    saveConfig(cfg);
    for (const k of KEYS) { if (cfg[k]) process.env[k] = cfg[k]; else delete process.env[k]; }
    ok(`Saved to ${path.relative(process.cwd(), CONFIG) || '.dev.vars'}`);
    if (process.env.ACCESS_TOKEN) console.log(c.dim('  Note: ACCESS_TOKEN is set in .dev.vars, so the app will ask for it. Remove it for open local use.'));
  }
  await startServer(process.env);
}

main().catch((err) => {
  console.error(`\n${c.red('Error:')} ${err.message}`);
  process.exit(1);
});

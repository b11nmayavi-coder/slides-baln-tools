const KEY = 'slides.settings';
const defaults = { accessToken: '', model: 'kimi-k3', effort: 'high' };

function load() {
  let s;
  try { s = { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { s = { ...defaults }; }
  delete s.apiKey;
  if (/^claude-/.test(s.model)) s.model = defaults.model; // from the earlier Anthropic version
  return s;
}

export const settings = load();

export function saveSettings(patch) {
  Object.assign(settings, patch);
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch {}
}

export const server = { ai: false, uploads: false, auth: true, checked: false };

export async function checkServer() {
  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    if (r.ok) Object.assign(server, await r.json());
  } catch {}
  server.checked = true;
  return server;
}

export function pref(key, fallback) {
  try { const v = localStorage.getItem('slides.pref.' + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function setPref(key, v) {
  try { localStorage.setItem('slides.pref.' + key, JSON.stringify(v)); } catch {}
}

// Main-thread side of an animation: owns a <canvas>, hands it to a Worker as an OffscreenCanvas,
// relays size / visibility / mouse / params, collects stats, errors and snapshots.
import { workerMain } from './runtime.js';

const SRC = '(' + workerMain.toString() + ')();';
let workerURL = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(SRC);

const QUALITY = {
  edit: { dprCap: 1.25, maxPixels: 1.6e6 },
  present: { dprCap: 2, maxPixels: 4.2e6 },
  preview: { dprCap: 1, maxPixels: 0.5e6 },
};

const hosts = new Set();
let snapSeq = 0;

export function paramValues(defs) {
  const out = {};
  for (const k in defs || {}) {
    const d = defs[k];
    out[k] = d && typeof d === 'object' && 'value' in d ? d.value : d;
  }
  return out;
}

function makeWorker() {
  try { return new Worker(workerURL, { name: 'anim' }); } catch {
    // Some browsers refuse data: workers; fall back to a blob URL.
    workerURL = URL.createObjectURL(new Blob([SRC], { type: 'text/javascript' }));
    return new Worker(workerURL, { name: 'anim' });
  }
}

export class AnimHost {
  constructor(container, anim, { theme, quality = 'edit', autoplay = true, onError, onStats, onReady } = {}) {
    this.container = container;
    this.anim = anim;
    this.theme = theme;
    this.quality = quality;
    this.autoplay = autoplay;
    this.onError = onError; this.onStats = onStats; this.onReady = onReady;
    this.visible = false;
    this.wantPlay = autoplay;
    this.playing = false;
    this.error = null;
    this.stats = null;
    this.snaps = new Map();
    this.readyWaiters = [];
    this.code = anim.code;
    hosts.add(this);
    this.boot();
  }

  boot() {
    this.error = null;
    this.ready = false;
    this.playing = false;
    this.lastBeat = performance.now();
    const canvas = document.createElement('canvas');
    canvas.className = 'anim-canvas';
    this.container.replaceChildren(canvas);
    this.canvas = canvas;
    if (!this.code || !this.code.trim()) return;
    if (!canvas.transferControlToOffscreen) {
      this.fail({ message: 'This browser does not support OffscreenCanvas.' });
      return;
    }
    const off = canvas.transferControlToOffscreen();
    const w = this.worker = makeWorker();
    w.onmessage = (ev) => this.handle(ev.data);
    w.onerror = (ev) => { ev.preventDefault(); this.fail({ message: ev.message || 'Worker error', phase: 'load' }); };
    const { width, height } = this.size();
    w.postMessage({
      type: 'init', canvas: off, code: this.code, params: paramValues(this.anim.params),
      theme: this.theme, width, height, dpr: this.dpr(width, height), quality: this.quality, play: false,
    }, [off]);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.io = new IntersectionObserver((ents) => {
      this.visible = ents[ents.length - 1].isIntersecting;
      this.sync();
    });
    this.io.observe(canvas);
  }

  size() {
    const r = this.canvas.getBoundingClientRect();
    // Report the untransformed CSS size (the stage is scaled with a CSS transform).
    const w = this.canvas.offsetWidth || r.width || 1;
    const h = this.canvas.offsetHeight || r.height || 1;
    const scale = r.width && w ? r.width / w : 1;
    // Render at on-screen resolution, but keep coordinates in element CSS pixels.
    this.screenScale = scale;
    return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
  }

  dpr(w, h) {
    const q = QUALITY[this.quality] || QUALITY.edit;
    const screen = (this.screenScale || 1) * (window.devicePixelRatio || 1);
    let d = Math.min(screen, q.dprCap);
    const budget = Math.sqrt(q.maxPixels / Math.max(1, w * h));
    return Math.max(0.25, Math.min(d, budget));
  }

  resize() {
    if (!this.worker) return;
    cancelAnimationFrame(this._rz);
    this._rz = requestAnimationFrame(() => {
      const { width, height } = this.size();
      const dpr = this.dpr(width, height);
      const key = width + 'x' + height + '@' + dpr.toFixed(3);
      if (key === this._lastSize) return;
      this._lastSize = key;
      this.worker.postMessage({ type: 'resize', width, height, dpr });
    });
  }

  handle(m) {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.lastBeat = performance.now();
        this.readyWaiters.splice(0).forEach((f) => f());
        this.sync();
        this.onReady?.(this);
        break;
      case 'stats':
        this.lastBeat = performance.now();
        this.stats = m;
        this.onStats?.(m, this);
        break;
      case 'error':
        this.fail(m);
        break;
      case 'snapshot': {
        const cb = this.snaps.get(m.id);
        this.snaps.delete(m.id);
        cb?.(m.blob || null);
        break;
      }
    }
  }

  fail(err) {
    this.error = err;
    this.playing = false;
    this.readyWaiters.splice(0).forEach((f) => f());
    this.snaps.forEach((cb) => cb(null));
    this.snaps.clear();
    this.onError?.(err, this);
  }

  sync() {
    if (!this.worker || !this.ready || this.error) return;
    const shouldPlay = this.wantPlay && this.visible && !document.hidden;
    if (shouldPlay === this.playing) return;
    this.playing = shouldPlay;
    this.lastBeat = performance.now();
    this.worker.postMessage({ type: shouldPlay ? 'play' : 'pause' });
  }

  play() { this.wantPlay = true; this.sync(); }
  pause() { this.wantPlay = false; this.sync(); }

  whenReady(timeout = 4000) {
    if (this.ready || this.error) return Promise.resolve();
    return new Promise((res) => { this.readyWaiters.push(res); setTimeout(res, timeout); });
  }

  setParams(defs) {
    this.anim = { ...this.anim, params: defs };
    this.worker?.postMessage({ type: 'params', values: paramValues(defs) });
  }
  setTheme(theme) {
    this.theme = theme;
    this.worker?.postMessage({ type: 'theme', theme });
  }
  setCode(anim) {
    this.anim = anim;
    if (anim.code === this.code && !this.error) { this.setParams(anim.params); return; }
    this.code = anim.code;
    this.teardown();
    this.boot();
  }
  mouse(x, y, active) { this.worker?.postMessage({ type: 'mouse', x, y, active }); }

  snapshot(width = 640, timeout = 2500) {
    if (!this.worker || this.error) return Promise.resolve(null);
    const id = ++snapSeq;
    return new Promise((res) => {
      this.snaps.set(id, res);
      this.worker.postMessage({ type: 'snapshot', id, width });
      setTimeout(() => { if (this.snaps.has(id)) { this.snaps.delete(id); res(null); } }, timeout);
    });
  }

  teardown() {
    this.worker?.terminate();
    this.worker = null;
    this.ro?.disconnect();
    this.io?.disconnect();
  }
  destroy() {
    this.teardown();
    hosts.delete(this);
    this.canvas?.remove();
  }
}

// Watchdog: a worker that stops reporting while it should be playing is stuck (e.g. an infinite loop).
setInterval(() => {
  const now = performance.now();
  for (const h of hosts) {
    if (h.worker && h.playing && !h.error && !document.hidden && now - h.lastBeat > 5000) {
      h.teardown();
      h.fail({ message: 'Animation stopped responding (possible infinite loop or very heavy frame). It was stopped.', phase: 'watchdog' });
    }
    if (h.worker && !h.ready && !h.error && now - h.lastBeat > 8000) {
      h.teardown();
      h.fail({ message: 'setup() did not finish within 8 seconds.', phase: 'watchdog' });
    }
  }
}, 1000);

document.addEventListener('visibilitychange', () => hosts.forEach((h) => h.sync()));

// Pointer position, relayed to visible animations (rAF-throttled).
let mouseRaf = 0, lastEv = null;
window.addEventListener('pointermove', (e) => {
  lastEv = e;
  if (mouseRaf) return;
  mouseRaf = requestAnimationFrame(() => {
    mouseRaf = 0;
    for (const h of hosts) {
      if (!h.playing || !h.canvas) continue;
      const r = h.canvas.getBoundingClientRect();
      const x = (lastEv.clientX - r.left) / r.width, y = (lastEv.clientY - r.top) / r.height;
      h.mouse(x, y, x >= 0 && x <= 1 && y >= 0 && y <= 1);
    }
  });
}, { passive: true });

export async function blobToDataURL(blob) {
  return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
}

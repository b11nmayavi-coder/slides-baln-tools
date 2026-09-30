export const SLIDE_W = 1920;
export const SLIDE_H = 1080;

export const uid = (p = '') => p + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Deep clone that shares string primitives (large data URLs aren't copied).
export function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k in v) o[k] = clone(v[k]);
    return o;
  }
  return v;
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  return d;
}

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function hashStr(s) {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h1 ^= s.charCodeAt(i); h1 = Math.imul(h1, 16777619); }
  return (h1 >>> 0).toString(36);
}

export function readAsDataURL(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

// Downscale big raster images before storing them.
export async function prepareImage(file, maxDim = 2400) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return { blob: file, w: 0, h: 0 };
  const bmp = await createImageBitmap(file);
  let { width: w, height: h } = bmp;
  const s = Math.min(1, maxDim / Math.max(w, h));
  if (s === 1 && file.size < 1.5e6) { bmp.close(); return { blob: file, w, h }; }
  w = Math.round(w * s); h = Math.round(h * s);
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await c.convertToBlob({ type, quality: 0.88 });
  return { blob, w, h };
}

export function mediaSize(src, kind) {
  return new Promise((res) => {
    if (kind === 'video') {
      const v = document.createElement('video');
      v.onloadedmetadata = () => res({ w: v.videoWidth, h: v.videoHeight });
      v.onerror = () => res({ w: 1280, h: 720 });
      v.src = src;
    } else {
      const i = new Image();
      i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight });
      i.onerror = () => res({ w: 800, h: 600 });
      i.src = src;
    }
  });
}

export function download(name, blob) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const mod = (e) => (isMac ? e.metaKey : e.ctrlKey);

export function toast(msg, ms = 2600) {
  let wrap = document.getElementById('toasts');
  if (!wrap) { wrap = h('div', { id: 'toasts' }); document.body.append(wrap); }
  const t = h('div', { class: 'toast' }, msg);
  wrap.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

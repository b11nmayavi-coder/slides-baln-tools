// Renders a slide model into a 1920x1080 DOM tree. Keyed by element id so re-renders are cheap
// and running animation workers survive edits. Used by the editor, filmstrip, presenter and print.
import { color, fontFor } from './model.js';
import { AnimHost } from './anim/host.js';
import { resolveSrc } from './media.js';
import { hashStr, SLIDE_W, SLIDE_H } from './util.js';

const LIVE = new Set(['edit', 'present']);

// Content signature: geometry is applied separately, so moving an element doesn't rebuild it.
// (Shapes include w/h because their SVG path depends on them.)
const GEOM = new Set(['x', 'y', 'rot', 'opacity', 'shadow', 'enter']);
let epoch = 0;
export const invalidateAll = () => { epoch++; }; // e.g. when local media finishes loading
function sig(e, themeKey) {
  return epoch + themeKey + JSON.stringify(e, (k, v) => {
    if (GEOM.has(k) || ((k === 'w' || k === 'h') && e.type !== 'shape')) return undefined;
    if ((k === 'src' || k === 'poster' || k === 'image') && typeof v === 'string') return v.length + ':' + v.slice(-32);
    if (k === 'code' && typeof v === 'string') return hashStr(v);
    return v;
  });
}

export function textCSS(st = {}, theme) {
  return {
    fontFamily: `"${fontFor(st.font, theme)}", Inter, system-ui, sans-serif`,
    fontSize: (st.fontSize || 40) + 'px',
    color: color(st.color, theme, theme.text),
    textAlign: st.align || 'left',
    justifyContent: { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[st.valign || 'top'],
    lineHeight: String(st.lineHeight || 1.3),
    fontWeight: String(st.fontWeight || 400),
    letterSpacing: (st.letterSpacing || 0) + 'px',
    fontStyle: st.italic ? 'italic' : '',
    textDecoration: st.underline ? 'underline' : '',
    padding: st.padding != null ? st.padding + 'px' : '',
  };
}

export function shapePath(shape, w, h, r = 0) {
  const R = Math.max(0, Math.min(r, w / 2, h / 2));
  switch (shape) {
    case 'ellipse': return `M${w / 2},0 A${w / 2},${h / 2} 0 1 1 ${w / 2 - 0.01},0 Z`;
    case 'triangle': return `M${w / 2},0 L${w},${h} L0,${h} Z`;
    case 'diamond': return `M${w / 2},0 L${w},${h / 2} L${w / 2},${h} L0,${h / 2} Z`;
    case 'hexagon': { const q = w * 0.25; return `M${q},0 L${w - q},0 L${w},${h / 2} L${w - q},${h} L${q},${h} L0,${h / 2} Z`; }
    case 'chevron': { const q = Math.min(w * 0.35, h * 0.5); return `M0,0 L${w - q},0 L${w},${h / 2} L${w - q},${h} L0,${h} L${q},${h / 2} Z`; }
    case 'arrow': { const hw = Math.min(w * 0.4, h); const sh = h * 0.28; return `M0,${h / 2 - sh} L${w - hw},${h / 2 - sh} L${w - hw},0 L${w},${h / 2} L${w - hw},${h} L${w - hw},${h / 2 + sh} L0,${h / 2 + sh} Z`; }
    case 'star': {
      let d = ''; const cx = w / 2, cy = h / 2;
      for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5; const k = i % 2 ? 0.45 : 1; d += (i ? 'L' : 'M') + (cx + Math.cos(a) * cx * k).toFixed(1) + ',' + (cy + Math.sin(a) * cy * k).toFixed(1); }
      return d + 'Z';
    }
    case 'line': return `M0,${h / 2} L${w},${h / 2}`;
    case 'round':
    case 'rect':
    default:
      if (!R) return `M0,0 H${w} V${h} H0 Z`;
      return `M${R},0 H${w - R} A${R},${R} 0 0 1 ${w},${R} V${h - R} A${R},${R} 0 0 1 ${w - R},${h} H${R} A${R},${R} 0 0 1 0,${h - R} V${R} A${R},${R} 0 0 1 ${R},0 Z`;
  }
}

function fillCSS(fill, theme) {
  if (!fill) return 'transparent';
  if (fill.includes('gradient(')) return fill;
  return color(fill, theme, 'transparent');
}

export class SlideView {
  constructor(root, { mode = 'edit', onAnimError, onAnimStats, onAnimReady } = {}) {
    this.root = root;
    this.mode = mode;
    this.cb = { onAnimError, onAnimStats, onAnimReady };
    this.nodes = new Map();
    this.hosts = new Map(); // element id or 'bg' -> AnimHost
    root.classList.add('slide');
    root.style.width = SLIDE_W + 'px';
    root.style.height = SLIDE_H + 'px';
    this.bgFill = root.appendChild(document.createElement('div'));
    this.bgFill.className = 'bg-fill';
    this.bgImg = root.appendChild(document.createElement('img'));
    this.bgImg.className = 'bg-img';
    this.bgImg.alt = '';
    this.bgAnim = root.appendChild(document.createElement('div'));
    this.bgAnim.className = 'bg-anim';
    this.bgDim = root.appendChild(document.createElement('div'));
    this.bgDim.className = 'bg-dim';
    this.layer = root.appendChild(document.createElement('div'));
    this.layer.className = 'els';
  }

  render(slide, deck, { editingId = null } = {}) {
    this.slide = slide;
    this.deck = deck;
    const theme = deck.theme;
    const themeKey = hashStr(JSON.stringify(theme));
    const bg = slide.bg || {};

    this.root.style.background = fillCSS(bg.fill || theme.bg, theme);
    this.root.style.color = theme.text;
    this.bgFill.style.background = '';
    const imgSrc = bg.image ? resolveSrc(bg.image) : '';
    if (this.bgImg.getAttribute('src') !== imgSrc) imgSrc ? this.bgImg.setAttribute('src', imgSrc) : this.bgImg.removeAttribute('src');
    this.bgImg.style.display = imgSrc ? '' : 'none';
    this.bgDim.style.opacity = bg.dim || 0;
    this.bgDim.style.display = bg.dim ? '' : 'none';
    this.renderAnim('bg', this.bgAnim, bg.anim, theme);

    const seen = new Set();
    slide.elements.forEach((e, i) => {
      seen.add(e.id);
      let node = this.nodes.get(e.id);
      if (!node) {
        node = document.createElement('div');
        node.className = 'el';
        node.dataset.id = e.id;
        this.nodes.set(e.id, node);
      }
      if (this.layer.children[i] !== node) this.layer.insertBefore(node, this.layer.children[i] || null);
      node.dataset.type = e.type;
      Object.assign(node.style, {
        left: e.x + 'px', top: e.y + 'px', width: e.w + 'px', height: e.h + 'px',
        transform: e.rot ? `rotate(${e.rot}deg)` : '',
        opacity: e.opacity ?? 1,
        filter: e.shadow ? 'drop-shadow(0 18px 40px rgba(0,0,0,.35))' : '',
      });
      const s = sig(e, themeKey);
      const editing = e.id === editingId;
      if (node._sig === s && !(node._editing && !editing)) return;
      node._sig = s;
      if (editing && node._editing) {
        // Keep the live contentEditable DOM; only restyle.
        const tx = node.querySelector('.tx');
        if (tx) Object.assign(tx.style, textCSS(e.style, theme));
        return;
      }
      node._editing = false;
      this.renderInner(node, e, theme);
    });
    for (const [id, node] of this.nodes) {
      if (!seen.has(id)) {
        node.remove();
        this.nodes.delete(id);
        this.hosts.get(id)?.destroy();
        this.hosts.delete(id);
      }
    }
  }

  renderAnim(key, box, anim, theme) {
    let host = this.hosts.get(key);
    if (!anim || !anim.code) {
      if (host) { host.destroy(); this.hosts.delete(key); }
      if (!LIVE.has(this.mode)) box.replaceChildren();
      box.style.display = 'none';
      return;
    }
    box.style.display = '';
    if (!LIVE.has(this.mode)) {
      const src = anim.poster || '';
      let img = box.firstElementChild;
      if (!img || img.tagName !== 'IMG') { img = document.createElement('img'); img.className = 'anim-poster'; img.alt = ''; box.replaceChildren(img); }
      if (img.getAttribute('src') !== src) src ? img.setAttribute('src', src) : img.removeAttribute('src');
      return;
    }
    if (!host) {
      host = new AnimHost(box, anim, {
        theme, quality: this.mode === 'present' ? 'present' : 'edit', autoplay: true,
        onError: (err, h) => this.cb.onAnimError?.(key, err, h, this),
        onStats: (st, h) => this.cb.onAnimStats?.(key, st, h, this),
        onReady: (h) => this.cb.onAnimReady?.(key, h, this),
      });
      host.key = key;
      this.hosts.set(key, host);
    } else {
      if (host.theme !== theme) host.setTheme(theme);
      host.setCode(anim);
    }
  }

  renderInner(node, e, theme) {
    const tx = () => {
      const d = document.createElement('div');
      d.className = 'tx';
      Object.assign(d.style, textCSS(e.style, theme));
      const c = document.createElement('div');
      c.className = 'tx-c';
      c.innerHTML = e.html || '';
      d.append(c);
      return d;
    };
    switch (e.type) {
      case 'text':
        node.replaceChildren(tx());
        break;
      case 'shape': {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', `0 0 ${e.w} ${e.h}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.classList.add('shape-svg');
        const sw = e.strokeWidth || 0;
        const isLine = e.shape === 'line';
        const path = document.createElementNS(ns, 'path');
        path.setAttribute('d', shapePath(e.shape, e.w, e.h, e.radius || 0));
        const fill = e.fill || null;
        if (fill && fill.includes('gradient(')) {
          node.style.setProperty('--shape-grad', fill);
          node.classList.add('grad-shape');
          path.setAttribute('fill', 'transparent');
        } else {
          node.classList.remove('grad-shape');
          path.setAttribute('fill', isLine ? 'none' : color(fill, theme, 'transparent'));
        }
        const stroke = isLine ? color(e.stroke || 'text', theme, theme.text) : color(e.stroke, theme, 'none');
        path.setAttribute('stroke', stroke);
        path.setAttribute('stroke-width', isLine ? Math.max(1, sw || 4) : sw);
        path.setAttribute('vector-effect', 'non-scaling-stroke');
        path.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('stroke-linecap', 'round');
        svg.append(path);
        if (fill && fill.includes('gradient(')) {
          node.style.setProperty('--shape-clip', `path("${shapePath(e.shape, e.w, e.h, e.radius || 0)}")`);
        }
        node.replaceChildren(svg, tx());
        break;
      }
      case 'image': {
        const img = document.createElement('img');
        img.className = 'media';
        img.alt = '';
        img.draggable = false;
        const src = resolveSrc(e.src);
        if (src) img.src = src;
        img.style.objectFit = e.fit || 'cover';
        img.style.borderRadius = (e.radius || 0) + 'px';
        node.replaceChildren(img);
        if (!e.src) node.append(Object.assign(document.createElement('div'), { className: 'placeholder', textContent: 'Image' }));
        break;
      }
      case 'video': {
        const v = document.createElement('video');
        v.className = 'media';
        v.muted = e.muted !== false;
        v.loop = e.loop !== false;
        v.playsInline = true;
        v.preload = LIVE.has(this.mode) ? 'auto' : 'metadata';
        v.autoplay = LIVE.has(this.mode);
        const src = resolveSrc(e.src);
        if (src) v.src = src + (LIVE.has(this.mode) ? '' : '#t=0.1');
        v.style.objectFit = e.fit || 'cover';
        v.style.borderRadius = (e.radius || 0) + 'px';
        node.replaceChildren(v);
        break;
      }
      case 'table': {
        const t = document.createElement('table');
        t.className = 'tbl' + (e.stripe ? ' stripe' : '') + (e.header ? ' has-header' : '');
        Object.assign(t.style, textCSS(e.style, theme));
        const bc = color(e.border, theme, 'color-mix(in srgb, currentColor 18%, transparent)');
        t.style.setProperty('--tb', bc);
        t.style.setProperty('--th-bg', fillCSS(e.headerFill, theme));
        t.style.setProperty('--th-fg', e.headerFill ? contrastOn(color(e.headerFill, theme, '#000')) : 'inherit');
        const cols = e.rows[0]?.length || 0;
        const cg = document.createElement('colgroup');
        for (let j = 0; j < cols; j++) {
          const c = document.createElement('col');
          if (e.colW?.[j]) c.style.width = e.colW[j] * 100 + '%';
          cg.append(c);
        }
        t.append(cg);
        const tb = document.createElement('tbody');
        e.rows.forEach((row, i) => {
          const tr = document.createElement('tr');
          row.forEach((html, j) => {
            const td = document.createElement('td');
            td.dataset.r = i; td.dataset.c = j;
            const fill = e.cellFill?.[i + ',' + j];
            if (fill) td.style.background = fillCSS(fill, theme);
            const d = document.createElement('div');
            d.className = 'cell';
            d.innerHTML = html;
            td.append(d);
            tr.append(td);
          });
          tb.append(tr);
        });
        t.append(tb);
        node.replaceChildren(t);
        break;
      }
      case 'anim': {
        let box = node.querySelector(':scope > .anim-box');
        if (!box) { box = document.createElement('div'); box.className = 'anim-box'; node.replaceChildren(box); }
        box.style.borderRadius = (e.radius || 0) + 'px';
        this.renderAnim(e.id, box, e.anim, theme);
        break;
      }
    }
  }

  setAllPlaying(on) { for (const h of this.hosts.values()) on ? h.play() : h.pause(); }

  destroy() {
    for (const h of this.hosts.values()) h.destroy();
    this.hosts.clear();
    this.nodes.clear();
    this.root.replaceChildren();
  }
}

export function contrastOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const l = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return l > 0.6 ? '#111' : '#fff';
}

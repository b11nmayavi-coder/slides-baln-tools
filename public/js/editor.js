// The main canvas: selection, move/resize/rotate with snapping, text & table editing, clipboard, drop.
import { store } from './store.js';
import { SlideView } from './render.js';
import { newElement, SLIDE_W, SLIDE_H } from './model.js';
import { h, clone, uid, clamp, mod, toast, mediaSize, prepareImage } from './util.js';
import { putMedia } from './media.js';
import { icon } from './icons.js';
import { menu } from './ui.js';
import { blobToDataURL } from './anim/host.js';

const SNAP = 7; // screen px

export class Editor {
  constructor(wrap, frame) {
    this.wrap = wrap;
    this.frame = frame;
    this.scale = 1;
    this.animState = new Map(); // host key -> {error, stats, name}
    this.clip = null;

    const slideEl = h('div');
    frame.append(slideEl);
    this.view = new SlideView(slideEl, {
      mode: 'edit',
      onAnimError: (key, err) => this.animEvent(key, { error: err }),
      onAnimStats: (key, st) => this.animEvent(key, { stats: st }),
      onAnimReady: (key, host) => { this.animEvent(key, { error: null }); this.schedulePoster(key, host); },
    });
    this.overlay = h('div', { class: 'sel-layer' });
    this.overlay.style.width = SLIDE_W + 'px';
    this.overlay.style.height = SLIDE_H + 'px';
    frame.append(this.overlay);

    new ResizeObserver(() => this.fit()).observe(wrap);
    wrap.addEventListener('pointerdown', (e) => this.onDown(e));
    wrap.addEventListener('dblclick', (e) => this.onDbl(e));
    wrap.addEventListener('contextmenu', (e) => this.onContext(e));
    wrap.addEventListener('pointermove', (e) => this.onHover(e));
    wrap.addEventListener('pointerleave', () => { this.hoverId = null; this.drawOverlay(); });
    wrap.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    wrap.addEventListener('drop', (e) => this.onDrop(e));
    frame.addEventListener('input', (e) => this.onTextInput(e));
    frame.addEventListener('paste', (e) => this.onEditPaste(e), true);

    store.on('change', () => this.render());
    store.on('deck', () => { this.animState.clear(); this.render(); });
    store.on('slide', () => { this.animState.clear(); this.render(); });
    store.on('selection', () => { this.applyEditing(); this.drawOverlay(); });
    store.on('stop-editing', (id) => this.finishEditing(id));
  }

  // ---------- layout ----------
  fit() {
    const W = this.wrap.clientWidth, H = this.wrap.clientHeight;
    const pad = Math.max(24, Math.min(W, H) * 0.05);
    const s = Math.max(0.05, Math.min((W - pad * 2) / SLIDE_W, (H - pad * 2) / SLIDE_H));
    this.scale = s;
    const x = Math.round((W - SLIDE_W * s) / 2), y = Math.round((H - SLIDE_H * s) / 2);
    this.frame.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    this.frame.style.setProperty('--inv', String(1 / s));
    this.drawOverlay();
  }

  pt(e) {
    const r = this.frame.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.scale, y: (e.clientY - r.top) / this.scale };
  }

  render() {
    if (!store.deck) return;
    this.view.render(store.slide, store.deck, { editingId: store.editingId });
    this.drawOverlay();
  }

  // ---------- overlay ----------
  drawOverlay() {
    const o = this.overlay;
    o.replaceChildren();
    if (!store.deck) return;
    const sel = store.selected;
    const multi = sel.length > 1;
    const box = (e, cls) => h('div', { class: cls, style: { left: e.x + 'px', top: e.y + 'px', width: e.w + 'px', height: e.h + 'px', transform: e.rot ? `rotate(${e.rot}deg)` : '' } });

    if (this.hoverId && !store.selection.includes(this.hoverId)) {
      const he = store.el(this.hoverId);
      if (he) o.append(box(he, 'hover-box'));
    }
    for (const e of sel) {
      const b = box(e, 'sel-box' + (multi ? ' multi' : '') + (store.editingId === e.id ? ' editing' : ''));
      if (!multi && store.editingId !== e.id) {
        const dirs = e.type === 'shape' && e.shape === 'line' ? ['w', 'e'] : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
        for (const d of dirs) {
          const hx = d.includes('w') ? 0 : d.includes('e') ? 100 : 50;
          const hy = d.includes('n') ? 0 : d.includes('s') ? 100 : 50;
          b.append(h('div', { class: 'handle', dataset: { dir: d }, style: { left: hx + '%', top: hy + '%', cursor: cursorFor(d, e.rot) } }));
        }
        b.append(h('div', { class: 'handle rot', dataset: { dir: 'rot' }, style: { left: '50%', top: `calc(-26px * var(--inv))` } }));
      }
      o.append(b);
      if (store.editingId === e.id && e.type === 'table') o.append(this.tableBar(e));
    }
    if (this.marquee) o.append(h('div', { class: 'marquee', style: { left: this.marquee.x + 'px', top: this.marquee.y + 'px', width: this.marquee.w + 'px', height: this.marquee.h + 'px' } }));
    for (const g of this.guides || []) o.append(h('div', { class: 'guide ' + g.axis, style: g.axis === 'v' ? { left: g.pos + 'px' } : { top: g.pos + 'px' } }));

    // Animation badges: selected animated element, or the slide background when nothing is selected.
    const badgeFor = (key, x, y) => {
      const st = this.animState.get(key) || {};
      const anim = key === 'bg' ? store.slide.bg?.anim : store.el(key)?.anim;
      if (!anim) return;
      const err = st.error;
      const b = h('div', {
        class: 'anim-badge' + (err ? ' err' : ''),
        style: { left: x + 'px', top: y + 'px', transform: `scale(${1 / this.scale})` },
        title: err ? err.message : 'Animation settings',
        html: icon(err ? 'alert' : 'sparkles', 13) + `<span>${escapeText(anim.name || 'Animation')}</span>` + (err ? '<span>error</span>' : st.stats ? `<span class="fps">${Math.round(st.stats.fps)} fps</span>` : ''),
      });
      b.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      b.addEventListener('click', (ev) => { ev.stopPropagation(); store.emit('open-anim', { key, anchor: b }); });
      o.append(b);
    };
    const one = sel.length === 1 ? sel[0] : null;
    if (one && one.type === 'anim') badgeFor(one.id, one.x, one.y + one.h + 8 / this.scale);
    else if (!sel.length && store.slide.bg?.anim) badgeFor('bg', 16 / this.scale, 16 / this.scale);
    for (const [key, st] of this.animState) {
      if (st.error && key !== 'bg' && !(one && one.id === key)) {
        const e = store.el(key);
        if (e) badgeFor(key, e.x, e.y + e.h + 8 / this.scale);
      }
      if (st.error && key === 'bg' && sel.length) badgeFor('bg', 16 / this.scale, 16 / this.scale);
    }
  }

  animEvent(key, patch) {
    const cur = this.animState.get(key) || {};
    const had = cur.error;
    this.animState.set(key, { ...cur, ...patch });
    if (patch.error && !had) store.emit('anim-error', { key, slideId: store.slide.id, error: patch.error });
    // Only redraw for errors or when the badge is visible, stats arrive once per second.
    this.drawOverlay();
  }

  schedulePoster(key, host) {
    clearTimeout(host._posterT);
    host._posterT = setTimeout(async () => {
      const slide = this.view.slide;
      const blob = await host.snapshot(480);
      if (!blob) return;
      const url = await blobToDataURL(blob);
      const anim = key === 'bg' ? slide.bg?.anim : slide.elements.find((e) => e.id === key)?.anim;
      if (anim && anim.code === host.code) {
        anim.poster = url; // not undoable: derived data
        store.save();
        store.emit('poster', slide.id);
      }
    }, 1400);
  }

  // Wait for an animation to run, then return a screenshot + health (used by the AI tool loop).
  async inspectAnim(key, waitMs = 1500) {
    const host = this.view.hosts.get(key);
    if (!host) return { error: { message: 'Animation host not found (is the slide visible?)' } };
    await host.whenReady();
    await new Promise((r) => setTimeout(r, waitMs));
    if (host.error) return { error: host.error };
    const blob = await host.snapshot(800);
    return { blob, stats: host.stats, error: host.error };
  }

  tableBar(e) {
    const cell = this.activeCell || { r: 0, c: 0 };
    const act = (label, ic, fn) => {
      const b = h('button', { class: 'tb', title: label, html: ic });
      b.addEventListener('pointerdown', (ev) => { ev.preventDefault(); ev.stopPropagation(); });
      b.addEventListener('click', () => { fn(); });
      return b;
    };
    const t = (s) => `<span class="lbl">${s}</span>`;
    const bar = h('div', { class: 'table-bar', style: { left: e.x + 'px', top: e.y + 'px', transform: `translateY(calc(-100% - 10px * var(--inv))) scale(${1 / this.scale})` } },
      act('Insert row above', t('+ Row ↑'), () => this.tableOp(e.id, 'row', cell.r)),
      act('Insert row below', t('+ Row ↓'), () => this.tableOp(e.id, 'row', cell.r + 1)),
      act('Insert column left', t('+ Col ←'), () => this.tableOp(e.id, 'col', cell.c)),
      act('Insert column right', t('+ Col →'), () => this.tableOp(e.id, 'col', cell.c + 1)),
      h('div', { class: 'tb-sep' }),
      act('Delete row', t('− Row'), () => this.tableOp(e.id, 'delrow', cell.r)),
      act('Delete column', t('− Col'), () => this.tableOp(e.id, 'delcol', cell.c)),
    );
    return bar;
  }

  tableOp(id, op, i) {
    this.flushText();
    const e = store.el(id);
    if (!e) return;
    store.stopEditing();
    store.commit('Edit table', () => {
      const cols = e.rows[0].length;
      if (op === 'row') { e.rows.splice(i, 0, Array(cols).fill('<p></p>')); e.h += e.h / (e.rows.length - 1); }
      if (op === 'col') { e.rows.forEach((r) => r.splice(i, 0, '<p></p>')); if (e.colW) { e.colW.splice(i, 0, 1 / (cols + 1)); normalize(e.colW); } }
      if (op === 'delrow' && e.rows.length > 1) { e.h -= e.h / e.rows.length; e.rows.splice(i, 1); }
      if (op === 'delcol' && cols > 1) { e.rows.forEach((r) => r.splice(i, 1)); if (e.colW) { e.colW.splice(i, 1); normalize(e.colW); } }
    });
    store.startEditing(id);
  }

  // ---------- pointer ----------
  onHover(e) {
    if (this.drag || e.buttons) return;
    const node = e.target.closest?.('.el');
    const id = node && this.view.layer.contains(node) ? node.dataset.id : null;
    if (id !== this.hoverId) { this.hoverId = id; this.drawOverlay(); }
  }

  onDown(e) {
    if (e.button !== 0) return;
    const handle = e.target.closest('.handle');
    if (handle) { e.preventDefault(); return this.startTransform(e, handle.dataset.dir); }
    if (e.target.closest('.table-bar, .anim-badge')) return;
    const node = e.target.closest('.el');
    const id = node && this.view.layer.contains(node) ? node.dataset.id : null;
    if (store.editingId) {
      if (id === store.editingId) return; // caret placement / text selection inside the editor
      this.flushText();
      store.stopEditing();
    }
    this.wrap.focus({ preventScroll: true });
    if (id) {
      e.preventDefault();
      if (e.shiftKey || mod(e)) {
        const s = store.selection.includes(id) ? store.selection.filter((x) => x !== id) : [...store.selection, id];
        store.select(s);
        if (!s.includes(id)) return;
      } else if (!store.selection.includes(id)) {
        store.select([id]);
      }
      this.startMove(e);
    } else {
      e.preventDefault();
      if (!e.shiftKey) store.select([]);
      this.startMarquee(e);
    }
  }

  track(e, move, up) {
    const id = e.pointerId;
    const mv = (ev) => { if (ev.pointerId === id) move(ev); };
    const end = (ev) => {
      if (ev.pointerId !== id) return;
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      up(ev);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  startMove(e) {
    const p0 = this.pt(e);
    const items = store.selected.map((el) => ({ el, x: el.x, y: el.y }));
    let moved = false;
    const others = store.slide.elements.filter((x) => !store.selection.includes(x.id));
    this.drag = true;
    this.track(e, (ev) => {
      const p = this.pt(ev);
      let dx = p.x - p0.x, dy = p.y - p0.y;
      if (!moved && Math.hypot(dx, dy) * this.scale < 3) return;
      if (!moved) { moved = true; store.beginGesture(items.length > 1 ? 'Move elements' : 'Move'); }
      if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      // Snap the selection's bounding box to slide centre/edges and other elements.
      const bb = bounds(items.map((it) => ({ ...it.el, x: it.x + dx, y: it.y + dy })));
      this.guides = [];
      if (!ev.altKey) {
        const s = snap(bb, others, SNAP / this.scale);
        dx += s.dx; dy += s.dy;
        this.guides = s.guides;
      }
      for (const it of items) { it.el.x = Math.round(it.x + dx); it.el.y = Math.round(it.y + dy); }
      store.live();
    }, () => {
      this.drag = false;
      this.guides = [];
      if (moved) store.endGesture(true);
      this.drawOverlay();
    });
  }

  startTransform(e, dir) {
    const el = store.selected[0];
    if (!el) return;
    const p0 = this.pt(e);
    const o = { x: el.x, y: el.y, w: el.w, h: el.h, rot: el.rot || 0 };
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    const th = (o.rot * Math.PI) / 180, cos = Math.cos(th), sin = Math.sin(th);
    const lockDefault = ['image', 'video'].includes(el.type) && dir.length === 2;
    const others = store.slide.elements.filter((x) => x.id !== el.id);
    store.beginGesture(dir === 'rot' ? 'Rotate' : 'Resize');
    this.drag = true;
    let changed = false;
    this.track(e, (ev) => {
      changed = true;
      const p = this.pt(ev);
      if (dir === 'rot') {
        let a = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI + 90;
        if (ev.shiftKey) a = Math.round(a / 15) * 15;
        else for (const s of [0, 90, 180, 270, 360, -90]) if (Math.abs(a - s) < 3) a = s;
        el.rot = Math.round(((a % 360) + 360) % 360 * 10) / 10;
        if (el.rot === 360) el.rot = 0;
        store.live();
        return;
      }
      const dxw = p.x - p0.x, dyw = p.y - p0.y;
      // Delta in the element's local (unrotated) frame
      const lx = dxw * cos + dyw * sin, ly = -dxw * sin + dyw * cos;
      const sx = dir.includes('e') ? 1 : dir.includes('w') ? -1 : 0;
      const sy = dir.includes('s') ? 1 : dir.includes('n') ? -1 : 0;
      let w = o.w + sx * lx, hh = o.h + sy * ly;
      const lock = ev.shiftKey !== lockDefault && sx && sy;
      if (lock) {
        const r = o.w / o.h;
        if (Math.abs(w / o.w) > Math.abs(hh / o.h)) hh = w / r; else w = hh * r;
      }
      w = Math.max(12, w); hh = Math.max(12, hh);
      // Snap unrotated edges being dragged
      this.guides = [];
      if (!o.rot && !ev.altKey && !lock) {
        const trial = { x: sx < 0 ? o.x + o.w - w : o.x, y: sy < 0 ? o.y + o.h - hh : o.y, w, h: hh };
        const s = snapEdges(trial, others, SNAP / this.scale, sx, sy);
        if (sx > 0) w += s.dx; if (sx < 0) w -= s.dx;
        if (sy > 0) hh += s.dy; if (sy < 0) hh -= s.dy;
        this.guides = s.guides;
      }
      const dw = w - o.w, dh = hh - o.h;
      // Keep the opposite edge fixed: shift the centre by half the growth along the dragged axis.
      const lcx = (sx * dw) / 2, lcy = (sy * dh) / 2;
      const ncx = cx + lcx * cos - lcy * sin, ncy = cy + lcx * sin + lcy * cos;
      el.w = Math.round(w); el.h = Math.round(hh);
      el.x = Math.round(ncx - w / 2); el.y = Math.round(ncy - hh / 2);
      store.live();
    }, () => {
      this.drag = false;
      this.guides = [];
      store.endGesture(changed);
      this.drawOverlay();
    });
  }

  startMarquee(e) {
    const p0 = this.pt(e);
    const base = e.shiftKey ? [...store.selection] : [];
    this.track(e, (ev) => {
      const p = this.pt(ev);
      const m = { x: Math.min(p0.x, p.x), y: Math.min(p0.y, p.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) };
      this.marquee = m;
      const hit = store.slide.elements.filter((el) => el.x < m.x + m.w && el.x + el.w > m.x && el.y < m.y + m.h && el.y + el.h > m.y).map((el) => el.id);
      store.selection = [...new Set([...base, ...hit])];
      this.drawOverlay();
    }, () => {
      this.marquee = null;
      store.select(store.selection);
    });
  }

  // ---------- text editing ----------
  onDbl(e) {
    const node = e.target.closest('.el');
    if (!node || !this.view.layer.contains(node)) {
      if (!store.selection.length && store.slide.bg?.anim) store.emit('open-anim', { key: 'bg', anchor: { x: e.clientX, y: e.clientY } });
      return;
    }
    const el = store.el(node.dataset.id);
    if (!el) return;
    if (['text', 'shape', 'table'].includes(el.type)) this.edit(el.id, e);
    else if (el.type === 'anim') store.emit('open-anim', { key: el.id, anchor: { x: e.clientX, y: e.clientY } });
    else if (el.type === 'image' || el.type === 'video') store.emit('replace-media', el.id);
  }

  edit(id, at) {
    this._caretAt = at ? { x: at.clientX, y: at.clientY } : null;
    store.startEditing(id);
  }

  applyEditing() {
    const id = store.editingId;
    if (!id) return;
    const node = this.view.nodes.get(id);
    if (!node || node._editing) return;
    const el = store.el(id);
    node._editing = true;
    node.classList.add('editing-el');
    const targets = el.type === 'table' ? [...node.querySelectorAll('.cell')] : [node.querySelector('.tx-c')];
    for (const t of targets) { t.contentEditable = 'true'; t.spellcheck = true; }
    const at = this._caretAt;
    this._caretAt = null;
    let target = targets[0];
    if (at) {
      const hit = document.elementFromPoint(at.x, at.y)?.closest('.cell, .tx-c');
      if (hit && targets.includes(hit)) target = hit;
    }
    target.focus({ preventScroll: true });
    const sel = getSelection();
    const r = at && document.caretRangeFromPoint ? document.caretRangeFromPoint(at.x, at.y) : null;
    if (r && target.contains(r.startContainer)) { sel.removeAllRanges(); sel.addRange(r); }
    else { const rr = document.createRange(); rr.selectNodeContents(target); if (at) rr.collapse(false); sel.removeAllRanges(); sel.addRange(rr); }
    if (el.type === 'table') this.trackCell(target);
    this._selHandler = () => {
      const c = getSelection().anchorNode;
      const cell = c && (c.nodeType === 1 ? c : c.parentElement)?.closest?.('td');
      if (cell && node.contains(cell)) this.activeCell = { r: +cell.dataset.r, c: +cell.dataset.c };
      store.emit('text-selection');
    };
    document.addEventListener('selectionchange', this._selHandler);
  }

  trackCell(cellDiv) {
    const td = cellDiv.closest('td');
    if (td) this.activeCell = { r: +td.dataset.r, c: +td.dataset.c };
  }

  onTextInput(e) {
    const id = store.editingId;
    if (!id) return;
    const node = this.view.nodes.get(id);
    if (!node || !node.contains(e.target)) return;
    this.pendingText = id;
    this.commitText();
  }

  commitText() {
    clearTimeout(this._textT);
    this._textT = setTimeout(() => this.flushText(), 350);
  }

  flushText() {
    clearTimeout(this._textT);
    const id = this.pendingText;
    this.pendingText = null;
    if (!id) return;
    const node = this.view.nodes.get(id);
    const el = store.el(id);
    if (!node || !el) return;
    store.commit('Edit text', () => {
      if (el.type === 'table') {
        node.querySelectorAll('td').forEach((td) => { el.rows[+td.dataset.r][+td.dataset.c] = cleanHTML(td.firstElementChild.innerHTML); });
      } else {
        const c = node.querySelector('.tx-c');
        el.html = cleanHTML(c.innerHTML);
        // Grow the box to fit its text (never shrink automatically).
        const need = Math.ceil(c.offsetHeight + (el.type === 'shape' ? 32 : 0));
        if (el.type === 'text' && need > el.h) el.h = need;
      }
    }, { coalesce: 'text:' + id });
  }

  finishEditing(id) {
    if (this.pendingText === id) this.flushText();
    document.removeEventListener('selectionchange', this._selHandler);
    const node = this.view.nodes.get(id);
    if (!node) return;
    node.classList.remove('editing-el');
    node.querySelectorAll('[contenteditable]').forEach((t) => t.removeAttribute('contenteditable'));
    node._editing = false;
    node._sig = null;
    getSelection().removeAllRanges();
    this.render();
  }

  onEditPaste(e) {
    if (!store.editingId) return;
    const target = e.target.closest?.('[contenteditable]');
    if (!target) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  }

  // ---------- context menu / clipboard ----------
  onContext(e) {
    if (store.editingId && e.target.closest('[contenteditable]')) return; // native menu inside text
    e.preventDefault();
    const node = e.target.closest('.el');
    const id = node && this.view.layer.contains(node) ? node.dataset.id : null;
    if (id && !store.selection.includes(id)) store.select([id]);
    if (!id) store.select([]);
    const has = store.selection.length > 0;
    menu({ x: e.clientX, y: e.clientY }, [
      has && { label: 'Cut', icon: 'copy', kbd: 'Ctrl X', onClick: () => this.cut() },
      has && { label: 'Copy', icon: 'copy', kbd: 'Ctrl C', onClick: () => this.copy() },
      { label: 'Paste', icon: 'copy', kbd: 'Ctrl V', onClick: () => this.pasteInternal(), disabled: !this.clip },
      has && { label: 'Duplicate', icon: 'copy', kbd: 'Ctrl D', onClick: () => this.duplicate() },
      'sep',
      has && { label: 'Bring to front', icon: 'layers', onClick: () => this.arrange('front') },
      has && { label: 'Send to back', icon: 'layers', onClick: () => this.arrange('back') },
      has && 'sep',
      { label: has ? 'Ask AI about selection' : 'Ask AI about this slide', icon: 'sparkles', onClick: () => store.emit('focus-ai') },
      has && { label: 'Delete', icon: 'trash', danger: true, kbd: 'Del', onClick: () => this.remove() },
      !has && { label: 'Change background', icon: 'bg', onClick: () => store.emit('open-bg', { x: e.clientX, y: e.clientY }) },
    ]);
  }

  copy() {
    const els = clone(store.selected);
    if (!els.length) return;
    this.clip = els;
    navigator.clipboard?.writeText('SLIDES:' + JSON.stringify(els)).catch(() => {});
  }
  cut() { this.copy(); this.remove(); }
  pasteInternal(els = this.clip) {
    if (!els?.length) return;
    const fresh = els.map((e) => ({ ...clone(e), id: uid('e'), x: e.x + 30, y: e.y + 30 }));
    store.commit('Paste', () => store.slide.elements.push(...fresh));
    store.select(fresh.map((e) => e.id));
    this.clip = fresh;
  }
  duplicate() {
    const els = store.selected;
    if (!els.length) return;
    const fresh = els.map((e) => ({ ...clone(e), id: uid('e'), x: e.x + 30, y: e.y + 30 }));
    store.commit('Duplicate', () => {
      const arr = store.slide.elements;
      const top = Math.max(...els.map((e) => arr.indexOf(e)));
      arr.splice(top + 1, 0, ...fresh);
    });
    store.select(fresh.map((e) => e.id));
  }
  remove() {
    const ids = new Set(store.selection);
    if (!ids.size) return;
    store.stopEditing();
    store.commit('Delete', () => { store.slide.elements = store.slide.elements.filter((e) => !ids.has(e.id)); });
    store.select([]);
  }
  arrange(where) {
    const ids = new Set(store.selection);
    store.commit('Arrange', () => {
      const arr = store.slide.elements;
      const picked = arr.filter((e) => ids.has(e.id));
      const rest = arr.filter((e) => !ids.has(e.id));
      if (where === 'front') store.slide.elements = [...rest, ...picked];
      else if (where === 'back') store.slide.elements = [...picked, ...rest];
      else {
        const d = where === 'forward' ? 1 : -1;
        const idx = picked.map((e) => arr.indexOf(e));
        const order = d > 0 ? idx.sort((a, b) => b - a) : idx.sort((a, b) => a - b);
        for (const i of order) { const j = i + d; if (j < 0 || j >= arr.length || ids.has(arr[j].id)) continue; [arr[i], arr[j]] = [arr[j], arr[i]]; }
      }
    });
  }
  nudge(dx, dy) {
    const sel = store.selected;
    if (!sel.length) return;
    store.commit('Nudge', () => sel.forEach((e) => { e.x += dx; e.y += dy; }), { coalesce: 'nudge' });
  }

  // ---------- insert ----------
  add(el, { select = true, edit = false } = {}) {
    store.stopEditing();
    store.commit('Insert ' + el.type, () => store.slide.elements.push(el));
    if (select) store.select([el.id]);
    if (edit) requestAnimationFrame(() => this.edit(el.id));
    return el;
  }

  async addMedia(file, at) {
    const kind = file.type.startsWith('video/') ? 'video' : 'image';
    toast(kind === 'video' ? 'Uploading video…' : 'Adding image…', 1500);
    let blob = file, w = 0, hh = 0;
    if (kind === 'image') ({ blob, w, h: hh } = await prepareImage(file));
    const src = await putMedia(blob);
    if (!w) {
      const { resolveSrc } = await import('./media.js');
      ({ w, h: hh } = await mediaSize(resolveSrc(src) || src, kind));
    }
    const s = Math.min(1, 1100 / w, 700 / hh);
    const ew = Math.round(w * s), eh = Math.round(hh * s);
    const x = at ? at.x - ew / 2 : (SLIDE_W - ew) / 2, y = at ? at.y - eh / 2 : (SLIDE_H - eh) / 2;
    return this.add(newElement(kind, { src, x: Math.round(clamp(x, -ew / 2, SLIDE_W - ew / 2)), y: Math.round(clamp(y, -eh / 2, SLIDE_H - eh / 2)), w: ew, h: eh }));
  }

  onDrop(e) {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => /^(image|video)\//.test(f.type));
    if (!files.length) return;
    e.preventDefault();
    const p = this.pt(e);
    files.forEach((f, i) => this.addMedia(f, { x: p.x + i * 30, y: p.y + i * 30 }));
  }

  // Global paste (not while typing somewhere).
  async onPaste(e) {
    const files = [...(e.clipboardData?.files || [])].filter((f) => /^(image|video)\//.test(f.type));
    if (files.length) { e.preventDefault(); for (const f of files) await this.addMedia(f); return; }
    const text = e.clipboardData?.getData('text/plain') || '';
    if (text.startsWith('SLIDES:')) {
      e.preventDefault();
      try { this.pasteInternal(JSON.parse(text.slice(7))); } catch {}
      return;
    }
    if (text.trim()) {
      e.preventDefault();
      const html = text.trim().split(/\n{2,}/).map((p) => `<p>${escapeText(p).replace(/\n/g, '<br>')}</p>`).join('');
      this.add(newElement('text', { html, x: 160, y: 160, w: 1200, h: 200 }));
    }
  }

  onKey(e) {
    const k = e.key;
    if (store.editingId) {
      if (k === 'Escape') { e.preventDefault(); this.flushText(); const id = store.editingId; store.stopEditing(); store.select([id]); }
      return false;
    }
    if (k === 'Delete' || k === 'Backspace') { if (store.selection.length) { e.preventDefault(); this.remove(); return true; } return false; }
    if (k.startsWith('Arrow') && store.selection.length) {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1;
      this.nudge(k === 'ArrowLeft' ? -d : k === 'ArrowRight' ? d : 0, k === 'ArrowUp' ? -d : k === 'ArrowDown' ? d : 0);
      return true;
    }
    if (k === 'Escape' && store.selection.length) { store.select([]); return true; }
    if (k === 'Enter' && store.selection.length === 1) {
      const el = store.selected[0];
      if (['text', 'shape', 'table'].includes(el.type)) { e.preventDefault(); this.edit(el.id); return true; }
    }
    if (mod(e)) {
      const key = k.toLowerCase();
      if (key === 'd' && store.selection.length) { e.preventDefault(); this.duplicate(); return true; }
      if (key === 'c' && store.selection.length) { e.preventDefault(); this.copy(); return true; }
      if (key === 'x' && store.selection.length) { e.preventDefault(); this.cut(); return true; }
      if (key === 'a') { e.preventDefault(); store.select(store.slide.elements.map((x) => x.id)); return true; }
      if (key === ']') { e.preventDefault(); this.arrange(e.shiftKey ? 'front' : 'forward'); return true; }
      if (key === '[') { e.preventDefault(); this.arrange(e.shiftKey ? 'back' : 'backward'); return true; }
    }
    return false;
  }
}

// ---------- helpers ----------
function cursorFor(d, rot = 0) {
  const names = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
  const cur = ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize'];
  const i = (names.indexOf(d) + Math.round(((rot % 360) + 360) % 360 / 45)) % 8;
  return cur[i % 4];
}

function bounds(els) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of els) { x0 = Math.min(x0, e.x); y0 = Math.min(y0, e.y); x1 = Math.max(x1, e.x + e.w); y1 = Math.max(y1, e.y + e.h); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function targetsFrom(others) {
  const xs = [0, SLIDE_W / 2, SLIDE_W], ys = [0, SLIDE_H / 2, SLIDE_H];
  for (const o of others) { if (o.rot) continue; xs.push(o.x, o.x + o.w / 2, o.x + o.w); ys.push(o.y, o.y + o.h / 2, o.y + o.h); }
  return { xs, ys };
}

function snap(bb, others, th) {
  const { xs, ys } = targetsFrom(others);
  let best = { dx: 0, dy: 0, gx: null, gy: null }, bx = th + 1, by = th + 1;
  for (const c of [bb.x, bb.x + bb.w / 2, bb.x + bb.w]) for (const t of xs) { const d = t - c; if (Math.abs(d) < bx) { bx = Math.abs(d); best.dx = d; best.gx = t; } }
  for (const c of [bb.y, bb.y + bb.h / 2, bb.y + bb.h]) for (const t of ys) { const d = t - c; if (Math.abs(d) < by) { by = Math.abs(d); best.dy = d; best.gy = t; } }
  const guides = [];
  if (bx <= th) guides.push({ axis: 'v', pos: best.gx }); else best.dx = 0;
  if (by <= th) guides.push({ axis: 'h', pos: best.gy }); else best.dy = 0;
  return { dx: best.dx, dy: best.dy, guides };
}

function snapEdges(bb, others, th, sx, sy) {
  const { xs, ys } = targetsFrom(others);
  let dx = 0, dy = 0, bx = th + 1, by = th + 1, gx = null, gy = null;
  if (sx) { const c = sx > 0 ? bb.x + bb.w : bb.x; for (const t of xs) { const d = t - c; if (Math.abs(d) < bx) { bx = Math.abs(d); dx = d; gx = t; } } }
  if (sy) { const c = sy > 0 ? bb.y + bb.h : bb.y; for (const t of ys) { const d = t - c; if (Math.abs(d) < by) { by = Math.abs(d); dy = d; gy = t; } } }
  const guides = [];
  if (bx <= th) guides.push({ axis: 'v', pos: gx }); else dx = 0;
  if (by <= th) guides.push({ axis: 'h', pos: gy }); else dy = 0;
  return { dx, dy, guides };
}

function normalize(a) { const s = a.reduce((x, y) => x + y, 0) || 1; for (let i = 0; i < a.length; i++) a[i] /= s; }

export function cleanHTML(html) {
  let s = html.replace(/<(\w+)[^>]*data-placeholder[^>]*><\/\1>/g, '');
  if (!s.trim() || s === '<br>') return '<p></p>';
  // Bare text (no block wrapper) gets a paragraph so styling stays consistent.
  if (!/^\s*<(p|ul|ol|div|h\d|blockquote)/i.test(s)) s = '<p>' + s + '</p>';
  return s.replace(/<div>/g, '<p>').replace(/<\/div>/g, '</p>');
}

function escapeText(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

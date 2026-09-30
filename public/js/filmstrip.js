// Left pane: slide thumbnails. Click to open, drag to reorder, right-click for slide actions.
import { store } from './store.js';
import { SlideView } from './render.js';
import { newSlide, LAYOUTS, SLIDE_W } from './model.js';
import { h, clone, uid, mod } from './util.js';
import { icon } from './icons.js';
import { menu, popover, closePop } from './ui.js';

export class Filmstrip {
  constructor(root) {
    this.root = root;
    this.views = new Map(); // slide id -> {row, view}
    this.multi = new Set();
    root.tabIndex = 0;
    this.list = h('div');
    this.addBtn = h('button', { class: 'film-add', html: icon('plus') + '<span>New slide</span>' });
    this.addBtn.onclick = () => this.layoutPicker(this.addBtn, store.index + 1);
    root.append(this.list, this.addBtn);

    store.on('deck', () => this.rebuild());
    store.on('slide', () => this.markCurrent(true));
    store.on('poster', (sid) => this.refresh(sid));
    store.on('change', (kind) => { if (kind !== 'live') this.sync(kind); else this.refreshSoon(store.slide.id); });
    new ResizeObserver(() => this.scaleAll()).observe(root);
    root.addEventListener('keydown', (e) => this.onKey(e));
  }

  rebuild() {
    for (const { view } of this.views.values()) view.destroy();
    this.views.clear();
    this.list.replaceChildren();
    this.multi.clear();
    this.sync('rebuild');
  }

  // Structural sync: add/remove/reorder rows, then refresh content of changed slides.
  sync(kind) {
    const slides = store.deck.slides;
    const alive = new Set(slides.map((s) => s.id));
    for (const [id, v] of this.views) if (!alive.has(id)) { v.view.destroy(); v.row.remove(); this.views.delete(id); }
    slides.forEach((s, i) => {
      let v = this.views.get(s.id);
      if (!v) v = this.makeRow(s);
      if (this.list.children[i] !== v.row) this.list.insertBefore(v.row, this.list.children[i] || null);
      v.num.textContent = i + 1;
      v.slide = s;
    });
    if (kind === 'history' || kind === 'rebuild' || kind === 'edit') {
      // Re-render every slide whose object changed (cheap: keyed renderer skips unchanged elements)
      for (const s of slides) this.refresh(s.id);
    }
    this.markCurrent();
    this.scaleAll();
  }

  makeRow(s) {
    const slideEl = h('div');
    const view = new SlideView(slideEl, { mode: 'thumb' });
    const thumb = h('div', { class: 'thumb' }, slideEl);
    const num = h('div', { class: 'thumb-num' });
    const row = h('div', { class: 'thumb-row', draggable: 'true' }, num, thumb);
    const v = { row, view, num, thumb, slide: s, badge: null };
    row.addEventListener('click', (e) => this.onClick(e, v));
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); this.contextMenu(e, v); });
    row.addEventListener('dragstart', (e) => this.dragStart(e, v));
    row.addEventListener('dragover', (e) => this.dragOver(e, v));
    row.addEventListener('drop', (e) => this.drop(e, v));
    row.addEventListener('dragend', () => this.clearDrop());
    this.views.set(s.id, v);
    return v;
  }

  refreshSoon(id) {
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => this.refresh(id));
  }

  refresh(id) {
    const v = this.views.get(id);
    const s = store.deck.slides.find((x) => x.id === id);
    if (!v || !s) return;
    v.view.render(s, store.deck);
    const hasAnim = s.bg?.anim || s.elements.some((e) => e.type === 'anim');
    if (hasAnim && !v.badge) { v.badge = h('div', { class: 'thumb-badge', html: icon('sparkles', 10) }); v.thumb.append(v.badge); }
    if (!hasAnim && v.badge) { v.badge.remove(); v.badge = null; }
  }

  scaleAll() {
    const w = this.list.querySelector('.thumb')?.clientWidth;
    if (!w) return;
    const s = w / SLIDE_W;
    for (const v of this.views.values()) v.view.root.style.transform = `scale(${s})`;
  }

  markCurrent(scroll) {
    for (const [id, v] of this.views) {
      v.row.classList.toggle('current', id === store.slide?.id);
      v.row.classList.toggle('multi', this.multi.has(id) && id !== store.slide?.id);
    }
    if (scroll) this.views.get(store.slide.id)?.row.scrollIntoView({ block: 'nearest' });
  }

  indexOf(v) { return store.deck.slides.indexOf(v.slide); }

  onClick(e, v) {
    const i = this.indexOf(v);
    if (e.shiftKey) {
      const a = Math.min(i, store.index), b = Math.max(i, store.index);
      this.multi = new Set(store.deck.slides.slice(a, b + 1).map((s) => s.id));
    } else if (mod(e)) {
      this.multi.has(v.slide.id) ? this.multi.delete(v.slide.id) : this.multi.add(v.slide.id);
      this.multi.add(store.slide.id);
    } else {
      this.multi.clear();
    }
    store.go(i);
    this.markCurrent();
    this.root.focus({ preventScroll: true });
  }

  selectedIndexes() {
    const ids = this.multi.size ? this.multi : new Set([store.slide.id]);
    return store.deck.slides.map((s, i) => (ids.has(s.id) ? i : -1)).filter((i) => i >= 0);
  }

  // ---------- actions ----------
  addSlide(layout, at = store.index + 1) {
    const s = newSlide(layout, store.deck.theme);
    // New slides inherit the current slide's background so decks stay consistent.
    const cur = store.slide;
    if (cur?.bg) s.bg = clone(cur.bg);
    store.commit('New slide', (d) => d.slides.splice(at, 0, s));
    store.go(at);
  }

  duplicate() {
    const idx = this.selectedIndexes();
    const copies = idx.map((i) => {
      const c = clone(store.deck.slides[i]);
      c.id = uid('s');
      c.elements.forEach((e) => { e.id = uid('e'); });
      return c;
    });
    const at = idx[idx.length - 1] + 1;
    store.commit('Duplicate slide', (d) => d.slides.splice(at, 0, ...copies));
    this.multi.clear();
    store.go(at);
  }

  remove() {
    const idx = this.selectedIndexes();
    if (idx.length >= store.deck.slides.length) {
      store.commit('Delete slide', (d) => { d.slides = [newSlide('blank', d.theme)]; });
    } else {
      const ids = new Set(idx.map((i) => store.deck.slides[i].id));
      store.commit('Delete slide', (d) => { d.slides = d.slides.filter((s) => !ids.has(s.id)); });
    }
    this.multi.clear();
    store.index = Math.min(idx[0], store.deck.slides.length - 1);
    store.selection = [];
    store.emit('slide');
  }

  move(ids, to) {
    const slides = store.deck.slides;
    const moving = slides.filter((s) => ids.has(s.id));
    const before = slides.slice(0, to).filter((s) => !ids.has(s.id)).length;
    const cur = store.slide;
    store.commit('Move slide', (d) => {
      const rest = d.slides.filter((s) => !ids.has(s.id));
      rest.splice(before, 0, ...moving);
      d.slides = rest;
    });
    store.index = store.deck.slides.indexOf(cur);
    store.emit('slide');
  }

  layoutPicker(anchor, at) {
    const grid = h('div', { class: 'layout-grid' });
    const views = [];
    for (const [key, label] of LAYOUTS) {
      const slideEl = h('div');
      const mini = h('div', { class: 'thumb-mini' }, slideEl);
      const card = h('button', { class: 'layout-card' }, mini, h('span', null, label));
      card.onclick = () => { closePop(); this.addSlide(key, at); };
      grid.append(card);
      const s = newSlide(key, store.deck.theme);
      if (store.slide?.bg) s.bg = { ...clone(store.slide.bg), anim: store.slide.bg.anim ? { ...store.slide.bg.anim } : null };
      const v = new SlideView(slideEl, { mode: 'thumb' });
      v.render(s, store.deck);
      slideEl.style.transform = `scale(${110 / SLIDE_W})`;
      views.push(v);
    }
    popover(anchor, grid, { onClose: () => views.forEach((v) => v.destroy()) });
  }

  contextMenu(e, v) {
    if (!this.multi.has(v.slide.id)) { this.multi.clear(); store.go(this.indexOf(v)); this.markCurrent(); }
    const n = this.selectedIndexes().length;
    menu({ x: e.clientX, y: e.clientY }, [
      { label: 'New slide', icon: 'plus', kbd: 'Ctrl M', onClick: () => this.layoutPicker({ getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY, width: 0 }) }, store.index + 1) },
      { label: n > 1 ? `Duplicate ${n} slides` : 'Duplicate slide', icon: 'copy', kbd: 'Ctrl D', onClick: () => this.duplicate() },
      'sep',
      { label: 'Move up', onClick: () => this.move(new Set(this.selectedIndexes().map((i) => store.deck.slides[i].id)), Math.max(0, this.selectedIndexes()[0] - 1)) },
      { label: 'Move down', onClick: () => { const idx = this.selectedIndexes(); this.move(new Set(idx.map((i) => store.deck.slides[i].id)), Math.min(store.deck.slides.length, idx[idx.length - 1] + 2)); } },
      'sep',
      { label: 'Present from here', icon: 'play', onClick: () => store.emit('present', store.index) },
      { label: n > 1 ? `Delete ${n} slides` : 'Delete slide', icon: 'trash', danger: true, kbd: 'Del', onClick: () => this.remove() },
    ]);
  }

  onKey(e) {
    if (e.target !== this.root) return;
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowRight' || k === 'PageDown') { e.preventDefault(); this.multi.clear(); store.go(store.index + 1); }
    else if (k === 'ArrowUp' || k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); this.multi.clear(); store.go(store.index - 1); }
    else if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); this.remove(); }
    else if (mod(e) && k.toLowerCase() === 'd') { e.preventDefault(); this.duplicate(); }
    else if (k === 'Enter') { e.preventDefault(); this.addSlide('title-body'); }
    else return;
    e.stopPropagation();
  }

  // ---------- drag & drop reorder ----------
  dragStart(e, v) {
    if (!this.multi.has(v.slide.id)) { this.multi.clear(); }
    const ids = this.multi.size ? new Set(this.multi) : new Set([v.slide.id]);
    this.dragIds = ids;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-slide', [...ids].join(','));
  }
  dragOver(e, v) {
    if (!this.dragIds) return;
    e.preventDefault();
    const r = v.row.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    const idx = this.indexOf(v) + (after ? 1 : 0);
    this.dropAt = idx;
    if (!this.line) this.line = h('div', { class: 'drop-line' });
    const top = after ? v.row.offsetTop + v.row.offsetHeight - 1 : v.row.offsetTop - 2;
    this.line.style.top = top + 'px';
    this.list.style.position = 'relative';
    this.list.append(this.line);
  }
  drop(e) {
    if (!this.dragIds) return;
    e.preventDefault();
    this.move(this.dragIds, this.dropAt);
    this.clearDrop();
  }
  clearDrop() { this.line?.remove(); this.line = null; this.dragIds = null; }
}

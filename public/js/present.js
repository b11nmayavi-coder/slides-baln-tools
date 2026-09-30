// Fullscreen presenter with slide transitions, entrance effects and live code animations.
import { store } from './store.js';
import { SlideView } from './render.js';
import { SLIDE_W, SLIDE_H } from './model.js';
import { h } from './util.js';
import { icon } from './icons.js';

const DUR = { none: 0, fade: 520, slide: 640, zoom: 600, blur: 700 };

export class Presenter {
  constructor(root) {
    this.root = root;
    this.active = false;
    this.onKey = this.onKey.bind(this);
    this.onResize = () => this.layout();
    store.on('present', (i) => this.start(i ?? store.index));
  }

  start(i = 0) {
    if (this.active) return;
    this.active = true;
    this.index = Math.max(0, Math.min(i, store.deck.slides.length - 1));
    this.root.hidden = false;
    this.root.replaceChildren();
    this.layers = [];
    this.hud = h('div', { class: 'p-hud' },
      h('button', { title: 'Previous (←)', html: icon('chevronLeft', 18), onclick: (e) => { e.stopPropagation(); this.prev(); } }),
      this.counter = h('span'),
      h('button', { title: 'Next (→)', html: icon('chevronRight', 18), onclick: (e) => { e.stopPropagation(); this.next(); } }),
      h('button', { title: 'Speaker notes (N)', html: icon('message', 16), onclick: (e) => { e.stopPropagation(); this.toggleNotes(); } }),
      h('button', { title: 'Exit (Esc)', html: icon('x', 18), onclick: (e) => { e.stopPropagation(); this.stop(); } }),
    );
    this.root.append(this.hud);
    this.root.onclick = (e) => { if (!e.target.closest('.p-hud')) this.next(); };
    this.root.oncontextmenu = (e) => { e.preventDefault(); this.prev(); };
    this.root.onpointermove = () => {
      this.root.classList.add('show-cursor');
      clearTimeout(this._cur);
      this._cur = setTimeout(() => this.root.classList.remove('show-cursor'), 1800);
    };
    document.addEventListener('keydown', this.onKey, true);
    window.addEventListener('resize', this.onResize);
    this.root.requestFullscreen?.().catch(() => {});
    document.addEventListener('fullscreenchange', this._fs = () => { if (!document.fullscreenElement && this.active) this.stop(); });
    this.show(this.index, 'none');
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    document.removeEventListener('keydown', this.onKey, true);
    document.removeEventListener('fullscreenchange', this._fs);
    window.removeEventListener('resize', this.onResize);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    for (const l of this.layers) l.view.destroy();
    this.prewarm?.view.destroy();
    this.prewarm = null;
    this.layers = [];
    this.root.hidden = true;
    this.root.replaceChildren();
    store.go(this.index);
  }

  scale() { return Math.min(innerWidth / SLIDE_W, innerHeight / SLIDE_H); }

  layout() {
    const s = this.scale();
    const t = `translate(${-SLIDE_W * s / 2}px, ${-SLIDE_H * s / 2}px) scale(${s})`;
    for (const l of [...this.layers, this.prewarm].filter(Boolean)) l.el.style.transform = t;
  }

  makeLayer(i) {
    const el = h('div', { class: 'p-layer' });
    const slideEl = h('div');
    el.append(slideEl);
    const view = new SlideView(slideEl, { mode: 'present' });
    view.render(store.deck.slides[i], store.deck);
    return { el, view, index: i };
  }

  show(i, transition) {
    const slides = store.deck.slides;
    if (i < 0 || i >= slides.length) return;
    const dir = i >= this.index ? 1 : -1;
    this.index = i;
    const slide = slides[i];
    const t = transition ?? slide.transition ?? 'fade';
    const dur = DUR[t] ?? 500;

    // Reuse the pre-rendered next slide when possible (its animations have already booted).
    let layer;
    if (this.prewarm && this.prewarm.index === i) { layer = this.prewarm; this.prewarm = null; }
    else layer = this.makeLayer(i);
    layer.el.style.visibility = '';
    layer.el.style.zIndex = 2;
    this.root.insertBefore(layer.el, this.hud);
    const s = this.scale();
    const base = `translate(${-SLIDE_W * s / 2}px, ${-SLIDE_H * s / 2}px) scale(${s})`;
    layer.el.style.transform = base;
    layer.view.setAllPlaying(true);
    this.entrances(layer);

    const old = this.layers.slice();
    this.layers = [...old, layer];
    if (dur && old.length) {
      const from = { fade: { opacity: 0 }, slide: { opacity: 1, transform: `translateX(${dir * 100}vw) ` + base }, zoom: { opacity: 0, transform: base + ' scale(1.06)' }, blur: { opacity: 0, filter: 'blur(30px)' } }[t] || { opacity: 0 };
      const to = { opacity: 1, transform: base, filter: 'blur(0px)' };
      layer.el.animate([{ ...to, ...from }, to], { duration: dur, easing: 'cubic-bezier(.2,.7,.2,1)' });
      if (t === 'slide') old.forEach((o) => o.el.animate([{ transform: o.el.style.transform }, { transform: `translateX(${-dir * 100}vw) ` + o.el.style.transform }], { duration: dur, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' }));
    }
    clearTimeout(this._cleanup);
    this._cleanup = setTimeout(() => {
      for (const o of old) { o.view.destroy(); o.el.remove(); }
      this.layers = this.layers.filter((l) => !old.includes(l));
      this.warm(i + 1);
    }, dur + 60);
    this.counter.textContent = `${i + 1} / ${slides.length}`;
    if (this.notesEl) this.notesEl.textContent = slide.notes || 'No notes for this slide.';
  }

  // Render the next slide hidden so its animation workers are initialised before we need them.
  warm(i) {
    if (!this.active || i >= store.deck.slides.length) return;
    if (this.prewarm?.index === i) return;
    this.prewarm?.view.destroy();
    this.prewarm?.el.remove();
    const layer = this.makeLayer(i);
    layer.el.style.zIndex = 0;
    layer.el.style.visibility = 'hidden';
    const s = this.scale();
    layer.el.style.transform = `translate(${-SLIDE_W * s / 2}px, ${-SLIDE_H * s / 2}px) scale(${s})`;
    this.root.insertBefore(layer.el, this.root.firstChild);
    layer.view.setAllPlaying(false);
    this.prewarm = layer;
  }

  entrances(layer) {
    const slide = store.deck.slides[layer.index];
    for (const e of slide.elements) {
      if (!e.enter?.effect) continue;
      const node = layer.view.nodes.get(e.id);
      if (!node) continue;
      node.classList.add('enter-' + e.enter.effect);
      node.style.animationDelay = (e.enter.delay || 0) + 0.15 + 's';
    }
  }

  next() { if (this.index < store.deck.slides.length - 1) this.show(this.index + 1); }
  prev() { if (this.index > 0) this.show(this.index - 1, 'fade'); }

  toggleNotes() {
    if (this.notesEl) { this.notesEl.remove(); this.notesEl = null; return; }
    this.notesEl = h('div', { class: 'p-notes' }, store.deck.slides[this.index].notes || 'No notes for this slide.');
    this.root.append(this.notesEl);
  }

  onKey(e) {
    const k = e.key;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'l'].includes(k)) { handled(); this.next(); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'h'].includes(k)) { handled(); this.prev(); }
    else if (k === 'Home') { handled(); this.show(0); }
    else if (k === 'End') { handled(); this.show(store.deck.slides.length - 1); }
    else if (k === 'Escape') { handled(); this.stop(); }
    else if (k === 'b' || k === '.') {
      handled();
      const b = this.root.querySelector('.p-black');
      if (b) b.remove(); else this.root.append(h('div', { class: 'p-black' }));
    } else if (k === 'n') { handled(); this.toggleNotes(); }
    else if (/^[0-9]$/.test(k)) {
      handled();
      this._num = (this._num || '') + k;
      clearTimeout(this._numT);
      this._numT = setTimeout(() => { this.show(Math.max(0, +this._num - 1)); this._num = ''; }, 600);
    }
  }
}

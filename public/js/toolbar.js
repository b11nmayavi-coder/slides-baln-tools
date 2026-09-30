// Contextual toolbar: insert tools + formatting for whatever is selected (or the slide).
import { store } from './store.js';
import { newElement, THEMES, FONTS, SHAPES, TRANSITIONS, ENTRANCES, SLIDE_W, SLIDE_H, fontFor, color as themeColor } from './model.js';
import { h, clone } from './util.js';
import { icon } from './icons.js';
import { popover, menu, colorPicker, closePop, field } from './ui.js';
import { PRESETS } from './anim/presets.js';
import { AnimHost } from './anim/host.js';
import { putMedia } from './media.js';
import { prepareImage } from './util.js';

document.execCommand?.('styleWithCSS', false, true);

export class Toolbar {
  constructor(root, editor) {
    this.root = root;
    this.ed = editor;
    const rerender = () => this.render();
    ['selection', 'slide', 'deck', 'text-selection'].forEach((e) => store.on(e, rerender));
    store.on('change', (k) => { if (k !== 'live') rerender(); });
    store.on('open-bg', (at) => this.backgroundPanel(at));
  }

  // ---------- small builders ----------
  btn(ic, title, fn, { on = false, label = '', cls = '', disabled = false } = {}) {
    const b = h('button', { class: 'tb' + (on ? ' on' : '') + (cls ? ' ' + cls : ''), title, disabled, html: (ic ? icon(ic) : '') + (label ? `<span class="lbl">${label}</span>` : '') });
    b.addEventListener('pointerdown', (e) => e.preventDefault()); // keep text selection while editing
    b.addEventListener('click', (e) => fn(e, b));
    return b;
  }
  sep() { return h('div', { class: 'tb-sep' }); }
  put(...xs) { this.root.append(...xs.filter(Boolean)); }

  render() {
    if (!store.deck) return;
    const ae = document.activeElement;
    if (ae && this.root.contains(ae) && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT')) return;
    const r = this.root;
    r.replaceChildren();
    this.put(
      this.btn('undo', 'Undo (Ctrl+Z)', () => store.undo(), { disabled: !store.past.length }),
      this.btn('redo', 'Redo (Ctrl+Shift+Z)', () => store.redo(), { disabled: !store.future.length }),
      this.sep(),
      this.btn('text', 'Text box', () => this.ed.add(newElement('text', { x: 560, y: 470, w: 800, h: 140, html: '<p></p>', style: { ...newElement('text').style, fontSize: 56 } }), { edit: true })),
      this.btn('shape', 'Shape', (e, b) => this.shapeMenu(b)),
      this.btn('image', 'Image or video', (e, b) => this.mediaMenu(b)),
      this.btn('table', 'Table', (e, b) => this.tableMenu(b)),
      this.btn('sparkles', 'Animations', (e, b) => this.animMenu(b), { label: 'Animate', cls: 'ai-btn' }),
      this.sep(),
    );
    const sel = store.selected;
    if (!sel.length) return this.slideTools();
    const one = sel.length === 1 ? sel[0] : null;
    const types = new Set(sel.map((e) => e.type));
    if ([...types].every((t) => ['text', 'shape', 'table'].includes(t))) this.textTools(sel);
    if (one?.type === 'shape') this.shapeTools(one);
    if (one && (one.type === 'image' || one.type === 'video')) this.mediaTools(one);
    if (one?.type === 'anim') r.append(this.btn('sliders', 'Animation settings', (e, b) => store.emit('open-anim', { key: one.id, anchor: b }), { label: one.anim?.name || 'Animation' }), this.sep());
    if (one?.type === 'table') this.tableTools(one);
    this.commonTools(sel);
  }

  // ---------- slide (nothing selected) ----------
  slideTools() {
    const s = store.slide;
    this.put(
      this.btn('bg', 'Background', (e, b) => this.backgroundPanel(b), { label: 'Background' }),
      this.btn('palette', 'Theme', (e, b) => this.themePanel(b), { label: 'Theme' }),
      this.btn('transition', 'Transition', (e, b) => menu(b, [
        { title: 'Transition into this slide' },
        ...TRANSITIONS.map((t) => ({ label: cap(t), on: (s.transition || 'fade') === t, onClick: () => store.commit('Transition', () => { s.transition = t; }) })),
        'sep',
        { label: 'Apply to all slides', onClick: () => store.commit('Transition', (d) => d.slides.forEach((x) => { x.transition = s.transition; })) },
      ]), { label: cap(s.transition || 'fade') }),
    );
  }

  // ---------- text ----------
  textTools(sel) {
    const e0 = sel[0];
    const st = e0.style || {};
    const theme = store.deck.theme;
    const editing = store.editingId === e0.id;
    const q = (cmd) => { try { return document.queryCommandState(cmd); } catch { return false; } };
    const hasRange = editing && !getSelection().isCollapsed;

    const setStyle = (patch, label = 'Format') => store.commit(label, () => sel.forEach((e) => { e.style = { ...e.style, ...patch }; }), { coalesce: 'style' });
    const inline = (cmd, val) => { document.execCommand(cmd, false, val); };

    // Font family
    const fontSel = h('select', { class: 'tb-select', title: 'Font', style: { width: '128px' } },
      h('option', { value: 'heading', selected: st.font === 'heading' }, `Heading · ${theme.heading}`),
      h('option', { value: 'body', selected: !st.font || st.font === 'body' }, `Body · ${theme.body}`),
      h('optgroup', { label: 'Fonts' }, FONTS.map((f) => h('option', { value: f, selected: st.font === f, style: { fontFamily: f } }, f))),
    );
    fontSel.addEventListener('change', () => {
      if (hasRange) { inline('fontName', fontFor(fontSel.value, theme)); }
      else setStyle({ font: fontSel.value }, 'Font');
      this.refocus();
    });

    // Size
    const size = st.fontSize || 40;
    const sizeIn = h('input', { value: String(size), inputmode: 'numeric', title: 'Font size (px on a 1920×1080 slide)' });
    const applySize = (v) => {
      v = Math.max(6, Math.min(600, Math.round(v)));
      if (hasRange) setInlineSize(v);
      else setStyle({ fontSize: v }, 'Font size');
    };
    sizeIn.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { applySize(+sizeIn.value || size); sizeIn.blur(); this.refocus(); } });
    sizeIn.addEventListener('change', () => applySize(+sizeIn.value || size));
    const step = (d) => applySize(size + d * (size >= 100 ? 8 : size >= 48 ? 4 : 2));
    const sizeBox = h('div', { class: 'tb-num' }, this.btn('minus', 'Smaller', () => step(-1)), sizeIn, this.btn('plus', 'Larger', () => step(1)));

    const toggle = (cmd, key, onVal, offVal) => () => {
      if (editing) inline(cmd);
      else setStyle({ [key]: st[key] === onVal ? offVal : onVal });
    };
    const colorBtn = (ic, title, cur, pick) => {
      const b = this.btn(ic, title, () => {});
      b.classList.add('tb-color');
      b.append(h('span', { class: 'bar', style: { background: cur || 'transparent' } }));
      b.onclick = () => {
        const saved = saveRange();
        colorPicker(b, { value: null, theme, allowNone: true, onPick: (v) => { restoreRange(saved); pick(v); } });
      };
      return b;
    };

    const align = st.align || 'left';
    const va = st.valign || 'top';
    this.put(
      fontSel, this.sep(), sizeBox, this.sep(),
      this.btn('bold', 'Bold (Ctrl+B)', toggle('bold', 'fontWeight', 700, 400), { on: editing ? q('bold') : (st.fontWeight || 400) >= 600 }),
      this.btn('italic', 'Italic (Ctrl+I)', toggle('italic', 'italic', true, false), { on: editing ? q('italic') : !!st.italic }),
      this.btn('underline', 'Underline (Ctrl+U)', toggle('underline', 'underline', true, false), { on: editing ? q('underline') : !!st.underline }),
      editing ? this.btn('strike', 'Strikethrough', () => inline('strikeThrough'), { on: q('strikeThrough') }) : null,
      colorBtn('type', 'Text color', themeColor(st.color, theme, theme.text), (v) => {
        if (hasRange) inline('foreColor', themeColor(v, theme, theme.text));
        else setStyle({ color: v }, 'Text color');
      }),
      editing ? colorBtn('highlight', 'Highlight', null, (v) => inline('hiliteColor', v ? themeColor(v, theme, v) : 'transparent')) : null,
      editing ? this.btn('link', 'Link', () => { const u = prompt('Link URL'); if (u) inline('createLink', u); }) : null,
      this.sep(),
      this.btn({ left: 'alignLeft', center: 'alignCenter', right: 'alignRight', justify: 'alignJustify' }[align], 'Align', (ev, b) => menu(b, [
        ['left', 'alignLeft'], ['center', 'alignCenter'], ['right', 'alignRight'], ['justify', 'alignJustify'],
      ].map(([a, ic]) => ({ label: cap(a), icon: ic, on: align === a, onClick: () => setStyle({ align: a }, 'Align') })))),
      this.btn({ top: 'vTop', middle: 'vMid', bottom: 'vBot' }[va], 'Vertical align', (ev, b) => menu(b, [
        ['top', 'vTop'], ['middle', 'vMid'], ['bottom', 'vBot'],
      ].map(([a, ic]) => ({ label: cap(a), icon: ic, on: va === a, onClick: () => setStyle({ valign: a }, 'Vertical align') })))),
      this.btn('list', 'Bulleted list', () => this.list(sel, 'ul', editing)),
      this.btn('listOl', 'Numbered list', () => this.list(sel, 'ol', editing)),
      this.btn('lineHeight', 'Spacing', (ev, b) => this.sliderPanel(b, [
        ['Line height', st.lineHeight || 1.3, 0.8, 2.4, 0.05, (v, fin) => setStyleLive(sel, { lineHeight: v }, fin)],
        ['Letter spacing', st.letterSpacing || 0, -10, 30, 0.5, (v, fin) => setStyleLive(sel, { letterSpacing: v }, fin)],
      ])),
      this.sep(),
    );
  }

  list(sel, tag, editing) {
    if (editing) { document.execCommand(tag === 'ul' ? 'insertUnorderedList' : 'insertOrderedList'); return; }
    store.commit('List', () => sel.forEach((e) => {
      if (e.type === 'table') return;
      const div = document.createElement('div');
      div.innerHTML = e.html || '';
      const existing = div.querySelector('ul, ol');
      if (existing && existing.tagName.toLowerCase() === tag) {
        e.html = [...div.querySelectorAll('li')].map((li) => `<p>${li.innerHTML}</p>`).join('');
      } else if (existing) {
        e.html = e.html.replace(/<(\/?)(ul|ol)>/g, `<$1${tag}>`);
      } else {
        const items = [...div.children].map((c) => c.innerHTML).filter((x) => x.trim());
        e.html = `<${tag}>${(items.length ? items : ['']).map((x) => `<li>${x}</li>`).join('')}</${tag}>`;
      }
    }));
  }

  refocus() {
    if (!store.editingId) return;
    const t = this.ed.view.nodes.get(store.editingId)?.querySelector('[contenteditable]');
    t?.focus({ preventScroll: true });
  }

  // ---------- shapes ----------
  shapeTools(e) {
    const theme = store.deck.theme;
    const fillBtn = this.btn('fill', 'Fill', (ev, b) => colorPicker(b, { value: e.fill, theme, allowGradient: true, onPick: (v) => store.commit('Fill', () => { e.fill = v; }) }));
    fillBtn.classList.add('tb-color');
    fillBtn.append(h('span', { class: 'bar', style: { background: e.fill?.includes('gradient') ? e.fill : themeColor(e.fill, theme, 'transparent') } }));
    const strokeBtn = this.btn('stroke', 'Border color', (ev, b) => colorPicker(b, { value: e.stroke, theme, onPick: (v) => store.commit('Border', () => { e.stroke = v; if (v && !e.strokeWidth) e.strokeWidth = 4; }) }));
    this.put(
      fillBtn, strokeBtn,
      this.btn(null, 'Border & corners', (ev, b) => this.sliderPanel(b, [
        ['Border width', e.strokeWidth || 0, 0, 40, 1, (v, fin) => live(e, { strokeWidth: v }, fin)],
        ...(['rect', 'round'].includes(e.shape) ? [['Corner radius', e.radius || 0, 0, 400, 1, (v, fin) => live(e, { radius: v }, fin)]] : []),
      ]), { label: `${e.strokeWidth || 0}px` }),
      this.btn(null, 'Change shape', (ev, b) => menu(b, SHAPES.map((s) => ({ label: cap(s), on: e.shape === s, onClick: () => store.commit('Shape', () => { e.shape = s; }) }))), { label: cap(e.shape) }),
      this.sep(),
    );
  }

  // ---------- media ----------
  mediaTools(e) {
    this.put(
      this.btn(null, 'Fit', (ev, b) => menu(b, ['cover', 'contain', 'fill'].map((f) => ({ label: cap(f), on: e.fit === f, onClick: () => store.commit('Fit', () => { e.fit = f; }) }))), { label: cap(e.fit || 'cover') }),
      this.btn(null, 'Corner radius', (ev, b) => this.sliderPanel(b, [['Corner radius', e.radius || 0, 0, 540, 1, (v, fin) => live(e, { radius: v }, fin)]]), { label: 'Radius' }),
      this.btn('refresh', 'Replace', () => store.emit('replace-media', e.id), { label: 'Replace' }),
      this.sep(),
    );
  }

  tableTools(e) {
    const theme = store.deck.theme;
    this.put(
      this.btn('fill', 'Header fill', (ev, b) => colorPicker(b, { value: e.headerFill, theme, onPick: (v) => store.commit('Header', () => { e.headerFill = v; }) })),
      this.btn(null, 'Header row', () => store.commit('Header row', () => { e.header = !e.header; }), { label: 'Header', on: e.header }),
      this.btn(null, 'Striped rows', () => store.commit('Stripes', () => { e.stripe = !e.stripe; }), { label: 'Stripes', on: e.stripe }),
      this.btn('stroke', 'Border color', (ev, b) => colorPicker(b, { value: e.border, theme, onPick: (v) => store.commit('Border', () => { e.border = v; }) })),
      store.editingId === e.id && this.ed.activeCell ? this.btn('palette', 'Cell fill', (ev, b) => {
        const { r, c } = this.ed.activeCell;
        colorPicker(b, { value: e.cellFill?.[r + ',' + c], theme, onPick: (v) => store.commit('Cell fill', () => { e.cellFill = { ...(e.cellFill || {}) }; if (v) e.cellFill[r + ',' + c] = v; else delete e.cellFill[r + ',' + c]; }) });
      }) : null,
      this.sep(),
    );
  }

  commonTools(sel) {
    const one = sel.length === 1 ? sel[0] : null;
    this.put(
      this.btn('opacity', 'Opacity & effects', (ev, b) => {
        const e = sel[0];
        const shadow = h('input', { type: 'checkbox' });
        shadow.checked = !!e.shadow;
        shadow.onchange = () => store.commit('Shadow', () => sel.forEach((x) => { x.shadow = shadow.checked; }));
        this.sliderPanel(b, [
          ['Opacity', e.opacity ?? 1, 0, 1, 0.01, (v, fin) => { sel.forEach((x) => { x.opacity = v; }); fin ? commitLive('Opacity') : store.live(); }],
          ['Rotation', e.rot || 0, 0, 360, 1, (v, fin) => { sel.forEach((x) => { x.rot = v; }); fin ? commitLive('Rotate') : store.live(); }],
        ], h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Drop shadow', shadow)));
      }),
      this.btn('enter', 'Entrance animation (when presenting)', (ev, b) => menu(b, [
        { title: 'Entrance' },
        ...ENTRANCES.map((x) => ({ label: cap(x), on: (one?.enter?.effect || 'none') === x, onClick: () => store.commit('Entrance', () => sel.forEach((e, i) => { e.enter = x === 'none' ? null : { effect: x, delay: e.enter?.delay ?? i * 0.12 }; })) })),
        'sep',
        { label: 'Stagger in reading order', onClick: () => store.commit('Entrance', () => { const s = [...store.slide.elements].filter((e) => e.enter).sort((a, b) => a.y - b.y || a.x - b.x); s.forEach((e, i) => { e.enter.delay = +(i * 0.15).toFixed(2); }); }) },
      ]), { on: !!one?.enter }),
      this.btn('layers', 'Arrange', (ev, b) => menu(b, [
        { label: 'Bring to front', kbd: 'Ctrl ⇧ ]', onClick: () => this.ed.arrange('front') },
        { label: 'Bring forward', kbd: 'Ctrl ]', onClick: () => this.ed.arrange('forward') },
        { label: 'Send backward', kbd: 'Ctrl [', onClick: () => this.ed.arrange('backward') },
        { label: 'Send to back', kbd: 'Ctrl ⇧ [', onClick: () => this.ed.arrange('back') },
        'sep',
        { title: 'Align on slide' },
        { label: 'Center horizontally', onClick: () => store.commit('Align', () => sel.forEach((e) => { e.x = Math.round((SLIDE_W - e.w) / 2); })) },
        { label: 'Center vertically', onClick: () => store.commit('Align', () => sel.forEach((e) => { e.y = Math.round((SLIDE_H - e.h) / 2); })) },
        sel.length > 1 && { label: 'Align left edges', onClick: () => { const x = Math.min(...sel.map((e) => e.x)); store.commit('Align', () => sel.forEach((e) => { e.x = x; })); } },
        sel.length > 1 && { label: 'Align top edges', onClick: () => { const y = Math.min(...sel.map((e) => e.y)); store.commit('Align', () => sel.forEach((e) => { e.y = y; })); } },
      ])),
      this.btn('copy', 'Duplicate (Ctrl+D)', () => this.ed.duplicate()),
      this.btn('trash', 'Delete', () => this.ed.remove()),
    );
  }

  // ---------- panels ----------
  sliderPanel(anchor, rows, extra) {
    const wrap = h('div');
    for (const [label, value, min, max, stepv, fn] of rows) {
      const val = h('span', { class: 'val' }, fmt(value));
      const inp = h('input', { type: 'range', min, max, step: stepv, value });
      let began = false;
      inp.addEventListener('input', () => { if (!began) { store.beginGesture(label); began = true; } val.textContent = fmt(+inp.value); fn(+inp.value, false); });
      inp.addEventListener('change', () => { fn(+inp.value, true); began = false; });
      wrap.append(h('div', { class: 'field' }, h('div', { class: 'field-label' }, label, val), inp));
    }
    if (extra) wrap.append(extra);
    popover(anchor, wrap, { className: 'panel-pop' });
  }

  shapeMenu(anchor) {
    const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(5, 44px)', gap: '4px', padding: '4px' } });
    const ns = 'http://www.w3.org/2000/svg';
    for (const s of SHAPES) {
      const b = h('button', { class: 'tb', title: cap(s), style: { width: '44px', height: '44px' } });
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '-2 -2 104 104'); svg.setAttribute('width', '26'); svg.setAttribute('height', '26');
      const p = document.createElementNS(ns, 'path');
      import('./render.js').then(({ shapePath }) => p.setAttribute('d', shapePath(s, 100, s === 'arrow' || s === 'line' ? 60 : 100, s === 'round' ? 22 : 0)));
      p.setAttribute('fill', s === 'line' ? 'none' : 'currentColor'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', s === 'line' ? '8' : '0');
      if (s === 'arrow' || s === 'line') p.setAttribute('transform', 'translate(0 20)');
      svg.append(p); b.append(svg);
      b.onclick = () => {
        closePop();
        const props = s === 'line' ? { w: 600, h: 20, x: 660, y: 530, stroke: 'text', strokeWidth: 6, fill: null }
          : s === 'arrow' ? { w: 500, h: 200, x: 710, y: 440 }
          : { shape: s };
        this.ed.add(newElement('shape', { shape: s, radius: s === 'round' ? 48 : s === 'rect' ? 0 : 0, ...props }));
      };
      grid.append(b);
    }
    popover(anchor, grid);
  }

  mediaMenu(anchor) {
    menu(anchor, [
      { label: 'Upload image or video…', icon: 'upload', onClick: () => pickFile('image/*,video/*', (f) => this.ed.addMedia(f)) },
      { label: 'From URL…', icon: 'link', onClick: () => {
        const u = prompt('Image or video URL');
        if (!u) return;
        const kind = /\.(mp4|webm|mov)(\?|$)/i.test(u) ? 'video' : 'image';
        this.ed.add(newElement(kind, { src: u, x: 460, y: 240, w: 1000, h: 600 }));
      } },
      'sep',
      { label: 'Paste or drag files onto the slide', icon: 'image', disabled: true },
    ]);
  }

  tableMenu(anchor) {
    const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(8, 20px)', gap: '3px', padding: '6px' } });
    const label = h('div', { style: { fontSize: '12px', color: 'var(--text-2)', padding: '2px 6px 6px' } }, 'Insert table');
    const cells = [];
    for (let r = 1; r <= 8; r++) for (let c = 1; c <= 8; c++) {
      const d = h('div', { style: { width: '20px', height: '20px', border: '1px solid var(--line-2)', borderRadius: '3px', cursor: 'pointer' } });
      d.onmouseenter = () => { label.textContent = `${c} × ${r}`; cells.forEach((x) => { x.el.style.background = x.r <= r && x.c <= c ? 'var(--accent-soft)' : ''; x.el.style.borderColor = x.r <= r && x.c <= c ? 'var(--accent)' : ''; }); };
      d.onclick = () => { closePop(); this.ed.add(newElement('table', { r, c, h: Math.min(800, 90 * r) })); };
      cells.push({ el: d, r, c });
      grid.append(d);
    }
    popover(anchor, h('div', null, label, grid));
  }

  animMenu(anchor) {
    const hosts = [];
    const cards = PRESETS.map((p) => {
      const box = h('div', { class: 'anim-box' });
      const card = h('button', { class: 'anim-card' }, h('div', { class: 'prev' }, box), h('span', null, p.name), h('small', null, p.target === 'background' ? 'Background' : 'Element'));
      card.onclick = () => { closePop(); this.applyPreset(p); };
      requestAnimationFrame(() => {
        if (!card.isConnected) return;
        hosts.push(new AnimHost(box, { code: p.code, params: p.params }, { theme: store.deck.theme, quality: 'preview' }));
      });
      return card;
    });
    const ask = h('button', { class: 'menu-item', html: icon('wand') + '<span>Describe your own — the AI writes it</span>' });
    ask.onclick = () => { closePop(); store.emit('focus-ai', 'Create a background animation: '); };
    popover(anchor, h('div', null, ask, h('div', { class: 'menu-sep' }), h('div', { class: 'anim-gallery' }, cards)), {
      onClose: () => hosts.forEach((x) => x.destroy()),
    });
  }

  applyPreset(p, target = p.target) {
    const anim = { name: p.name, code: p.code, params: clone(p.params) };
    if (target === 'background') {
      store.commit('Background animation', () => { store.slide.bg = { ...store.slide.bg, anim }; });
      store.select([]);
    } else {
      this.ed.add(newElement('anim', { anim }));
    }
  }

  backgroundPanel(anchor) {
    const s = store.slide;
    const theme = store.deck.theme;
    const bg = s.bg || {};
    const swatch = h('button', { class: 'btn', style: { width: '100%', justifyContent: 'flex-start' } },
      h('span', { class: 'swatch-dot', style: { background: bg.fill?.includes('gradient') ? bg.fill : themeColor(bg.fill, theme, theme.bg), width: '18px', height: '18px' } }),
      bg.fill ? (bg.fill.includes('gradient') ? 'Gradient' : bg.fill) : 'Theme background');
    swatch.onclick = () => colorPicker(swatch, { value: bg.fill, theme, allowGradient: true, title: 'Background fill', onPick: (v) => store.commit('Background', () => { s.bg = { ...s.bg, fill: v }; }) });
    const dim = h('input', { type: 'range', min: 0, max: 0.9, step: 0.01, value: bg.dim || 0 });
    dim.oninput = () => { s.bg = { ...s.bg, dim: +dim.value }; store.live(); };
    dim.onchange = () => store.commit('Dim', () => { s.bg = { ...s.bg, dim: +dim.value }; });
    const imgRow = h('div', { style: { display: 'flex', gap: '6px' } },
      h('button', { class: 'btn small', onclick: () => pickFile('image/*', async (f) => { const { blob } = await prepareImage(f, 3000); const src = await putMedia(blob); store.commit('Background image', () => { s.bg = { ...s.bg, image: src }; }); }) }, bg.image ? 'Replace image' : 'Choose image'),
      bg.image ? h('button', { class: 'btn small', onclick: () => store.commit('Background image', () => { s.bg = { ...s.bg, image: null }; }) }, 'Remove') : null,
    );
    const animRow = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
      bg.anim ? h('button', { class: 'btn small', onclick: () => { closePop(); store.emit('open-anim', { key: 'bg', anchor }); } }, h('span', { html: icon('sliders', 14) }), bg.anim.name || 'Animation') : null,
      bg.anim ? h('button', { class: 'btn small', onclick: () => store.commit('Remove animation', () => { s.bg = { ...s.bg, anim: null }; }) }, 'Remove') : null,
      h('button', { class: 'btn small', onclick: (ev) => { closePop(); this.animMenu(anchor.nodeType ? anchor : this.root); } }, bg.anim ? 'Change' : 'Add animation'),
      h('button', { class: 'btn small', onclick: () => { closePop(); store.emit('focus-ai', 'Create a background animation for this slide: '); } }, h('span', { html: icon('wand', 14) }), 'Describe'),
    );
    const content = h('div', null,
      field('Fill', swatch),
      field('Image', imgRow),
      field('Code animation', animRow, 'Runs off the main thread; pauses automatically when not visible.'),
      h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Darken', h('span', { class: 'val' }, Math.round((bg.dim || 0) * 100) + '%')), dim),
      h('button', { class: 'btn small', onclick: () => { store.commit('Background', (d) => d.slides.forEach((x) => { if (x !== s) x.bg = clone(s.bg); })); closePop(); } }, 'Apply to all slides'),
    );
    popover(anchor, content, { className: 'panel-pop' });
  }

  themePanel(anchor) {
    const d = store.deck;
    const list = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '6px', marginBottom: '12px' } },
      Object.entries(THEMES).map(([k, t]) => {
        const b = h('button', { title: t.name, style: { height: '46px', borderRadius: '8px', border: '1px solid var(--line)', background: t.bg, color: t.text, fontFamily: t.heading, fontWeight: 700, fontSize: '15px', position: 'relative', padding: 0 } }, 'Aa',
          h('span', { style: { position: 'absolute', right: '5px', bottom: '5px', width: '8px', height: '8px', borderRadius: '50%', background: t.accent } }));
        b.onclick = () => { store.commit('Theme', () => { d.theme = { ...t }; }); closePop(); };
        return b;
      }));
    const fontPick = (key) => {
      const s = h('select', null, FONTS.map((f) => h('option', { value: f, selected: d.theme[key] === f }, f)));
      s.onchange = () => store.commit('Theme font', () => { d.theme = { ...d.theme, [key]: s.value }; });
      return s;
    };
    const colorRow = h('div', { style: { display: 'flex', gap: '8px' } }, ['bg', 'text', 'muted', 'accent', 'accent2'].map((k) => {
      const b = h('button', { title: k, style: { width: '34px', height: '34px', borderRadius: '50%', border: '1px solid var(--line)', background: d.theme[k] } });
      b.onclick = () => colorPicker(b, { value: d.theme[k], allowNone: false, title: k, onPick: (v) => store.commit('Theme color', () => { d.theme = { ...d.theme, [k]: v }; }, { coalesce: 'theme-' + k }) });
      return b;
    }));
    popover(anchor, h('div', null, list, field('Heading font', fontPick('heading')), field('Body font', fontPick('body')), field('Colors', colorRow, 'Background · Text · Muted · Accent · Accent 2')), { className: 'panel-pop' });
  }
}

// ---------- helpers ----------
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ');
const fmt = (v) => (Math.abs(v) >= 10 ? Math.round(v) : +(+v).toFixed(2));

function commitLive(label) {
  // Values were already mutated live inside a gesture started by the slider.
  store.endGesture(true);
}
function live(e, patch, fin) {
  Object.assign(e, patch);
  fin ? commitLive() : store.live();
}
function setStyleLive(sel, patch, fin) {
  sel.forEach((e) => { e.style = { ...e.style, ...patch }; });
  fin ? commitLive() : store.live();
}

function saveRange() {
  const s = getSelection();
  return s.rangeCount ? s.getRangeAt(0).cloneRange() : null;
}
function restoreRange(r) {
  if (!r) return;
  const host = (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement)?.closest('[contenteditable]');
  host?.focus({ preventScroll: true });
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}

function setInlineSize(px) {
  document.execCommand('styleWithCSS', false, false);
  document.execCommand('fontSize', false, '7');
  document.execCommand('styleWithCSS', false, true);
  const root = getSelection().anchorNode?.parentElement?.closest('[contenteditable]');
  root?.querySelectorAll('font[size="7"]').forEach((f) => {
    const span = document.createElement('span');
    span.style.fontSize = px + 'px';
    span.innerHTML = f.innerHTML;
    f.replaceWith(span);
  });
  root?.dispatchEvent(new Event('input', { bubbles: true }));
}

export function pickFile(accept, cb) {
  const inp = document.getElementById('filePicker');
  inp.accept = accept;
  inp.value = '';
  inp.onchange = () => { const f = inp.files[0]; if (f) cb(f); };
  inp.click();
}

// Popovers, menus, modals and the colour picker.
import { h } from './util.js';
import { icon } from './icons.js';

let openPop = null;

export function closePop() {
  if (!openPop) return;
  const p = openPop;
  openPop = null;
  p.el.remove();
  p.onClose?.();
  document.removeEventListener('pointerdown', p.outside, true);
  document.removeEventListener('keydown', p.key, true);
}

// Show `content` anchored to `anchor` (element or {x,y}).
export function popover(anchor, content, { onClose, align = 'start', className = '' } = {}) {
  closePop();
  const el = h('div', { class: 'pop ' + className }, content);
  document.body.append(el);
  const place = () => {
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0 };
    const pw = el.offsetWidth, ph = el.offsetHeight;
    let x = align === 'end' ? r.right - pw : align === 'center' ? r.left + r.width / 2 - pw / 2 : r.left;
    let y = r.bottom + 6;
    if (y + ph > innerHeight - 8) y = Math.max(8, r.top - ph - 6);
    x = Math.max(8, Math.min(x, innerWidth - pw - 8));
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  };
  place();
  const outside = (e) => {
    if (el.contains(e.target) || (anchor.contains && anchor.contains(e.target))) return;
    closePop();
  };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePop(); } };
  openPop = { el, onClose, outside, key, place };
  setTimeout(() => {
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
  });
  return el;
}
export const repositionPop = () => openPop?.place();

// items: [{label, icon, kbd, onClick, danger, on, disabled}] | 'sep' | {title}
export function menu(anchor, items, opts) {
  const list = items.filter(Boolean).map((it) => {
    if (it === 'sep') return h('div', { class: 'menu-sep' });
    if (it.title) return h('div', { class: 'menu-title' }, it.title);
    if (it.node) return it.node;
    return h('button', {
      class: 'menu-item' + (it.danger ? ' danger' : '') + (it.on ? ' on' : ''),
      disabled: it.disabled,
      onclick: () => { closePop(); it.onClick?.(); },
      html: (it.icon ? icon(it.icon) : '') + `<span>${it.label}</span>` + (it.kbd ? `<span class="kbd">${it.kbd}</span>` : ''),
    });
  });
  return popover(anchor, list, opts);
}

export function modal({ title, body, foot, wide = false, onClose }) {
  const back = h('div', { class: 'modal-back' });
  const close = () => { back.remove(); document.removeEventListener('keydown', key, true); onClose?.(); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const m = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog' },
    h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'btn ghost icon-only', html: icon('x'), onclick: close, title: 'Close' })),
    body,
    foot ? h('div', { class: 'modal-foot' }, foot) : null,
  );
  back.append(m);
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', key, true);
  document.body.append(back);
  return { close, el: m };
}

const STD = [
  '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#d9d9d9', '#efefef', '#ffffff',
  '#ff443f', '#ff9a3c', '#ffbb1f', '#1fa73f', '#2dd4bf', '#3b95fd', '#7c5cff', '#ff5ca8',
  '#7f1d1d', '#9a3412', '#854d0e', '#14532d', '#134e4a', '#1e3a8a', '#3b0764', '#831843',
  '#fecaca', '#fed7aa', '#fef08a', '#bbf7d0', '#99f6e4', '#bfdbfe', '#ddd6fe', '#fbcfe8',
];
export const GRADIENTS = [
  'linear-gradient(135deg, #7c9cff, #ff7ac6)',
  'linear-gradient(135deg, #0f2027, #2c5364)',
  'linear-gradient(160deg, #ff9a62, #ff5ca8 60%, #7c5cff)',
  'radial-gradient(circle at 30% 20%, #3b2a8a, #07090f 70%)',
  'linear-gradient(135deg, #f6d365, #fda085)',
  'linear-gradient(180deg, #111318, #2a2f3a)',
];

// Colour picker popover. Value may be a theme token ("accent"), a colour, or a gradient (if allowGradient).
export function colorPicker(anchor, { value, theme, onPick, allowNone = true, allowGradient = false, title }) {
  const tokens = ['text', 'muted', 'bg', 'accent', 'accent2'];
  const hex = /^#[0-9a-f]{6}$/i.test(value || '') ? value : (theme && theme[value]) || '#000000';
  const pick = (v) => { onPick(v); closePop(); };
  const sw = (v, css, label) => h('button', { class: 'swatch' + (value === v ? ' sel' : ''), style: { background: css }, title: label || v, onclick: () => pick(v) });
  const input = h('input', { type: 'text', value: hex, spellcheck: 'false' });
  const native = h('input', { type: 'color', value: hex });
  native.addEventListener('input', () => { input.value = native.value; onPick(native.value); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && /^#?[0-9a-f]{3,8}$/i.test(input.value.trim())) pick(input.value.trim().startsWith('#') ? input.value.trim() : '#' + input.value.trim()); });
  const content = h('div', null,
    title ? h('div', { class: 'pop-label', style: { marginTop: 0 } }, title) : null,
    theme ? h('div', { class: 'pop-label', style: title ? {} : { marginTop: 0 } }, 'Theme') : null,
    theme ? h('div', { class: 'swatches' }, tokens.map((t) => sw(t, theme[t], t)), allowNone ? h('button', { class: 'swatch none' + (!value ? ' sel' : ''), title: 'None', onclick: () => pick(null) }) : null) : null,
    h('div', { class: 'pop-label' }, 'Standard'),
    h('div', { class: 'swatches' }, STD.map((c) => sw(c, c))),
    allowGradient ? h('div', { class: 'pop-label' }, 'Gradients') : null,
    allowGradient ? h('div', { class: 'grad-presets' }, GRADIENTS.map((g) => h('button', { style: { background: g }, onclick: () => pick(g) }))) : null,
    h('div', { class: 'color-row' }, native, input),
  );
  return popover(anchor, content, { className: 'color-pop' });
}

export function field(label, control, hint) {
  return h('div', { class: 'field' }, h('label', null, label), control, hint ? h('div', { class: 'hint' }, hint) : null);
}

// Range/colour/toggle controls for animation params. defs: {name: {type, value, min, max, step, label}}
export function paramControls(defs, onChange) {
  const wrap = h('div');
  for (const k in defs) {
    const d = defs[k];
    if (!d || typeof d !== 'object') continue;
    const label = d.label || k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
    if (d.type === 'color') {
      const inp = h('input', { type: 'color', value: d.value });
      inp.addEventListener('input', () => onChange(k, inp.value, false));
      inp.addEventListener('change', () => onChange(k, inp.value, true));
      wrap.append(h('div', { class: 'field' }, h('div', { class: 'field-label' }, label, inp)));
    } else if (d.type === 'toggle' || typeof d.value === 'boolean') {
      const inp = h('input', { type: 'checkbox' });
      inp.checked = !!d.value;
      inp.addEventListener('change', () => onChange(k, inp.checked, true));
      wrap.append(h('div', { class: 'field' }, h('div', { class: 'field-label' }, label, inp)));
    } else if (d.type === 'select') {
      const sel = h('select', null, (d.options || []).map((o) => h('option', { value: o, selected: o === d.value }, o)));
      sel.addEventListener('change', () => onChange(k, sel.value, true));
      wrap.append(field(label, sel));
    } else {
      const val = h('span', { class: 'val' }, fmt(d.value));
      const inp = h('input', { type: 'range', min: d.min ?? 0, max: d.max ?? 1, step: d.step ?? 0.01, value: d.value });
      inp.addEventListener('input', () => { val.textContent = fmt(+inp.value); onChange(k, +inp.value, false); });
      inp.addEventListener('change', () => onChange(k, +inp.value, true));
      wrap.append(h('div', { class: 'field' }, h('div', { class: 'field-label' }, label, val), inp));
    }
  }
  if (!wrap.children.length) wrap.append(h('div', { class: 'hint', style: { color: 'var(--muted)', fontSize: '12px' } }, 'No adjustable parameters.'));
  return wrap;
}
const fmt = (v) => (Math.abs(v) >= 100 ? Math.round(v) : +(+v).toFixed(2));

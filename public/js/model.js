import { uid, SLIDE_W, SLIDE_H } from './util.js';

export const THEMES = {
  ink: { name: 'Ink', heading: 'Inter Tight', body: 'Inter', bg: '#07090f', text: '#f4f5f8', muted: '#9aa3b5', accent: '#7c9cff', accent2: '#ff7ac6' },
  paper: { name: 'Paper', heading: 'Inter Tight', body: 'Inter', bg: '#ffffff', text: '#111318', muted: '#5f6573', accent: '#3b5bfd', accent2: '#ff5a36' },
  dusk: { name: 'Dusk', heading: 'Space Grotesk', body: 'Inter', bg: '#120d24', text: '#f3eefe', muted: '#a99cc9', accent: '#b69cff', accent2: '#5ce1e6' },
  sand: { name: 'Sand', heading: 'Fraunces', body: 'Inter', bg: '#f4efe6', text: '#1d1a16', muted: '#6e665b', accent: '#c2562f', accent2: '#2f6b5e' },
  mono: { name: 'Mono', heading: 'JetBrains Mono', body: 'Inter', bg: '#0c0c0c', text: '#ededed', muted: '#8a8a8a', accent: '#d7ff3a', accent2: '#ffffff' },
};

export const FONTS = [
  'Inter', 'Inter Tight', 'Space Grotesk', 'Manrope', 'DM Sans', 'Sora', 'Outfit', 'Plus Jakarta Sans',
  'Fraunces', 'Playfair Display', 'DM Serif Display', 'Instrument Serif', 'Libre Baskerville',
  'JetBrains Mono', 'IBM Plex Mono', 'Caveat',
];

export const SHAPES = ['rect', 'round', 'ellipse', 'triangle', 'diamond', 'star', 'arrow', 'line', 'chevron', 'hexagon'];

export const TRANSITIONS = ['none', 'fade', 'slide', 'zoom', 'blur'];
export const ENTRANCES = ['none', 'fade', 'rise', 'zoom', 'blur', 'wipe'];

const textStyle = (over = {}) => ({
  font: 'body', fontSize: 40, color: null, align: 'left', valign: 'top',
  lineHeight: 1.3, fontWeight: 400, letterSpacing: 0, italic: false, underline: false, ...over,
});

export function newElement(type, props = {}) {
  const base = { id: uid('e'), type, x: 660, y: 390, w: 600, h: 300, rot: 0, opacity: 1 };
  switch (type) {
    case 'text':
      return { ...base, w: 800, h: 120, html: '<p>Text</p>', style: textStyle(), ...props };
    case 'shape':
      return { ...base, w: 400, h: 400, shape: 'rect', fill: 'accent', stroke: null, strokeWidth: 0, radius: 24, html: '', style: textStyle({ align: 'center', valign: 'middle' }), ...props };
    case 'image':
      return { ...base, src: '', fit: 'cover', radius: 0, ...props };
    case 'video':
      return { ...base, src: '', fit: 'cover', radius: 0, loop: true, muted: true, ...props };
    case 'table': {
      const r = props.r || 4, c = props.c || 3;
      delete props.r; delete props.c;
      const rows = Array.from({ length: r }, (_, i) => Array.from({ length: c }, (_, j) => (i === 0 ? `<p>Header ${j + 1}</p>` : '<p></p>')));
      return { ...base, x: 360, y: 300, w: 1200, h: 100 * r, rows, header: true, border: null, headerFill: 'accent', stripe: true, style: textStyle({ fontSize: 28 }), ...props };
    }
    case 'anim':
      return { ...base, w: 700, h: 700, x: 610, y: 190, anim: { name: 'Animation', code: '', params: {} }, ...props };
  }
  return { ...base, ...props };
}

export function newSlide(layout = 'title-body', theme = THEMES.ink) {
  const s = { id: uid('s'), bg: { fill: null, image: null, anim: null, dim: 0 }, elements: [], notes: '', transition: 'fade' };
  const T = (props, style) => newElement('text', { ...props, style: textStyle(style) });
  switch (layout) {
    case 'title':
      s.elements.push(
        T({ x: 160, y: 380, w: 1600, h: 200, html: '<p>Presentation title</p>' }, { font: 'heading', fontSize: 120, fontWeight: 700, align: 'center', valign: 'bottom', lineHeight: 1.05, letterSpacing: -2 }),
        T({ x: 360, y: 610, w: 1200, h: 80, html: '<p>Subtitle</p>' }, { fontSize: 40, color: 'muted', align: 'center' }),
      );
      break;
    case 'section':
      s.elements.push(
        T({ x: 160, y: 300, w: 1600, h: 80, html: '<p>01</p>' }, { font: 'heading', fontSize: 48, color: 'accent', fontWeight: 600 }),
        T({ x: 160, y: 390, w: 1600, h: 300, html: '<p>Section title</p>' }, { font: 'heading', fontSize: 140, fontWeight: 700, lineHeight: 1.0, letterSpacing: -3 }),
      );
      break;
    case 'title-body':
      s.elements.push(
        T({ x: 140, y: 110, w: 1640, h: 140, html: '<p>Slide title</p>' }, { font: 'heading', fontSize: 80, fontWeight: 700, lineHeight: 1.05, letterSpacing: -1.5, valign: 'bottom' }),
        T({ x: 140, y: 300, w: 1640, h: 660, html: '<ul><li>First point</li><li>Second point</li><li>Third point</li></ul>' }, { fontSize: 44, color: 'muted', lineHeight: 1.5 }),
      );
      break;
    case 'two-col':
      s.elements.push(
        T({ x: 140, y: 110, w: 1640, h: 140, html: '<p>Comparison</p>' }, { font: 'heading', fontSize: 80, fontWeight: 700, lineHeight: 1.05, letterSpacing: -1.5, valign: 'bottom' }),
        T({ x: 140, y: 310, w: 780, h: 640, html: '<p><b>Left</b></p><p>Supporting detail goes here.</p>' }, { fontSize: 40, color: 'muted', lineHeight: 1.45 }),
        T({ x: 1000, y: 310, w: 780, h: 640, html: '<p><b>Right</b></p><p>Supporting detail goes here.</p>' }, { fontSize: 40, color: 'muted', lineHeight: 1.45 }),
      );
      break;
    case 'statement':
      s.elements.push(
        T({ x: 200, y: 290, w: 1520, h: 500, html: '<p>One big idea, said plainly.</p>' }, { font: 'heading', fontSize: 110, fontWeight: 600, align: 'center', valign: 'middle', lineHeight: 1.1, letterSpacing: -2 }),
      );
      break;
  }
  return s;
}

export const LAYOUTS = [
  ['title', 'Title'], ['title-body', 'Title & body'], ['section', 'Section'],
  ['two-col', 'Two columns'], ['statement', 'Statement'], ['blank', 'Blank'],
];

export function newDeck(title = 'Untitled deck', themeKey = 'ink') {
  const theme = { ...THEMES[themeKey] };
  return {
    id: uid('d'), v: 1, title, theme, created: Date.now(), updated: Date.now(),
    slides: [newSlide('title', theme)],
  };
}

// Resolve theme tokens ("accent", "text", "muted", "bg", "accent2") to colors.
export function color(v, theme, fallback) {
  if (v == null || v === '') return fallback;
  return theme[v] && typeof theme[v] === 'string' && v !== 'name' && v !== 'heading' && v !== 'body' ? theme[v] : v;
}

export function fontFor(font, theme) {
  if (!font || font === 'body') return theme.body;
  if (font === 'heading') return theme.heading;
  return font;
}

export function fontsUsed(deck) {
  const set = new Set([deck.theme.heading, deck.theme.body]);
  const scan = (html) => { for (const m of (html || '').matchAll(/font-family:\s*&quot;([^&]+)&quot;|font-family:\s*"?([^;"']+)/g)) set.add((m[1] || m[2]).trim()); };
  for (const s of deck.slides) for (const e of s.elements) {
    if (e.style?.font && !['body', 'heading'].includes(e.style.font)) set.add(e.style.font);
    scan(e.html);
  }
  return [...set].filter((f) => FONTS.includes(f));
}

export { SLIDE_W, SLIDE_H };

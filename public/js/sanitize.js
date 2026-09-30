// HTML sanitiser for rich text coming from the AI or imported files (rendered via innerHTML in our origin).
const TAGS = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'SPAN', 'A', 'UL', 'OL', 'LI', 'CODE', 'SUB', 'SUP', 'H1', 'H2', 'H3', 'BLOCKQUOTE', 'FONT', 'DIV', 'MARK', 'SMALL']);
const STYLE_OK = /^(color|background-color|font-size|font-weight|font-style|font-family|text-decoration(-line)?|letter-spacing|line-height|opacity|text-transform|vertical-align)$/i;

export function sanitizeHTML(html) {
  if (typeof html !== 'string') return '<p></p>';
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) continue;
      if (child.nodeType !== 1 || !TAGS.has(child.tagName)) {
        if (child.nodeType === 1 && !['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE'].includes(child.tagName)) {
          walk(child);
          child.replaceWith(...child.childNodes);
        } else child.remove();
        continue;
      }
      for (const a of [...child.attributes]) {
        const n = a.name.toLowerCase();
        if (n === 'style') {
          const kept = [];
          for (const decl of a.value.split(';')) {
            const [p, ...rest] = decl.split(':');
            const v = rest.join(':').trim();
            if (p && STYLE_OK.test(p.trim()) && !/url\(|expression|javascript:/i.test(v)) kept.push(`${p.trim()}: ${v}`);
          }
          kept.length ? child.setAttribute('style', kept.join('; ')) : child.removeAttribute('style');
        } else if (n === 'href' && child.tagName === 'A') {
          if (!/^(https?:|mailto:|#)/i.test(a.value.trim())) child.removeAttribute('href');
          else { child.setAttribute('target', '_blank'); child.setAttribute('rel', 'noopener noreferrer'); }
        } else if (!(child.tagName === 'FONT' && (n === 'color' || n === 'face' || n === 'size')) && n !== 'target' && n !== 'rel') {
          child.removeAttribute(a.name);
        }
      }
      walk(child);
    }
  };
  walk(tpl.content);
  const out = tpl.innerHTML.trim();
  return out || '<p></p>';
}

// Sanitize every rich-text field in a deck (used for imports).
export function sanitizeDeck(deck) {
  for (const s of deck.slides || []) {
    for (const e of s.elements || []) {
      if (typeof e.html === 'string') e.html = sanitizeHTML(e.html);
      if (Array.isArray(e.rows)) e.rows = e.rows.map((r) => r.map((c) => sanitizeHTML(String(c))));
      for (const k of ['src']) if (typeof e[k] === 'string' && /^\s*javascript:/i.test(e[k])) e[k] = '';
    }
  }
  return deck;
}

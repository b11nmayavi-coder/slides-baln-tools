import { store } from './store.js';
import { db, useRemoteStorage, migrateLocalToServer } from './db.js';
import { Editor } from './editor.js';
import { Toolbar, pickFile } from './toolbar.js';
import { Filmstrip } from './filmstrip.js';
import { Presenter } from './present.js';
import { AnimPanel } from './animpanel.js';
import { Assistant } from './ai.js';
import { SlideView, invalidateAll } from './render.js';
import { checkServer, server, pref, setPref } from './settings.js';
import { openSettings, applyUITheme } from './settingsModal.js';
import { newDeck, newSlide, newElement } from './model.js';
import { PRESETS } from './anim/presets.js';
import { h, mod, download, toast, clone, uid, isMac } from './util.js';
import { icon } from './icons.js';
import { menu, popover, closePop } from './ui.js';
import { onMediaReady, inlineLocalMedia, importInlineMedia, putMedia } from './media.js';
import { sanitizeDeck } from './sanitize.js';
import { fillMissingPosters } from './posters.js';

applyUITheme();
const $ = (id) => document.getElementById(id);

const editor = new Editor($('stageWrap'), $('stageFrame'));
const toolbar = new Toolbar($('toolbar'), editor);
new Filmstrip($('filmstrip'));
new Presenter($('present'));
new AnimPanel(editor);
const assistant = new Assistant($('assistant'), editor);
window.slides = { store, editor, assistant }; // handy for debugging from the console

// ---------- top bar ----------
$('toggleFilmstrip').innerHTML = icon('panelLeft');
$('toggleAssistant').innerHTML = icon('sparkles');
$('presentBtn').innerHTML = icon('play', 14) + '<span>Present</span>';
$('presentMenuBtn').innerHTML = icon('chevron', 14);
$('presentBtn').onclick = () => store.emit('present', store.index);
$('presentMenuBtn').onclick = () => menu($('presentMenuBtn'), [
  { label: 'From current slide', icon: 'play', kbd: isMac ? '⌘ ↵' : 'Ctrl ↵', onClick: () => store.emit('present', store.index) },
  { label: 'From beginning', icon: 'play', kbd: isMac ? '⌘ ⇧ ↵' : 'Ctrl ⇧ ↵', onClick: () => store.emit('present', 0) },
], { align: 'end' });

const ws = $('workspace');
function setPanes() {
  ws.classList.toggle('no-film', !pref('film', true));
  ws.classList.toggle('no-ai', !pref('ai', true));
  $('toggleFilmstrip').classList.toggle('on', pref('film', true));
  $('toggleAssistant').classList.toggle('on', pref('ai', true));
  ws.style.setProperty('--ai-w', pref('aiW', 380) + 'px');
}
$('toggleFilmstrip').onclick = () => { setPref('film', !pref('film', true)); setPanes(); };
$('toggleAssistant').onclick = () => {
  if (innerWidth <= 760) { ws.classList.toggle('mobile-ai'); return; }
  setPref('ai', !pref('ai', true)); setPanes();
};
store.on('show-ai', () => { if (innerWidth <= 760) ws.classList.add('mobile-ai'); else if (!pref('ai', true)) { setPref('ai', true); setPanes(); } });
setPanes();

// Resizable assistant pane
$('assistantResizer').addEventListener('pointerdown', (e) => {
  const r = $('assistantResizer');
  r.classList.add('drag');
  r.setPointerCapture(e.pointerId);
  const move = (ev) => { const w = Math.max(300, Math.min(720, innerWidth - ev.clientX)); ws.style.setProperty('--ai-w', w + 'px'); };
  const up = (ev) => { r.classList.remove('drag'); r.removeEventListener('pointermove', move); r.removeEventListener('pointerup', up); setPref('aiW', Math.max(300, Math.min(720, innerWidth - ev.clientX))); };
  r.addEventListener('pointermove', move);
  r.addEventListener('pointerup', up);
});

const titleIn = $('deckTitle');
titleIn.addEventListener('change', () => store.commit('Rename deck', (d) => { d.title = titleIn.value.trim() || 'Untitled deck'; }));
titleIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') titleIn.blur(); e.stopPropagation(); });
const syncTitle = () => { if (document.activeElement !== titleIn) titleIn.value = store.deck.title; document.title = store.deck.title + ' · Slides'; };
store.on('deck', syncTitle);
store.on('deck-title', syncTitle);
store.on('change', syncTitle);

// Save indicator
store.on('change', (k) => {
  if (k === 'live') return;
  $('saveState').textContent = 'Saving…';
});
store.on('saved', (ok, err) => {
  $('saveState').textContent = ok ? (server.storage ? `Saved to ${server.storage === 'sqlite' ? 'SQLite' : 'Firebase'}` : 'Saved') : 'Not saved';
  $('saveState').title = ok ? '' : String(err?.message || err || '');
  if (!ok) toast('Could not save: ' + (err?.message || err));
});

// Notes
const notes = $('notes');
const syncNotes = () => { if (document.activeElement !== notes) notes.value = store.slide?.notes || ''; };
store.on('slide', syncNotes); store.on('deck', syncNotes); store.on('change', syncNotes);
notes.addEventListener('input', () => { const s = store.slide; store.commit('Notes', () => { s.notes = notes.value; }, { coalesce: 'notes' }); });
notes.addEventListener('keydown', (e) => e.stopPropagation());

// ---------- deck menu ----------
$('deckMenuBtn').onclick = async () => {
  const decks = await store.list();
  const list = h('div', { class: 'deck-list' }, decks.slice(0, 20).map((d) => h('button', {
    class: 'menu-item' + (d.id === store.deck.id ? ' on' : ''),
    onclick: async () => { closePop(); if (d.id !== store.deck.id) await openDeck(d.id); },
  }, h('span', null, d.title), h('small', null, `${d.slides} · ${ago(d.updated)}`))));
  menu($('deckMenuBtn'), [
    { label: 'New deck', icon: 'plus', onClick: async () => { await store.create('Untitled deck', 'ink'); } },
    { label: 'Duplicate deck', icon: 'copy', onClick: async () => { const d = clone(store.deck); d.id = uid('d'); d.title += ' (copy)'; d.updated = Date.now(); await db.put('decks', d.id, d); await store.open(d); } },
    'sep',
    { label: 'Import deck (.json)…', icon: 'upload', onClick: () => pickFile('.json,application/json', importDeck) },
    { label: 'Export deck (.json)', icon: 'download', onClick: exportDeck },
    { label: 'Print / save as PDF', icon: 'printer', kbd: isMac ? '⌘ P' : 'Ctrl P', onClick: printDeck },
    'sep',
    { label: 'Settings', icon: 'settings', onClick: () => openSettings(() => assistant.updateNote()) },
    { label: 'Keyboard shortcuts', icon: 'more', onClick: shortcuts },
    'sep',
    { title: 'Recent decks' },
    { node: list },
    'sep',
    { label: 'Delete this deck', icon: 'trash', danger: true, onClick: deleteDeck },
  ]);
};

function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
}

async function openDeck(id) {
  const d = await db.get('decks', id);
  if (d) await store.open(d);
}

async function deleteDeck() {
  const decks = await store.list();
  if (!confirm(`Delete “${store.deck.title}”? This cannot be undone.`)) return;
  const id = store.deck.id;
  await db.del('decks', id);
  await db.del('chats', id);
  store.deck = null;
  const next = decks.find((d) => d.id !== id);
  if (next) await openDeck(next.id); else await store.open(starterDeck());
}

async function exportDeck() {
  await store.persist();
  const json = JSON.stringify(store.deck);
  const media = await inlineLocalMedia(json);
  const blob = new Blob([JSON.stringify({ format: 'slides.baln.tools', version: 1, deck: store.deck, media })], { type: 'application/json' });
  download((store.deck.title || 'deck').replace(/[^\w\- ]+/g, '').trim() + '.slides.json', blob);
}

async function importDeck(file) {
  try {
    const data = JSON.parse(await file.text());
    const deck = data.deck || data;
    if (!Array.isArray(deck.slides)) throw new Error('Not a deck file');
    await importInlineMedia(data.media);
    sanitizeDeck(deck);
    deck.id = uid('d');
    deck.updated = Date.now();
    await db.put('decks', deck.id, deck);
    await store.open(deck);
    toast('Imported “' + deck.title + '”');
  } catch (e) {
    toast('Import failed: ' + e.message);
  }
}

function printDeck() {
  const root = $('print');
  root.replaceChildren();
  const views = store.deck.slides.map((s) => {
    const page = h('div', { class: 'print-page' });
    const slideEl = h('div');
    page.append(slideEl);
    root.append(page);
    const v = new SlideView(slideEl, { mode: 'print' });
    v.render(s, store.deck);
    return v;
  });
  setTimeout(() => {
    window.print();
    views.forEach((v) => v.destroy());
    root.replaceChildren();
  }, 400);
}

function shortcuts() {
  const k = isMac ? '⌘' : 'Ctrl';
  const rows = [
    ['Present', `${k} Enter`], ['Undo / Redo', `${k} Z / ${k} ⇧ Z`], ['Duplicate', `${k} D`], ['Copy / Paste', `${k} C / ${k} V`],
    ['Select all', `${k} A`], ['Nudge', 'Arrows (⇧ ×10)'], ['Edit text', 'Enter or double-click'], ['Stop editing', 'Esc'],
    ['Constrain move / snap angle', '⇧ while dragging'], ['Disable snapping', 'Alt while dragging'], ['New slide', `${k} M`],
    ['Next / previous slide', 'PageDown / PageUp'], ['Ask the assistant', `${k} /`], ['While presenting', '→ ← Space · B black · N notes · Esc'],
  ];
  popover($('deckMenuBtn'), h('div', { style: { padding: '8px', display: 'grid', gridTemplateColumns: 'auto auto', gap: '6px 18px', fontSize: '12.5px' } },
    rows.flatMap(([a, b]) => [h('span', { style: { color: 'var(--text-2)' } }, a), h('kbd', null, b)])));
}

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (!$('present').hidden) return;
  const t = e.target;
  const typing = t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
  const k = e.key.toLowerCase();
  if (mod(e) && k === 'enter') { e.preventDefault(); store.emit('present', e.shiftKey ? 0 : store.index); return; }
  if (mod(e) && k === '/') { e.preventDefault(); store.emit('focus-ai'); return; }
  if (mod(e) && k === 'p') { e.preventDefault(); printDeck(); return; }
  if (mod(e) && k === 's') { e.preventDefault(); store.persist(); toast('Saved'); return; }
  if (store.editingId) { editor.onKey(e); return; }
  if (typing) return;
  if (mod(e) && k === 'z') { e.preventDefault(); e.shiftKey ? store.redo() : store.undo(); return; }
  if (mod(e) && k === 'y') { e.preventDefault(); store.redo(); return; }
  if (mod(e) && k === 'm') { e.preventDefault(); const s = newSlide('title-body', store.deck.theme); if (store.slide.bg) s.bg = clone(store.slide.bg); store.commit('New slide', (d) => d.slides.splice(store.index + 1, 0, s)); store.go(store.index + 1); return; }
  if (e.key === 'PageDown') { e.preventDefault(); store.go(store.index + 1); return; }
  if (e.key === 'PageUp') { e.preventDefault(); store.go(store.index - 1); return; }
  if (editor.onKey(e)) return;
  if (!store.selection.length && (e.key === 'ArrowDown' || e.key === 'ArrowRight')) { e.preventDefault(); store.go(store.index + 1); }
  if (!store.selection.length && (e.key === 'ArrowUp' || e.key === 'ArrowLeft')) { e.preventDefault(); store.go(store.index - 1); }
});

document.addEventListener('paste', (e) => {
  const t = e.target;
  if (!$('present').hidden || store.editingId || t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName)) return;
  editor.onPaste(e);
});

// Replace media on an image/video element
store.on('replace-media', (id) => pickFile('image/*,video/*', async (f) => {
  const el = store.el(id);
  if (!el) return;
  const src = await putMedia(f);
  store.commit('Replace media', () => { el.src = src; el.type = f.type.startsWith('video/') ? 'video' : 'image'; });
}));

store.on('deck', () => setTimeout(fillMissingPosters, 1500));
store.on('change', (k) => { if (k !== 'live') { clearTimeout(window.__posterT); window.__posterT = setTimeout(fillMissingPosters, 3000); } });

onMediaReady(() => { invalidateAll(); store.emit('change', 'history'); });
window.addEventListener('beforeunload', () => { store.persist(); });

// ---------- starter deck ----------
function starterDeck() {
  const d = newDeck('Welcome to Slides', 'ink');
  const gl = (() => { try { return !!new OffscreenCanvas(4, 4).getContext('webgl2'); } catch { return false; } })();
  const aurora = PRESETS.find((p) => p.id === (gl ? 'aurora' : 'dotgrid'));
  const orb = PRESETS.find((p) => p.id === 'orb');
  const bgAnim = { name: aurora.name, code: aurora.code, params: clone(aurora.params) };
  const s1 = d.slides[0];
  s1.bg = { fill: null, image: null, anim: bgAnim, dim: 0 };
  s1.elements[0].html = '<p>Motion, written as code</p>';
  s1.elements[1].html = '<p>Describe an animation. The assistant writes it, runs it, and refines it.</p>';
  s1.elements[0].enter = { effect: 'rise', delay: 0 };
  s1.elements[1].enter = { effect: 'fade', delay: 0.25 };

  const s2 = newSlide('blank', d.theme);
  s2.elements.push(
    newElement('text', { x: 140, y: 250, w: 820, h: 240, html: '<p>Lighter than video.<br>Sharper at any size.</p>', style: { font: 'heading', fontSize: 84, fontWeight: 700, lineHeight: 1.05, letterSpacing: -2, color: null, align: 'left', valign: 'bottom' }, enter: { effect: 'rise', delay: 0 } }),
    newElement('text', { x: 140, y: 530, w: 760, h: 300, html: '<ul><li>Runs in a Web Worker, off the main thread</li><li>Pauses itself when it’s off-screen</li><li>Every look has live parameters you can tweak</li></ul>', style: { font: 'body', fontSize: 38, color: 'muted', lineHeight: 1.5, align: 'left', valign: 'top' }, enter: { effect: 'fade', delay: 0.2 } }),
    newElement('anim', { x: 1020, y: 140, w: 800, h: 800, anim: { name: orb.name, code: orb.code, params: clone(orb.params) } }),
  );
  s2.transition = 'fade';

  const s3 = newSlide('statement', d.theme);
  const mesh = PRESETS.find((p) => p.id === (gl ? 'mesh' : 'flow'));
  s3.bg = { fill: null, image: null, anim: { name: mesh.name, code: mesh.code, params: clone(mesh.params) }, dim: 0.15 };
  s3.elements[0].html = '<p>Try: “make the background feel like dusk over water”.</p>';
  d.slides.push(s2, s3);
  return d;
}

// ---------- boot ----------
(async () => {
  await checkServer();
  assistant.updateNote();
  if (server.storage) {
    useRemoteStorage(true);
    try {
      const n = await migrateLocalToServer();
      if (n) toast(`Moved ${n} deck${n > 1 ? 's' : ''} from this browser to ${server.storage === 'sqlite' ? 'SQLite' : 'Firebase'}`);
    } catch (err) {
      // Most likely the access token is missing: fall back to browser storage for this session.
      console.warn(err);
      useRemoteStorage(false);
      toast('Server storage unavailable (' + err.message + '). Using this browser for now.', 5000);
    }
  }
  const last = pref('lastDeck', null);
  let deck = last ? await db.get('decks', last) : null;
  if (!deck) {
    const all = await store.list();
    if (all.length) deck = await db.get('decks', all[0].id);
  }
  if (!deck) { deck = starterDeck(); await db.put('decks', deck.id, deck); }
  await store.open(deck);
  $('stageWrap').tabIndex = -1;
})();

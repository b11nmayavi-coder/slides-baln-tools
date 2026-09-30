// App state: the open deck, current slide, selection, undo history and persistence.
import { db } from './db.js';
import { clone, debounce } from './util.js';
import { newDeck } from './model.js';
import { setPref } from './settings.js';

const listeners = new Map();
const HISTORY_MAX = 150;

export const store = {
  deck: null,
  index: 0,
  selection: [],        // element ids on current slide
  editingId: null,      // element whose text is being edited
  past: [],
  future: [],
  _coalesce: null,
  _coalesceAt: 0,

  on(evt, fn) { (listeners.get(evt) || listeners.set(evt, new Set()).get(evt)).add(fn); },
  emit(evt, ...data) { listeners.get(evt)?.forEach((fn) => fn(...data)); },

  get slide() { return this.deck.slides[this.index]; },
  el(id, slide = this.slide) { return slide?.elements.find((e) => e.id === id); },
  get selected() { return this.selection.map((id) => this.el(id)).filter(Boolean); },

  snapshot() { return { slides: clone(this.deck.slides), theme: clone(this.deck.theme), title: this.deck.title, index: this.index }; },
  restore(s) {
    this.deck.slides = s.slides; this.deck.theme = s.theme; this.deck.title = s.title;
    this.index = Math.min(s.index, this.deck.slides.length - 1);
    this.selection = this.selection.filter((id) => this.el(id));
    this.editingId = null;
  },

  // Mutate the deck with one undoable step. `coalesce` merges rapid edits with the same key.
  commit(label, fn, { coalesce = null } = {}) {
    const now = performance.now();
    const merge = coalesce && this._coalesce === coalesce && now - this._coalesceAt < 1200;
    if (!merge) {
      this.past.push({ label, state: this.snapshot() });
      if (this.past.length > HISTORY_MAX) this.past.shift();
      this.future = [];
    }
    this._coalesce = coalesce;
    this._coalesceAt = now;
    fn(this.deck);
    this.index = Math.max(0, Math.min(this.index, this.deck.slides.length - 1));
    this.changed();
  },
  // Begin a gesture (drag/resize): capture state once, mutate freely, then `endGesture`.
  beginGesture(label) { this._gesture = { label, state: this.snapshot() }; this._coalesce = null; },
  endGesture(changed = true) {
    if (this._gesture && changed) {
      this.past.push(this._gesture);
      if (this.past.length > HISTORY_MAX) this.past.shift();
      this.future = [];
      this.changed();
    }
    this._gesture = null;
  },
  undo() {
    const step = this.past.pop();
    if (!step) return;
    this.future.push({ label: step.label, state: this.snapshot() });
    this.restore(step.state);
    this._coalesce = null;
    this.changed('history');
  },
  redo() {
    const step = this.future.pop();
    if (!step) return;
    this.past.push({ label: step.label, state: this.snapshot() });
    this.restore(step.state);
    this._coalesce = null;
    this.changed('history');
  },

  changed(kind = 'edit') {
    this.deck.updated = Date.now();
    this.emit('change', kind);
    this.save();
  },
  // Visual-only update during a gesture (no save/history).
  live() { this.emit('change', 'live'); },

  go(i) {
    i = Math.max(0, Math.min(i, this.deck.slides.length - 1));
    if (i === this.index) return;
    this.stopEditing();
    this.index = i;
    this.selection = [];
    this.emit('slide');
  },
  select(ids) {
    if (this.editingId && !ids.includes(this.editingId)) this.stopEditing();
    this.selection = ids;
    this.emit('selection');
  },
  startEditing(id) { this.editingId = id; this.selection = [id]; this.emit('selection'); },
  stopEditing() {
    if (!this.editingId) return;
    const id = this.editingId;
    this.editingId = null;
    this.emit('stop-editing', id);
    this.emit('selection');
  },

  save: debounce(function () { store.persist(); }, 500),
  async persist() {
    if (!this.deck) return;
    try {
      await db.put('decks', this.deck.id, this.deck);
      setPref('lastDeck', this.deck.id);
      this.emit('saved', true);
    } catch (err) {
      console.error(err);
      this.emit('saved', false, err);
    }
  },

  async open(deck) {
    if (this.deck) await this.persist();
    this.deck = deck;
    this.index = 0;
    this.selection = [];
    this.editingId = null;
    this.past = [];
    this.future = [];
    setPref('lastDeck', deck.id);
    this.emit('deck');
  },
  async create(title, theme) {
    const d = newDeck(title, theme);
    await db.put('decks', d.id, d);
    await this.open(d);
    return d;
  },
  list() { return db.listDecks(); },
};

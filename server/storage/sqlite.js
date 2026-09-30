// SQLite backend (Node's built-in node:sqlite). One file holds decks, chats and uploaded media.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function createSqlite(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS media (
      key     TEXT PRIMARY KEY,
      type    TEXT NOT NULL,
      size    INTEGER NOT NULL,
      data    BLOB NOT NULL,
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decks (
      id      TEXT PRIMARY KEY,
      title   TEXT NOT NULL,
      updated INTEGER NOT NULL,
      slides  INTEGER NOT NULL,
      data    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chats (
      id      TEXT PRIMARY KEY,
      updated INTEGER NOT NULL,
      data    TEXT NOT NULL
    );
  `);

  const q = {
    mediaHead: db.prepare('SELECT type, size FROM media WHERE key = ?'),
    mediaAll: db.prepare('SELECT data FROM media WHERE key = ?'),
    mediaPart: db.prepare('SELECT substr(data, ?, ?) AS data FROM media WHERE key = ?'), // 1-based offset
    mediaPut: db.prepare('INSERT OR IGNORE INTO media (key, type, size, data, created) VALUES (?, ?, ?, ?, ?)'),
    deckList: db.prepare('SELECT id, title, updated, slides FROM decks ORDER BY updated DESC'),
    deckGet: db.prepare('SELECT data FROM decks WHERE id = ?'),
    deckPut: db.prepare(`INSERT INTO decks (id, title, updated, slides, data) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated = excluded.updated, slides = excluded.slides, data = excluded.data`),
    deckDel: db.prepare('DELETE FROM decks WHERE id = ?'),
    chatGet: db.prepare('SELECT data FROM chats WHERE id = ?'),
    chatPut: db.prepare(`INSERT INTO chats (id, updated, data) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated = excluded.updated, data = excluded.data`),
    chatDel: db.prepare('DELETE FROM chats WHERE id = ?'),
  };

  const media = {
    head(key) {
      const r = q.mediaHead.get(key);
      return r ? { size: r.size, type: r.type, etag: `"${key.split('.')[0]}"` } : null;
    },
    get(key, range) {
      const r = range ? q.mediaPart.get(range.offset + 1, range.length, key) : q.mediaAll.get(key);
      return r ? new Uint8Array(r.data) : null;
    },
    put(key, bytes, type) {
      q.mediaPut.run(key, type, bytes.byteLength, new Uint8Array(bytes), Date.now());
    },
  };

  const store = {
    name: 'sqlite',
    listDecks: () => q.deckList.all().map((r) => ({ id: r.id, title: r.title, updated: r.updated, slides: r.slides })),
    getDeck(id) { const r = q.deckGet.get(id); return r ? JSON.parse(r.data) : null; },
    putDeck(id, deck) { q.deckPut.run(id, String(deck.title || 'Untitled'), Number(deck.updated) || Date.now(), deck.slides.length, JSON.stringify(deck)); },
    deleteDeck(id) { q.deckDel.run(id); q.chatDel.run(id); },
    getChat(id) { const r = q.chatGet.get(id); return r ? JSON.parse(r.data) : null; },
    putChat(id, chat) { q.chatPut.run(id, Date.now(), JSON.stringify(chat)); },
    deleteChat(id) { q.chatDel.run(id); },
  };

  return { media, store, describe: `SQLite ${file}`, close: () => db.close() };
}

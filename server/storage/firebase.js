// Firebase backend: Firestore holds the deck index, Cloud Storage holds deck/chat JSON and media files.
// (Deck JSON can exceed Firestore's 1 MiB document limit once it carries images, so it lives in Storage.)
//
// Credentials, in order of preference:
//   FIREBASE_SERVICE_ACCOUNT=/path/to/service-account.json
//   FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
//   Application Default Credentials (gcloud auth application-default login / GOOGLE_APPLICATION_CREDENTIALS)
// FIREBASE_STORAGE_BUCKET defaults to <project-id>.firebasestorage.app.
import fs from 'node:fs';
import { Readable } from 'node:stream';

const PREFIX = 'slides';
const COLLECTION = 'slides_decks';

export async function createFirebase(env) {
  let admin;
  try {
    admin = {
      app: await import('firebase-admin/app'),
      firestore: await import('firebase-admin/firestore'),
      storage: await import('firebase-admin/storage'),
    };
  } catch {
    throw new Error('firebase-admin is not installed. Run: npm install firebase-admin');
  }

  let credential, projectId = env.FIREBASE_PROJECT_ID;
  if (env.FIREBASE_SERVICE_ACCOUNT) {
    const sa = JSON.parse(fs.readFileSync(env.FIREBASE_SERVICE_ACCOUNT, 'utf8'));
    credential = admin.app.cert(sa);
    projectId = projectId || sa.project_id;
  } else if (env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
    credential = admin.app.cert({
      projectId: env.FIREBASE_PROJECT_ID,
      clientEmail: env.FIREBASE_CLIENT_EMAIL,
      privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    });
  } else {
    credential = admin.app.applicationDefault();
  }
  const bucketName = env.FIREBASE_STORAGE_BUCKET || (projectId && `${projectId}.firebasestorage.app`);
  if (!bucketName) throw new Error('Set FIREBASE_STORAGE_BUCKET (or FIREBASE_PROJECT_ID).');

  const app = admin.app.getApps().find((a) => a.name === 'slides')
    || admin.app.initializeApp({ credential, projectId, storageBucket: bucketName }, 'slides');
  const firestore = admin.firestore.getFirestore(app);
  const bucket = admin.storage.getStorage(app).bucket(bucketName);
  const decksCol = firestore.collection(COLLECTION);

  const notFound = (err) => err?.code === 404 || err?.code === 5 || /No such object/i.test(err?.message || '');
  async function readJSON(name) {
    try {
      const [buf] = await bucket.file(name).download();
      return JSON.parse(buf.toString('utf8'));
    } catch (err) {
      if (notFound(err)) return null;
      throw err;
    }
  }
  const writeJSON = (name, v) => bucket.file(name).save(JSON.stringify(v), { contentType: 'application/json', resumable: false });
  async function remove(name) {
    try { await bucket.file(name).delete(); } catch (err) { if (!notFound(err)) throw err; }
  }

  const media = {
    async head(key) {
      try {
        const [m] = await bucket.file(`${PREFIX}/media/${key}`).getMetadata();
        return { size: Number(m.size), type: m.contentType || 'application/octet-stream', etag: `"${m.md5Hash || key}"` };
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
    },
    async get(key, range) {
      const opts = range ? { start: range.offset, end: range.offset + range.length - 1 } : {};
      return Readable.toWeb(bucket.file(`${PREFIX}/media/${key}`).createReadStream(opts));
    },
    async put(key, bytes, type) {
      await bucket.file(`${PREFIX}/media/${key}`).save(Buffer.from(bytes), {
        contentType: type,
        resumable: false,
        metadata: { cacheControl: 'public, max-age=31536000, immutable' },
      });
    },
  };

  const store = {
    name: 'firebase',
    async listDecks() {
      const snap = await decksCol.orderBy('updated', 'desc').get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    getDeck: (id) => readJSON(`${PREFIX}/decks/${id}.json`),
    async putDeck(id, deck) {
      await writeJSON(`${PREFIX}/decks/${id}.json`, deck);
      await decksCol.doc(id).set({ title: String(deck.title || 'Untitled'), updated: Number(deck.updated) || Date.now(), slides: deck.slides.length });
    },
    async deleteDeck(id) {
      await Promise.all([remove(`${PREFIX}/decks/${id}.json`), remove(`${PREFIX}/chats/${id}.json`), decksCol.doc(id).delete()]);
    },
    getChat: (id) => readJSON(`${PREFIX}/chats/${id}.json`),
    putChat: (id, chat) => writeJSON(`${PREFIX}/chats/${id}.json`, chat),
    deleteChat: (id) => remove(`${PREFIX}/chats/${id}.json`),
  };

  // Fail fast with a clear message if the bucket or credentials are wrong.
  const [exists] = await bucket.exists();
  if (!exists) throw new Error(`Cloud Storage bucket "${bucketName}" not found. Enable Storage in the Firebase console, or set FIREBASE_STORAGE_BUCKET.`);

  return { media, store, describe: `Firebase project ${projectId || '(default)'} · bucket ${bucketName}`, close: () => {} };
}

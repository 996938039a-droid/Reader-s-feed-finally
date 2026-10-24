// Everything the app keeps on this device (IndexedDB): the library list, saved articles,
// highlights, reading positions, and changes waiting to be sent.
const DB_NAME = 'reading-library';
let dbp;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('meta');
        db.createObjectStore('articles', { keyPath: 'id' });
        db.createObjectStore('content', { keyPath: 'id' });
        db.createObjectStore('progress', { keyPath: 'id' });
        const h = db.createObjectStore('highlights', { keyPath: 'id' });
        h.createIndex('article_id', 'article_id');
        db.createObjectStore('outbox', { keyPath: 'key', autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    let out;
    Promise.resolve(fn(tx.objectStore(store), tx)).then((v) => { out = v; }, reject);
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const store = {
  get: (s, k) => run(s, 'readonly', (o) => wrap(o.get(k))),
  all: (s) => run(s, 'readonly', (o) => wrap(o.getAll())),
  put: (s, v, k) => run(s, 'readwrite', (o) => wrap(k === undefined ? o.put(v) : o.put(v, k))),
  del: (s, k) => run(s, 'readwrite', (o) => wrap(o.delete(k))),
  clear: (s) => run(s, 'readwrite', (o) => wrap(o.clear())),
  putMany: (s, list) => run(s, 'readwrite', (o) => { list.forEach((v) => o.put(v)); }),
  replaceAll: (s, list) => run(s, 'readwrite', (o) => { o.clear(); list.forEach((v) => o.put(v)); }),
  byIndex: (s, idx, key) => run(s, 'readonly', (o) => wrap(o.index(idx).getAll(key))),
};

export async function getMeta(k, fallback) {
  try { const v = await store.get('meta', k); return v === undefined ? fallback : v; } catch { return fallback; }
}
export const setMeta = (k, v) => store.put('meta', v, k).catch(() => {});

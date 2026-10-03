// Tiny IndexedDB wrapper shared by the service worker, offscreen page and dashboard.
// Stores:
//   sessions  { id, domain, url, title, startedAt, endedAt|null, open?:1 }
//   frames    { id, sessionId, ts, faceFound, score, box, expressions, mood, dominant, thumb:Blob|null, inferMs,
//               screen:Blob|null, pageUrl, pageTitle }   (screen fields are filled in by the worker)
//   activity  { id, sessionId, ts, scrollPx, clicks, keys }
const DB_NAME = 'doomscroll-happiness-monitor';
const DB_VERSION = 1;
let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('startedAt', 'startedAt');
        s.createIndex('open', 'open');
      }
      if (!db.objectStoreNames.contains('frames')) {
        const f = db.createObjectStore('frames', { keyPath: 'id', autoIncrement: true });
        f.createIndex('sessionId', 'sessionId');
        f.createIndex('ts', 'ts');
      }
      if (!db.objectStoreNames.contains('activity')) {
        const a = db.createObjectStore('activity', { keyPath: 'id', autoIncrement: true });
        a.createIndex('sessionId', 'sessionId');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(store, mode, fn) {
  const db = await openDB();
  const tx = db.transaction(store, mode);
  const result = await fn(tx.objectStore(store));
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return result;
}

export const put = (store, value) => withStore(store, 'readwrite', (s) => reqToPromise(s.put(value)));
export const add = (store, value) => withStore(store, 'readwrite', (s) => reqToPromise(s.add(value)));
export const get = (store, key) => withStore(store, 'readonly', (s) => reqToPromise(s.get(key)));
export const getAll = (store, query, count) => withStore(store, 'readonly', (s) => reqToPromise(s.getAll(query, count)));
export const getAllByIndex = (store, index, query, count) =>
  withStore(store, 'readonly', (s) => reqToPromise(s.index(index).getAll(query, count)));
export const countByIndex = (store, index, query) =>
  withStore(store, 'readonly', (s) => reqToPromise(s.index(index).count(query)));
export const update = (store, key, patch) =>
  withStore(store, 'readwrite', async (s) => {
    const cur = await reqToPromise(s.get(key));
    if (!cur) return false;
    await reqToPromise(s.put({ ...cur, ...patch }));
    return true;
  });
export const del = (store, key) => withStore(store, 'readwrite', (s) => reqToPromise(s.delete(key)));

export async function deleteByIndex(store, index, query) {
  return withStore(store, 'readwrite', async (s) => {
    const keys = await reqToPromise(s.index(index).getAllKeys(query));
    for (const k of keys) s.delete(k);
    return keys.length;
  });
}

export async function deleteSession(sessionId) {
  await deleteByIndex('frames', 'sessionId', sessionId);
  await deleteByIndex('activity', 'sessionId', sessionId);
  await del('sessions', sessionId);
}

export async function clearAll() {
  const db = await openDB();
  const tx = db.transaction(['sessions', 'frames', 'activity'], 'readwrite');
  tx.objectStore('sessions').clear();
  tx.objectStore('frames').clear();
  tx.objectStore('activity').clear();
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
}

export function sessionsInRange(startMs, endMs) {
  return getAllByIndex('sessions', 'startedAt', IDBKeyRange.bound(startMs, endMs, false, true));
}
export const framesForSession = (sessionId) => getAllByIndex('frames', 'sessionId', sessionId);
export const activityForSession = (sessionId) => getAllByIndex('activity', 'sessionId', sessionId);
export const openSessions = () => getAllByIndex('sessions', 'open', 1);
export const framesInRange = (startMs, endMs) => getAllByIndex('frames', 'ts', IDBKeyRange.bound(startMs, endMs, false, true));

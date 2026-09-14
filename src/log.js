// Append-only record of every post sent to the model and what it said, in IndexedDB
// (cheap appends; chrome.storage would rewrite one blob per write). Never pruned:
// it grows until you clear it from the settings page. Nothing leaves your machine.
//
// One row per post:
// { at, day, batch, provider, model, policy, viewer, id, author, text, quoted, media,
//   verdict, reason, batchSize, usage, cost }
// `viewer` is the X account that was logged in; `author` wrote the post. `batch` groups
// posts that went out in the same request; `usage` and `cost` are for that whole request
// and are repeated on each of its rows.

const DB_NAME = 'prism';
const STORE = 'log';

let dbPromise = null;

function open() {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { autoIncrement: true });
      store.createIndex('at', 'at');
    };
    req.onsuccess = () => {
      req.result.onclose = () => (dbPromise = null);
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  }));
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function result(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function appendLog(rows) {
  if (!rows.length) return;
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const row of rows) store.add(row);
  await done(tx);
}

export async function countLog() {
  const db = await open();
  return result(db.transaction(STORE).objectStore(STORE).count());
}

export async function clearLog() {
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).clear();
  await done(tx);
}

// Calls onRow for every row in insertion order; used to stream an export.
export async function eachLogRow(onRow) {
  const db = await open();
  const cursor = db.transaction(STORE).objectStore(STORE).openCursor();
  await new Promise((resolve, reject) => {
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return resolve();
      onRow(c.value);
      c.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
}

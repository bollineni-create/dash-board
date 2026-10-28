// Loom (web): IndexedDB storage. Everything stays in this browser.
'use strict';

const DB = (() => {
  const STORES = ['items', 'blobs', 'spaces', 'chats', 'kv'];
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('loom', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, s === 'kv' || s === 'blobs' ? undefined : { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('Loom is open in another tab that needs to be closed first.'));
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      const r = fn(s);
      if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('Storage is full.'));
    });
  }
  return {
    all: (store) => tx(store, 'readonly', (s) => s.getAll()),
    get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
    put: (store, value, key) => tx(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key))),
    del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
    clear: async () => { for (const s of STORES) await tx(s, 'readwrite', (st) => st.clear()); },
    estimate: async () => (navigator.storage?.estimate ? navigator.storage.estimate() : null),
    persist: () => navigator.storage?.persist?.().catch(() => false),
  };
})();

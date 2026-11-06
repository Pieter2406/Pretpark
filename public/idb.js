// Tiny IndexedDB wrapper: tickets and photos live on the device, so they open without signal.
let dbp = null;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('pretpark', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('tickets', { keyPath: 'id' });
      req.result.createObjectStore('photos', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
async function run(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const r = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(r?.result);
    tx.onerror = () => reject(tx.error);
  });
}
export const idb = {
  all: (store) => run(store, 'readonly', (s) => s.getAll()).catch(() => []),
  put: (store, v) => run(store, 'readwrite', (s) => s.put(v)).catch(() => {}),
  del: (store, id) => run(store, 'readwrite', (s) => s.delete(id)).catch(() => {}),
};

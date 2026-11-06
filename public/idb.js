// Tiny IndexedDB wrapper: tickets, lost-child photos and the album's upload queue live on the device,
// so they work without signal.
let dbp = null;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('pretpark', 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const name of ['tickets', 'photos', 'uploads']) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: 'id' });
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

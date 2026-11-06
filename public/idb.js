// Tiny IndexedDB wrapper: tickets, lost-child photos and the album's upload queue live on the device,
// so they work without signal. iOS can close the connection while the app is in the background, and a full disk
// aborts a transaction: both are retried once on a fresh connection. all() returns null (not []) on failure, so
// callers can keep what they already show instead of "losing" the tickets.
let dbp = null;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('pretpark', 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const name of ['tickets', 'photos', 'uploads']) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: 'id' });
    };
    req.onsuccess = () => { const d = req.result; d.onclose = () => { dbp = null; }; d.onversionchange = () => { d.close(); dbp = null; }; resolve(d); };
    req.onerror = () => { dbp = null; reject(req.error); };
    req.onblocked = () => { dbp = null; reject(new Error('blocked')); };
  });
  return dbp;
}
async function once(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = d.transaction(store, mode); } catch (e) { dbp = null; reject(e); return; } // connection was closed
    const r = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(r?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  });
}
async function run(store, mode, fn) {
  try { return await once(store, mode, fn); } catch { dbp = null; return once(store, mode, fn); }
}
export const idb = {
  all: (store) => run(store, 'readonly', (s) => s.getAll()).catch(() => null),
  put: (store, v) => run(store, 'readwrite', (s) => s.put(v)).then(() => true, () => false),
  del: (store, id) => run(store, 'readwrite', (s) => s.delete(id)).then(() => true, () => false),
};

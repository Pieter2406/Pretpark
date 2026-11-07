// Tiny IndexedDB wrapper: tickets, lost-child photos, the album's upload queue and `keep` (every album photo taken or
// added on this phone, original + thumbnail, kept after upload so nothing is ever lost) live on the device,
// so they work without signal. iOS can close the connection while the app is in the background, and a full disk
// aborts a transaction: both are retried once on a fresh connection. all() returns null (not []) on failure, so
// callers can keep what they already show instead of "losing" the tickets.
// iOS WebKit sometimes never answers indexedDB.open (no success, no error): without a time limit every photo, ticket
// and the whole album waited forever. Now an open gets 3 s (a second try after nudging with databases(), which
// unsticks it on some iOS versions); a stuck transaction 8 s. Callers then fall back (photos upload from memory).
let dbp = null;
const limit = (p, ms, what) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(what + ' timeout')), ms); p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); }); });
function db() {
  dbp ??= limit(openDb(), 3000, 'open').catch(async () => { await limit(Promise.resolve(indexedDB.databases?.()).catch(() => {}), 1000, 'nudge').catch(() => {}); return limit(openDb(), 3000, 'open'); })
    .catch((e) => { dbp = null; S_down = Date.now(); report('idb-open', e); throw e; });
  return dbp;
}
// problems go to the app's diagnostics (app.js listens and sends them to the server)
const report = (kind, e) => { try { dispatchEvent(new CustomEvent('pp-diag', { detail: { kind, msg: `${e?.name || ''} ${e?.message || e}`.trim() } })); } catch { /* old browser */ } };
let S_down = 0; // when IndexedDB last failed to open: don't wait 6 s on every call for the next 30 s
export const idbDown = () => Date.now() - S_down < 30e3;
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('pretpark', 3);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const name of ['tickets', 'photos', 'uploads', 'keep']) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: 'id' });
    };
    req.onsuccess = () => { const d = req.result; d.onclose = () => { dbp = null; }; d.onversionchange = () => { d.close(); dbp = null; }; resolve(d); };
    req.onerror = () => { dbp = null; reject(req.error); };
    req.onblocked = () => reject(new Error('blocked'));
  });
}
async function once(store, mode, fn) {
  if (idbDown()) throw new Error('indexeddb unavailable');
  const d = await db();
  return limit(new Promise((resolve, reject) => {
    let tx;
    try { tx = d.transaction(store, mode); } catch (e) { dbp = null; reject(e); return; } // connection was closed
    const r = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(r?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  }), 8000, 'transaction');
}
async function run(store, mode, fn) {
  try { return await once(store, mode, fn); } catch (e) {
    dbp = null;
    try { return await once(store, mode, fn); } catch (e2) { report(`idb-${mode === 'readonly' ? 'read' : 'write'}-${store}`, e2); throw e2; }
  }
}
export const idb = {
  all: (store) => run(store, 'readonly', (s) => s.getAll()).catch(() => null),
  // undefined = not there; throws when IndexedDB failed (so a hiccup is never mistaken for "deleted")
  get: (store, id) => run(store, 'readonly', (s) => s.get(id)),
  put: (store, v) => run(store, 'readwrite', (s) => s.put(v)).then(() => true, () => false),
  del: (store, id) => run(store, 'readwrite', (s) => s.delete(id)).then(() => true, () => false),
};

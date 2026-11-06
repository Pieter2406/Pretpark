// The Worker's API against an in-memory D1 (node:sqlite) and R2, with fetch mocked (push services, live data).
// Requests are plain-http loopback, so access.js lets them through as local development.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index.js';
import { liveRides, okEndpoint, okDataUrl, readyMessage } from '../worker/rules.js';
import { plans, DEFAULT_PEOPLE } from '../public/logic.js';
import { ATTRACTIONS } from '../public/data.js';

// ---------- fakes
function d1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())), raw: db };
}
function r2() {
  const m = new Map();
  return {
    m,
    async put(key, body, opts) { m.set(key, { data: Buffer.from(await new Response(body).arrayBuffer()), ...opts }); },
    async get(key) {
      const o = m.get(key); if (!o) return null;
      return { body: o.data, httpEtag: '"e"', customMetadata: o.customMetadata, writeHttpMetadata: (h) => h.set('content-type', o.httpMetadata.contentType) };
    },
    async delete(keys) { for (const k of [].concat(keys)) m.delete(k); },
  };
}
const b64u = (b) => Buffer.from(b).toString('base64url');
async function subKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { p256dh: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) };
}

let env, pushes, pushStatus, waits;
const ctx = { waitUntil: (p) => waits.push(p) };
const settle = async () => { while (waits.length) await waits.shift(); };
const call = async (method, path, body, headers = {}) => {
  const init = { method, headers };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.body = typeof body === 'string' ? body : JSON.stringify(body); init.headers = { 'content-type': 'application/json', ...headers }; }
  const res = await worker.fetch(new Request('http://localhost' + path, init), env, ctx);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, res };
};

const LIVE = {
  liveData: [
    { id: ATTRACTIONS[0].id, entityType: 'ATTRACTION', status: 'OPERATING', queue: { STANDBY: { waitTime: 12.4 } } },
    { id: ATTRACTIONS[1].id, entityType: 'ATTRACTION', status: '<b>HACK</b>', queue: { STANDBY: { waitTime: '<img>' } } },
    { id: ATTRACTIONS[2].id, entityType: 'ATTRACTION', status: 'DOWN', queue: { STANDBY: { waitTime: 9999 } } },
    { id: ATTRACTIONS[3].id, entityType: 'ATTRACTION', status: 'REFURBISHMENT', queue: { STANDBY: { waitTime: -5 } } },
    { id: 'show', entityType: 'SHOW', status: 'OPERATING' },
  ],
};
before(async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  env = { DB: d1(), PHOTOS: r2(), VAPID_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey)) };
  pushes = []; waits = []; pushStatus = () => 201;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input.url ?? input);
    if (url.includes('themeparks.wiki') && url.endsWith('/live')) return Response.json(LIVE);
    if (url.includes('themeparks.wiki')) return Response.json({ schedule: [] }); // no schedule today
    if (url.includes('api.met.no')) return new Response('', { status: 503 });
    pushes.push({ url, init });
    return new Response('', { status: pushStatus(url) });
  };
});

const newFam = async () => (await call('POST', '/api/family')).data;
const together = plans({ people: DEFAULT_PEOPLE, favs: [], done: {}, live: { rides: Object.fromEntries(ATTRACTIONS.map((a) => [a.id, { s: 'OPERATING', w: 5 }])) }, walk: () => 200, month: 10 });
const split = together.find((p) => p.type === 'split' && !p.parts[1].rest);

test('family: { id, fam, updated } on create, GET and POST; a repeated aid writes nothing', async () => {
  const c = await call('POST', '/api/family');
  assert.equal(c.status, 201);
  assert.deepEqual(Object.keys(c.data).sort(), ['fam', 'id', 'updated']);
  assert.equal(typeof c.data.updated, 'number');
  const g = await call('GET', '/api/family/' + c.data.id);
  assert.equal(g.status, 200);
  assert.equal(g.data.updated, c.data.updated);
  const p1 = await call('POST', '/api/family/' + c.data.id, { type: 'ate', aid: 'aaa111' });
  assert.equal(p1.status, 200);
  assert.ok(p1.data.updated > c.data.updated);
  assert.ok(p1.data.fam.ate > 0);
  const p2 = await call('POST', '/api/family/' + c.data.id, { type: 'ate', aid: 'aaa111' });
  assert.equal(p2.status, 200);
  assert.equal(p2.data.updated, p1.data.updated, 'no-op: same version');
  assert.deepEqual(p2.data.fam, p1.data.fam);
  assert.equal((await call('GET', '/api/family/' + c.data.id)).data.updated, p1.data.updated);
  const bad = await call('POST', '/api/family/' + c.data.id, { type: 'target', plan: { ...split, meet: 'nope' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'bad plan');
});

test('push: endpoints only from real push services; a POST without sub moves the device to the family', async () => {
  const f1 = await newFam(), f2 = await newFam();
  const keys = await subKeys();
  const sub = (endpoint) => call('POST', '/api/push', { device: 'devpush0001', family: f1.id, sub: { endpoint, keys } });
  for (const e of ['https://evil.example/x', 'http://fcm.googleapis.com/fcm/send/x', 'https://fcm.googleapis.com.evil.com/x',
    'https://evilfcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'javascript:alert(1)']) {
    assert.equal((await sub(e)).status, 400, e);
  }
  for (const e of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/x',
    'https://web.push.apple.com/QK', 'https://wns2-par02p.notify.windows.com/w/?token=x', 'https://api.push.apple.com/x']) {
    assert.equal((await sub(e)).status, 200, e);
  }
  const r = await call('POST', '/api/push', { device: 'devpush0001', family: f2.id, prefs: { fav: false } });
  assert.equal(r.status, 200);
  const row = env.DB.raw.prepare('SELECT family, prefs FROM subs WHERE device = ?').get('devpush0001');
  assert.equal(row.family, f2.id);
  assert.equal(JSON.parse(row.prefs).fav, false);
  assert.ok(okEndpoint('https://FCM.googleapis.com/x'));
  assert.ok(!okEndpoint('https://user:pw@fcm.googleapis.com/x'));
});

test('ready: Web Push to the other phones of the family (not the sender), gone subscriptions deleted', async () => {
  const f = await newFam();
  const other = await newFam();
  const keys = await subKeys();
  const subscribe = (device, family, endpoint) => call('POST', '/api/push', { device, family, sub: { endpoint, keys } });
  await subscribe('devreadyaa1', f.id, 'https://fcm.googleapis.com/fcm/send/aa1');
  await subscribe('devreadybb2', f.id, 'https://fcm.googleapis.com/fcm/send/bb2');
  await subscribe('devreadycc3', f.id, 'https://fcm.googleapis.com/fcm/send/gone');
  await subscribe('devreadydd4', other.id, 'https://fcm.googleapis.com/fcm/send/dd4');
  await call('POST', '/api/family/' + f.id, { type: 'target', plan: split, device: 'devreadyaa1' });
  pushes = []; waits = [];
  pushStatus = (url) => (url.endsWith('/gone') ? 410 : 201);
  const r = await call('POST', '/api/family/' + f.id, { type: 'ready', part: 1, device: 'devreadyaa1', aid: 'rdy001' });
  assert.equal(r.status, 200);
  assert.ok(r.data.fam.target.ready[1] > 0);
  await settle();
  assert.deepEqual(pushes.map((p) => p.url).sort(), ['https://fcm.googleapis.com/fcm/send/bb2', 'https://fcm.googleapis.com/fcm/send/gone']);
  assert.equal(pushes[0].init.headers['content-encoding'], 'aes128gcm');
  assert.equal(pushes[0].init.headers.topic, 'ready');
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM subs WHERE device = ?').get('devreadycc3').n, 0, '410 → deleted');
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM subs WHERE device = ?').get('devreadybb2').n, 1);
  // the same action again (lost answer): no second notification
  pushes = [];
  await call('POST', '/api/family/' + f.id, { type: 'ready', part: 1, device: 'devreadyaa1', aid: 'rdy001' });
  await settle();
  assert.equal(pushes.length, 0);
  // without a target: nothing to tell
  await call('POST', '/api/family/' + f.id, { type: 'untarget' });
  await call('POST', '/api/family/' + f.id, { type: 'ready', part: 0, device: 'devreadyaa1' });
  await settle();
  assert.equal(pushes.length, 0);
  pushStatus = () => 201;
});

test('ready: message text names the group and the meeting ride', () => {
  const fam = { people: DEFAULT_PEOPLE, target: { plan: split } };
  const m = readyMessage(fam, 1);
  const names = split.parts[1].group.map((id) => DEFAULT_PEOPLE.find((p) => p.id === id).name);
  const ride = ATTRACTIONS.find((a) => a.id === split.meet).name;
  assert.deepEqual(m, { tag: 'ready', title: '✅ Wij zijn klaar', body: `${names.join(' en ')} staan aan de uitgang van ${ride}`, url: '/' });
});

test('live: wait and status coerced, scheduleKnown reported', async () => {
  const r = await call('GET', '/api/live');
  assert.equal(r.status, 200);
  assert.equal(r.data.scheduleKnown, false);
  assert.equal(r.data.open, null);
  const rides = r.data.rides;
  assert.deepEqual(rides[ATTRACTIONS[0].id], { s: 'OPERATING', w: 12 });
  assert.deepEqual(rides[ATTRACTIONS[1].id], { s: 'CLOSED', w: null });
  assert.deepEqual(rides[ATTRACTIONS[2].id], { s: 'DOWN', w: 600 });
  assert.deepEqual(rides[ATTRACTIONS[3].id], { s: 'REFURBISHMENT', w: 0 });
  assert.equal(rides.show, undefined);
  assert.deepEqual(liveRides(null), {});
  assert.deepEqual(liveRides([{ id: 'x', entityType: 'ATTRACTION', status: 'OPERATING', queue: { STANDBY: { waitTime: NaN } } }]), { x: { s: 'OPERATING', w: null } });
});

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const JPG = 'data:image/jpeg;base64,/9j/4AAQ';
test('tickets: strict data URLs, never replace another family\'s ticket', async () => {
  const a = await newFam(), b = await newFam();
  const t = { id: 'ticket0001', name: 'Volwassene', crop: PNG, page: JPG };
  assert.equal((await call('POST', '/api/tickets/' + a.id, t)).status, 201);
  assert.equal((await call('POST', '/api/tickets/' + a.id, t)).status, 201, 'same family may replace');
  const x = await call('POST', '/api/tickets/' + b.id, { ...t, name: 'stolen' });
  assert.equal(x.status, 409);
  assert.equal((await call('GET', '/api/tickets/' + a.id)).data[0].name, 'Volwassene');
  for (const crop of ['data:image/png;base64,abc"><script>', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,', 'javascript:x']) {
    assert.equal((await call('POST', '/api/tickets/' + a.id, { ...t, id: 'ticket0002', crop })).status, 400, crop);
  }
  assert.ok(okDataUrl(null, 10) && okDataUrl(PNG, 100) && !okDataUrl(PNG, 10));
  // PATCH/DELETE from another family do nothing
  await call('DELETE', '/api/tickets/' + b.id + '/ticket0001');
  assert.equal((await call('GET', '/api/tickets/' + a.id)).data.length, 1);
});

test('photos: "bad photo" / "photo too big" errors, never replace another family\'s photo', async () => {
  const a = await newFam(), b = await newFam();
  const form = (full, meta = {}) => { const fd = new FormData(); if (full) fd.set('full', full); fd.set('meta', JSON.stringify(meta)); return fd; };
  const jpg = () => new File([Buffer.from('fakejpeg')], 'x.jpg', { type: 'image/jpeg' });
  const ok = await call('POST', `/api/photos/${a.id}/photo00001`, form(jpg()));
  assert.equal(ok.status, 201);
  assert.equal(ok.data.type, 'image/jpeg');
  for (const full of [null, new File([], 'e.jpg', { type: 'image/jpeg' }), new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }), new File(['x'], 'x.html', { type: 'text/html' })]) {
    const r = await call('POST', `/api/photos/${a.id}/photo00002`, form(full));
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'bad photo');
  }
  const big = await call('POST', `/api/photos/${a.id}/photo00003`, form(jpg()), { 'content-length': String(70 * 1024 * 1024) });
  assert.equal(big.status, 413);
  assert.equal(big.data.error, 'photo too big');
  // no type: kept as JPEG
  const untyped = await call('POST', `/api/photos/${a.id}/photo00004`, form(new File(['x'], 'x')));
  assert.equal(untyped.data.type, 'image/jpeg', JSON.stringify(untyped.data));
  // another family can't take over the id; a star survives a re-upload by the same family
  assert.equal((await call('PATCH', `/api/photos/${a.id}/photo00001`, { star: true })).status, 200);
  assert.equal((await call('POST', `/api/photos/${b.id}/photo00001`, form(jpg()))).status, 409);
  assert.equal((await call('POST', `/api/photos/${a.id}/photo00001`, form(jpg()))).data.star, true);
  const list = (await call('GET', `/api/photos/${a.id}`)).data;
  assert.equal(list.length, 2);
  const file = await call('GET', `/api/photos/${a.id}/photo00001`);
  assert.equal(file.res.headers.get('x-content-type-options'), 'nosniff');
});

test('cron retention: by the family\'s last change; families with photos and photos stay', async () => {
  const db = env.DB.raw;
  const now = Date.now(), day = 864e5;
  const fam = (id, updated) => db.prepare('INSERT INTO families (id, data, created, updated) VALUES (?, ?, ?, ?)').run(id, '{}', updated - day, updated);
  fam('oldfamily0001', now - 31 * day); // old, no photos → goes, with its tickets and subs
  fam('oldphotos0001', now - 31 * day); // old, has photos → stays, tickets go
  fam('weekoldfam001', now - 8 * day); // a week old → stays with tickets, subs go
  fam('freshfamily01', now - day);
  const ticket = (id, family, created) => db.prepare('INSERT INTO tickets (id, family, meta, crop, page, created) VALUES (?, ?, ?, NULL, NULL, ?)').run(id, family, '{}', created);
  ticket('tk00000001', 'oldfamily0001', now);
  ticket('tk00000002', 'oldphotos0001', now);
  ticket('tk00000003', 'weekoldfam001', now - 20 * day); // an old ticket of a recently used family stays
  ticket('tk00000004', 'freshfamily01', now);
  ticket('tk00000005', 'nofamily00001', now);
  db.prepare('INSERT INTO photos (id, family, meta, t, created) VALUES (?, ?, ?, ?, ?)').run('ph00000001', 'oldphotos0001', '{}', now - 31 * day, now - 31 * day);
  const sub = (device, family) => db.prepare("INSERT INTO subs (device, family, sub, prefs, memo, updated) VALUES (?, ?, '{}', '{}', '{}', ?)").run(device, family, now);
  sub('devret00001', 'oldfamily0001'); sub('devret00002', 'weekoldfam001'); sub('devret00003', 'freshfamily01');
  const saved = env.VAPID_PRIVATE_JWK; delete env.VAPID_PRIVATE_JWK; // retention only, no notifications
  waits = [];
  await worker.scheduled({}, env, ctx);
  await settle();
  env.VAPID_PRIVATE_JWK = saved;
  const ids = (sql) => db.prepare(sql).all().map((r) => Object.values(r)[0]);
  const fams = ids('SELECT id FROM families');
  assert.ok(!fams.includes('oldfamily0001'));
  for (const id of ['oldphotos0001', 'weekoldfam001', 'freshfamily01']) assert.ok(fams.includes(id), id);
  const tks = ids("SELECT id FROM tickets WHERE id LIKE 'tk%'");
  assert.deepEqual(tks.sort(), ['tk00000003', 'tk00000004']);
  assert.deepEqual(ids("SELECT device FROM subs WHERE device LIKE 'devret%'"), ['devret00003']);
  assert.deepEqual(ids("SELECT id FROM photos WHERE id = 'ph00000001'"), ['ph00000001']);
});

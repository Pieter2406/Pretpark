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
  assert.deepEqual(rides[ATTRACTIONS[2].id], { s: 'DOWN', w: null });
  assert.deepEqual(rides[ATTRACTIONS[3].id], { s: 'REFURBISHMENT', w: null });
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
  await worker.scheduled({ scheduledTime: Date.UTC(2026, 10, 7, 12, 17) }, env, ctx); // retention runs at :17 only
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

test('chat: validated messages, idempotent POST, ?after=, pushed to the other phones only (respecting prefs)', async () => {
  const { id } = await newFam();
  const keys = await subKeys();
  await call('POST', '/api/push', { device: 'chatphoneA1', family: id, sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/a1', keys }, prefs: {} });
  await call('POST', '/api/push', { device: 'chatphoneB1', family: id, sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/b1', keys }, prefs: {} });
  await call('POST', '/api/push', { device: 'chatphoneC1', family: id, sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/c1', keys }, prefs: { chat: false } });
  await settle(); pushes.length = 0;
  const m1 = await call('POST', `/api/chat/${id}`, { id: 'msg0000001', text: '  Waar zijn jullie? <b>  ', person: 'p1', device: 'chatphoneA1' });
  assert.equal(m1.status, 201);
  assert.equal(m1.data.text, 'Waar zijn jullie? <b>'); // stored as text; the app escapes it
  assert.equal(m1.data.by, 'local@dev');
  await settle();
  assert.deepEqual(pushes.map((p) => p.url), ['https://fcm.googleapis.com/fcm/send/b1']); // not the sender, not C (chat off)
  pushes.length = 0;
  const again = await call('POST', `/api/chat/${id}`, { id: 'msg0000001', text: 'changed', person: 'p1', device: 'chatphoneA1' });
  assert.equal(again.status, 200); assert.equal(again.data.text, 'Waar zijn jullie? <b>');
  await settle(); assert.equal(pushes.length, 0);
  assert.equal((await call('POST', `/api/chat/${id}`, { id: 'msg0000002', text: '   ' })).status, 400);
  assert.equal((await call('POST', `/api/chat/${id}`, { id: 'bad id!', text: 'x' })).status, 400);
  assert.equal((await call('POST', `/api/chat/${id}`, { id: 'msg0000003', kind: 'loc', lat: 'x', lon: 4 })).status, 400);
  const loc = await call('POST', `/api/chat/${id}`, { id: 'msg0000004', kind: 'loc', lat: 50.7, lon: 4.59, near: 'Kondaa', person: 'p2' });
  assert.equal(loc.status, 201); assert.equal(loc.data.near, 'Kondaa');
  const all = await call('GET', `/api/chat/${id}`);
  assert.deepEqual(all.data.map((m) => m.id), ['msg0000001', 'msg0000004']);
  const newer = await call('GET', `/api/chat/${id}?after=${m1.data.t}`);
  assert.ok(newer.data.every((m) => m.t > m1.data.t));
  assert.equal((await call('GET', '/api/chat/doesnotexist000')).status, 404);
});

test('tickets: a ticket can be marked as the parking ticket (person "car")', async () => {
  const { id } = await newFam();
  const crop = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal((await call('POST', `/api/tickets/${id}`, { id: 'parkingticket01', name: 'Parkeerticket', person: 'car', code: 'PARK123', crop })).status, 201);
  assert.equal((await call('POST', `/api/tickets/${id}`, { id: 'parkingticket02', name: 'x', person: 'bus', code: 'X', crop })).status, 201);
  const list = (await call('GET', `/api/tickets/${id}`)).data;
  assert.equal(list.find((t) => t.id === 'parkingticket01').person, 'car');
  assert.equal(list.find((t) => t.id === 'parkingticket02').person, null);
});

test('liveRides: placeholder waits (222 everywhere before opening, the same long wait on most rides) become unknown', () => {
  const ride = (id, w, status = 'OPERATING') => ({ id, entityType: 'ATTRACTION', status, queue: { STANDBY: { waitTime: w } } });
  const all222 = liveRides(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ride(id, 222)));
  assert.ok(Object.values(all222).every((r) => r.w === null && r.s === 'OPERATING'));
  const same90 = liveRides([ride('a', 90), ride('b', 90), ride('c', 90), ride('d', 90), ride('e', 90), ride('f', 15)]);
  assert.deepEqual(Object.values(same90).map((r) => r.w), [null, null, null, null, null, 15]);
  const normal = liveRides([ride('a', 5), ride('b', 5), ride('c', 5), ride('d', 5), ride('e', 5), ride('f', 45)]);
  assert.deepEqual(Object.values(normal).map((r) => r.w), [5, 5, 5, 5, 5, 45]); // a quiet morning is real
  assert.equal(liveRides([ride('a', 181)]).a.w, null);
  assert.equal(liveRides([ride('a', 180)]).a.w, 180);
});

test('OwnTracks: token per phone, background fixes → queue → done (+ push), junk and revoked tokens are quiet', async () => {
  const f = await newFam();
  const dev = 'devot0000001';
  // this phone is p1; choose a together plan
  await call('POST', '/api/family/' + f.id, { type: 'me', device: dev, person: 'p1' });
  const plan = together.find((p) => p.type === 'together');
  const a = ATTRACTIONS.find((x) => x.id === plan.parts[0].id);
  const now = Date.now();
  await call('POST', '/api/family/' + f.id, { type: 'target', plan, device: dev, at: now - 60 * 60e3 });
  const keys = await subKeys();
  await call('POST', '/api/push', { device: dev, family: f.id, sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/ot', keys } });
  assert.equal((await call('GET', `/api/otsetup/${f.id}?device=${dev}`)).data.active, false);
  const s = await call('POST', `/api/otsetup/${f.id}`, { device: dev });
  assert.equal(s.status, 201);
  const token = s.data.token;
  assert.match(token, /^[a-z0-9]{24}$/);
  const move = (p, dx, dy) => ({ lat: p.lat + dy / 111194, lon: p.lon + dx / (111194 * Math.cos((p.lat * Math.PI) / 180)) });
  const loc = (p, t, acc = 8, vel = 0) => ({ _type: 'location', lat: p.lat, lon: p.lon, acc, tst: Math.round(t / 1000), vel, batt: 77, tid: 'PP' });
  // OwnTracks posts its offline queue as an array: 30 min in the queue at the ride, then walking away
  const t0 = now - 50 * 60e3;
  const batch = [];
  for (let i = 0; i < 30 * 2; i++) batch.push(loc(move(a, (i % 5) - 2, (i % 3) - 1), t0 + i * 30e3));
  batch.push({ _type: 'transition', event: 'leave' }, { foo: 1 }, 'junk');
  pushes.length = 0;
  let r = await call('POST', '/api/ot/' + token, batch);
  assert.equal(r.status, 200); assert.deepEqual(r.data, []);
  await settle();
  let fam = (await call('GET', '/api/family/' + f.id)).data.fam;
  assert.ok(fam.target?.q?.[0]?.auto, 'queue started by the server');
  assert.ok(pushes.some((p) => p.url.includes('fcm.googleapis.com/fcm/send/ot')), 'pushed to this phone');
  const away = [];
  for (let i = 0; i < 8; i++) away.push(loc(move(a, 200 + i * 20, 150), now - 3 * 60e3 + i * 20e3));
  r = await call('POST', '/api/ot/' + token, away);
  await settle();
  fam = (await call('GET', '/api/family/' + f.id)).data.fam;
  assert.equal(fam.done[a.id], 1, 'done by the server');
  assert.equal(fam.target, null);
  assert.ok(fam.positions[dev], 'partner dot updated');
  const st = (await call('GET', `/api/otsetup/${f.id}?device=${dev}`)).data;
  assert.equal(st.active, true); assert.equal(st.info.batt, 77);
  // the same batch again (OwnTracks retry) changes nothing
  await call('POST', '/api/ot/' + token, away);
  fam = (await call('GET', '/api/family/' + f.id)).data.fam;
  assert.equal(fam.done[a.id], 1);
  // wrong / revoked tokens and junk: 200 [] and nothing happens
  assert.deepEqual((await call('POST', '/api/ot/nottoken', away)).data, []);
  assert.deepEqual((await call('POST', '/api/ot/' + token, 'not json')).data, []);
  await call('DELETE', `/api/otsetup/${f.id}?device=${dev}`);
  assert.deepEqual((await call('POST', '/api/ot/' + token, away)).data, []);
  assert.equal((await call('GET', `/api/otsetup/${f.id}?device=${dev}`)).data.active, false);
  assert.equal((await call('POST', `/api/otsetup/${f.id}`, { device: '<x>' })).status, 400);
});

test('OwnTracks review fixes: oversized body refused before reading; push respects the "auto" setting and the family', async () => {
  const f = await newFam();
  const dev = 'devot0000002';
  await call('POST', '/api/family/' + f.id, { type: 'me', device: dev, person: 'p1' });
  const plan = together.find((p) => p.type === 'together');
  const a = ATTRACTIONS.find((x) => x.id === plan.parts[0].id);
  const now = Date.now();
  await call('POST', '/api/family/' + f.id, { type: 'target', plan, device: dev, at: now - 60 * 60e3 });
  const keys = await subKeys();
  await call('POST', '/api/push', { device: dev, family: f.id, sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/ot2', keys }, prefs: { auto: false } });
  const token = (await call('POST', `/api/otsetup/${f.id}`, { device: dev })).data.token;
  const big = await call('POST', '/api/ot/' + token, 'x', { 'content-length': '500000' });
  assert.deepEqual(big.data, []);
  const batch = [];
  for (let i = 0; i < 60; i++) batch.push({ _type: 'location', lat: a.lat, lon: a.lon, acc: 8, tst: Math.round((now - 40 * 60e3 + i * 30e3) / 1000) });
  pushes.length = 0;
  await call('POST', '/api/ot/' + token, batch);
  await settle();
  const fam = (await call('GET', '/api/family/' + f.id)).data.fam;
  assert.ok(fam.target?.q?.[0]?.auto, 'queued');
  assert.ok(!pushes.some((p) => p.url.includes('/ot2')), 'no push: auto notifications off');
});

test('OwnTracks: a status message (no location) is remembered as contact', async () => {
  const f = await newFam();
  const dev = 'devot0000003';
  const token = (await call('POST', `/api/otsetup/${f.id}`, { device: dev })).data.token;
  await call('POST', '/api/ot/' + token, { _type: 'status', iOS: { version: '27.1.2' } });
  const st = (await call('GET', `/api/otsetup/${f.id}?device=${dev}`)).data;
  assert.ok(st.info.contact > 0); assert.deepEqual(st.info.types, ['status']); assert.equal(st.info.t, undefined);
});

test('otsetup ?all=1: every phone of the family, never the token', async () => {
  const f = await newFam(), g = await newFam();
  await call('POST', `/api/otsetup/${f.id}`, { device: 'devotall0001' });
  await call('POST', `/api/otsetup/${f.id}`, { device: 'devotall0002' });
  await call('POST', `/api/otsetup/${g.id}`, { device: 'devotall0003' });
  const r = await call('GET', `/api/otsetup/${f.id}?all=1`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.links.map((l) => l.device).sort(), ['devotall0001', 'devotall0002']);
  assert.ok(!JSON.stringify(r.data).match(/"token"/));
});

test('photos: small version first (in the album at once), the original later; star/caption kept; thumb served meanwhile', async () => {
  const f = await newFam();
  const thumb = new File([Buffer.from('thumbjpeg')], 'thumb.jpg', { type: 'image/jpeg' });
  const fd1 = new FormData(); fd1.append('thumb', thumb); fd1.append('meta', JSON.stringify({ t: Date.now() - 60e3, thumbOnly: true, size: 7716853, near: 'Cobra' }));
  const r1 = await call('POST', `/api/photos/${f.id}/twostep0001`, fd1);
  assert.equal(r1.status, 201); assert.equal(r1.data.full, false); assert.equal(r1.data.size, 7716853);
  const list1 = (await call('GET', `/api/photos/${f.id}`)).data;
  assert.equal(list1.length, 1); assert.equal(list1[0].full, false);
  // the "full" URL serves the small version until the original is there
  const g = await worker.fetch(new Request(`http://localhost/api/photos/${f.id}/twostep0001/full`), env, ctx);
  assert.equal(g.status, 200); assert.equal(await g.text(), 'thumbjpeg');
  await call('PATCH', `/api/photos/${f.id}/twostep0001`, { star: true, caption: 'Wauw' });
  const fd2 = new FormData(); fd2.append('full', new File([Buffer.from('fulljpeg')], 'x.jpg', { type: 'image/jpeg' })); fd2.append('thumb', thumb); fd2.append('meta', JSON.stringify({ t: Date.now() - 60e3 }));
  const r2 = await call('POST', `/api/photos/${f.id}/twostep0001`, fd2);
  assert.equal(r2.status, 201); assert.notEqual(r2.data.full, false); assert.equal(r2.data.star, true); assert.equal(r2.data.caption, 'Wauw');
  const g2 = await worker.fetch(new Request(`http://localhost/api/photos/${f.id}/twostep0001/full`), env, ctx);
  assert.equal(await g2.text(), 'fulljpeg');
  // a late small-version retry never downgrades the original
  const r3 = await call('POST', `/api/photos/${f.id}/twostep0001`, fd1);
  assert.equal(r3.status, 200);
  assert.notEqual((await call('GET', `/api/photos/${f.id}`)).data[0].full, false);
});

test('photos: deleted on purpose → a late upload gets 410; a slow small-version request never downgrades the original', async () => {
  const f = await newFam();
  const thumb = new File([Buffer.from('t')], 't.jpg', { type: 'image/jpeg' });
  const full = () => new File([Buffer.from('fulljpeg')], 'x.jpg', { type: 'image/jpeg' });
  const small = () => { const fd = new FormData(); fd.append('thumb', thumb); fd.append('meta', JSON.stringify({ thumbOnly: true, size: 9 })); return fd; };
  const big = () => { const fd = new FormData(); fd.append('full', full()); fd.append('thumb', thumb); fd.append('meta', '{}'); return fd; };
  assert.equal((await call('POST', `/api/photos/${f.id}/gone00001`, small())).status, 201);
  assert.equal((await call('DELETE', `/api/photos/${f.id}/gone00001`)).status, 200);
  assert.equal((await call('POST', `/api/photos/${f.id}/gone00001`, big())).status, 410);
  assert.equal((await call('GET', `/api/photos/${f.id}`)).data.length, 0);
  // original first, then a late small-version request: still the original
  assert.equal((await call('POST', `/api/photos/${f.id}/late00001`, big())).status, 201);
  const r = await call('POST', `/api/photos/${f.id}/late00001`, small());
  assert.notEqual(r.data.full, false);
  // the stand-in is never cached and is marked
  assert.equal((await call('POST', `/api/photos/${f.id}/stand0001`, small())).status, 201);
  const g = await worker.fetch(new Request(`http://localhost/api/photos/${f.id}/stand0001/full`), env, ctx);
  assert.equal(g.headers.get('cache-control'), 'no-store'); assert.equal(g.headers.get('x-pretpark-small'), '1');
});

test('photos: PATCH only changes the fields sent (star on one phone, caption on the other)', async () => {
  const f = await newFam();
  const fd = new FormData(); fd.append('full', new File([Buffer.from('j')], 'x.jpg', { type: 'image/jpeg' })); fd.append('meta', '{}');
  await call('POST', `/api/photos/${f.id}/patch0001`, fd);
  await call('PATCH', `/api/photos/${f.id}/patch0001`, { caption: 'Wauw' });
  await call('PATCH', `/api/photos/${f.id}/patch0001`, { star: true });
  const p = (await call('GET', `/api/photos/${f.id}`)).data[0];
  assert.equal(p.caption, 'Wauw'); assert.equal(p.star, true);
});

test('photos: the original as raw bytes (PUT) with a size check; a cut-off body is 409 "truncated", not a crash', async () => {
  const f = await newFam();
  const put = (bytes, size, meta = {}) => worker.fetch(new Request(`http://localhost/api/photos/${f.id}/rawput0001`, {
    method: 'PUT', body: bytes, headers: { 'content-type': 'image/jpeg', 'x-pretpark-size': String(size), 'x-pretpark-meta': encodeURIComponent(JSON.stringify(meta)) } }), env, ctx);
  const short = await put(Buffer.from('half'), 8);
  assert.equal(short.status, 409); assert.match((await short.json()).error, /truncated/);
  const ok = await put(Buffer.from('fulljpeg'), 8, { t: Date.now() - 60e3, near: 'Kondaa', caption: 'Hoera' });
  assert.equal(ok.status, 201);
  const d = await ok.json(); assert.equal(d.size, 8); assert.equal(d.near, 'Kondaa'); assert.equal(d.type, 'image/jpeg');
  const g = await worker.fetch(new Request(`http://localhost/api/photos/${f.id}/rawput0001/full`), env, ctx);
  assert.equal(await g.text(), 'fulljpeg');
  // a multipart body that can't be parsed: 409 too (retried), never 500
  const bad = await worker.fetch(new Request(`http://localhost/api/photos/${f.id}/rawput0002`, { method: 'POST', body: '--x\r\ncut', headers: { 'content-type': 'multipart/form-data; boundary=zzz' } }), env, ctx);
  assert.equal(bad.status, 409);
});

test('photos: the place can be set by hand (PATCH near), cleaned and capped, star and caption untouched', async () => {
  const f = await newFam();
  const fd = new FormData(); fd.append('full', new File([Buffer.from('jpeg')], 'x.jpg', { type: 'image/jpeg' })); fd.append('meta', JSON.stringify({ near: 'Pulsar' }));
  assert.equal((await call('POST', `/api/photos/${f.id}/placefix01`, fd)).status, 201);
  await call('PATCH', `/api/photos/${f.id}/placefix01`, { star: true, caption: 'Wauw' });
  const r = await call('PATCH', `/api/photos/${f.id}/placefix01`, { near: '  Turbine\n' });
  assert.equal(r.status, 200); assert.equal(r.data.meta.near, 'Turbine'); assert.equal(r.data.meta.placed, 'hand');
  assert.equal(r.data.meta.star, true); assert.equal(r.data.meta.caption, 'Wauw');
  assert.equal((await call('PATCH', `/api/photos/${f.id}/placefix01`, { near: 'x'.repeat(200) })).data.meta.near.length, 60);
  assert.equal((await call('PATCH', `/api/photos/${f.id}/placefix01`, { near: '' })).data.meta.near, '');
  const list = (await call('GET', `/api/photos/${f.id}`)).data;
  assert.equal(list[0].near, '');
});

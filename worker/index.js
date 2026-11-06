// Pretpark Worker: /api/* only (everything else is a static file from public/).
// - /api/live: Walibi Belgium wait times (ThemeParks.wiki), cached 60 s
// - /api/family: the shared family state (D1), changed through validated actions
// - /api/push: Web Push subscriptions; a cron every minute decides and sends notifications
// - /api/tickets: imported admission tickets (code crop + page image), shared by the family
// - /api/photos: the shared photo album, originals + thumbnails in R2 (EU), metadata in D1
// Everything is behind Cloudflare Access (e-mail code) and checked again here (access.js).
import { newFamily, apply } from '../public/family.js';
import { accessEmail } from './access.js';
import { decideNotifications } from '../public/logic.js';
import { sendPush, publicKey } from './push.js';

const DEST = '8d8a8cc7-4523-4437-8bb6-5c87a26ba5ce'; // Walibi Belgium on ThemeParks.wiki
const KEEP_DAYS = 7; // tickets, push subscriptions and families without photos; photos are kept until deleted

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    try {
      if (parts[1] === 'health') return json({ ok: true });
      const email = await accessEmail(request);
      if (!email) return json({ error: 'auth' }, 401);
      if (parts[1] === 'photos') return await photos(request, env, email, parts[2], parts[3], parts[4]);
      if (parts[1] === 'tickets') return await tickets(request, env, parts[2], parts[3]);
      if (parts[1] === 'live') return json(await getLive(ctx));
      if (parts[1] === 'vapid') return json({ key: env.VAPID_PRIVATE_JWK ? publicKey(env) : null });
      if (parts[1] === 'family') return await family(request, env, parts[2]);
      if (parts[1] === 'push') return await push(request, env);
      return json({ error: 'not found' }, 404);
    } catch (err) {
      if (err.status) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'server error' }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(notifyAll(env, ctx));
  },
};

const fail = (status, message) => Object.assign(new Error(message), { status });

// ---------- live data
async function getLive(ctx) {
  const cache = caches.default;
  const key = new Request('https://cache.pretpark/live-v1');
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const [live, sched, wx] = await Promise.all([
    fetch(`https://api.themeparks.wiki/v1/entity/${DEST}/live`).then((r) => (r.ok ? r.json() : null)),
    fetch(`https://api.themeparks.wiki/v1/entity/${DEST}/schedule`, { cf: { cacheTtl: 3600 } }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    getWeather(),
  ]);
  if (!live) throw fail(502, 'live data unavailable');
  const rides = {};
  for (const x of live.liveData || []) {
    if (x.entityType !== 'ATTRACTION') continue;
    rides[x.id] = { s: x.status, w: x.queue?.STANDBY?.waitTime ?? null };
  }
  const now = Date.now();
  const today = brusselsDate(now);
  const day = (sched?.parks?.[0]?.schedule || sched?.schedule || []).find((s) => s.date === today && s.type === 'OPERATING');
  const open = day ? Date.parse(day.openingTime) : null, close = day ? Date.parse(day.closingTime) : null;
  const out = {
    t: now, rides, open, close,
    minutesLeft: close ? Math.max(0, Math.round((close - now) / 60e3)) : null,
    localTime: brusselsLocal(now),
    weather: wx,
  };
  ctx?.waitUntil?.(cache.put(key, new Response(JSON.stringify(out), { headers: { 'cache-control': 'max-age=60' } })));
  return out;
}
// Weather from MET Norway (free, asks for an identifying User-Agent). Kept 20 minutes in this isolate.
let wxCache = null;
async function getWeather() {
  if (wxCache && Date.now() - wxCache.t < 20 * 60e3) return wxCache.v;
  try {
    const r = await fetch('https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=50.70&lon=4.59',
      { headers: { 'user-agent': 'pretpark.pieterverlinden.be (family day planner)' }, cf: { cacheTtl: 1200 } });
    if (!r.ok) return wxCache?.v ?? null;
    const d = await r.json();
    const rows = (d.properties?.timeseries || []).filter((x) => x.data?.next_1_hours).slice(0, 36).map((x) => {
      const n = x.data.next_1_hours;
      const mm = n.details?.precipitation_amount ?? 0;
      return { h: x.time, t: x.data.instant.details.air_temperature, mm, p: n.details?.probability_of_precipitation ?? (mm >= 0.1 ? 70 : 0), sym: n.summary?.symbol_code || '' };
    });
    const v = rows.length ? { now: rows[0], hours: rows } : null;
    wxCache = { t: Date.now(), v };
    return v;
  } catch { return wxCache?.v ?? null; }
}
const brusselsDate = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Brussels' }).format(t);
// Brussels wall-clock time written as if it were UTC: the Worker runs in UTC, so getHours() gives the Brussels hour
function brusselsLocal(t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Brussels', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(t).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`;
}

// ---------- D1
let ready = null;
function schema(env) {
  ready ??= env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS families (id TEXT PRIMARY KEY, data TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, family TEXT NOT NULL, meta TEXT NOT NULL, crop TEXT, page TEXT, created INTEGER NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, family TEXT NOT NULL, meta TEXT NOT NULL, t INTEGER NOT NULL, created INTEGER NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS photos_family ON photos (family, t)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS subs (device TEXT PRIMARY KEY, family TEXT NOT NULL, sub TEXT NOT NULL, prefs TEXT NOT NULL, memo TEXT NOT NULL, updated INTEGER NOT NULL)'),
  ]).catch((err) => { ready = null; throw err; });
  return ready;
}
const okFamily = (id) => typeof id === 'string' && /^[a-z0-9]{12,32}$/.test(id);
const okDevice = (d) => typeof d === 'string' && /^[a-z0-9]{8,32}$/i.test(d);

async function family(request, env, id) {
  await schema(env);
  const now = Date.now();
  if (!id) {
    if (request.method !== 'POST') throw fail(405, 'method not allowed');
    const newId = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
    const fam = newFamily(now);
    await env.DB.prepare('INSERT INTO families (id, data, created, updated) VALUES (?, ?, ?, ?)').bind(newId, JSON.stringify(fam), now, now).run();
    return json({ id: newId, fam }, 201);
  }
  if (!okFamily(id)) throw fail(400, 'bad family');
  if (request.method === 'GET') {
    const row = await env.DB.prepare('SELECT data FROM families WHERE id = ?').bind(id).first();
    if (!row) throw fail(404, 'no-family');
    return json({ id, fam: JSON.parse(row.data) });
  }
  if (request.method !== 'POST') throw fail(405, 'method not allowed');
  const text = await request.text();
  if (text.length > 8000) throw fail(413, 'too big');
  let act; try { act = JSON.parse(text); } catch { throw fail(400, 'bad json'); }
  // optimistic concurrency: re-read and retry if the other phone changed it in between
  for (let i = 0; i < 4; i++) {
    const row = await env.DB.prepare('SELECT data, updated FROM families WHERE id = ?').bind(id).first();
    if (!row) throw fail(404, 'no-family');
    let fam;
    try { fam = apply(JSON.parse(row.data), act, now); } catch (e) { throw fail(400, e.message); }
    const t = Math.max(now, row.updated + 1);
    const res = await env.DB.prepare('UPDATE families SET data = ?, updated = ? WHERE id = ? AND updated = ?').bind(JSON.stringify(fam), t, id, row.updated).run();
    if (res.meta.changes === 1) return json({ id, fam });
  }
  throw fail(409, 'busy, try again');
}

async function push(request, env) {
  await schema(env);
  const body = await request.json().catch(() => ({}));
  if (!okDevice(body.device)) throw fail(400, 'bad device');
  if (request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM subs WHERE device = ?').bind(body.device).run();
    return json({ ok: true });
  }
  if (request.method !== 'POST') throw fail(405, 'method not allowed');
  if (!okFamily(body.family)) throw fail(400, 'bad family');
  const prefs = { fav: body.prefs?.fav !== false, best: body.prefs?.best !== false, food: body.prefs?.food !== false, down: body.prefs?.down !== false };
  const s = body.sub;
  if (s) {
    if (typeof s.endpoint !== 'string' || !s.endpoint.startsWith('https://') || s.endpoint.length > 1000 || !s.keys?.p256dh || !s.keys?.auth) throw fail(400, 'bad subscription');
    const sub = JSON.stringify({ endpoint: s.endpoint, keys: { p256dh: String(s.keys.p256dh).slice(0, 200), auth: String(s.keys.auth).slice(0, 100) } });
    await env.DB.prepare(`INSERT INTO subs (device, family, sub, prefs, memo, updated) VALUES (?, ?, ?, ?, '{}', ?)
      ON CONFLICT(device) DO UPDATE SET family = excluded.family, sub = excluded.sub, prefs = excluded.prefs, updated = excluded.updated`)
      .bind(body.device, body.family, sub, JSON.stringify(prefs), Date.now()).run();
  } else {
    await env.DB.prepare('UPDATE subs SET prefs = ? WHERE device = ?').bind(JSON.stringify(prefs), body.device).run();
  }
  if (body.test) {
    const row = await env.DB.prepare('SELECT sub FROM subs WHERE device = ?').bind(body.device).first();
    if (!row) throw fail(404, 'no subscription');
    const status = await sendPush(env, JSON.parse(row.sub), { tag: 'test', title: '🎢 Pretpark', body: 'Meldingen staan aan. Veel plezier!', url: '/' });
    return json({ ok: status < 300, status });
  }
  return json({ ok: true, prefs });
}

// ---------- tickets: { id, meta: { name, person, code, format, page: n, source }, crop: dataURL png, page: dataURL jpeg }
const okDataUrl = (s, type, max) => s == null || (typeof s === 'string' && s.startsWith(`data:${type};base64,`) && s.length <= max);
async function tickets(request, env, fam, id) {
  await schema(env);
  if (!okFamily(fam)) throw fail(400, 'bad family');
  const exists = await env.DB.prepare('SELECT 1 FROM families WHERE id = ?').bind(fam).first();
  if (!exists) throw fail(404, 'no-family');
  if (request.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT id, meta, crop, page, created FROM tickets WHERE family = ? ORDER BY created').bind(fam).all();
    return json(results.map((r) => ({ id: r.id, ...JSON.parse(r.meta), crop: r.crop, page: r.page, created: r.created })));
  }
  if (request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM tickets WHERE family = ? AND id = ?').bind(fam, String(id)).run();
    return json({ ok: true });
  }
  const text = await request.text();
  if (text.length > 1_900_000) throw fail(413, 'ticket too big');
  let t; try { t = JSON.parse(text); } catch { throw fail(400, 'bad json'); }
  const meta = {
    name: String(t.name ?? '').slice(0, 40), person: /^p\d{1,2}$/.test(t.person) ? t.person : null,
    code: t.code == null ? null : String(t.code).slice(0, 2000), format: String(t.format ?? '').slice(0, 30),
    source: String(t.source ?? '').slice(0, 80), pageNo: Number(t.pageNo) || 1,
  };
  if (request.method === 'PATCH') {
    const row = await env.DB.prepare('SELECT meta FROM tickets WHERE family = ? AND id = ?').bind(fam, String(id)).first();
    if (!row) throw fail(404, 'no ticket');
    const old = JSON.parse(row.meta);
    const next = { ...old, ...(t.name != null ? { name: meta.name } : {}), ...('person' in t ? { person: meta.person } : {}) };
    await env.DB.prepare('UPDATE tickets SET meta = ? WHERE family = ? AND id = ?').bind(JSON.stringify(next), fam, String(id)).run();
    return json({ ok: true });
  }
  if (request.method !== 'POST') throw fail(405, 'method not allowed');
  if (!/^[a-z0-9]{8,32}$/.test(t.id)) throw fail(400, 'bad id');
  if (!okDataUrl(t.crop, 'image/png', 900_000) || !okDataUrl(t.page, 'image/jpeg', 900_000)) throw fail(400, 'bad image');
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM tickets WHERE family = ?').bind(fam).first();
  if (n.n >= 20) throw fail(400, 'too many tickets');
  await env.DB.prepare('INSERT OR REPLACE INTO tickets (id, family, meta, crop, page, created) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(t.id, fam, JSON.stringify(meta), t.crop ?? null, t.page ?? null, Date.now()).run();
  return json({ ok: true }, 201);
}

// ---------- photos: originals in R2 at <family>/<id> and <family>/<id>.t (thumbnail), metadata in D1
const IMG_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'];
const MAX_PHOTO = 60 * 1024 * 1024;
async function photos(request, env, email, fam, id, what) {
  await schema(env);
  if (!okFamily(fam)) throw fail(400, 'bad family');
  if (!env.PHOTOS) throw fail(503, 'photo storage not set up');
  const exists = await env.DB.prepare('SELECT 1 FROM families WHERE id = ?').bind(fam).first();
  if (!exists) throw fail(404, 'no-family');
  if (id && !/^[a-z0-9]{8,32}$/.test(id)) throw fail(400, 'bad id');

  if (request.method === 'GET' && !id) {
    const { results } = await env.DB.prepare('SELECT id, meta, t FROM photos WHERE family = ? ORDER BY t').bind(fam).all();
    return json(results.map((r) => ({ id: r.id, t: r.t, ...JSON.parse(r.meta) })));
  }
  if (request.method === 'GET') {
    const obj = await env.PHOTOS.get(`${fam}/${id}${what === 'thumb' ? '.t' : ''}`);
    if (!obj) throw fail(404, 'no photo');
    const h = new Headers();
    obj.writeHttpMetadata(h);
    h.set('etag', obj.httpEtag);
    h.set('cache-control', 'private, max-age=31536000, immutable');
    const url = new URL(request.url);
    if (url.searchParams.get('dl')) {
      const ext = (h.get('content-type') || 'image/jpeg').split('/')[1].replace('jpeg', 'jpg');
      h.set('content-disposition', `attachment; filename="walibi-${obj.customMetadata?.stamp || id}.${ext}"`);
    }
    return new Response(obj.body, { headers: h });
  }
  if (request.method === 'DELETE' && id) {
    await env.PHOTOS.delete([`${fam}/${id}`, `${fam}/${id}.t`]);
    await env.DB.prepare('DELETE FROM photos WHERE family = ? AND id = ?').bind(fam, id).run();
    return json({ ok: true });
  }
  if (request.method === 'PATCH' && id) {
    const body = await request.json().catch(() => ({}));
    const row = await env.DB.prepare('SELECT meta FROM photos WHERE family = ? AND id = ?').bind(fam, id).first();
    if (!row) throw fail(404, 'no photo');
    const meta = { ...JSON.parse(row.meta), caption: String(body.caption ?? '').slice(0, 200), star: !!body.star };
    await env.DB.prepare('UPDATE photos SET meta = ? WHERE family = ? AND id = ?').bind(JSON.stringify(meta), fam, id).run();
    return json({ ok: true, meta });
  }
  if (request.method !== 'POST' || !id) throw fail(405, 'method not allowed');
  // multipart: full (original file), thumb (jpeg), meta (json)
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_PHOTO + 2e6) throw fail(413, 'photo too big');
  const form = await request.formData();
  const full = form.get('full'), thumb = form.get('thumb');
  let m = {}; try { m = JSON.parse(form.get('meta') || '{}'); } catch { /* defaults */ }
  if (!(full instanceof File) || full.size === 0 || full.size > MAX_PHOTO) throw fail(400, 'bad photo');
  const type = IMG_TYPES.includes(full.type) ? full.type : 'image/jpeg';
  const t = Number.isFinite(+m.t) && +m.t > 1.6e12 && +m.t < Date.now() + 864e5 ? +m.t : Date.now();
  const stamp = brusselsLocal(t).slice(0, 16).replace(/[-:]/g, '').replace('T', '-'); // 20261107-1432
  await env.PHOTOS.put(`${fam}/${id}`, full.stream(), { httpMetadata: { contentType: type }, customMetadata: { stamp, by: email } });
  if (thumb instanceof File && thumb.size > 0 && thumb.size < 2e6) {
    await env.PHOTOS.put(`${fam}/${id}.t`, thumb.stream(), { httpMetadata: { contentType: 'image/jpeg' } });
  }
  const meta = {
    by: email, size: full.size, type,
    w: Math.round(+m.w) || null, h: Math.round(+m.h) || null,
    lat: Number.isFinite(+m.lat) && m.lat !== null ? +m.lat : null, lon: Number.isFinite(+m.lon) && m.lon !== null ? +m.lon : null,
    near: String(m.near ?? '').slice(0, 60), caption: String(m.caption ?? '').slice(0, 200), star: false,
  };
  await env.DB.prepare('INSERT OR REPLACE INTO photos (id, family, meta, t, created) VALUES (?, ?, ?, ?, ?)')
    .bind(id, fam, JSON.stringify(meta), t, Date.now()).run();
  return json({ ok: true, id, t, ...meta }, 201);
}

// ---------- cron: every minute
async function notifyAll(env, ctx) {
  await schema(env);
  const now = Date.now();
  const old = now - KEEP_DAYS * 864e5;
  await env.DB.prepare('DELETE FROM subs WHERE family IN (SELECT id FROM families WHERE updated < ?)').bind(old).run();
  await env.DB.prepare('DELETE FROM tickets WHERE created < ?').bind(old).run();
  // a family with photos stays (the album and the day's log belong together); others go after a week
  await env.DB.prepare('DELETE FROM families WHERE created < ? AND id NOT IN (SELECT DISTINCT family FROM photos)').bind(old).run();
  if (!env.VAPID_PRIVATE_JWK) return;
  const { results } = await env.DB.prepare(
    'SELECT s.device, s.sub, s.prefs, s.memo, f.data FROM subs s JOIN families f ON f.id = s.family WHERE f.updated > ?',
  ).bind(now - 14 * 3600e3).all();
  if (!results.length) return;
  const live = await getLive(ctx).catch(() => null);
  if (!live || !live.open || now < live.open - 15 * 60e3 || now > live.close + 15 * 60e3) return;
  for (const r of results) {
    try {
      const { notes, memo } = decideNotifications({ fam: JSON.parse(r.data), deviceId: r.device, live, now, prefs: JSON.parse(r.prefs), memo: JSON.parse(r.memo) });
      for (const n of notes) {
        const status = await sendPush(env, JSON.parse(r.sub), n);
        if (status === 404 || status === 410) { await env.DB.prepare('DELETE FROM subs WHERE device = ?').bind(r.device).run(); break; }
      }
      await env.DB.prepare('UPDATE subs SET memo = ? WHERE device = ?').bind(JSON.stringify(memo), r.device).run();
    } catch (err) {
      console.error('notify', r.device, err);
    }
  }
}

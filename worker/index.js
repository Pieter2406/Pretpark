// Pretpark Worker: /api/* only (everything else is a static file from public/).
// - /api/live: Walibi Belgium wait times (ThemeParks.wiki), cached 60 s
// - /api/family: the shared family state (D1), changed through validated actions
// - /api/push: Web Push subscriptions; a cron every minute decides and sends notifications
import { newFamily, apply } from '../public/family.js';
import { decideNotifications } from '../public/logic.js';
import { sendPush, publicKey } from './push.js';

const DEST = '8d8a8cc7-4523-4437-8bb6-5c87a26ba5ce'; // Walibi Belgium on ThemeParks.wiki
const KEEP_DAYS = 7;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    try {
      if (parts[1] === 'health') return json({ ok: true });
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
  const [live, sched] = await Promise.all([
    fetch(`https://api.themeparks.wiki/v1/entity/${DEST}/live`).then((r) => (r.ok ? r.json() : null)),
    fetch(`https://api.themeparks.wiki/v1/entity/${DEST}/schedule`, { cf: { cacheTtl: 3600 } }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
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
  };
  ctx?.waitUntil?.(cache.put(key, new Response(JSON.stringify(out), { headers: { 'cache-control': 'max-age=60' } })));
  return out;
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

// ---------- cron: every minute
async function notifyAll(env, ctx) {
  await schema(env);
  const now = Date.now();
  await env.DB.prepare('DELETE FROM subs WHERE family IN (SELECT id FROM families WHERE created < ?)').bind(now - KEEP_DAYS * 864e5).run();
  await env.DB.prepare('DELETE FROM families WHERE created < ?').bind(now - KEEP_DAYS * 864e5).run();
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

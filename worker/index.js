// Pretpark Worker: /api/* only (everything else is a static file from public/).
// - /api/live: Walibi Belgium wait times (ThemeParks.wiki), cached 60 s
// - /api/family: the shared family state (D1), changed through validated actions
// - /api/push: Web Push subscriptions; a cron every minute decides and sends notifications
// - /api/tickets: imported admission tickets (code crop + page image), shared by the family
// - /api/photos: the shared photo album, originals + thumbnails in R2 (EU), metadata in D1
// Everything is behind Cloudflare Access (e-mail code) and checked again here (access.js).
import { newFamily, apply, okDevice } from '../public/family.js';
import { accessEmail } from './access.js';
import { decideNotifications, parkOpen } from '../public/logic.js';
import { okEndpoint, readyMessage, okDataUrl, liveRides, chatMessage, chatNote } from './rules.js';
import { okToken, newToken, otFixes, otTypes, step, actionsFor, freshTracker, TOILETS } from './owntracks.js';
import { sendPush, publicKey } from './push.js';

const DEST = '8d8a8cc7-4523-4437-8bb6-5c87a26ba5ce'; // Walibi Belgium on ThemeParks.wiki
// Retention (cron): tickets and families without photos go 30 days after the family's last change, push
// subscriptions 7 days after it. Photos (and the families that have them) are kept until deleted by hand.
const KEEP_FAMILY_DAYS = 30;
const KEEP_SUBS_DAYS = 7;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    try {
      if (parts[1] === 'health') return json({ ok: true });
      // OwnTracks can't log in with Access: this one path is bypassed in Access and checked by its secret token
      if (parts[1] === 'ot') return await ownTracks(request, env, ctx, parts[2]);
      const email = await accessEmail(request);
      if (!email) return json({ error: 'auth' }, 401);
      if (parts[1] === 'photos') return await photos(request, env, email, parts[2], parts[3], parts[4]);
      if (parts[1] === 'tickets') return await tickets(request, env, parts[2], parts[3]);
      if (parts[1] === 'chat') return await chat(request, env, ctx, email, parts[2]);
      if (parts[1] === 'live') return json(await getLive(ctx));
      if (parts[1] === 'vapid') return json({ key: env.VAPID_PRIVATE_JWK ? publicKey(env) : null });
      if (parts[1] === 'family') return await family(request, env, ctx, parts[2]);
      if (parts[1] === 'push') return await push(request, env);
      if (parts[1] === 'otsetup') return await otSetup(request, env, url, parts[2]);
      if (parts[1] === 'diag' && request.method === 'POST') return await diag(request, env, email);
      return json({ error: 'not found' }, 404);
    } catch (err) {
      if (err.status) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'server error' }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(notifyAll(env, ctx, event?.scheduledTime));
  },
};

const fail = (status, message) => Object.assign(new Error(message), { status });

// ---------- live data
async function getLive(ctx) {
  const cache = caches.default;
  const key = new Request('https://cache.pretpark/live-v2');
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const [live, sched, wx] = await Promise.all([
    fetch(`https://api.themeparks.wiki/v1/entity/${DEST}/live`, { signal: AbortSignal.timeout(5000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch(`https://api.themeparks.wiki/v1/entity/${DEST}/schedule`, { cf: { cacheTtl: 3600 }, signal: AbortSignal.timeout(4000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    // the weather is a nice-to-have: never let a slow MET Norway hold up the wait times
    Promise.race([getWeather(), new Promise((r) => setTimeout(() => r(wxCache?.v ?? null), 3000))]),
  ]);
  if (!live) {
    // ThemeParks.wiki is down or slow: the last good copy (≤ 10 min old), marked stale, beats nothing
    if (lastLive && Date.now() - lastLive.t < 10 * 60e3) return { ...lastLive, stale: true };
    throw fail(502, 'live data unavailable');
  }
  const rides = liveRides(live.liveData);
  const now = Date.now();
  const today = brusselsDate(now);
  const day = (sched?.parks?.[0]?.schedule || sched?.schedule || []).find((s) => s.date === today && s.type === 'OPERATING');
  const open = day ? Date.parse(day.openingTime) : null, close = day ? Date.parse(day.closingTime) : null;
  const out = {
    t: now, rides, open, close, scheduleKnown: !!day,
    minutesLeft: close ? Math.max(0, Math.round((close - now) / 60e3)) : null,
    localTime: brusselsLocal(now),
    weather: wx,
  };
  lastLive = out;
  ctx?.waitUntil?.(cache.put(key, new Response(JSON.stringify(out), { headers: { 'cache-control': 'max-age=60' } })));
  return out;
}
let lastLive = null; // per isolate
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
    env.DB.prepare('CREATE TABLE IF NOT EXISTS messages (family TEXT NOT NULL, id TEXT NOT NULL, t INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (family, id))'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS messages_family ON messages (family, t)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS subs (device TEXT PRIMARY KEY, family TEXT NOT NULL, sub TEXT NOT NULL, prefs TEXT NOT NULL, memo TEXT NOT NULL, updated INTEGER NOT NULL)'),
    // OwnTracks: one secret token per phone; tracker = activity.js state (≤ 45 min of cleaned positions); info = last fix
    env.DB.prepare('CREATE TABLE IF NOT EXISTS ot (token TEXT PRIMARY KEY, family TEXT NOT NULL, device TEXT NOT NULL, tracker TEXT NOT NULL, info TEXT NOT NULL, last INTEGER NOT NULL, created INTEGER NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS ot_device ON ot (family, device)'),
    // photos deleted on purpose: a late upload of the same id (the other phone, a retry) is refused with 410
    env.DB.prepare('CREATE TABLE IF NOT EXISTS photo_gone (id TEXT PRIMARY KEY, family TEXT NOT NULL, t INTEGER NOT NULL)'),
    // problems a phone reports about itself (photo uploads, storage): so a failure on someone's phone can be seen
    env.DB.prepare('CREATE TABLE IF NOT EXISTS diag (t INTEGER NOT NULL, family TEXT, device TEXT, email TEXT, kind TEXT NOT NULL, msg TEXT NOT NULL)'),
  ]).catch((err) => { ready = null; throw err; });
  return ready;
}
const okFamily = (id) => typeof id === 'string' && /^[a-z0-9]{12,32}$/.test(id);

// Responses: { id, fam, updated } (updated = the row's version, ms); create answers 201.
async function family(request, env, ctx, id) {
  await schema(env);
  const now = Date.now();
  if (!id) {
    if (request.method !== 'POST') throw fail(405, 'method not allowed');
    const newId = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
    const fam = newFamily(now);
    await env.DB.prepare('INSERT INTO families (id, data, created, updated) VALUES (?, ?, ?, ?)').bind(newId, JSON.stringify(fam), now, now).run();
    return json({ id: newId, fam, updated: now }, 201);
  }
  if (!okFamily(id)) throw fail(400, 'bad family');
  if (request.method === 'GET') {
    const row = await env.DB.prepare('SELECT data, updated FROM families WHERE id = ?').bind(id).first();
    if (!row) throw fail(404, 'no-family');
    return json({ id, fam: JSON.parse(row.data), updated: row.updated });
  }
  if (request.method !== 'POST') throw fail(405, 'method not allowed');
  const text = await request.text();
  if (text.length > 8000) throw fail(413, 'too big');
  let act; try { act = JSON.parse(text); } catch { throw fail(400, 'bad json'); }
  return json(await applyAction(env, ctx, id, act, now));
}
// Apply one validated action with optimistic concurrency (re-read and retry if the other phone changed it in between).
// → { id, fam, updated, changed }
async function applyAction(env, ctx, id, act, now = Date.now()) {
  for (let i = 0; i < 4; i++) {
    const row = await env.DB.prepare('SELECT data, updated FROM families WHERE id = ?').bind(id).first();
    if (!row) throw fail(404, 'no-family');
    const before = JSON.parse(row.data);
    let fam;
    try { fam = apply(before, act, now); } catch (e) { throw fail(400, e.message); }
    if (fam === before) return { id, fam, updated: row.updated, changed: false }; // already applied (same aid)
    const t = Math.max(now, row.updated + 1);
    const res = await env.DB.prepare('UPDATE families SET data = ?, updated = ? WHERE id = ? AND updated = ?').bind(JSON.stringify(fam), t, id, row.updated).run();
    if (res.meta.changes === 1) {
      if (act.type === 'ready' && fam.target && JSON.stringify(fam.target.ready) !== JSON.stringify(before.target?.ready)) {
        ctx?.waitUntil?.(notifyReady(env, id, fam, act).catch((err) => console.error('ready push', err)));
      }
      const same = (k) => JSON.stringify(fam[k]) === JSON.stringify(before[k]);
      return { id, fam, updated: t, changed: !same('done') || !same('target') || !same('car') };
    }
  }
  throw fail(409, 'busy, try again');
}

// ---------- OwnTracks: background location from the free OwnTracks app (worker/owntracks.js)
// POST /api/ot/<token>: always answers 200 [] (OwnTracks keeps retrying anything else, also after an error of ours),
// so a revoked token is quiet and a failure never makes a phone resend the same batch forever.
async function ownTracks(request, env, ctx, token) {
  if (request.method !== 'POST' || !okToken(token)) return json([]);
  if (Number(request.headers.get('content-length') || 0) > 400000) return json([]); // before reading the body
  try { await otReceive(request, env, ctx, token); } catch (err) { console.error('ot', err?.message || err); }
  return json([]);
}
async function otReceive(request, env, ctx, token) {
  await schema(env);
  const row = await env.DB.prepare('SELECT token, family, device, tracker, info, last FROM ot WHERE token = ?').bind(token).first();
  if (!row) return;
  const text = await request.text();
  if (text.length > 400000) return;
  const now = Date.now();
  const fixes = otFixes(text, now);
  if (!fixes.length) {
    // OwnTracks reached us but sent no location (e.g. its "status" message on connect): remember the contact, so the
    // app can say "connected, now choose Actie and tap ↑" instead of "nothing received"
    // one atomic update of just these two fields: a location saved in parallel is never overwritten by an old copy
    await env.DB.prepare("UPDATE ot SET info = json_set(coalesce(info, '{}'), '$.contact', ?, '$.types', json(?)) WHERE token = ?").bind(now, JSON.stringify(otTypes(text)), token).run();
    return;
  }
  const tr = freshTracker(JSON.parse(row.tracker || 'null'), fixes[0].t);
  const famRow = await env.DB.prepare('SELECT data FROM families WHERE id = ?').bind(row.family).first();
  if (!famRow) return;
  let fam = JSON.parse(famRow.data);
  const live = await getLive(ctx).catch(() => null);
  let lastGood = null, rejected = 0;
  const notes = [];
  for (const fix of fixes) {
    const { events, T, r } = step(tr, fix, fam, row.device, live);
    if (!r.ok) { rejected++; continue; }
    lastGood = { ...r.pos, batt: fix.batt };
    for (const e of events) {
      for (const { act, note } of actionsFor(e, T, fam, row.device)) {
        let changed = true;
        if (act) {
          try { const res = await applyAction(env, ctx, row.family, act, now); fam = res.fam; changed = res.changed; }
          catch (err) { console.error('ot action', act.type, err.message); delete tr.emitted[e.key]; continue; } // may fire again later
        }
        if (note && changed) notes.push(note);
      }
    }
  }
  // the partner dot on the other phone: our latest good position (at most once a minute or after 25 m)
  const prev = fam.positions?.[row.device];
  if (lastGood && okDevice(row.device) && now - lastGood.t < 10 * 60e3
    && (!prev || lastGood.t - prev.t > 60e3 || Math.hypot((lastGood.lat - prev.lat) * 111194, (lastGood.lon - prev.lon) * 70500) > 25)) {
    try { await applyAction(env, ctx, row.family, { type: 'pos', device: row.device, lat: lastGood.lat, lon: lastGood.lon, at: lastGood.t }, now); } catch { /* ignore */ }
  }
  const info = { t: lastGood?.t || null, acc: lastGood ? Math.round(lastGood.acc) : null, batt: lastGood?.batt ?? null, n: fixes.length, rejected, contact: now };
  // versioned on `last`: a parallel request for the same phone that saved first wins; we then send no pushes
  // (its own run already decided them), so a burst of retries never doubles a notification
  const res = await env.DB.prepare('UPDATE ot SET tracker = ?, info = ?, last = ? WHERE token = ? AND last = ?').bind(JSON.stringify(tr), JSON.stringify(info), Math.max(now, (row.last || 0) + 1), token, row.last).run();
  if (res.meta.changes !== 1) return;
  for (const note of notes) ctx.waitUntil(notifyDevice(env, row.family, row.device, note).catch((err) => console.error('ot push', err)));
}
async function notifyDevice(env, family, device, note) {
  if (!env.VAPID_PRIVATE_JWK) return;
  const r = await env.DB.prepare('SELECT sub, prefs FROM subs WHERE device = ? AND family = ?').bind(device, family).first();
  if (!r) return;
  let prefs = {}; try { prefs = JSON.parse(r.prefs) || {}; } catch { /* default */ }
  if (prefs.auto === false) return; // "automatisch herkend" notifications switched off
  const status = await pushTo(env, r.sub, note);
  if (status === 404 || status === 410) await env.DB.prepare('DELETE FROM subs WHERE device = ?').bind(device).run();
}
// /api/otsetup/<family>?device=…  GET status, POST { device } → a new token (replaces this phone's old one), DELETE stop
async function otSetup(request, env, url, id) {
  await schema(env);
  if (!okFamily(id)) throw fail(400, 'bad family');
  const fam = await env.DB.prepare('SELECT id FROM families WHERE id = ?').bind(id).first();
  if (!fam) throw fail(404, 'no-family');
  // GET ?all=1: every phone's OwnTracks link in this family, for the location check (never the tokens)
  if (request.method === 'GET' && url.searchParams.get('all') === '1') {
    const { results } = await env.DB.prepare('SELECT device, info, last, created FROM ot WHERE family = ?').bind(id).all();
    return json({ links: results.map((r) => ({ device: r.device, info: JSON.parse(r.info || '{}'), last: r.last, created: r.created })) });
  }
  let device = url.searchParams.get('device');
  if (request.method === 'POST') { try { device = (await request.json())?.device; } catch { throw fail(400, 'bad json'); } }
  if (!okDevice(device)) throw fail(400, 'bad device');
  if (request.method === 'GET') {
    const r = await env.DB.prepare('SELECT token, info, last, created FROM ot WHERE family = ? AND device = ?').bind(id, device).first();
    return json(r ? { active: true, token: r.token, info: JSON.parse(r.info), last: r.last, created: r.created } : { active: false });
  }
  if (request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM ot WHERE family = ? AND device = ?').bind(id, device).run();
    return json({ active: false });
  }
  if (request.method !== 'POST') throw fail(405, 'method not allowed');
  const token = newToken(), now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM ot WHERE family = ? AND device = ?').bind(id, device),
    env.DB.prepare('INSERT INTO ot (token, family, device, tracker, info, last, created) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(token, id, device, 'null', '{}', 0, now),
  ]);
  return json({ active: true, token, info: {}, last: 0, created: now }, 201);
}

// Sends one notification; a stored subscription that isn't (or is no longer) a valid push service counts as gone.
async function pushTo(env, subText, note) {
  const sub = JSON.parse(subText);
  if (!okEndpoint(sub?.endpoint)) return 410;
  return sendPush(env, sub, note);
}
async function notifyReady(env, id, fam, act) {
  if (!env.VAPID_PRIVATE_JWK) return;
  const { results } = await env.DB.prepare('SELECT device, sub FROM subs WHERE family = ?').bind(id).all();
  const note = readyMessage(fam, act.part);
  await Promise.all(results.filter((r) => r.device !== act.device).map(async (r) => {
    try {
      const status = await pushTo(env, r.sub, note);
      if (status === 404 || status === 410) await env.DB.prepare('DELETE FROM subs WHERE device = ?').bind(r.device).run();
    } catch (err) {
      console.error('ready push', r.device, err);
    }
  }));
}

// ---------- family chat: { id, t, kind: 'text'|'loc', text, lat, lon, near, person, by, device }
// GET ?after=<ms> → newer messages (max 300, oldest first); without `after` the last 200.
// POST is idempotent per (family, id), so an offline retry never doubles a message; new ones are pushed at once.
async function chat(request, env, ctx, email, fam) {
  await schema(env);
  if (!okFamily(fam)) throw fail(400, 'bad family');
  const row = await env.DB.prepare('SELECT data FROM families WHERE id = ?').bind(fam).first();
  if (!row) throw fail(404, 'no-family');
  if (request.method === 'GET') {
    const after = Number(new URL(request.url).searchParams.get('after'));
    const { results } = Number.isFinite(after) && after > 0
      ? await env.DB.prepare('SELECT data FROM messages WHERE family = ? AND t > ? ORDER BY t LIMIT 300').bind(fam, after).all()
      : await env.DB.prepare('SELECT data FROM (SELECT data, t FROM messages WHERE family = ? ORDER BY t DESC LIMIT 200) ORDER BY t').bind(fam).all();
    return json(results.map((r) => JSON.parse(r.data)));
  }
  if (request.method !== 'POST') throw fail(405, 'method not allowed');
  const text = await request.text();
  if (text.length > 4000) throw fail(413, 'too big');
  let b; try { b = JSON.parse(text); } catch { throw fail(400, 'bad json'); }
  const msg = chatMessage(b, email, Date.now());
  if (!msg) throw fail(400, 'bad message');
  const res = await env.DB.prepare('INSERT OR IGNORE INTO messages (family, id, t, data) VALUES (?, ?, ?, ?)').bind(fam, msg.id, msg.t, JSON.stringify(msg)).run();
  if (res.meta.changes === 1) ctx?.waitUntil?.(notifyChat(env, fam, JSON.parse(row.data), msg).catch((err) => console.error('chat push', err)));
  else {
    const prev = await env.DB.prepare('SELECT data FROM messages WHERE family = ? AND id = ?').bind(fam, msg.id).first();
    return json(prev ? JSON.parse(prev.data) : msg);
  }
  return json(msg, 201);
}
async function notifyChat(env, id, fam, msg) {
  if (!env.VAPID_PRIVATE_JWK) return;
  const { results } = await env.DB.prepare('SELECT device, sub, prefs FROM subs WHERE family = ?').bind(id).all();
  const note = chatNote(fam, msg);
  await Promise.all(results.filter((r) => r.device !== msg.device && JSON.parse(r.prefs || '{}').chat !== false).map(async (r) => {
    try {
      const status = await pushTo(env, r.sub, note);
      if (status === 404 || status === 410) await env.DB.prepare('DELETE FROM subs WHERE device = ?').bind(r.device).run();
    } catch (err) { console.error('chat push', r.device, err); }
  }));
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
  const prefs = { fav: body.prefs?.fav !== false, best: body.prefs?.best !== false, food: body.prefs?.food !== false, down: body.prefs?.down !== false, chat: body.prefs?.chat !== false, auto: body.prefs?.auto !== false, diaper: body.prefs?.diaper !== false };
  const s = body.sub;
  if (s) {
    if (!okEndpoint(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) throw fail(400, 'bad subscription');
    const sub = JSON.stringify({ endpoint: s.endpoint, keys: { p256dh: String(s.keys.p256dh).slice(0, 200), auth: String(s.keys.auth).slice(0, 100) } });
    await env.DB.prepare(`INSERT INTO subs (device, family, sub, prefs, memo, updated) VALUES (?, ?, ?, ?, '{}', ?)
      ON CONFLICT(device) DO UPDATE SET family = excluded.family, sub = excluded.sub, prefs = excluded.prefs, updated = excluded.updated`)
      .bind(body.device, body.family, sub, JSON.stringify(prefs), Date.now()).run();
  } else {
    await env.DB.prepare('UPDATE subs SET prefs = ?, family = ? WHERE device = ?').bind(JSON.stringify(prefs), body.family, body.device).run();
  }
  if (body.test) {
    const row = await env.DB.prepare('SELECT sub FROM subs WHERE device = ?').bind(body.device).first();
    if (!row) throw fail(404, 'no subscription');
    const status = await pushTo(env, row.sub, { tag: 'test', title: '🎢 Pretpark', body: 'Meldingen staan aan. Veel plezier!', url: '/' });
    return json({ ok: status < 300, status });
  }
  return json({ ok: true, prefs });
}

// ---------- tickets: { id, meta: { name, person, code, format, page: n, source }, crop: dataURL png, page: dataURL jpeg }
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
    name: String(t.name ?? '').slice(0, 40), person: /^(p\d{1,2}|car)$/.test(t.person) ? t.person : null, // 'car' = the parking ticket
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
  if (!okDataUrl(t.crop, 900_000) || !okDataUrl(t.page, 900_000)) throw fail(400, 'bad image');
  const own = await env.DB.prepare('SELECT family FROM tickets WHERE id = ?').bind(t.id).first();
  if (own && own.family !== fam) throw fail(409, 'id taken'); // never replace another family's ticket
  if (!own) {
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM tickets WHERE family = ?').bind(fam).first();
    if (n.n >= 20) throw fail(400, 'too many tickets');
  }
  await env.DB.prepare('INSERT OR REPLACE INTO tickets (id, family, meta, crop, page, created) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(t.id, fam, JSON.stringify(meta), t.crop ?? null, t.page ?? null, Number.isFinite(t.created) && Math.abs(t.created - Date.now()) < 7 * 864e5 ? Math.round(t.created) : Date.now()).run(); // the phone's import order
  return json({ ok: true }, 201);
}

// ---------- photos: originals in R2 at <family>/<id> and <family>/<id>.t (thumbnail), metadata in D1
const IMG_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'image/avif', 'image/gif'];
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
    // the original may still be on its way (the phone sent the small version first): show the small one meanwhile,
    // never cached (so the original replaces it) and marked, so the app doesn't share or save it as the original
    let obj = await env.PHOTOS.get(`${fam}/${id}${what === 'thumb' ? '.t' : ''}`), stand = false;
    if (!obj && what !== 'thumb') { obj = await env.PHOTOS.get(`${fam}/${id}.t`); stand = !!obj; }
    if (!obj) throw fail(404, 'no photo');
    const h = new Headers();
    obj.writeHttpMetadata(h);
    h.set('etag', obj.httpEtag);
    h.set('cache-control', stand ? 'no-store' : 'private, max-age=31536000, immutable');
    if (stand) h.set('x-pretpark-small', '1');
    h.set('x-content-type-options', 'nosniff');
    const url = new URL(request.url);
    if (url.searchParams.get('dl')) {
      const ext = (h.get('content-type') || 'image/jpeg').split('/')[1].replace('jpeg', 'jpg');
      h.set('content-disposition', `attachment; filename="walibi-${obj.customMetadata?.stamp || id}.${ext}"`);
    }
    return new Response(obj.body, { headers: h });
  }
  if (request.method === 'DELETE' && id) {
    const other = await env.DB.prepare('SELECT family FROM photos WHERE id = ?').bind(id).first();
    if (other && other.family !== fam) throw fail(404, 'no photo');
    await env.PHOTOS.delete([`${fam}/${id}`, `${fam}/${id}.t`]);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM photos WHERE family = ? AND id = ?').bind(fam, id),
      env.DB.prepare('INSERT OR REPLACE INTO photo_gone (id, family, t) VALUES (?, ?, ?)').bind(id, fam, Date.now()),
    ]);
    return json({ ok: true });
  }
  if (request.method === 'PATCH' && id) {
    const body = await request.json().catch(() => ({}));
    const row = await env.DB.prepare('SELECT meta FROM photos WHERE family = ? AND id = ?').bind(fam, id).first();
    if (!row) throw fail(404, 'no photo');
    // only the fields sent: one phone starring while the other writes a caption doesn't wipe either change
    const meta = { ...JSON.parse(row.meta), ...('caption' in body ? { caption: String(body.caption ?? '').slice(0, 200) } : {}), ...('star' in body ? { star: !!body.star } : {}) };
    await env.DB.prepare('UPDATE photos SET meta = ? WHERE family = ? AND id = ?').bind(JSON.stringify(meta), fam, id).run();
    return json({ ok: true, meta });
  }
  if (request.method !== 'POST' || !id) throw fail(405, 'method not allowed');
  // multipart: full (original file), thumb (jpeg), meta (json). With meta.thumbOnly the phone sends the small version
  // first (seconds, even on a weak signal), so the photo is in the shared album at once; the original follows later.
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_PHOTO + 2e6) throw fail(413, 'photo too big');
  // The client drops a queued upload only on 'bad photo' (400) or 'photo too big' (413): anything else is retried.
  const form = await request.formData();
  const full = form.get('full'), thumb = form.get('thumb');
  let m = {}; try { m = JSON.parse(form.get('meta') || '{}'); } catch { /* defaults */ }
  const prev = await env.DB.prepare('SELECT family, meta FROM photos WHERE id = ?').bind(id).first();
  if (prev && prev.family !== fam) throw fail(409, 'id taken'); // never replace another family's photo
  if (await env.DB.prepare('SELECT 1 FROM photo_gone WHERE id = ? AND family = ?').bind(id, fam).first()) throw fail(410, 'deleted');
  if (m.thumbOnly === true && !(full instanceof File)) {
    if (!(thumb instanceof File) || thumb.size === 0 || thumb.size >= 2e6) throw fail(400, 'bad photo');
    const old = prev ? JSON.parse(prev.meta) : null;
    if (old && old.full !== false) return json({ ok: true, id, t: (await env.DB.prepare('SELECT t FROM photos WHERE id = ?').bind(id).first())?.t, ...old }, 200); // original already here
    await env.PHOTOS.put(`${fam}/${id}.t`, thumb.stream(), { httpMetadata: { contentType: 'image/jpeg' } });
    const t0 = Number.isFinite(+m.t) && +m.t > 1.6e12 && +m.t < Date.now() + 864e5 ? +m.t : Date.now();
    const meta0 = { by: email, size: Math.max(0, Math.round(+m.size) || 0), type: 'image/jpeg', full: false,
      w: Math.round(+m.w) || null, h: Math.round(+m.h) || null,
      lat: Number.isFinite(+m.lat) && m.lat !== null ? +m.lat : null, lon: Number.isFinite(+m.lon) && m.lon !== null ? +m.lon : null,
      near: String(m.near ?? '').slice(0, 60), caption: String(old?.caption || m.caption || '').slice(0, 200), star: !!old?.star };
    // insert, or update only while the original isn't there: a slow small-version request that finishes after the
    // original never downgrades it
    await env.DB.prepare(`INSERT INTO photos (id, family, meta, t, created) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET meta = excluded.meta, t = excluded.t WHERE json_extract(photos.meta, '$.full') = 0`).bind(id, fam, JSON.stringify(meta0), t0, Date.now()).run();
    const now0 = await env.DB.prepare('SELECT meta, t FROM photos WHERE id = ?').bind(id).first();
    return json({ ok: true, id, t: now0?.t ?? t0, ...(now0 ? JSON.parse(now0.meta) : meta0) }, 201);
  }
  if (!(full instanceof File) || full.size === 0 || full.size > MAX_PHOTO) throw fail(400, 'bad photo');
  // not an image (or an SVG, which could run script on this origin): refused. No type (multipart sends a typeless
  // file as application/octet-stream) or an unusual image type: stored as image/jpeg like before (browsers sniff
  // the real image format; served with nosniff)
  const ft = full.type.toLowerCase();
  if (ft && ft !== 'application/octet-stream' && (!ft.startsWith('image/') || /svg|xml/.test(ft))) throw fail(400, 'bad photo');
  const type = IMG_TYPES.includes(ft) ? ft : 'image/jpeg';
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
  if (prev) { // the same upload again (its answer got lost): keep a star or caption set in the meantime
    const old = JSON.parse(prev.meta);
    meta.star = !!old.star; if (old.caption) meta.caption = old.caption;
  }
  await env.DB.prepare('INSERT OR REPLACE INTO photos (id, family, meta, t, created) VALUES (?, ?, ?, ?, ?)')
    .bind(id, fam, JSON.stringify(meta), t, Date.now()).run();
  return json({ ok: true, id, t, ...meta }, 201);
}

// ---------- a phone's own problem report (best effort, small, kept 3 days)
async function diag(request, env, email) {
  await schema(env);
  const text = await request.text();
  if (text.length > 8000) throw fail(413, 'too big');
  let b; try { b = JSON.parse(text); } catch { throw fail(400, 'bad json'); }
  const list = (Array.isArray(b.items) ? b.items : []).slice(0, 20);
  const family = okFamily(b.family) ? b.family : null, device = okDevice(b.device) ? b.device : null;
  for (const it of list) {
    await env.DB.prepare('INSERT INTO diag (t, family, device, email, kind, msg) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(Number.isFinite(it.t) ? Math.round(it.t) : Date.now(), family, device, email, String(it.kind || '?').slice(0, 40), String(it.msg || '').slice(0, 400)).run();
  }
  return json({ ok: true });
}

// ---------- cron: every minute
async function notifyAll(env, ctx, at) {
  await schema(env);
  const now = Date.now();
  const oldFam = now - KEEP_FAMILY_DAYS * 864e5, oldSubs = now - KEEP_SUBS_DAYS * 864e5;
  // retention once an hour (these scan whole tables: every minute would add up to millions of D1 reads a day)
  if (new Date(at || now).getUTCMinutes() === 17) await retention(env, now, oldFam, oldSubs);
  if (!env.VAPID_PRIVATE_JWK) return;
  await pushAll(env, ctx, now);
}
async function retention(env, now, oldFam, oldSubs) {
  // by the family's last change (not by ticket/sub age); rows of families that no longer exist go too
  await env.DB.prepare('DELETE FROM tickets WHERE family IN (SELECT id FROM families WHERE updated < ?) OR family NOT IN (SELECT id FROM families)').bind(oldFam).run();
  await env.DB.prepare('DELETE FROM subs WHERE family IN (SELECT id FROM families WHERE updated < ?) OR family NOT IN (SELECT id FROM families)').bind(oldSubs).run();
  // a family with photos stays (the album and the day's log belong together); photos are never deleted here
  await env.DB.prepare('DELETE FROM families WHERE updated < ? AND id NOT IN (SELECT DISTINCT family FROM photos)').bind(oldFam).run();
  await env.DB.prepare('DELETE FROM messages WHERE t < ? OR family NOT IN (SELECT id FROM families)').bind(oldFam).run();
  await env.DB.prepare('DELETE FROM photo_gone WHERE t < ?').bind(oldFam).run();
  await env.DB.prepare('DELETE FROM diag WHERE t < ?').bind(now - 3 * 864e5).run();
  // OwnTracks links: gone after a day without positions (the location track itself is never kept longer than 45 min)
  await env.DB.prepare('DELETE FROM ot WHERE (last < ? AND created < ?) OR family NOT IN (SELECT id FROM families)').bind(Date.now() - 24 * 3600e3, Date.now() - 24 * 3600e3).run();
}
async function pushAll(env, ctx, now) {
  const { results } = await env.DB.prepare(
    'SELECT s.device, s.sub, s.prefs, s.memo, f.data FROM subs s JOIN families f ON f.id = s.family WHERE f.updated > ?',
  ).bind(now - 14 * 3600e3).all();
  if (!results.length) return;
  const live = await getLive(ctx).catch(() => null);
  if (!parkOpen(live, now)) return; // schedule window, or (schedule unknown) at least one ride running
  for (const r of results) {
    try {
      const { notes, memo } = decideNotifications({ fam: JSON.parse(r.data), deviceId: r.device, live, now, prefs: JSON.parse(r.prefs), memo: JSON.parse(r.memo), toilets: TOILETS });
      for (const n of notes) {
        const status = await pushTo(env, r.sub, n);
        if (status === 404 || status === 410) { await env.DB.prepare('DELETE FROM subs WHERE device = ?').bind(r.device).run(); break; }
      }
      await env.DB.prepare('UPDATE subs SET memo = ? WHERE device = ?').bind(JSON.stringify(memo), r.device).run();
    } catch (err) {
      console.error('notify', r.device, err);
    }
  }
}

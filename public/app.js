// Pretpark: the screens. State lives in S; changes call render(). The shared family state lives on the server
// (family.js actions, versioned by `updated`); wait times come from /api/live; walking routes from route.js.
import './compat.js'; // first: fallbacks for older iPhones
import { ATTRACTIONS, FOOD, ENTRANCE } from './data.js';
import { plans, foodOptions, canRide, status, byId, walkMin, isMealTime, distM, raining, WX_ICON, sunTimes, isDaylight, waitFactor, markedClosed, toddlerOf, diaperDue, nearestToilet, COOL } from './logic.js';
import { QUESTS, FACTS } from './fun.js';
import { freshTracker, addFix, detect, farState } from './activity.js';
import { makePark, pathLength, bearingXY } from './route.js';
import { apply, phoneOf } from './family.js';
import { showsOn, spookyOn, nextShow, dayKind, ADVICE } from './shows.js';
import { idb } from './idb.js';
import { PHOTOS } from './photos.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (x, d = 0) => (Number.isFinite(+x) ? +x : d);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('pp:' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pp:' + k, JSON.stringify(v)); } catch { /* private mode: fine */ } },
};
const rnd = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
const buzz = (ms = 12) => navigator.vibrate?.(ms);
const hhmm = (t) => new Date(t).toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' });

const device = store.get('device') || (() => { const d = rnd(16); store.set('device', d); return d; })();
const S = {
  famId: null, fam: null, famUpdated: 0, live: null, park: null, here: null, plans: [],
  gps: null, gpsAt: 0, manual: store.get('manual', null), sim: 'wait', heading: null, headingSrc: null,
  // location cleaning + "what are we doing" (activity.js); auto = recognise queue/done/eat/rest/car by itself
  tr: freshTracker(store.get('tracker', null), Date.now()),
  auto: store.get('auto', true), autoLog: store.get('autoLog', []), pendingRate: null, ask: null, pocket: false, gpsReject: '',
  gpsStats: { ok: 0, since: Date.now() }, otAll: null, otAllAt: 0,
  tickets: [], ticketBusy: '', auth: false, liveStale: false, outbox: [], offline: false,
  album: store.get('c:album', null)?.v || [], uploads: [], upMsg: '', albumOff: false, keep: new Map(), queue: new Map(), mem: [],
  tab: 'now', mapMode: 'map', guide: null, filter: 'us', placing: false, dismissed: store.get('dismissed', {}),
  history: store.get('history', []), voice: store.get('voice', false),
  // 'sun' = light while the sun is up at Walibi, dark from sunset; also 'light', 'dark', 'system' (follow the phone)
  theme: store.get('theme', store.get('autoNight', true) === false ? 'system' : 'sun'),
  newVersion: false,
  chat: store.get('c:chat', null)?.v || [], chatQ: store.get('chatq', []), chatRead: store.get('chatRead', 0), chatOpen: false,
};

// ---------- people
const people = () => S.fam?.people || [];
const meId = () => S.fam?.me?.[device] || null;
// nothing in progress on screen: no dialog/sheet/guide/pocket open, no text being typed, no upload or import running
const calmMoment = () => !document.hidden && !S.guide && !S.pocket && !S.chatOpen && $('#sheet')?.hidden !== false && !S.ticketBusy && !uploading
  && !document.activeElement?.matches?.('input, textarea, select');
// ---------- diagnostics: problems on this phone (photo uploads, storage, crashes) go to the server (/api/diag), so a
// failure on someone's phone can be looked at from afar. Small, batched, at most one send per 10 s, same kind ≤ 1/min.
const diagQ = [], diagSeen = new Map();
let diagTimer = null;
function diag(kind, msg) {
  const now = Date.now(), k = kind + String(msg).slice(0, 60);
  if (now - (diagSeen.get(k) || 0) < 60e3) return;
  diagSeen.set(k, now);
  diagQ.push({ t: now, kind, msg: `${String(msg).slice(0, 300)} · ${navigator.userAgent.match(/(iPhone OS [\d_]+|Android [\d.]+|Version\/[\d.]+|Chrome\/\d+)/g)?.join(' ') || ''}${navigator.standalone ? ' · app' : ''}` });
  if (diagQ.length > 40) diagQ.splice(0, diagQ.length - 40);
  diagTimer ??= setTimeout(sendDiag, 10e3);
}
async function sendDiag() {
  diagTimer = null;
  if (!diagQ.length) return;
  const items = diagQ.splice(0, 20);
  try { await fetch('/api/diag', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ family: S.famId, device, items }), redirect: 'manual' }); }
  catch { diagQ.unshift(...items); }
  if (diagQ.length) diagTimer = setTimeout(sendDiag, 30e3);
}
addEventListener('pp-diag', (e) => diag(e.detail.kind, e.detail.msg));
// A photo taken with the in-app camera can be lost when the phone closes the browser while the camera is open (low
// memory; mostly Android): Pretpark then starts again and the photo never arrives. Remember that the camera was opened;
// a cancelled camera clears it a few seconds after coming back; finding it at the next start means it happened.
document.addEventListener('click', (e) => {
  const inp = e.target.closest?.('label')?.querySelector('input[type=file][capture]') || (e.target.matches?.('input[type=file][capture]') ? e.target : null);
  if (inp) store.set('camOpen', Date.now());
}, true);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && store.get('camOpen', 0)) setTimeout(() => { if (Date.now() - store.get('camOpen', 0) > 4e3) store.set('camOpen', 0); }, 6e3);
});
function checkLostCamera() {
  const t = store.get('camOpen', 0);
  store.set('camOpen', 0);
  if (!t || Date.now() - t > 20 * 60e3) return;
  store.set('camLost', store.get('camLost', 0) + 1);
  diag('camera-lost', `restart ${Math.round((Date.now() - t) / 1000)} s after the camera opened`);
  setTimeout(() => toast('⚠️ Je gsm sloot Pretpark terwijl de camera open stond: die foto kwam niet aan. Neem foto’s liever met de camera-app van je gsm en voeg ze toe met 🖼️ Uit galerij (dan staan ze ook in je Foto’s).', null, 12000), 1500);
}
// what this phone still holds that isn't online (so a "lost" photo can be found from afar)
function reportAlbumState(why) {
  const onServer = new Set(S.album.filter((p) => p.full !== false).map((p) => p.id));
  const kept = [...S.keep.values()];
  diag('album-state', `${why}: server ${S.album.length} · kept here ${kept.length} (not original online ${kept.filter((k) => !onServer.has(k.id)).length}, refused ${kept.filter((k) => k.refused).length}) · queue ${S.queue.size} · memory ${S.mem.length} · camera lost ${store.get('camLost', 0)}`);
}
addEventListener('error', (e) => diag('js-error', `${e.message} @ ${String(e.filename).split('/').pop()}:${e.lineno}`));
addEventListener('unhandledrejection', (e) => diag('js-reject', `${e.reason?.name || ''} ${e.reason?.message || e.reason}`));
// people other phones chose. Nothing claimed yet → the first adult is preselected; otherwise nobody (a second phone may be
// the partner's, or the same person's home-screen app: they must pick) and claimed names say so
const claimed = () => new Set(Object.entries(S.fam?.me || {}).filter(([d]) => d !== device).map(([, p]) => p));
const freeAdult = () => (claimed().size ? null : people().find((p) => p.kind === 'adult')?.id || null);
const person = (id) => people().find((p) => p.id === id);
// live status, but a ride the family marked "Is dicht" counts as closed (map pins, list order)
const famStatus = (id) => { const st = status(S.live, id); return markedClosed(S.fam?.closed, id) ? { ...st, open: false, wait: null, s: 'MARKED' } : st; };
const emoji = (p) => (p?.pregnant ? '🤰' : p?.kind === 'adult' ? '🧑' : p?.height < 110 ? '👶' : '🧒');
const pname = (p) => (p.id === meId() ? 'Jij' : p.name);
const names = (ids) => ids.map((id) => person(id)).filter(Boolean).map(pname).join(' + ');
const photoOf = (a) => (a && PHOTOS[a.name]) || null;
const photoSrc = (a) => (photoOf(a) ? `/img/rides/${photoOf(a).fn}` : null);
const credit = (a) => { const p = photoOf(a); return p ? `Foto: ${esc(p.artist || 'Wikimedia Commons')} · <a href="${esc(p.page)}" target="_blank" rel="noopener">${esc(p.license || 'licentie')}</a>` : ''; };
const icon = (a, cls = 'thumb') => (photoSrc(a) ? `<img class="${cls}" src="${photoSrc(a)}" alt="" loading="lazy">` : `<span aria-hidden="true">${a.icon}</span>`);
const hasToddler = () => people().some((p) => p.kind === 'child' && p.height < 110);

// ---------- network
// Errors: e.offline (no network or too slow), e.status 401 (Cloudflare Access session expired: log in again)
// AbortSignal.timeout exists from iOS 16: older phones get the same with a controller and a timer
const timeoutSignal = (ms) => { if (AbortSignal.timeout) return AbortSignal.timeout(ms); const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; };
async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...opts, redirect: 'manual', signal: timeoutSignal(opts.timeout || 7000),
      headers: { 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    S.offline = true;
    throw Object.assign(new Error('offline'), { offline: true });
  }
  S.offline = false;
  if (res.type === 'opaqueredirect' || res.status === 401) { S.auth = true; renderBanners(); throw Object.assign(new Error('auth'), { status: 401 }); }
  S.auth = false;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.status), { status: res.status, error: data.error });
  return data;
}
// Last good copies, so the app opens and plans without signal
const cached = {
  save(k, v) { store.set('c:' + k, { t: Date.now(), v }); },
  load(k) { return store.get('c:' + k, null); },
};
const saveFam = () => cached.save('fam', { id: S.famId, fam: S.fam, updated: S.famUpdated });
// Only accept a server copy that is at least as new as the one we have (a slow poll must not undo a tap)
function takeFam(r) {
  if (!r?.fam) return false;
  const u = num(r.updated, 0);
  if (u && u < S.famUpdated) return false;
  S.fam = r.fam; if (u) S.famUpdated = u;
  // actions still waiting to be sent stay visible on top of the server's copy (apply skips any it already has, by aid)
  for (const a of S.outbox) { try { S.fam = apply(S.fam, a, a.at); } catch { /* invalid now: the server will say so */ } }
  saveFam();
  return true;
}
// actions in flight (by aid): survive the page being killed mid-request; the server de-dupes a re-send
const inflight = (a, on) => { const m = store.get('inflight', null); const x = m && !Array.isArray(m) && !m.aid ? m : {}; if (on) x[a.aid] = a; else delete x[a.aid]; store.set('inflight', x); };

// Change the shared family state. Every action carries an id (the server ignores repeats) and the time it happened.
// Offline: apply it here with the same rules as the server and send it later.
async function act(a, quiet = false) {
  a = { ...a, ...(a.type === 'pos' ? {} : { aid: a.aid || rnd(10) }), at: a.at || Date.now() };
  // older actions still waiting: this one goes behind them (a late replay must never overtake a newer action)
  if (a.type !== 'pos' && S.outbox.length) {
    try { S.fam = apply(S.fam, a, a.at); } catch { return false; }
    S.outbox.push(a); store.set('outbox', S.outbox); saveFam();
    recompute(); if (!quiet) render();
    flushOutbox();
    return true;
  }
  if (a.type !== 'pos') inflight(a, true);
  try {
    const r = await api('/api/family/' + S.famId, { method: 'POST', body: a });
    if (a.type !== 'pos') inflight(a, false);
    const key = (f) => JSON.stringify([f?.target?.setAt, f?.target?.ready, f?.done]);
    const was = key(S.fam);
    takeFam(r); recompute();
    // a quiet action (rate, guess, pos…) can bring the other phone's done/plan/ready: then the screen must follow too
    if (!quiet || key(S.fam) !== was) render();
    return true;
  } catch (e) {
    if (a.type !== 'pos') inflight(a, false);
    if (e.offline && a.type !== 'pos') {
      try { S.fam = apply(S.fam, a, a.at); } catch { return false; }
      S.outbox.push(a); store.set('outbox', S.outbox); saveFam();
      recompute(); if (!quiet) { render(); toast('Offline: bewaard, ik stuur het door zodra er bereik is'); }
      return true;
    }
    if (!quiet && !e.offline && e.status !== 401) toast('Dat lukte niet. Probeer zo opnieuw.');
    renderBanners();
    return false;
  }
}
let flushing = false;
async function flushOutbox() {
  if (flushing || !S.outbox.length || !S.famId) return;
  flushing = true;
  try {
    while (S.outbox.length) {
      const head = S.outbox[0];
      try { const r = await api('/api/family/' + S.famId, { method: 'POST', body: { ...head, tries: undefined, firstFail: undefined } }); S.outbox.shift(); store.set('outbox', S.outbox); takeFam(r); continue; }
      catch (e) {
        if (e.offline || e.status === 401) break; // no signal / log in again: retry later, nothing lost
        // a rejected action is dropped; one that keeps failing (busy, server error) is given up after 6 tries AND
        // 15 min (a short server hiccup never loses an offline "Gedaan"), so it never blocks everything behind it
        head.tries = (head.tries || 0) + 1; head.firstFail ||= Date.now();
        if (e.status !== 400 && (head.tries < 6 || Date.now() - head.firstFail < 15 * 60e3)) { store.set('outbox', S.outbox); break; }
        if (e.status !== 400) toast('Een oude wijziging lukte niet en is overgeslagen.');
      }
      S.outbox.shift(); store.set('outbox', S.outbox);
    }
    recompute(); render();
  } finally { flushing = false; }
}

const famIdOf = (s) => { const m = String(s || '').match(/[?&]g=([a-z0-9]{12,32})/) || String(s || '').trim().match(/^([a-z0-9]{12,32})$/); return m?.[1] || null; };
async function loadFamily() {
  const url = new URL(location.href);
  const id = famIdOf(url.search) || store.get('fam');
  if (!id) return false; // no family yet: onboarding asks "new" or "join with a link"
  const c = cached.load('fam');
  if (c?.v?.id === id) { S.fam = c.v.fam; S.famId = id; S.famUpdated = num(c.v.updated); } // instant start from the last copy
  try {
    const r = await api('/api/family/' + id);
    S.famId = id; takeFam(r);
  } catch (e) {
    if (e.status === 404) { store.set('fam', null); S.fam = null; S.famId = null; return false; }
    if (!S.fam) throw e;
  }
  store.set('fam', S.famId);
  // keep the family in the address, so "Add to Home Screen" and sharing carry it
  history.replaceState(null, '', url.pathname + '?g=' + S.famId);
  return true;
}
async function newFamily() {
  const r = await api('/api/family', { method: 'POST' });
  S.famId = r.id; S.fam = r.fam; S.famUpdated = num(r.updated);
  store.set('fam', S.famId); saveFam();
  history.replaceState(null, '', location.pathname + '?g=' + S.famId);
}
async function joinFamily(text) {
  const id = famIdOf(text);
  if (!id) { toast('Dat is geen gezinslink'); return false; }
  try { await api('/api/family/' + id); } catch (e) { toast(e.status === 404 ? 'Dat gezin bestaat niet (meer)' : 'Geen verbinding'); return false; }
  store.set('fam', id); store.set('c:fam', null);
  location.href = '/?g=' + id;
  return true;
}
async function loadLive() {
  try {
    const L = await api('/api/live');
    // another server copy can be older than what we already have (a stale fallback): never step back in time
    if (S.live?.t && L?.t && L.t < S.live.t) { S.liveStale = !!L.stale; }
    else { S.live = L; S.liveStale = !!L?.stale; cached.save('live', S.live); rememberWaits(S.live); }
  } catch { if (!S.live) S.live = cached.load('live')?.v || null; S.liveStale = !!S.live; }
  recompute(); render();
}
async function loadOtAll() {
  // every minute while someone uses OwnTracks or the Gezin tab is open, else every 10 min
  if (!S.famId || Date.now() - S.otAllAt < (S.otAll?.length || S.tab === 'fam' ? 55e3 : 600e3)) return;
  S.otAllAt = Date.now();
  try { S.otAll = (await api(`/api/otsetup/${S.famId}?all=1`)).links || []; renderBanners(); if (S.tab === 'fam') renderLocCheck(); } catch { /* next time */ }
}
async function pollFamily() {
  if (document.hidden || !S.famId) return;
  loadOtAll();
  if (!S.chatOpen) loadChat();
  await flushOutbox(); // waiting local changes are re-applied on top of whatever the server sends (takeFam)
  try {
    const before = JSON.stringify(S.fam);
    if (takeFam(await api('/api/family/' + S.famId)) && JSON.stringify(S.fam) !== before) {
      const t = S.fam.target;
      // the other phone said "we're ready"
      if (t?.ready && !S.seenReady?.[t.setAt]) {
        const other = Object.keys(t.ready).map(Number).find((i) => !t.plan.parts[i]?.group.includes(meId()));
        if (other != null) { S.seenReady = { ...S.seenReady, [t.setAt]: 1 }; buzz([60, 40, 60]); toast(`✅ ${names(t.plan.parts[other].group)} zijn klaar`); }
      }
      recompute(); render();
    }
  } catch { /* next time */ }
}

// ---------- wait trends: the last 45 minutes of waits, to show ↗ / ↘
function rememberWaits(L) {
  if (!L?.rides) return;
  const w = Object.fromEntries(Object.entries(L.rides).filter(([, r]) => r.w != null).map(([id, r]) => [id, num(r.w)]));
  S.history = [...S.history.filter((h) => L.t - h.t < 45 * 60e3 && h.t !== L.t), { t: L.t, w }].slice(-50);
  store.set('history', S.history);
}
function trend(id) {
  const now = status(S.live, id).wait;
  if (now == null || !S.live) return 0;
  const old = S.history.find((h) => S.live.t - h.t >= 15 * 60e3 && h.w[id] != null);
  if (!old) return 0;
  const d = now - old.w[id];
  return d >= 10 ? 1 : d <= -10 ? -1 : 0;
}
const trendIcon = (id) => ({ 1: '<span class="trend up" title="stijgt">↗</span>', '-1': '<span class="trend down" title="daalt">↘</span>' })[trend(id)] || '';

// ---------- position
const GPS_STALE = 3 * 60e3;
const pos = () => {
  if (S.manual && Date.now() - S.manual.t < 20 * 60e3) return S.manual;
  if (S.gps && S.sim === null && Date.now() - S.gpsAt < 20 * 60e3) return S.gps;
  return ENTRANCE;
};
let lastPlanPos = null, lastPost = { t: 0, p: null }, watchId = null, trSaveT = null;
// at most every 15 s (fixes come every second, so a debounce would never fire), and when the app goes to the back
const saveTracker = () => { if (!trSaveT) trSaveT = setTimeout(() => { trSaveT = null; store.set('tracker', S.tr); }, 15000); };
function onGps(p) {
  const c = p.coords, now = Date.now();
  // some phones stamp fixes with a clock that isn't the wall clock: only trust the fix's own time when plausible,
  // and never in the future (a later fix would look out of order)
  const t = Math.abs((p.timestamp || 0) - now) < 3600e3 ? Math.min(now, p.timestamp) : now;
  const r = addFix(S.tr, { lat: c.latitude, lon: c.longitude, acc: c.accuracy, t, speed: c.speed ?? null }, now);
  saveTracker();
  if (!r.ok) {
    S.gpsReject = r.reason; S.gpsStats[r.reason] = (S.gpsStats[r.reason] || 0) + 1;
    if (r.reason === 'approx') { if (!S.gps && S.sim === 'wait') S.sim = null; if (now - (onGps.bannerT || 0) > 30e3) { onGps.bannerT = now; renderBanners(); } }
    // a poor fix (under trees, between buildings) never feeds the detection, but when nothing better came for 30 s
    // it still moves the dot and the arrow, so the guide doesn't freeze
    if (r.reason === 'acc' && c.accuracy <= 200 && now - S.gpsAt > 30e3) usePosition({ lat: c.latitude, lon: c.longitude, acc: c.accuracy }, c, false);
    if (S.pocket) renderPocket();
    return;
  }
  S.gpsReject = ''; S.gpsStats.ok++; S.gpsGoodAt = Date.now();
  usePosition({ lat: r.pos.lat, lon: r.pos.lon, acc: r.pos.acc }, c, true, r.pos);
  runDetect(r.gap);
}
function usePosition(g, c, good, posT) {
  const now = Date.now();
  S.gps = g; S.gpsAt = now;
  const wasSim = S.sim;
  if (good) S.sim = farState(S.tr, posT, ENTRANCE) ? 'far' : null;
  else if (S.sim === 'wait') S.sim = null;
  if (wasSim !== S.sim) renderBanners();
  if (S.headingSrc !== 'compass' && c.heading != null && c.speed > 0.6 && c.accuracy <= 30) { S.heading = c.heading; S.headingSrc = 'gps'; }
  const here = pos();
  if (S.pocket) { if (!lastPlanPos || distM(lastPlanPos, here) > 40) { lastPlanPos = here; recompute(); } renderPocket(); }
  else if (!lastPlanPos || distM(lastPlanPos, here) > 12) { recompute(); render(); }
  else if (S.guide) { S.here = S.park.fromHere(here); updateGuide(); } // the guide follows every fix, the plan only every 12 m
  // in the park: every 25 m / 3 min (partner dot, the cron's tips). Away from Walibi: the real spot every 10 min, so the
  // cron knows we went home and stops park tips (pos() would say "at the entrance")
  const away = S.sim === 'far' && good;
  if (good && S.famId && (!S.sim || away) && (away ? now - lastPost.t > 600e3 : !lastPost.p || (distM(lastPost.p, here) > 25 && now - lastPost.t > 60e3) || now - lastPost.t > 180e3)) {
    const p = away ? { lat: g.lat, lon: g.lon } : here;
    lastPost = { t: now, p };
    act({ type: 'pos', device, lat: p.lat, lon: p.lon }, true);
  }
}
function onGpsError(err) {
  // only "not allowed" means no location; a timeout in a queue or between buildings keeps the last fix
  if (err.code === 1) { S.sim = 'off'; recompute(); render(); }
}
function startGps() {
  if (!navigator.geolocation) { S.sim = 'off'; return; }
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  // maximumAge 0: never a cached fix (we check the age ourselves too); the watch is restarted when the app comes
  // back to the front, because phones stop it in the background and don't always resume it
  watchId = navigator.geolocation.watchPosition(onGps, onGpsError, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}
const insidePark = (p) => {
  const o = S.park?.data?.outline; if (!o) return false;
  const q = S.park.toXY(p); let inside = false;
  for (let i = 0, j = o.length - 2; i < o.length; j = i, i += 2) {
    const xi = o[i], yi = o[i + 1], xj = o[j], yj = o[j + 1];
    if ((yi > q.y) !== (yj > q.y) && q.x < ((xj - xi) * (q.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

// ---------- automatic: what are we doing? (activity.js decides; here we apply it, always with "Klopt niet")
function myTarget() {
  const t = S.fam?.target, plan = t?.plan;
  if (!plan || (plan.type === 'split' && !meId())) return null; // don't act for the wrong half
  const i = myIdx(plan), pt = plan.parts[i];
  if (!pt) return null;
  const q = t.q?.[i] || (!t.q && t.queued ? { t: t.queued } : null);
  return { i, plan, a: pt.rest ? null : byId[pt.id], rest: !!pt.rest, setAt: t.setAt, queuedAt: q?.t || null, boardedAt: q?.b || null, queuedAuto: !!q?.auto,
    wait: q?.w ?? (pt.id ? status(S.live, pt.id).wait ?? pt.wait : null),
    // the wait the park posts (null when it reports none): what a queue stores; a planner guess would skew waitFactor
    posted: q?.w ?? (pt.id && status(S.live, pt.id).known ? status(S.live, pt.id).wait : null) };
}
function runDetect(gap) {
  if (!S.auto || !S.fam || S.sim || (S.manual && Date.now() - S.manual.t < 20 * 60e3)) return; // a chosen spot only counts 20 min
  const T = myTarget();
  const tq = S.fam.target;
  const queueing = !!tq && (Object.values(tq.q || {}).some((q) => !q.b) || (!tq.q && !!tq.queued));
  const ev = detect(S.tr, { now: Date.now(), target: T, queueing, foods: FOOD, mealTime: isMealTime(new Date()), ate: S.fam.ate, pause: S.fam.pause,
    entrance: ENTRANCE, inPark: insidePark, carT: S.fam.car?.t || 0, gap });
  if (ev.length) saveTracker();
  for (const e of ev) autoApply(e, T).then((done) => { if (done === false) setTimeout(() => { delete S.tr.emitted[e.key]; }, 120e3); });
}
// remember what was recognised; its "Klopt niet" stays on Nu for 15 min (in pocket mode no toast: a tap through
// the fabric must not undo anything)
function autoLog(text, undo = null, toastText = '') {
  S.autoLog = [{ t: Date.now(), text }, ...S.autoLog].slice(0, 6); store.set('autoLog', S.autoLog);
  S.lastUndo = undo ? { fn: undo, t: Date.now(), text } : null;
  buzz([20, 60, 20]);
  if (toastText && !S.pocket) toast(toastText, undo ? { label: 'Klopt niet', fn: undoLast } : null, 8000);
}
async function undoLast() {
  const u = S.lastUndo; S.lastUndo = null;
  if (u) { await u.fn(); toast('Teruggezet'); }
  render();
}
async function autoApply(e, T) {
  const name = T?.a?.name || '';
  switch (e.type) {
    case 'queue':
      if (!(await act({ type: 'queue', part: T.i, wait: T.posted, at: e.at, auto: true }, true))) return false;
      autoLog(`⏳ In de rij bij ${name} sinds ${hhmm(e.at)}`, () => act({ type: 'unqueue', part: T.i }), `⏳ In de rij bij ${name} (automatisch)`);
      break;
    case 'board':
      if (!(await act({ type: 'board', part: T.i, at: e.at }, true))) return false;
      autoLog(`🎢 Aan de beurt bij ${name}`);
      break;
    case 'unqueue':
      if (!(await act({ type: 'unqueue', part: T.i }, true))) return false;
      autoLog(`↩️ Rij bij ${name} verlaten`, () => act({ type: 'queue', part: T.i, wait: T.posted, at: T.queuedAt }), `↩️ Rij bij ${name} verlaten? (automatisch)`);
      break;
    case 'done': if ((await finishPlan({ auto: true, at: e.at })) === false) return false; break;
    case 'ask-done': if (T?.a) { S.ask = { id: T.a.id, setAt: T.setAt }; buzz([20, 60, 20]); render(); } break;
    case 'ate':
      if (!(await act({ type: 'ate', at: e.at }, true))) return false;
      autoLog(`😋 Gegeten${e.where ? ` bij ${e.where}` : ''}`, null, '😋 Smakelijk! (eten herkend)'); break;
    case 'pause':
      if (!(await act({ type: 'pause', at: e.at }, true))) return false;
      autoLog('🪑 Even gerust'); break;
    case 'car':
      if (!(await act({ type: 'car', lat: e.lat, lon: e.lon, note: 'automatisch bewaard', at: e.at }, true))) return false;
      autoLog('🚗 Parkeerplek bewaard', () => act({ type: 'car', lat: null }), '🚗 Parkeerplek automatisch bewaard');
      break;
  }
  render();
}
// The detection card on Nu: open questions ("gedaan?", "hoe was het?") and what was recognised last
function autoCard() {
  let html = '';
  if (S.ask && S.fam?.target?.setAt === S.ask.setAt) {
    const a = byId[S.ask.id];
    html += `<div class="autoq"><span>🤔 Hebben jullie <b>${esc(a?.name || '')}</b> gedaan?</span><span class="row2"><button class="primary" data-go="askyes">✓ Ja</button><button data-go="askno">Nee</button></span></div>`;
  } else S.ask = null;
  const pr = S.pendingRate;
  if (pr && Date.now() - pr.t < 90 * 60e3) {
    const a = byId[pr.id];
    html += `<div class="autoq"><span>${icon(a)} Hoe was <b>${esc(a?.name || '')}</b>?</span><button data-go="rateopen">😍 🙂 😬</button><button class="ghost small" data-go="ratelater" aria-label="Niet nu">✕</button></div>`;
  }
  html += diaperCard();
  const last = S.auto && S.autoLog[0] && Date.now() - S.autoLog[0].t < 30 * 60e3 ? S.autoLog[0] : null;
  const undo = S.lastUndo && Date.now() - S.lastUndo.t < 15 * 60e3 ? S.lastUndo : null;
  if (last) html += `<p class="small muted autolog">🤖 ${esc(last.text)} · ${hhmm(last.t)}${undo && undo.text === last.text ? ' <button class="linkbtn" data-go="autoundo">Klopt niet</button>' : ''}</p>`;
  return html;
}

// ---------- diaper check: passing a toilet while the toddler's last check is ≥ 90 min ago ("Later" = 20 min quiet)
function diaperCard() {
  const tod = toddlerOf(people());
  if (!tod || !S.fam || !S.gps || Date.now() - S.gpsAt > 2 * 60e3 || S.sim) return '';
  if (S.live?.close && Date.now() > S.live.close) return '';
  if (!diaperDue(S.fam, S.live, Date.now()) || Date.now() - store.get('diaperLater', 0) < 20 * 60e3) return '';
  // in a split, only on the phone that is with the toddler
  const tp = S.fam.target?.plan;
  if (tp?.type === 'split' && meId() && !tp.parts.some((pt) => pt.group?.includes(tod.id) && pt.group.includes(meId()))) return '';
  const wc = nearestToilet(S.gps, S.park?.toilets);
  if (!wc || wc.d > 45) return '';
  if (diaperCard.buzzed !== Math.round(wc.lat * 1e4)) { diaperCard.buzzed = Math.round(wc.lat * 1e4); buzz([30, 50, 30]); }
  return `<div class="autoq"><span>🚼 Toilet op <b>${Math.round(wc.d * 1.2)} m</b>: even de luier van ${esc(tod.name)} checken?</span><span class="row2"><button class="primary" data-go="diaperdone">✓ Gedaan</button><button data-go="diaperlater">Later</button></span><button class="ghost small" data-go="toilet" style="width:100%">🧭 Breng me naar het toilet</button></div>`;
}

// ---------- shows (Ibilaw): the next one on Nu, the whole day in a sheet (data + sources in shows.js)
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const inMin = (m) => (m <= 0 ? 'nu' : m < 60 ? `over ${m} min` : `over ${Math.floor(m / 60)} u ${String(m % 60).padStart(2, '0')}`);
function showCard() {
  if (!dayKind(todayStr()) || (S.live?.close && Date.now() > S.live.close)) return '';
  const n = nextShow(todayStr(), nowMin(), 5);
  if (!n || n.min - nowMin() > 90) return '<button class="ghost small showbtn" data-go="shows">🎭 Shows & Halloween vandaag</button>';
  const m = n.min - nowMin();
  return `<div class="showcard"><span class="ic" aria-hidden="true">${n.icon}</span><span><b>${esc(n.name)}</b> · ${n.roughly ? 'vanaf ±' : ''}${n.hm} <span class="muted">(${inMin(m)})</span><br><span class="small muted">${esc(n.where)}</span></span>
    <span class="row2">${n.lat ? `<button data-showgo="${esc(n.id)}">🧭 Erheen</button>` : ''}<button data-go="shows">Alle shows</button></span></div>`;
}
function openShows() {
  const date = todayStr(), k = dayKind(date), now = nowMin();
  if (!k) { openSheet('<h2>🎭 Shows</h2><p class="muted">Vandaag is er geen Halloween-programma (Ibilaw loopt van 10 oktober tot 11 november 2026).</p>'); return; }
  const shows = showsOn(date), spooky = spookyOn(date);
  const tod = toddlerOf(people());
  const showRow = (s) => { const past = s.min < now - 10; return `<div class="ride hrow ${past ? 'past' : ''}"><span aria-hidden="true">${s.icon}</span><span><b>${s.roughly ? '±' : ''}${s.hm}</b> ${esc(s.name)}<br><span class="small muted">${esc(s.where)}</span></span>
    ${!past && s.lat ? `<button class="ghost" data-showgo="${esc(s.id)}" aria-label="Breng me naar ${esc(s.name)}">🧭</button>` : `<span class="small muted">${past ? 'voorbij' : ''}</span>`}</div>`; };
  const spRow = (s) => { const open = now >= s.from && now < s.to; return `<div class="ride hrow ${now >= s.to ? 'past' : ''}"><span aria-hidden="true">${s.icon}</span><span><b>${esc(s.name)}</b> <span class="small">${s.fromHm}–${s.toHm}${open ? ' · <b>nu open</b>' : ''}</span><br><span class="small muted">${esc(s.where)}${s.near ? ` · bij ${esc(s.near)}` : ''} · ${esc(s.price)}</span></span>
    ${s.lat && now < s.to ? `<button class="ghost" data-showgo="${esc(s.id)}" aria-label="Breng me naar ${esc(s.name)}">🧭</button>` : ''}</div>`; };
  openSheet(`<h2>🎭 Shows & Halloween vandaag</h2>
    <p class="small muted">${k === 'ext' ? 'Verlengde Halloweendag: open tot 22:00.' : 'Halloweendag: open tot 18:00.'} Tijden van walibi.be (gecontroleerd 7 nov); kijk bij twijfel op het bord aan de ingang.</p>
    <h3>Shows</h3><div class="list hist">${shows.map(showRow).join('')}</div>
    <p class="small muted">${shows.map((s) => s.about).filter((x, i, a) => a.indexOf(x) === i).map(esc).join(' ')} Het Tiki Theater staat niet op de kaart: 🧭 brengt je naar de Tiki-Bar ernaast.</p>
    <h3>Spookhuizen</h3><div class="list hist">${spooky.filter((s) => s.kind === 'house').map(spRow).join('')}</div>
    <h3>Scare zones</h3><div class="list hist">${spooky.filter((s) => s.kind === 'zone').map(spRow).join('')}</div>
    ${spooky.some((s) => s.kind === 'food') ? `<h3>Eten</h3><div class="list hist">${spooky.filter((s) => s.kind === 'food').map(spRow).join('')}</div>` : ''}
    <p class="small">⚠️ ${esc(ADVICE)}${tod ? ` Met ${esc(tod.name)}: de show en Bill's procession zijn het leukst; scare zones en spookhuizen liever niet.` : ''}</p>`);
}
function showGo(id) {
  const all = [...showsOn(todayStr()), ...spookyOn(todayStr())];
  const s = all.find((x) => x.id === id); if (!s?.lat) return;
  closeSheet(); guideTap({ kind: 'show', id: 'show-' + s.id, name: s.name, icon: s.icon, lat: s.lat, lon: s.lon });
}

// ---------- history (Nu › 📜 / Gezin): everything recorded today, newest first; a misclick can be deleted
// (with "Terugzetten") or moved to the right time; a ride that wasn't tapped can be added afterwards
const HIST = { ride: '🎢', ate: '🍽️', pause: '🪑', diaper: '🚼', car: '🚗' };
function historyItems() {
  const f = S.fam; if (!f) return [];
  const now = Date.now(), today = (t) => t && now - t < 14 * 3600e3;
  const out = [];
  for (const l of f.log || []) if (today(l.t)) for (const id of l.ids || []) if (byId[id]) out.push({ k: 'ride', id, t: l.t, s: l.s, icon: byId[id].icon, name: byId[id].name });
  const hist = (f.hist || []).filter((h) => today(h.t) && HIST[h.k]);
  // a meal/pause/check from before the history existed
  for (const k of ['ate', 'pause', 'diaper']) if (today(f[k]) && !hist.some((h) => h.k === k && h.t === f[k])) hist.push({ k, t: f[k] });
  const label = { ate: 'Gegeten', pause: 'Pauze', diaper: 'Luier gecheckt' };
  for (const h of hist) out.push({ k: h.k, t: h.t, icon: HIST[h.k], name: label[h.k] });
  if (today(f.car?.t)) out.push({ k: 'car', t: f.car.t, icon: '🚗', name: 'Parkeerplek bewaard', sub: f.car.note });
  return out.sort((a, b) => b.t - a.t);
}
const hhmmIn = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
// "14:05" → today at that time (ms), null when invalid, in the future or > 14 h ago
function timeToday(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v || ''); if (!m) return null;
  const d = new Date(); d.setHours(+m[1], +m[2], 0, 0);
  const t = d.getTime(), now = Date.now();
  return t > now + 60e3 || now - t > 14 * 3600e3 ? null : Math.min(t, now);
}
function openHistory() {
  const items = historyItems();
  const rides = [...ATTRACTIONS].sort((a, b) => a.name.localeCompare(b.name, 'nl'));
  openSheet(`<h2>📜 Geschiedenis van vandaag</h2>
    <p class="small muted">Verkeerd getikt? Tik op ✕ om het te verwijderen of tik op de tijd om ze aan te passen. Dit geldt voor het hele gezin.</p>
    ${items.length ? `<div class="list hist">${items.map((it) => {
      const key = esc(JSON.stringify({ k: it.k, t: it.t, ...(it.id ? { id: it.id } : {}), ...(it.s != null ? { s: it.s } : {}) }));
      return `<div class="ride hrow"><span aria-hidden="true">${it.icon}</span><span><b>${esc(it.name)}</b>${it.sub ? `<br><span class="small muted">${esc(it.sub)}</span>` : ''}</span>
        ${it.k === 'car' ? `<span class="small muted">${hhmm(it.t)}</span>` : `<input type="time" class="htime" value="${hhmmIn(it.t)}" data-hmove="${key}" aria-label="Tijd van ${esc(it.name)}">`}
        <button class="ghost hdel" data-hdel="${key}" aria-label="Verwijder ${esc(it.name)}">✕</button></div>`;
    }).join('')}</div>` : '<p class="muted">Nog niets vandaag.</p>'}
    <div class="card" style="margin-top:12px"><h3 style="margin:0 0 6px">＋ Vergeten attractie</h3>
      <p class="small muted" style="margin:0 0 8px">Gedaan maar niet getikt? Voeg ze hier toe (het plan blijft staan).</p>
      <select id="histRide" aria-label="Attractie"><option value="">Kies een attractie…</option>${rides.map((a) => `<option value="${a.id}">${a.icon} ${esc(a.name)}</option>`).join('')}</select>
      <div class="row2" style="margin-top:8px"><input type="time" id="histAddT" value="${hhmmIn(Date.now())}" aria-label="Hoe laat"><button class="primary" data-go="histadd">Toevoegen</button></div></div>`);
}
async function histDelete(it) {
  const name = it.k === 'ride' ? byId[it.id]?.name : { ate: 'Gegeten', pause: 'Pauze', diaper: 'Luiercheck', car: 'Parkeerplek' }[it.k];
  const car = S.fam.car;
  const { s, ...entry } = it;
  const ok = it.k === 'car' ? await act({ type: 'car', lat: null }, true) : await act({ type: 'histdel', ...entry }, true);
  if (!ok) return;
  // put it back exactly as it was
  const back = it.k === 'ride' ? { type: 'ridelog', id: it.id, when: it.t, ...(s != null ? { s } : {}) } : it.k === 'car' ? { type: 'car', lat: car.lat, lon: car.lon, note: car.note } : { type: it.k, at: it.t };
  toast(`${name} (${hhmm(it.t)}) verwijderd`, { label: 'Terugzetten', fn: async () => { if (await act(back, true)) { toast('Teruggezet'); if (!$('#sheet').hidden) openHistory(); render(); } } }, 7000);
  if (!$('#sheet').hidden) openHistory();
  render();
}

// ---------- pocket mode: screen on (black) so the location keeps coming while the phone is in a pocket
// iOS home-screen apps only keep the screen on from iOS 18.4 (the API exists earlier but does nothing there)
const iosOld = (() => { const m = navigator.userAgent.match(/OS (\d+)_(\d+)/); return /iPhone|iPad/.test(navigator.userAgent) && navigator.standalone && m && (+m[1] < 18 || (+m[1] === 18 && +m[2] < 4)); })();
async function openPocket() {
  // only useful when the screen really stays on: a web page gets no location with the screen off
  if (iosOld || !(await wake(true))) { toast('Zakmodus lukt niet op deze gsm: het scherm mag niet aan blijven (iPhone-beginschermapp: iOS 18.4 of nieuwer nodig, of spaarstand staat aan).', null, 7000); return; }
  S.pocket = true;
  $('#pocket').hidden = false; openDialog($('#pocket'));
  renderPocket();
}
function closePocket() {
  if (!S.pocket) return;
  S.pocket = false; $('#pocket').hidden = true; closeDialog($('#pocket'));
  if (!S.guide && $('#tview').hidden) wake(false);
  render();
  if (S.afterPocket) { toast(S.afterPocket, null, 7000); S.afterPocket = null; }
}
function renderPocket() {
  const el = $('#pocket'); if (!el || el.hidden) return;
  const T = myTarget();
  const q = T?.queuedAt ? `⏳ In de rij bij ${T.a?.name || ''} sinds ${hhmm(T.queuedAt)}` : T?.a ? `🎯 ${T.a.name}` : '';
  const gps = !S.gps || Date.now() - S.gpsAt > 2 * 60e3 ? '📡 zoekt locatie…' : `📍 ±${Math.round(S.gps.acc || 0)} m`;
  el.querySelector('.pk-time').textContent = hhmm(Date.now());
  el.querySelector('.pk-what').textContent = q;
  const last = S.autoLog[0] && Date.now() - S.autoLog[0].t < 30 * 60e3 ? S.autoLog[0].text : '';
  el.querySelector('.pk-auto').textContent = last && last !== q ? '🤖 ' + last : '';
  el.querySelector('.pk-gps').textContent = gps;
}

// ---------- compass (iOS asks permission on every start, so it's requested from the tap that opens the guide)
let smooth = null, compassOn = false;
function onOrientation(e) {
  let h = null;
  if (e.webkitCompassHeading != null) h = e.webkitCompassHeading;
  else if (e.absolute && e.alpha != null) h = 360 - e.alpha;
  if (h == null) return;
  h = (h + (screen.orientation?.angle || 0) + 360) % 360;
  if (smooth == null) smooth = h;
  else { const d = ((h - smooth + 540) % 360) - 180; smooth = (smooth + d * 0.25 + 360) % 360; }
  S.heading = smooth; S.headingSrc = 'compass';
  if (S.guide) headingSoon();
}
function enableCompass(fromTap) {
  if (compassOn) return Promise.resolve(true);
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) return Promise.resolve(false);
  const listen = () => {
    addEventListener('deviceorientationabsolute', onOrientation, true);
    addEventListener('deviceorientation', onOrientation, true);
    compassOn = true; return true;
  };
  if (typeof DOE.requestPermission === 'function') {
    if (!fromTap) return Promise.resolve(false);
    // called synchronously inside the tap, before any other await, so iOS accepts it
    return DOE.requestPermission().then((r) => (r === 'granted' ? listen() : false)).catch(() => false);
  }
  return Promise.resolve(listen());
}
let headingRaf = null;
const headingSoon = () => { if (!headingRaf) headingRaf = requestAnimationFrame(() => { headingRaf = null; guideHeading(); }); };

// ---------- planning
function recompute() {
  if (!S.park || !S.fam) return;
  const here = pos();
  lastPlanPos = here;
  S.here = S.park.fromHere(here);
  const closed = S.live?.close && Date.now() > S.live.close; // after closing time: nothing to suggest
  S.plans = S.live && !closed ? plans({ ...planCtx(), walk: (a) => S.here.metres(a) }) : [];
}
function planCtx() {
  const minutesLeft = S.live?.close ? Math.round((S.live.close - Date.now()) / 60e3) : null;
  return {
    people: people(), favs: S.fam.favs || [], done: S.fam.done || {}, rates: S.fam.rates || {}, waitFactor: waitFactor(S.fam.waits), closed: S.fam.closed || {}, now: Date.now(), live: S.live,
    month: new Date().getMonth(), minutesLeft: minutesLeft != null && minutesLeft > 0 ? minutesLeft : null, rain: raining(S.live), walkPref: S.fam.walk,
    clock: S.live?.close ? { now: new Date().getHours() * 60 + new Date().getMinutes(), close: new Date().getHours() * 60 + new Date().getMinutes() + minutesLeft } : null,
  };
}
const walkOf = (x) => (S.here ? S.here.metres(x) : distM(pos(), x) * 1.35);
// A concrete place to rest near the meeting point: the playground (with a toddler) or the nearest seats
function restSpot(near) {
  const opts = [];
  for (const p of S.park?.play || []) opts.push({ ...p, name: 'de speeltuin', icon: '🛝', kid: true });
  for (const f of FOOD.filter((x) => x.seat)) opts.push({ lat: f.lat, lon: f.lon, name: f.name, icon: '🪑' });
  const scored = opts.map((o) => ({ ...o, d: distM(near, o) - (o.kid && hasToddler() ? 80 : 0) })).sort((a, b) => a.d - b.d);
  return scored[0] || null;
}

// ---------- small render helpers
function waitBadge(id) {
  const st = status(S.live, id);
  if (markedClosed(S.fam?.closed, id)) return '<span class="wait w-off">dicht (gemeld)</span>';
  if (!st.known) return `<span class="wait w-off">${st.assumed ? '? min' : 'geen info'}</span>`;
  if (!st.open) return `<span class="wait w-off">${st.s === 'DOWN' ? 'storing' : 'dicht'}</span>`;
  if (st.wait == null) return '<span class="wait w-off">open</span>';
  const w = num(st.wait);
  const cls = w <= 10 ? 'w-ok' : w <= 25 ? 'w-mid' : 'w-bad';
  return `<span class="wait ${cls}" aria-label="${w} minuten wachten">${w}′${trendIcon(id)}</span>`;
}
const chip = (id, watch) => { const p = person(id); if (!p) return ''; return `<span class="chip ${watch ? 'watch' : ''} ${id === meId() ? 'me' : ''}">${emoji(p)} ${esc(pname(p))}${watch ? ' · kijkt toe' : ''}</span>`; };
const mins = (m) => `${walkMin(m)} min`;

function notesFor(part) {
  const a = byId[part.id]; const out = [];
  if (!a) return out;
  for (const id of part.escorted || []) { const p = person(id); if (p) out.push(['🤝', `${esc(p.name)} rijdt mee met een volwassene`]); }
  for (const id of part.watch || []) {
    const p = person(id); if (!p) continue;
    out.push(['👀', p.pregnant ? `${esc(p.name)} kijkt toe: niet voor zwangeren` : `${esc(p.name)} mag niet mee en kijkt toe`]);
  }
  if (a.preg && (part.ride || []).some((id) => person(id)?.pregnant)) out.push(['🤰', 'Rustige attractie, check het bordje voor zwangeren']);
  if (a.wet) out.push(['💧', 'Je kan nat worden']);
  if (a.indoor) out.push(['🏠', 'Binnen']);
  if (trend(a.id) === -1) out.push(['↘', 'De rij wordt korter']);
  if (part.waitKnown === false) out.push(['❔', status(S.live, a.id).assumed ? 'Geen live info van Walibi. Dicht? Tik op de attractie › “Is dicht”' : 'Wachttijd niet bekend']);
  return out;
}
const notesHtml = (n) => (n.length ? `<ul class="notes">${n.map(([i, t]) => `<li><span aria-hidden="true">${i}</span><span>${t}</span></li>`).join('')}</ul>` : '');

// the plans as drawn on screen, by key: a tap starts exactly the plan the family saw, even when a quiet update
// re-ordered S.plans since (indexes would point at another plan)
const shownPlans = new Map();
const shown = (p) => { if (shownPlans.size > 60) shownPlans.clear(); shownPlans.set(p.key, p); return esc(p.key); };
function planActions(plan, chosen) {
  if (!chosen) return `<button class="primary big" data-go="choose:0" data-pkey="${shown(plan)}">🧭 Doen! Breng me erheen</button>
    <button class="ghost small" data-qplan="${shown(plan)}" style="width:100%;margin-top:6px">⏳ We staan hier al in de rij</button>`;
  const t = S.fam.target;
  const mine = plan.parts.indexOf(myPart(plan));
  const queued = t.queued && !t.q ? `<p class="queued">⏳ In de rij sinds ${hhmm(t.queued)} (${Math.max(0, Math.round((Date.now() - t.queued) / 60e3))} min)</p>` : '';
  const ready = plan.type === 'split'
    ? (t.ready?.[mine] ? '<button disabled>✅ Gemeld: wij zijn klaar</button>' : '<button data-go="ready">✅ Wij zijn klaar</button>') : '';
  return `${queued}<button class="primary big" data-go="guide">🧭 Breng me erheen</button>
    <div class="row3">${t.q?.[mine] || plan.parts[mine]?.rest ? '' : '<button data-go="queue">⏳ In de rij</button>'}<button data-go="done">✓ Gedaan</button><button data-go="untarget">✕ Iets anders</button></div>
    ${ready ? `<div class="row1">${ready}</div>` : ''}`;
}
function ticket(plan, chosen) {
  if (plan.type === 'together') {
    const pt = plan.parts[0], a = byId[pt.id];
    if (!a) return '';
    const live = status(S.live, pt.id);
    const wait = num(live.wait ?? pt.wait);
    return `<article class="ticket" style="--notch: 62%">
      <div class="what">${photoSrc(a) ? `<div class="t-photo"><img src="${photoSrc(a)}" alt="${esc(a.name)}"><span class="cr">${credit(a)}</span></div>` : `<div class="icon" aria-hidden="true">${a.icon}</div>`}<h2>${esc(a.name)}</h2>
        <div class="who">${(pt.ride || []).map((id) => chip(id)).join('')}${(pt.watch || []).map((id) => chip(id, true)).join('')}</div></div>
      <div class="how">
        <div class="stats"><div class="stat"><b>${live.open || !live.known ? wait + '′' : '—'}${trendIcon(a.id)}</b><span>${live.open || !live.known ? 'wachten' : 'nu dicht'}</span></div>
        <div class="stat"><b>${walkMin(walkOf(a))}′</b><span>stappen</span></div></div>
        ${notesHtml(notesFor(pt))}
        ${planActions(plan, chosen)}
      </div></article>`;
  }
  const mine = myPart(plan);
  const meet = byId[plan.meet];
  if (!meet) return '';
  const t = chosen ? S.fam.target : null;
  const halves = plan.parts.map((pt, i) => {
    const isMine = pt === mine;
    const who = pt.group.map((id) => chip(id)).join('');
    const done = t?.ready?.[i] ? '<span class="chip ok">✅ klaar</span>' : t?.q?.[i]?.b ? '<span class="chip">🎢 aan de beurt</span>' : t?.q?.[i] ? `<span class="chip">⏳ in de rij sinds ${hhmm(t.q[i].t)}</span>` : '';
    if (pt.rest) {
      const r = restSpot(meet);
      return `<div class="half ${isMine ? 'mine' : ''}"><div class="who">${who}${done}</div><h3>${r?.icon || '🪑'} Even rusten</h3>
        <div class="meta">${r ? `Bij <b>${esc(r.name)}</b>, ${mins(distM(meet, r) * 1.35)} van ${esc(meet.name)}.` : `In de buurt van ${esc(meet.name)}.`}</div></div>`;
    }
    const a = byId[pt.id], live = status(S.live, pt.id);
    if (!a) return '';
    return `<div class="half ${isMine ? 'mine' : ''}"><div class="who">${who}${done}</div><h3>${icon(a)} ${esc(a.name)}</h3>
      <div class="meta">⏱ <b>${num(live.wait ?? pt.wait)} min</b>${trendIcon(a.id)} wachten · 🚶 ${mins(walkOf(a))} stappen</div>
      ${notesHtml(notesFor(pt).filter(([i2]) => i2 !== '👀'))}</div>`;
  }).join('');
  return `<article class="ticket" style="--notch: -100px">
    <div class="halves">${halves}</div>
    <div class="meet">📍 Daarna afspreken aan de uitgang van <b>${esc(meet.name)}</b></div>
    <div class="how">${planActions(plan, chosen)}</div></article>`;
}
// A plan for "we're standing in line at this ride" picked by hand. In a split (and we know who we are) only our half
// switches to this ride, the other half keeps theirs; otherwise the whole family is on it.
function planForRide(id) {
  const a = byId[id], t = S.fam.target, st = status(S.live, id);
  const wait = st.known && st.wait != null ? st.wait : null;
  const side = (group) => ({ id, group, ride: group.filter((pid) => canRide(person(pid), a)), watch: group.filter((pid) => !canRide(person(pid), a)), escorted: [],
    walkM: Math.round(walkOf(a) || 0), wait, waitKnown: wait != null, minutes: Math.round((wait ?? (a.cat === 'kids' ? 5 : 10)) + (a.ride || 3)) });
  if (t?.plan?.type === 'split' && meId()) {
    const i = myIdx(t.plan);
    const parts = t.plan.parts.map((p, j) => (j === i ? side(p.group) : { ...p }));
    if (parts[0].rest) return null; // the split's meeting point must be a ride
    return { type: 'split', key: `${parts.map((p) => p.id || 'rest').join('+')}:hand`, parts, meet: parts[0].id, score: 0, minutes: Math.max(...parts.map((p) => p.minutes || 0)) };
  }
  const p = side(people().map((x) => x.id));
  return { type: 'together', key: `${id}:hand`, parts: [p], score: 0, minutes: p.minutes };
}
// "⏳ We staan in de rij" for a ride chosen by hand (ride sheet) or the suggestion before choosing it
async function queueAt(plan) {
  if (!plan) { toast('Kies eerst een plan op Nu'); return; }
  const t = S.fam.target;
  if (!t?.plan || t.plan.key !== plan.key) { if (!(await act({ type: 'target', plan, device }, true))) return; }
  const p = S.fam.target?.plan; if (!p) return;
  if (p.type === 'split' && !meId()) { toast('Kies eerst wie je bent, dan weet ik welke rij van jullie is'); onboard('who'); return; }
  const i = myIdx(p), pt = p.parts[i];
  if (S.fam.target.q?.[i]) { toast('Jullie staan al in de rij'); return; }
  if (!(await act({ type: 'queue', part: i, wait: pt?.id && status(S.live, pt.id).known ? status(S.live, pt.id).wait : null }))) return;
  closeSheet(); if (S.guide) closeGuide(); scrollTo(0, 0);
  toast(`⏳ In de rij bij ${byId[pt.id]?.name || ''}: spelletjes en aftellen op Nu`);
}
function myPart(plan) {
  return plan.parts.find((pt) => pt.group.includes(meId())) || plan.parts[0];
}
function guideTargetFor(plan) {
  const pt = myPart(plan);
  if (pt.rest) {
    const meet = byId[plan.meet]; const r = restSpot(meet) || meet;
    return { kind: 'meet', id: 'rest', name: r.name === meet.name ? `Bij ${meet.name}` : r.name, icon: r.icon || '🪑', lat: r.lat, lon: r.lon };
  }
  const a = byId[pt.id];
  return { kind: 'ride', id: a.id, name: a.name, icon: a.icon, lat: a.lat, lon: a.lon };
}
// Variety in "Ook goed": the best plan for everyone together and one where the toddler rides, then by score
function alternatives(exclude) {
  const rest = S.plans.filter((p) => p.key !== exclude);
  const pick = [];
  const add = (p) => { if (p && !pick.includes(p) && pick.length < 3) pick.push(p); };
  add(rest.find((p) => p.type === 'together'));
  const tod = people().filter((p) => p.kind === 'child' && p.height < 110).map((p) => p.id);
  if (tod.length) add(rest.find((p) => p.parts.some((pt) => !pt.rest && tod.some((id) => pt.ride?.includes(id)))));
  for (const p of rest) add(p);
  return pick.sort((a, b) => b.score - a.score);
}

// ---------- views
function statusLine() {
  const bits = [];
  const w = S.live?.weather;
  if (w?.now && w.now.t != null) {
    const now = Date.now();
    const next = (w.hours || []).filter((h) => { const t = Date.parse(h.h); return t >= now - 3600e3 && t < now + 6 * 3600e3; });
    const wet = next.reduce((m, h) => (h.p > (m?.p ?? -1) ? h : m), null);
    bits.push(`${WX_ICON(w.now.sym)} <b>${Math.round(w.now.t)}°</b> ${raining(S.live) ? 'regen: binnen eerst' : wet && wet.p >= 30 ? `regen ${Math.round(wet.p)}% rond ${hhmm(Date.parse(wet.h))}` : 'droog'}`);
  }
  const L = S.live;
  if (L?.close && Date.now() < L.close) bits.push(`open tot ${hhmm(L.close)}`);
  const done = Object.values(S.fam?.done || {}).reduce((a, b) => a + b, 0);
  if (done) bits.push(`🎢 ${done} ${done === 1 ? 'ritje' : 'ritjes'}`);
  return bits.length ? `<p class="wx">${bits.join(' · ')}</p>` : '';
}
const POPULAR = ['Kondaa', 'Pulsar', 'Calamity Mine', 'Loup-Garou', 'Tiki-Waka', 'Mecalodon', 'Vampire', 'Radja River'];
function morningTip() {
  const L = S.live;
  if (!L?.open || Date.now() > L.open + 40 * 60e3 || S.fam.target) return '';
  const ok = POPULAR.map((n) => ATTRACTIONS.find((a) => a.name === n)).filter((a) => a && !S.fam.done?.[a.id] && people().some((p) => canRide(p, a)));
  if (!ok.length) return '';
  return `<div class="tip">🌅 <b>Ochtendtip:</b> doe eerst de drukke toppers (${ok.slice(0, 2).map((a) => esc(a.name)).join(', ')}). In de namiddag worden die rijen het langst.</div>`;
}
function renderNow() {
  const el = $('#view-now');
  if (!S.fam) { el.innerHTML = '<p class="empty">Laden…</p>'; return; }
  let html = statusLine() + morningTip();
  const L = S.live;
  if (parkingTicketIndex() < 0 && (S.sim === 'far' || (L?.open && Date.now() < L.open + 30 * 60e3))) html += parkingCard(true);
  if (shownTickets().length && (S.sim === 'far' || (L?.open && Date.now() < L.open + 90 * 60e3))) {
    html += `<button class="primary big" data-tview="0" style="margin:8px 0 4px">🎟️ Toon onze tickets (${shownTickets().length})</button>`;
  }
  const t = S.fam.target;
  if (t?.plan) {
    const ago = Math.round((Date.now() - t.setAt) / 60e3);
    html += queueCard() || `<p class="kicker">Jullie plan · ${ago < 1 ? 'net gekozen' : ago + ' min geleden'}</p>` + ticket(t.plan, true);
  } else if (!S.live) {
    html += '<p class="kicker">Doe nu dit</p><div class="ticket"><div class="what"><p class="empty">Wachttijden laden…</p></div></div>';
  } else if (!S.plans.length) {
    html += `<p class="kicker">Doe nu dit</p><div class="ticket"><div class="what"><h2>Niets open op dit moment</h2>
      <p class="muted">Er zijn geen attracties open (of het park is dicht). Tijd voor een snack?</p></div></div>`;
  } else {
    html += '<p class="kicker">Doe nu dit</p>' + ticket(S.plans[0], false);
  }
  html += autoCard();
  html += showCard();
  if (historyItems().length) html += '<button class="ghost small histbtn" data-go="history">📜 Geschiedenis · iets verkeerd getikt?</button>';
  if (!meId() && people().some((p) => p.kind === 'adult')) html += '<button class="ghost small whoami" data-go="onboard">🙋 Wie ben jij op deze gsm? Tik om te kiezen</button>';
  if (navigator.wakeLock && S.gps && !S.sim) html += '<button class="ghost small pocketbtn" data-go="pocket">🫥 Zakmodus: blijf volgen met de gsm in je zak <span class="muted">(±10% batterij/uur)</span></button>';
  if (S.auto) html += `<button class="ghost small pocketbtn" data-go="ot">📡 ${store.get('otActive', false) ? 'Volgen met de app dicht: aan ✅' : 'Volgen met de app dicht (OwnTracks)'}</button>`;
  html += `<div class="quick">
    <button data-go="food"><span aria-hidden="true">🍽️</span>Eten</button>
    <button data-go="toilet"><span aria-hidden="true">🚻</span>Toilet</button>
    <button data-go="pause"><span aria-hidden="true">🪑</span>Pauze</button>
    <button data-go="car"><span aria-hidden="true">🚗</span>Auto</button></div>
    <div class="row2 tight"><button class="ghost small" data-go="stickers">🏅 Stickerboek ${stickerCount()}/${ATTRACTIONS.length}</button><button class="ghost small" data-go="lost">🆘 Kind kwijt?</button></div>`;
  const alts = alternatives(t?.plan?.key || S.plans[0]?.key);
  if (alts.length) {
    html += `<p class="kicker">${t ? 'Of liever' : 'Ook goed'}</p><div class="alts">` + alts.map((p) => {
      const i = S.plans.indexOf(p);
      if (p.type === 'together') {
        const a = byId[p.parts[0].id];
        return `<button class="alt" data-go="choose:${i}" data-pkey="${shown(p)}"><span class="ic">${icon(a)}</span>
          <span><span class="t">${esc(a.name)}</span><span class="s">Iedereen samen · ${mins(walkOf(a))} stappen</span></span>${waitBadge(a.id)}</button>`;
      }
      const [x, y] = p.parts; const a = byId[x.id];
      return `<button class="alt" data-go="choose:${i}" data-pkey="${shown(p)}"><span class="ic">${icon(a)}</span>
        <span><span class="t">${esc(a.name)} <span class="muted">+ ${y.rest ? 'rust' : esc(byId[y.id]?.name)}</span></span>
        <span class="s">Splitsen · ${x.group.map((id) => emoji(person(id))).join('')} / ${y.group.map((id) => emoji(person(id))).join('')}</span></span>${waitBadge(a.id)}</button>`;
    }).join('') + '</div>';
  }
  el.innerHTML = html;
}

function renderList() {
  const el = $('#listPane');
  if (!el) return;
  const ps = people();
  const f = S.filter;
  const can = (a) => ps.map((p) => canRide(p, a));
  let rows = ATTRACTIONS.map((a) => ({ a, st: famStatus(a.id), can: can(a), walk: walkOf(a) }));
  rows = rows.filter(({ a, can: c }) => {
    if (f === 'fav') return (S.fam.favs || []).includes(a.id);
    if (f === 'small') return ps.some((p, i) => p.kind === 'child' && p.height < 110 && c[i]);
    if (f === 'thrill') return a.cat === 'thrill';
    if (f === 'us') return c.some(Boolean);
    return true;
  });
  rows.sort((x, y) => (y.st.open - x.st.open) || (num(x.st.wait, 99) - num(y.st.wait, 99)) || (x.walk - y.walk));
  const fb = (k, t) => `<button data-filter="${k}" aria-pressed="${f === k}">${t}</button>`;
  el.innerHTML = `<div class="filters" role="group" aria-label="Filter">${fb('us', 'Voor ons')}${fb('small', '👶 Peuter')}${fb('thrill', '🎢 Spanning')}${fb('fav', '⭐ Favorieten')}${fb('all', 'Alles')}</div>
    <div class="list">${rows.map(({ a, st, can: c, walk }) => `
      <div class="ride ${st.open ? '' : 'off'}">
        <button class="open" data-ride="${a.id}">${photoSrc(a) ? icon(a) : `<span style="font-size:1.6rem;width:48px;text-align:center" aria-hidden="true">${a.icon}</span>`}
          <span><span class="name">${esc(a.name)}</span><span class="sub">${mins(walk)} stappen${S.fam.done?.[a.id] ? ` · ✓ ${S.fam.done[a.id]}× gedaan` : ''}</span>
          <span class="dots" aria-label="${esc(ps.map((p, i) => `${p.name}: ${c[i] === 'alone' ? 'mag' : c[i] === 'adult' ? 'met volwassene' : 'mag niet'}`).join(', '))}">${ps.map((p, i) => `<span class="dot ${c[i] === 'alone' ? '' : c[i] === 'adult' ? 'adult' : 'no'}" aria-hidden="true">${emoji(p)}</span>`).join('')}</span></span></button>
        ${waitBadge(a.id)}
        <button class="star" data-fav="${a.id}" aria-pressed="${(S.fam.favs || []).includes(a.id)}" aria-label="Favoriet: ${esc(a.name)}">★</button>
      </div>`).join('') || '<p class="empty">Niets gevonden.</p>'}</div>
    <p class="muted small" style="margin-top:14px">🟢 mag · 🟠 met volwassene · doorstreept = mag niet. ↗↘ = rij groeit / krimpt. Lengtes volgens walibi.be; zwangerschap is een voorzichtige inschatting. Check altijd het bordje aan de ingang.</p>`;
}

// ---------- the big map: one SVG that is built once; pins and the view box change, the base layer never re-parses
const MAP = { svg: null, cx: -20, cy: -40, R: 400, init: false };
function renderMapView() {
  const el = $('#view-map');
  if (!S.park) return;
  if (!el.querySelector('#mapShell')) {
    el.innerHTML = `<div class="seg mapseg" role="tablist"><button data-mapmode="map" role="tab">🗺️ Kaart</button><button data-mapmode="list" role="tab">📋 Lijst</button></div>
      <div id="mapShell" class="mapbox"><div class="mapwrap mapview" id="bigmap"></div>
        <div class="map-tools ov"><button data-go="mapme" aria-label="Rond mij">📍</button><button data-go="mappark" aria-label="Heel het park">🗺️</button><button data-go="place"></button></div>
        <p class="legend ov"><span class="lg" style="--c:var(--ok)">≤10′</span><span class="lg" style="--c:#e08a00">≤25′</span><span class="lg" style="--c:var(--bad)">langer</span><span>⚪ dicht</span></p></div>
      <div id="listPane"></div>`;
    if (!MAP.init) { MAP.init = true; const h = S.park.toXY(pos()); if (!S.sim) { MAP.cx = h.x; MAP.cy = h.y; MAP.R = 190; } }
    MAP.svg = null;
  }
  el.querySelectorAll('[data-mapmode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mapmode === S.mapMode)));
  $('#mapShell').hidden = S.mapMode !== 'map';
  $('#listPane').hidden = S.mapMode !== 'list';
  if (S.mapMode === 'list') { renderList(); return; }
  const pb = el.querySelector('[data-go="place"]'); pb.textContent = S.placing ? 'Tik waar je staat…' : S.manual ? '🛰️' : '✋'; pb.setAttribute('aria-label', S.placing ? 'Tik op de kaart waar je staat' : S.manual ? 'GPS gebruiken' : 'Ik sta hier'); pb.classList.toggle('wide', S.placing);
  pb.dataset.go = S.manual && !S.placing ? 'gps' : 'place';
  const box = $('#bigmap');
  if (!MAP.svg || !box.contains(MAP.svg)) {
    box.innerHTML = `<svg viewBox="0 0 10 10" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Kaart van het park">
      <defs><clipPath id="pc"><circle r="13"/></clipPath></defs>
      <rect x="-2000" y="-2000" width="4000" height="4000" fill="var(--map-green)"/>${baseLayer()}<g id="pins"></g></svg>`;
    MAP.svg = box.querySelector('svg');
    mapGestures(box);
  }
  drawPins();
}
function setMapView() { MAP.svg?.setAttribute('viewBox', `${MAP.cx - MAP.R} ${MAP.cy - MAP.R} ${2 * MAP.R} ${2 * MAP.R}`); }
const waitCol = (st) => (!st.open ? 'var(--muted)' : st.wait == null || num(st.wait) <= 10 ? 'var(--ok)' : num(st.wait) <= 25 ? '#e08a00' : 'var(--bad)');
let lakeAt = null;
function drawPins() {
  if (!MAP.svg) return;
  setMapView();
  const zoomedOut = MAP.R > 300;
  const k = MAP.R / 180 * (zoomedOut ? 0.72 : 1); // pins a bit smaller when the whole park is in view
  const ps = people();
  const pins = [], labels = [], under = [];
  const target = S.fam?.target?.plan ? new Set(S.fam.target.plan.parts.filter((p) => !p.rest).map((p) => p.id)) : new Set();
  // big, readable pins for open rides someone in the family can do; small grey dots for the rest
  const rides = ATTRACTIONS.map((a) => ({ a, st: famStatus(a.id), xy: S.park.toXY(a), can: ps.some((p) => canRide(p, a)) }))
    .map((r) => ({ ...r, big: r.st.open && r.can }))
    .sort((x, y) => (x.big - y.big) || (target.has(x.a.id) - target.has(y.a.id))); // big ones drawn last = on top
  const placed = [];
  // pins count as taken space, so labels never sit on top of an icon
  for (const { xy, big } of rides) { const r = (big ? 17 : 8) * k; placed.push([xy.x - r, xy.y - r, xy.x + r, xy.y + (big ? 27 : 8) * k]); }
  const tryLabel = (x, y, text, size, cls = 'lbl') => {
    const lw = text.length * size * 0.58, lh = size * 1.15;
    const b = [x - lw / 2, y - lh, x + lw / 2, y + size * 0.3];
    if (placed.some((q) => b[0] < q[2] && b[2] > q[0] && b[1] < q[3] && b[3] > q[1])) return false;
    placed.push(b);
    labels.push(`<text class="${cls}" x="${x}" y="${y}" text-anchor="middle" font-size="${size}" stroke-width="${size / 3}">${esc(text)}</text>`);
    return true;
  };
  for (const { a, st, xy, big } of rides) {
    const col = waitCol(st), w = num(st.wait);
    const label = `${esc(a.name)}, ${st.open ? (st.wait != null ? w + ' minuten' : 'open') : st.s === 'DOWN' ? 'storing' : 'dicht'}`;
    if (!big) {
      pins.push(`<g class="pin" data-ride="${a.id}" role="button" tabindex="0" aria-label="${label}" transform="translate(${xy.x} ${xy.y}) scale(${k})" opacity=".75">
        <circle r="7.5" fill="var(--surface)" stroke="var(--line)" stroke-width="1.5"/><text y="3.2" text-anchor="middle" font-size="8.5" opacity=".65">${a.icon}</text></g>`);
      continue;
    }
    const src = MAP.R < 260 ? photoSrc(a) : null;
    const tg = target.has(a.id);
    if (tg) under.push(`<circle class="pulse" cx="${xy.x}" cy="${xy.y}" r="${26 * k}" fill="var(--accent)" opacity=".25"/>`);
    pins.push(`<g class="pin" data-ride="${a.id}" role="button" tabindex="0" aria-label="${label}" transform="translate(${xy.x} ${xy.y}) scale(${k})">
      <circle r="16" fill="var(--surface)" stroke="${tg ? 'var(--accent)' : col}" stroke-width="${tg ? 5 : 4}"/>
      ${src ? `<image href="${src}" x="-13" y="-13" width="26" height="26" preserveAspectRatio="xMidYMid slice" clip-path="url(#pc)"/>` : `<text y="6" text-anchor="middle" font-size="16">${a.icon}</text>`}
      <g transform="translate(0 19)"><rect x="-14" y="-7.5" width="28" height="15" rx="7.5" fill="${col}" stroke="var(--surface)" stroke-width="1.5"/>
      <text y="4" text-anchor="middle" font-size="10" font-weight="800" fill="#fff">${st.wait != null ? w + '′' : 'open'}</text></g></g>`);
  }
  // labels after pins, big rides first so they win the space
  for (const { a, xy, big } of [...rides].sort((x, y) => y.big - x.big)) {
    if (big) tryLabel(xy.x, xy.y + 41 * k, a.name, 10 * k) || tryLabel(xy.x, xy.y - 21 * k, a.name, 10 * k); // below, else above
    else if (MAP.R < 140) tryLabel(xy.x, xy.y + 19 * k, a.name, 7 * k, "lbl small");
  }
  if (MAP.R < 220) for (const f of FOOD) { const xy = S.park.toXY(f); pins.push(`<g class="pin" data-food="${f.id}" role="button" tabindex="0" aria-label="Eten: ${esc(f.name)}" transform="translate(${xy.x} ${xy.y}) scale(${k})"><circle r="8" fill="var(--surface)" stroke="var(--line)"/><text y="3.5" text-anchor="middle" font-size="9">🍴</text></g>`); }
  S.park.toilets.forEach((t, i) => { const xy = S.park.toXY(t); pins.push(`<g class="pin" data-wc="wc${i}" role="button" tabindex="0" aria-label="Toilet" transform="translate(${xy.x} ${xy.y}) scale(${k})"><rect x="-9" y="-9" width="18" height="18" rx="5" fill="#2f6fd6"/><text y="4.5" text-anchor="middle" font-size="11">🚻</text></g>`); });
  // landmarks help you find your bearings: the entrance, the big lake, the playground, your car
  const ent = S.park.toXY(ENTRANCE);
  pins.push(`<g transform="translate(${ent.x} ${ent.y}) scale(${k})"><rect x="-11" y="-11" width="22" height="22" rx="6" fill="var(--plum)"/><text y="5" text-anchor="middle" font-size="13">🚪</text></g>`);
  tryLabel(ent.x, ent.y + 24 * k, 'Ingang / uitgang', 9 * k, 'lbl land');
  if (!lakeAt) { const w = [...S.park.data.water].sort((x, y) => y.length - x.length)[0]; let sx = 0, sy = 0; for (let i = 0; i < w.length; i += 2) { sx += w[i]; sy += w[i + 1]; } lakeAt = { x: sx / (w.length / 2), y: sy / (w.length / 2) }; }
  if (MAP.R < 450) tryLabel(lakeAt.x, lakeAt.y, 'Het meer', 12 * k, 'lbl water');
  for (const p of S.park.play || []) { const xy = S.park.toXY(p); pins.push(`<g transform="translate(${xy.x} ${xy.y}) scale(${k})"><circle r="9" fill="var(--sun)"/><text y="4" text-anchor="middle" font-size="10">🛝</text></g>`); }
  if (S.fam?.car) { const xy = S.park.toXY(S.fam.car); pins.push(`<g transform="translate(${xy.x} ${xy.y}) scale(${k})"><circle r="11" fill="var(--surface)" stroke="var(--ink)" stroke-width="2"/><text y="4.5" text-anchor="middle" font-size="12">🚗</text></g>`); }
  // the partner's phone, if it reported in the last 15 minutes
  for (const [dev, p] of Object.entries(S.fam?.positions || {})) {
    if (dev === device || Date.now() - p.t > 15 * 60e3 || distM(p, ENTRANCE) > 2000) continue; // a phone that went home isn't on the park map
    const who = person(S.fam.me?.[dev]); const xy = S.park.toXY(p);
    pins.push(`<g transform="translate(${xy.x} ${xy.y}) scale(${k})"><circle r="10" fill="var(--plum)" stroke="#fff" stroke-width="3"/><text y="4" text-anchor="middle" font-size="9" fill="#fff" font-weight="800">${esc((who?.name || 'P')[0])}</text></g>`);
    tryLabel(xy.x, xy.y - 16 * k, who?.name || 'partner', 9 * k);
  }
  const me = S.park.toXY(pos());
  pins.push(`<g transform="translate(${me.x} ${me.y}) scale(${k})"><circle r="18" fill="var(--me)" opacity=".18"/><circle r="9" fill="var(--me)" stroke="#fff" stroke-width="3"/>${S.heading != null ? `<path d="M0 -25 L7 -13 L-7 -13 Z" fill="var(--me)" transform="rotate(${S.heading})"/>` : ''}</g>`);
  MAP.svg.querySelector('#pins').innerHTML = under.join('') + pins.join('') + labels.join('');
}
// drag to pan, pinch or wheel to zoom; a tap places your position in "Ik sta hier" mode
function mapGestures(box) {
  const pts = new Map(); let start = null, moved = false;
  const toMap = (e) => { const m = MAP.svg.getScreenCTM()?.inverse(); return m ? new DOMPoint(e.clientX, e.clientY).matrixTransform(m) : null; };
  box.addEventListener('pointerdown', (e) => { pts.set(e.pointerId, e); box.setPointerCapture(e.pointerId); start = { cx: MAP.cx, cy: MAP.cy, R: MAP.R, pts: new Map([...pts].map(([k, v]) => [k, { x: v.clientX, y: v.clientY }])) }; moved = false; });
  box.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !start) return;
    pts.set(e.pointerId, e);
    const scale = (2 * MAP.R) / Math.max(box.clientWidth, box.clientHeight); // "slice": the square view fills the longer side
    const ids = [...pts.keys()];
    if (ids.length === 1) {
      const s0 = start.pts.get(ids[0]); if (!s0) return;
      const dx = e.clientX - s0.x, dy = e.clientY - s0.y;
      if (Math.hypot(dx, dy) > 6) moved = true;
      MAP.cx = start.cx - dx * scale; MAP.cy = start.cy - dy * scale;
    } else if (ids.length >= 2) {
      const [a, b] = ids.map((id) => pts.get(id)); const [a0, b0] = ids.map((id) => start.pts.get(id)); if (!a0 || !b0) return;
      const d0 = Math.hypot(a0.x - b0.x, a0.y - b0.y), d1 = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      MAP.R = Math.max(60, Math.min(600, start.R * d0 / Math.max(20, d1))); moved = true;
    }
    setMapView();
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (!pts.size) {
      if (moved) drawPins(); // re-place labels for the new zoom
      else if (S.placing) { const p = toMap(e); if (p) { S.manual = { ...S.park.toLL(p), t: Date.now() }; store.set('manual', S.manual); S.placing = false; recompute(); render(); toast('📍 Positie gezet'); } }
      start = null;
    } else start = { cx: MAP.cx, cy: MAP.cy, R: MAP.R, pts: new Map([...pts].map(([k, v]) => [k, { x: v.clientX, y: v.clientY }])) };
  };
  box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
  box.addEventListener('wheel', (e) => { e.preventDefault(); MAP.R = Math.max(60, Math.min(600, MAP.R * (e.deltaY > 0 ? 1.15 : 0.87))); drawPins(); }, { passive: false });
  // a tap on a pin (no drag) opens it
  box.addEventListener('click', (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); } }, true);
}

let baseCache = '';
function baseLayer() {
  if (baseCache) return baseCache;
  const d = S.park.data;
  const poly = (f) => { let s = ''; for (let i = 0; i < f.length; i += 2) s += (i ? ' ' : '') + f[i] + ',' + f[i + 1]; return s; };
  const pts = d.pts;
  const lines = d.lines.map((l) => l.map((i) => pts[2 * i] + ',' + pts[2 * i + 1]).join(' '));
  baseCache = `<polygon points="${poly(d.outline)}" fill="var(--map-ground)"/>`
    + d.green.map((g) => `<polygon points="${poly(g)}" fill="var(--map-green)"/>`).join('')
    + d.water.map((g) => `<polygon points="${poly(g)}" fill="var(--map-water)"/>`).join('')
    + d.build.map((g) => `<polygon points="${poly(g)}" fill="var(--map-build)"/>`).join('')
    + `<g fill="none" stroke-linecap="round" stroke-linejoin="round">${lines.map((l) => `<polyline points="${l}" stroke="var(--map-edge)" stroke-width="7"/>`).join('')}${lines.map((l) => `<polyline points="${l}" stroke="var(--map-path)" stroke-width="4.5"/>`).join('')}</g>`;
  return baseCache;
}

function renderFam() {
  const el = $('#view-fam');
  if (!S.fam) return;
  const link = `${location.origin}/?g=${S.famId}`;
  const ps = people();
  el.innerHTML = `
    <div class="card"><h2>📲 Op de andere gsm</h2>
      <p class="small muted">Open deze link op de gsm van je partner. Dan zien jullie hetzelfde plan.</p>
      <p class="small" style="word-break:break-all"><b>${esc(link)}</b></p>
      <div class="row2"><button class="primary" data-go="share">📤 Delen</button><button data-go="copy">Kopieer link</button></div>
      <details class="join"><summary class="small">Andere gezinslink openen (bv. op de iPhone-app)</summary>
        <form id="joinForm" class="joinrow"><input type="text" name="link" placeholder="Plak de link of code" autocomplete="off" aria-label="Gezinslink"><button type="submit">Openen</button></form></details></div>
    <div class="card"><h2>🙋 Wie ben jij op deze gsm?</h2>
      <div class="seg">${ps.filter((p) => p.kind === 'adult').map((p) => `<button data-me="${p.id}" aria-pressed="${p.id === meId()}">${emoji(p)} ${esc(p.name)}</button>`).join('')}</div></div>
    <div class="card"><h2>🚶 Stappen</h2>
      <p class="small muted">Hoe zwaar weegt een stuk wandelen tegenover wat langer aanschuiven?</p>
      <div class="seg"><button data-walk="normal" aria-pressed="${S.fam.walk !== 'low'}">Normaal</button><button data-walk="low" aria-pressed="${S.fam.walk === 'low'}">Liever weinig stappen</button></div>
      <p class="small muted" style="margin-top:6px">In de simulatie: ±8 km per dag normaal, ±6 km met “liever weinig”, voor ±5% minder ritjes-plezier.</p></div>
    <div class="card" id="pushCard"><h2>🔔 Meldingen</h2><div id="pushBody"><p class="muted small">…</p></div></div>
    <div class="card"><h2>🎛️ Weergave</h2>
      <p class="small muted" style="margin:0 0 6px">Kleuren van de app</p>
      <div class="seg themeseg" role="radiogroup" aria-label="Kleuren">${[['sun', '🌅 Automatisch (zon)'], ['light', '☀️ Licht'], ['dark', '🌙 Donker'], ['system', '📱 Zoals mijn gsm']].map(([k, t]) => `<button role="radio" data-themepick="${k}" aria-checked="${S.theme === k}" aria-pressed="${S.theme === k}">${t}</button>`).join('')}</div>
      <p class="small muted" style="margin:6px 0 10px">${S.theme === 'sun' ? (() => { const st = sunTimes(new Date()); return `Vandaag licht van ${hhmm(st.rise)} tot zonsondergang om ${hhmm(st.set)}, daarna donker.`; })() : S.theme === 'system' ? 'Volgt de licht/donker-instelling van je gsm.' : ''}</p>
      <label class="tog"><input type="checkbox" data-setting="voice" ${S.voice ? 'checked' : ''}> 🔊 Gesproken aanwijzingen in de wandelgids</label></div>
    <div class="card" id="locCheck"></div>
    <div class="card"><h2>📡 Volgen met de app dicht</h2>
      <p class="small muted" style="margin:0 0 8px">Met de gratis app OwnTracks herkent Pretpark ook wat jullie doen als de app dicht is en de gsm in je zak zit.</p>
      <button class="primary" data-go="ot" style="width:100%">📡 ${store.get('otActive', false) ? 'Bekijk de koppeling ✅' : 'Instellen (2 minuten)'}</button></div>
    <div class="card"><h2>🤖 Automatisch herkennen</h2>
      <label class="tog"><input type="checkbox" data-setting="auto" ${S.auto ? 'checked' : ''}> Herken zelf wat we doen</label>
      <p class="small muted" style="margin:6px 0 0">Aan de hand van je locatie en de tijd: in de rij, aan de beurt, klaar, uit de rij, eten, rusten en waar de auto staat. Je krijgt altijd een “Klopt niet”-knop. Vreemde locatiesprongen negeert de app.</p>
      <p class="small muted" style="margin:6px 0 0">Een web-app krijgt geen locatie als de app dicht is of het scherm uit staat. Wat er intussen gebeurde, leidt de app af als je ze weer opent. Wil je dat ze blijft volgen in je zak: tik op Nu op <b>🫥 Zakmodus</b> (zwart scherm, scherm blijft aan, kost wat batterij).</p>
      ${S.gpsReject ? `<p class="small muted" style="margin:6px 0 0">Laatste locatie genegeerd: ${{ acc: 'te onnauwkeurig', jump: 'onmogelijke sprong', stale: 'te oud', old: 'dubbel', approx: '“ongeveer”-locatie', bad: 'ongeldig' }[S.gpsReject] || S.gpsReject}.</p>` : ''}</div>
    <div class="card"><h2>👨‍👩‍👧‍👦 Ons gezin</h2>
      <form id="peopleForm">${ps.map((p) => `
        <div class="person" data-id="${p.id}" data-kind="${p.kind}">
          <label><span class="small muted">${emoji(p)} Naam</span><input type="text" name="name" value="${esc(p.name)}" maxlength="24" autocomplete="off"></label>
          <label><span class="small muted">Lengte (cm)</span><input type="number" name="height" value="${num(p.height)}" min="50" max="220" inputmode="numeric"></label>
          <label class="phone"><span class="small muted">📱 Gsm-nummer${p.kind === 'child' ? ' (als ' + esc(p.name) + ' een eigen gsm heeft)' : ' (optioneel)'}</span><input type="tel" name="phone" value="${esc(p.phone || '')}" placeholder="+32 4xx xx xx xx" autocomplete="off" inputmode="tel"></label>
          ${p.kind === 'adult' ? `<div class="opts"><label class="tog"><input type="checkbox" name="pregnant" ${p.pregnant ? 'checked' : ''}> Zwanger</label></div>` : ''}
        </div>`).join('')}
        <button class="primary" type="submit" style="margin-top:8px">Opslaan</button></form></div>
    <div class="card"><h2>🏠 Op je beginscherm</h2>
      <ul class="steps small"><li><b>iPhone (Safari):</b> deelknop <span aria-hidden="true">⬆️</span> → <i>Zet op beginscherm</i>. Open de app daarna vanaf het beginscherm (nodig voor meldingen). Opent de app daar een leeg gezin? Plak dan hierboven de gezinslink.</li>
      <li><b>Android (Chrome):</b> menu ⋮ → <i>App installeren</i> of <i>Toevoegen aan startscherm</i>.</li></ul></div>
    <div class="card"><h2>📜 Geschiedenis van vandaag</h2>
      ${(() => { const h = historyItems(); const rides = h.filter((x) => x.k === 'ride').length;
        return `<p class="small muted">${h.length ? `${rides} attractie${rides === 1 ? '' : 's'}${h.length > rides ? ` · ${h.length - rides} andere` : ''}. Verkeerd getikt? Verwijder het of pas de tijd aan.` : 'Nog niets. Tik op “Gedaan” na een attractie.'}</p>`; })()}
      <button class="primary" data-go="history" style="width:100%">📜 Bekijk en bewerk</button></div>
    <p class="muted small">Foto’s van attracties via Wikimedia Commons: ${[...new Set(Object.values(PHOTOS).map((p) => p.artist))].map(esc).join(', ')} (CC BY-SA 3.0/4.0, CC0, publiek domein; per foto vermeld).</p>
    <p class="muted small">Wachttijden: ThemeParks.wiki (live). Weer: MET Norway. Kaart: © OpenStreetMap-bijdragers. Foto’s blijven bewaard tot je ze verwijdert.</p>`;
  renderPush();
  renderLocCheck(); loadOtAll();
}

// ---------- push notifications
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushPrefs = () => ({ chat: true, auto: true, diaper: true, shows: true, ...store.get('pushPrefs', { fav: true, best: true, food: true, down: true }) });
async function renderPush() {
  const body = $('#pushBody'); if (!body) return;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (isIOS && !standalone) {
    body.innerHTML = `<p class="small">Op een iPhone werken meldingen alleen vanaf het beginscherm:</p>
      <ol class="steps small"><li>Tik op de deelknop ⬆️ onderaan in Safari.</li><li>Kies <b>Zet op beginscherm</b>.</li><li>Open <b>Pretpark</b> vanaf je beginscherm en kom hier terug.</li></ol>`;
    return;
  }
  if (!supported) { body.innerHTML = '<p class="small muted">Deze browser ondersteunt geen meldingen. Probeer Chrome (Android) of Safari vanaf het beginscherm (iPhone).</p>'; return; }
  if (Notification.permission === 'denied') { body.innerHTML = '<p class="small">Meldingen zijn geblokkeerd. Zet ze aan in de instellingen van je browser of gsm voor deze site.</p>'; return; }
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  const p = pushPrefs();
  const tog = (k, t) => `<label class="tog"><input type="checkbox" data-pref="${k}" ${p[k] ? 'checked' : ''}> ${t}</label>`;
  body.innerHTML = sub
    ? `<p class="small">✅ Meldingen staan aan op deze gsm.</p>
      <div style="display:grid">${tog('fav', '⭐ Wachttijd zakt bij een favoriet')}${tog('best', '👉 Nieuwe beste suggestie')}${tog('food', '🍽️ Tijd om te eten / pauze')}${tog('down', '⚠️ Attractie in storing')}${tog('chat', '💬 Berichten in de gezinschat')}${tog('auto', '🤖 Automatisch herkend (met OwnTracks)')}${toddlerOf(people()) ? tog('diaper', '🚼 Luiercheck als je langs een toilet komt') : ''}${tog('shows', '🎭 Show begint binnen 20 min')}</div>
      <div class="row2"><button data-go="pushtest">Testmelding</button><button data-go="pushoff">Uitzetten</button></div>`
    : `<p class="small muted">Krijg een seintje als een favoriet kort wordt, als er iets beters is, als het etenstijd is, als jullie attractie stilvalt of als de anderen klaar zijn. Ook als de app dicht is.</p>
      <button class="primary big" data-go="pushon">🔔 Meldingen aanzetten</button>`;
}
const b64ToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function pushOn() {
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if ((await Notification.requestPermission()) !== 'granted') { toast('Meldingen niet toegestaan'); renderPush(); return; }
    const { key } = await api('/api/vapid');
    if (!key) { toast('Meldingen zijn nog niet ingesteld op de server'); return; }
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
    await api('/api/push', { method: 'POST', body: { device, family: S.famId, sub: sub.toJSON(), prefs: pushPrefs(), test: true } });
    toast('Meldingen staan aan 🔔');
  } catch (e) { console.error(e); toast('Meldingen aanzetten lukte niet'); }
  renderPush();
}
async function pushOff() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  await sub?.unsubscribe();
  await api('/api/push', { method: 'DELETE', body: { device } }).catch(() => {});
  renderPush();
}
// keep the server's subscription pointed at this family (after joining another family, for example)
async function syncPushFamily() {
  try {
    if (!('serviceWorker' in navigator) || Notification.permission !== 'granted') return;
    const sub = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
    if (sub) await api('/api/push', { method: 'POST', body: { device, family: S.famId, sub: sub.toJSON(), prefs: pushPrefs() } });
  } catch { /* next start */ }
}

// ---------- the walking guide: the map SVG is built once per guide; heading changes only rotate it
const G = { svg: null, rot: null, route: null, route2: null, me: null, tgt: null, center: null, R: 120, lastSay: '', lastSpoke: 0, lastDist: null };
function openGuide(target) {
  S.guide = target; buzz();
  $('#guide').hidden = false; openDialog($('#guide'));
  enableCompass(false);
  wake(true);
  G.svg = null; G.lastSay = ''; G.lastDist = null; G.arrivedAt = null; G.band = null; guideState = null;
  // iOS only lets a page speak after a first speak() inside a tap: this tap opens the guide
  if (S.voice && window.speechSynthesis) { try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch { /* no voice */ } }
  if (S.here) { S.here = S.park.fromHere(pos()); }
  updateGuide(true);
}
function closeGuide() { S.guide = null; $('#guide').hidden = true; closeDialog($('#guide')); if ($('#tview').hidden) wake(false); window.speechSynthesis?.cancel(); render(); }
let wakeLock = null;
async function wake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not supported, or refused (power saving; iOS home-screen apps before 18.4) */ }
  return !!wakeLock;
}
function say(text, force) {
  if (!S.voice || !window.speechSynthesis || !text) return;
  if (!force && Date.now() - G.lastSpoke < 5000) return;
  G.lastSpoke = Date.now();
  const u = new SpeechSynthesisUtterance(text); u.lang = 'nl-BE'; u.rate = 1.02;
  speechSynthesis.cancel(); speechSynthesis.speak(u);
}
let arrowAngle = 0, guideState = null;
const turnBand = (r, prev) => { let k = 0; for (const [i, b] of [25, 70, 135].entries()) if (r >= b + (prev == null ? 0 : prev <= i ? 8 : -8)) k = i + 1; return k; };
function guideCalc() {
  const g = S.guide; if (!g || !S.here) return null;
  const path = S.here.path(g);
  const dist = pathLength(path);
  const here = path[0];
  const brg = bearingXY(here, S.park.lookahead(path, 25));
  // arrive under 25 m, leave only above 40 m: GPS jitter around 25 m must not flip the screens
  const was = guideState?.g === g && guideState.arrived;
  return { g, path, dist, here, brg, arrived: dist < 25 || (was && dist < 40) };
}
function updateGuide(full) {
  const c = guideCalc(); if (!c) return;
  guideState = c;
  const { g, dist, arrived } = c;
  const el = $('#guide');
  const hasHeading = S.heading != null;
  const near = dist < 250;
  if (full || !el.querySelector('.head') || el.dataset.arrived !== String(arrived) || el.dataset.id !== g.id || el.dataset.heading !== String(hasHeading) || el.dataset.near !== String(near)) {
    el.dataset.arrived = String(arrived); el.dataset.id = g.id; el.dataset.heading = String(hasHeading); el.dataset.near = String(near);
    const doneBtn = g.kind === 'ride' ? '<button class="primary big" data-go="done">✓ Gedaan</button>'
      : g.kind === 'ride-solo' ? `<button class="primary big" data-doneone="${g.id}">✓ Gedaan</button>`
      : g.kind === 'food' ? '<button class="primary big" data-go="ate">🍽️ We hebben gegeten</button>'
      : '<button class="primary big" data-go="guideclose">👍 Ik ben er</button>';
    const st = g.kind === 'ride' || g.kind === 'ride-solo' ? status(S.live, g.id) : null;
    const ga = byId[g.id];
    const gphoto = ga && ga.cat ? photoSrc(ga) : null;
    el.innerHTML = `<div class="head">${gphoto ? `<img class="gthumb" src="${gphoto}" alt="">` : `<span class="ic" aria-hidden="true">${g.icon}</span>`}<h2 id="guideTitle">${esc(g.name)}</h2>
        ${st ? waitBadge(g.id) : ''}<button data-go="voice" aria-pressed="${S.voice}" aria-label="Gesproken aanwijzingen">${S.voice ? '🔊' : '🔈'}</button><button data-go="guideclose" aria-label="Sluiten">✕</button></div>
      ${arrived ? `<div class="arrived"><b>Je bent er! 🎉</b><span class="muted">${g.kind === 'ride' ? 'Veel plezier!' : g.kind === 'ride-solo' ? 'Veel plezier!' : g.kind === 'meet' ? 'Rust even, de anderen komen hierheen.' : ''}</span>
          ${g.kind === 'ride' && S.fam.target && !S.fam.target.q?.[myIdx(S.fam.target.plan)] ? '<button class="big" data-go="queue" style="margin-top:10px">⏳ We staan in de rij</button>' : ''}</div>`
      : `<div class="arrowbox"><div class="arrow ${hasHeading ? '' : 'unknown'}"><svg viewBox="-50 -50 100 100" aria-hidden="true" id="arrowSvg"><path d="M0 -44 L30 18 L0 6 L-30 18 Z" fill="${hasHeading ? '#fff' : 'var(--accent)'}" stroke="${hasHeading ? '#fff' : 'var(--accent)'}" stroke-width="6" stroke-linejoin="round"/></svg></div>
          <div class="dist"><b id="distTxt">${Math.round(dist)} m</b><span id="minTxt">± ${walkMin(dist)} min stappen</span></div></div>
        <p class="say" id="sayTxt" aria-live="polite"></p>
        ${hasHeading ? '' : `<button data-go="compass" style="margin-bottom:10px">🧭 Kompas aan: de pijl draait mee</button>`}`}
      ${S.sim ? `<p class="small muted">📍 ${S.sim === 'far' ? 'Je bent niet in het park: ik doe alsof je aan de ingang staat.' : S.sim === 'wait' ? 'GPS zoeken…' : 'Geen GPS: ik reken vanaf de ingang.'}</p>` : ''}
      ${hasToddler() && isDark() ? '<p class="small">🎃 Donker: blijf met de peuter op de brede hoofdpaden.</p>' : ''}
      ${gphoto && !arrived && dist < 250 ? `<div class="look"><img src="${gphoto}" alt=""><span><b>Zo ziet het eruit.</b><br>Kijk ernaar uit, je bent bijna.</span></div>` : ''}
      <div class="mapwrap" id="guideMap"></div>
      <div class="foot"><button data-go="guideclose">Stop</button>${doneBtn}</div>`;
    G.svg = null;
    if (arrived && G.arrivedAt !== g) { G.arrivedAt = g; buzz([80, 60, 80]); say(`Je bent er. ${g.name}.`, true); }
  }
  // the map: built once, then only moved
  const span = Math.max(60, Math.min(220, dist * 0.7));
  if (!G.svg) {
    const box = $('#guideMap');
    box.innerHTML = `<svg preserveAspectRatio="xMidYMid slice" role="img" aria-label="Route op de kaart"><rect x="-2000" y="-2000" width="4000" height="4000" fill="var(--map-green)"/>
      <g id="gRot">${baseLayer()}<polyline id="gRoute2" fill="none" stroke="var(--route)" stroke-linecap="round" stroke-linejoin="round" opacity=".5"/>
      <polyline id="gRoute" fill="none" stroke="var(--route)" stroke-linecap="round" stroke-linejoin="round"/>
      <g id="gTgt"><circle r="22" fill="var(--accent)" opacity=".2"/><circle r="14" fill="var(--accent)" stroke="#fff" stroke-width="3"/><text y="5" text-anchor="middle" font-size="14">${g.icon}</text></g>
      <g id="gMe"><circle r="16" fill="var(--me)" opacity=".18"/><circle r="8" fill="var(--me)" stroke="#fff" stroke-width="3"/></g></g></svg>`;
    G.svg = box.querySelector('svg'); G.rot = $('#gRot'); G.route = $('#gRoute'); G.route2 = $('#gRoute2'); G.me = $('#gMe'); G.tgt = $('#gTgt');
  }
  const k = span / 180;
  const pts = c.path.map((p) => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
  G.route.setAttribute('points', pts); G.route2.setAttribute('points', pts);
  G.route.setAttribute('stroke-width', 7 * k); G.route.setAttribute('stroke-dasharray', `${0.1 * k} ${12 * k}`); G.route2.setAttribute('stroke-width', 3 * k);
  const t = S.park.toXY(g);
  G.tgt.setAttribute('transform', `translate(${t.x} ${t.y}) scale(${k})`);
  G.me.setAttribute('transform', `translate(${c.here.x} ${c.here.y}) scale(${k})`);
  G.svg.setAttribute('viewBox', `${c.here.x - span} ${c.here.y - span} ${2 * span} ${2 * span}`);
  G.center = c.here;
  const dt = $('#distTxt'); if (dt) dt.textContent = `${Math.round(dist)} m`;
  const mt = $('#minTxt'); if (mt) mt.textContent = `± ${walkMin(dist)} min stappen`;
  // spoken distance milestones
  if (!arrived && G.lastDist != null) for (const m of [200, 100, 50]) if (G.lastDist > m && dist <= m) say(`Nog ${m} meter.`, true);
  G.lastDist = dist;
  guideHeading();
}
function guideHeading() {
  const c = guideState; if (!c || !S.guide) return;
  const hasHeading = S.heading != null;
  const rel = hasHeading ? ((c.brg - S.heading + 540) % 360) - 180 : c.brg > 180 ? c.brg - 360 : c.brg;
  if (G.rot && G.center) G.rot.setAttribute('transform', hasHeading ? `rotate(${-S.heading} ${G.center.x} ${G.center.y})` : '');
  if (c.arrived) return;
  let d = rel - (((arrowAngle % 360) + 540) % 360 - 180); d = ((d + 540) % 360) - 180; arrowAngle += d; // shortest turn, no spin at 359→0
  const a = $('#arrowSvg'); if (a) a.style.transform = `rotate(${arrowAngle}deg)`;
  const sayEl = $('#sayTxt');
  if (sayEl) {
    // the direction band (straight / slight / turn / back) with 8° of hysteresis around the last one, so a wobbling
    // compass doesn't flip the text (and buzz) back and forth
    const k = turnBand(Math.abs(rel), G.band);
    G.band = k;
    const text = !hasHeading ? 'De pijl wijst zoals op een kaart (noorden boven).'
      : [() => '⬆️ Rechtdoor', () => (rel > 0 ? '↗️ Schuin rechts' : '↖️ Schuin links'), () => (rel > 0 ? '➡️ Rechts afslaan' : '⬅️ Links afslaan'), () => '↩️ Draai je om'][k]();
    if (sayEl.textContent !== text) sayEl.textContent = text; // the screen always shows the current direction
    // the buzz/voice cue: within 3 s of the last one it waits (G.lastSay stays old, so it's given on a later update)
    if (text !== G.lastSay && !(hasHeading && G.lastSay && Date.now() - (G.lastBuzz || 0) < 3000)) {
      if (hasHeading && G.lastSay) { G.lastBuzz = Date.now(); buzz(text.includes('Rechtdoor') ? 10 : [30, 40, 30]); say(text.replace(/^\S+\s/, ''), true); }
      G.lastSay = text;
    }
  }
}

// ---------- dialogs (sheet, guide, viewers, story, chat, onboarding)
// - the page behind is locked, so a swipe never scrolls the screen underneath (iOS needs position: fixed for that)
// - the phone's back button / gesture closes the top dialog instead of leaving the app (a history entry per dialog)
// - keyboard users get focus moved in and kept in; on touch screens we don't move focus (it makes iOS jump)
const dialogStack = [];
const finePointer = matchMedia('(pointer: fine)').matches;
let lockedY = 0, skipPops = 0;
function lockPage(on) {
  const b = document.body;
  if (on && !b.classList.contains('locked')) {
    lockedY = scrollY; b.style.top = `-${lockedY}px`; b.classList.add('locked');
  } else if (!on && b.classList.contains('locked')) {
    b.classList.remove('locked'); b.style.top = ''; scrollTo(0, lockedY);
  }
}
// Closing a dialog with a button drops its history entry with history.back(), a little later: when another dialog
// opens in the meantime (sheet → "Breng me erheen" → guide) it takes over that entry instead (replaceState), because
// a back() that lands after the new pushState would pop the new dialog's entry and leave the app on "back".
let pendingBack = null;
function openDialog(el) {
  if (dialogStack.some((d) => d.el === el)) return; // already open (e.g. the next onboarding step): no second entry
  dialogStack.push({ el, back: document.activeElement });
  lockPage(true);
  try {
    if (pendingBack) { clearTimeout(pendingBack); pendingBack = null; history.replaceState({ pp: el.id }, ''); }
    else history.pushState({ pp: el.id }, '');
  } catch { /* ignore */ }
  if (finePointer) setTimeout(() => el.querySelector('button, [href], input, select, [tabindex="0"]')?.focus(), 30);
}
function closeDialog(el) {
  const i = dialogStack.findLastIndex((d) => d.el === el);
  if (i < 0) return;
  const [d] = dialogStack.splice(i, 1);
  if (!dialogStack.length) lockPage(false);
  if (finePointer) d.back?.focus?.();
  // closed with a button or a swipe: drop our history entry too, so "back" later doesn't do nothing
  if (!d.noHistory && history.state?.pp === el.id) {
    clearTimeout(pendingBack);
    pendingBack = setTimeout(() => { pendingBack = null; if (history.state?.pp === el.id && !dialogStack.some((x) => x.el === el)) { skipPops++; history.back(); } }, 450);
  }
}
const closers = {
  sheet: () => closeSheet(), guide: () => closeGuide(), tview: () => closeViewer(), pview: () => closePhoto(),
  story: () => closeStory(), chat: () => closeChat(), pocket: () => closePocket(), otview: () => closeOt(),
};
// pocket mode: only a long swipe up opens the app again (taps through the fabric do nothing)
{
  const pk = document.getElementById('pocket');
  let y0 = null;
  // a swipe starting in the bottom 20% is the iPhone's Home gesture, not ours
  pk?.addEventListener('touchstart', (e) => { const y = e.touches[0].clientY; y0 = y < innerHeight * 0.8 ? y : null; }, { passive: true });
  pk?.addEventListener('touchend', (e) => { if (y0 != null && y0 - e.changedTouches[0].clientY > 160) closePocket(); y0 = null; });
  pk?.addEventListener('touchcancel', () => { y0 = null; });
  if (matchMedia('(pointer: fine)').matches) pk?.addEventListener('dblclick', closePocket); // mouse only: two taps through fabric must not open
}
addEventListener('pagehide', () => store.set('tracker', S.tr));
document.addEventListener('input', (e) => { if (e.target.closest?.('#peopleForm')) S.famDirty = true; }, true);
// a photo only in memory (this browser can't store it) would be lost when the page closes: ask first
addEventListener('beforeunload', (e) => { if (S.mem.length) { e.preventDefault(); e.returnValue = ''; } });
setInterval(() => { if (S.pocket) renderPocket(); }, 30e3);
addEventListener('popstate', () => {
  if (skipPops) { skipPops--; return; }
  const top = dialogStack.at(-1);
  if (!top) return;
  if (top.el.id === 'onboard') { try { history.pushState({ pp: 'onboard' }, ''); } catch { /* ignore */ } return; } // can't back out of the welcome
  // the entry is already gone (the user pressed back): close without calling history.back() again
  top.noHistory = true;
  closers[top.el.id]?.();
});
function closeStory() { $('#story').hidden = true; closeDialog($('#story')); }
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || !dialogStack.length) return;
  const el = dialogStack.at(-1).el; if (el.hidden) return;
  const f = [...el.querySelectorAll('button:not([disabled]), [href], input, select, [tabindex="0"]')].filter((x) => x.offsetParent !== null);
  if (!f.length) return;
  if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
  else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
});

// ---------- sheets
function openSheet(html) {
  const s = $('#sheet'); const was = !s.hidden;
  s.innerHTML = `<div class="sheet-grip" aria-hidden="true"></div><button class="sheet-x" data-go="sheetclose" aria-label="Sluiten">✕</button>${html}`;
  s.scrollTop = 0; s.style.setProperty('--dy', '0px');
  s.hidden = false; $('#sheetBack').hidden = false;
  if (!was) { openDialog(s); s.classList.remove('in'); void s.offsetWidth; s.classList.add('in'); }
}
function closeSheet() {
  const s = $('#sheet'); if (s.hidden) return;
  s.hidden = true; $('#sheetBack').hidden = true; $('#sheetBack').style.opacity = '';
  s.style.setProperty('--dy', '0px'); s.classList.remove('dragging');
  closeDialog(s);
}
// swipe the sheet down to close it: it follows the finger; a long or quick swipe closes, a short one snaps back.
// Only when the sheet is scrolled to the top, so scrolling inside a long sheet keeps working.
(() => {
  const s = $('#sheet'), back = $('#sheetBack');
  let y0 = 0, dy = 0, drag = null, trail = []; // drag: null = undecided, true = dragging the sheet, false = scrolling inside
  s.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { drag = false; return; }
    y0 = e.touches[0].clientY; dy = 0; trail = [];
    drag = s.scrollTop <= 0 || !!e.target.closest('.sheet-grip') ? null : false;
  }, { passive: true });
  s.addEventListener('touchmove', (e) => {
    if (drag === false) return;
    const d = e.touches[0].clientY - y0;
    if (drag === null) { if (Math.abs(d) < 6) return; drag = d > 0; if (!drag) return; s.classList.add('dragging'); }
    e.preventDefault(); // we move the sheet; nothing scrolls
    dy = Math.max(0, d);
    const now = performance.now(); trail.push([now, dy]); while (trail.length > 2 && now - trail[0][0] > 100) trail.shift();
    s.style.setProperty('--dy', dy + 'px');
    back.style.opacity = String(Math.max(0.15, 1 - dy / 400));
  }, { passive: false });
  const end = () => {
    if (!drag) { drag = null; return; }
    drag = null; s.classList.remove('dragging');
    // speed over the last ~100 ms of the movement (a flick), in px per ms
    const v = trail.length > 1 ? (trail.at(-1)[1] - trail[0][1]) / Math.max(1, trail.at(-1)[0] - trail[0][0]) : 0;
    if (dy > Math.min(140, s.offsetHeight * 0.3) || (v > 0.5 && dy > 30)) {
      s.style.setProperty('--dy', s.offsetHeight + 'px'); back.style.opacity = '0';
      setTimeout(closeSheet, 180);
    } else { s.style.setProperty('--dy', '0px'); back.style.opacity = ''; }
  };
  s.addEventListener('touchend', end); s.addEventListener('touchcancel', end);
  // the backdrop never lets a swipe through to the page
  back.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
})();
function foodSheet() {
  const meal = isMealTime(new Date());
  const opts = foodOptions(walkOf, { mealTime: meal }).slice(0, 6);
  openSheet(`<h2>🍽️ Eten in de buurt</h2><p class="muted small">Dichtstbij eerst, plaatsen met zitplaatsen krijgen voorrang${meal ? ', en nu vooral echte maaltijden' : ''}.</p>
    <div class="alts">${opts.map(({ f, walkM }) => `<button class="alt" data-food="${f.id}"><span class="ic" aria-hidden="true">${f.kind === 'meal' ? '🍔' : '🍩'}</span>
      <span><span class="t">${esc(f.name)}</span><span class="s">${esc(f.what)}${f.seat ? ' · 🪑 zitplaatsen' : ' · afhalen'}${f.approx ? ' · ≈ locatie' : ''}</span></span><span class="wait w-off">${mins(walkM)}</span></button>`).join('')}</div>
    <p class="muted small" style="margin-top:10px">Openingsuren van eetplekken zijn niet live bekend; ’s avonds kan een kraam dicht zijn.</p>
    <div class="row2"><button data-go="ate">✓ We hebben gegeten</button><button data-go="sheetclose">Sluiten</button></div>`);
}
function toiletGo() {
  const t = S.park.toilets.map((p) => ({ p, m: walkOf(p) })).sort((a, b) => a.m - b.m)[0];
  if (!t) return toast('Geen toilet gevonden');
  openGuide({ kind: 'wc', id: 'wc', name: 'Toilet', icon: '🚻', ...t.p });
}
function rideSheet(id) {
  const a = byId[id]; if (!a || !a.cat) return;
  const st = status(S.live, id);
  const rule = (p) => {
    const c = canRide(p, a);
    if (c === 'alone') return '✅ mag';
    if (c === 'adult') return `🤝 met volwassene (min. ${a.withAdult} cm)`;
    if (p.pregnant && !a.preg) return '🚫 niet voor zwangeren';
    if (a.max && p.height > a.max) return `🚫 max. ${a.max} cm`;
    return `🚫 te klein (min. ${a.withAdult ?? a.alone} cm${a.withAdult ? ' met volwassene' : ''})`;
  };
  const favs = S.fam.favs || [];
  openSheet(`${photoSrc(a) ? `<div class="ride-photo"><img src="${photoSrc(a)}" alt="${esc(a.name)}"><span class="cr">${credit(a)}</span></div>` : ''}<div style="display:flex;gap:12px;align-items:center"><span style="font-size:2.4rem" aria-hidden="true">${a.icon}</span><div style="flex:1"><h2>${esc(a.name)}</h2>
      <span class="muted small">${COOL[a.name] === 1 ? '🔥 Topper · ' : COOL[a.name] ? '🔥 Aanrader · ' : ''}${{ kids: 'Kinderattractie', family: 'Gezinsattractie', thrill: 'Spanning' }[a.cat]} · ${mins(walkOf(a))} stappen</span></div>${waitBadge(id)}</div>
    <ul class="notes" style="margin-top:12px">${people().map((p) => `<li><span aria-hidden="true">${emoji(p)}</span><span><b>${esc(p.name)}</b> (${num(p.height)} cm): ${rule(p)}</span></li>`).join('')}</ul>
    ${a.wet ? '<p class="small">💧 Je kan nat worden.</p>' : ''}
    <p class="muted small">Min. ${a.alone ?? '–'} cm alleen${a.withAdult ? `, ${a.withAdult} cm met volwassene` : ''}${a.max ? `, max. ${a.max} cm` : ''}. Check het bordje aan de ingang.</p>
    ${st.assumed ? '<p class="small muted">Walibi geeft voor deze attractie geen live wachttijd door: ze telt als open zolang het park open is.</p>' : ''}
    <button class="primary big" data-goride="${a.id}" ${(st.known && !st.open) || markedClosed(S.fam.closed, a.id) ? 'disabled' : ''}>🧭 Breng me erheen</button>
    ${(st.known && !st.open) || markedClosed(S.fam.closed, a.id) ? '' : `<button data-queueride="${a.id}" style="width:100%">${myQueue()?.pt?.id === a.id ? '⏳ Jullie staan hier in de rij' : '⏳ We staan hier in de rij'}</button>`}
    <button class="ghost small" data-closed="${a.id}" style="width:100%">${markedClosed(S.fam.closed, a.id) ? '✅ Toch open: weer voorstellen' : '🚫 Is dicht: niet meer voorstellen vandaag'}</button>
    <div class="row2"><button data-fav="${a.id}" aria-pressed="${favs.includes(a.id)}">${favs.includes(a.id) ? '★ Favoriet' : '☆ Favoriet'}</button>
      <button data-doneone="${a.id}">✓ Gedaan${S.fam.done?.[a.id] ? ` (${S.fam.done[a.id]}×)` : ''}</button></div>`);
}
// after "Gedaan": a quick photo at the exit, so the album fills itself with the right place
function photoMoment(ids) {
  const a = byId[ids[0]]; if (!a) return;
  openSheet(`<h2>📸 Foto bij ${esc(a.name)}?</h2><p class="small muted">Nu jullie nog blij uitstappen: één foto voor het dagverslag.</p>
    <label class="filebtn solid big"><input type="file" id="camIn" accept="image/*" capture="environment" hidden><span>📸 Foto nemen</span></label>
    <button data-go="sheetclose" style="width:100%">Nee, verder</button>`);
  clearTimeout(photoMoment.t); photoMoment.t = setTimeout(() => { if ($('#sheet').innerHTML.includes('id="camIn"')) closeSheet(); }, 20000);
}

// ---------- in the queue: countdown, "it's our turn", tell the others, photo quest, facts + quiz, guess the wait.
// All of it works without signal (actions go through the outbox; facts and quests are in fun.js).
const myIdx = (plan) => plan.parts.indexOf(myPart(plan));
function myQueue() {
  const t = S.fam?.target; if (!t?.plan) return null;
  const i = myIdx(t.plan), pt = t.plan.parts[i], q = t.q?.[i];
  if (!q || !pt || pt.rest) return null;
  const a = byId[pt.id]; if (!a) return null;
  return { t, i, pt, q, a };
}
// the wait posted when we joined, corrected with the family's measured waits today
function queueLeft(Q) {
  const posted = Q.q.w ?? status(S.live, Q.a.id).wait ?? Q.pt.wait ?? 10;
  const est = posted * waitFactor(S.fam.waits);
  const gone = (Date.now() - Q.q.t) / 60e3;
  return { est: Math.round(est), gone: Math.max(0, Math.floor(gone)), left: Math.max(0, Math.round(est - gone)), frac: est ? Math.min(1, gone / est) : 1 };
}
const groupOf = (Q) => (Q ? Q.pt.group : people().map((p) => p.id)).map(person).filter(Boolean);
const quizPts = (pid) => num(S.fam?.quiz?.[pid]?.pts);
const hashOf = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h; };
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
// best guess of the real wait (same rule as family.js addWait)
const realWait = (q) => Math.round(((q.b - q.t) / 60e3) * 10) / 10; // as stored by family.js addWait
function guessWinner(g, m) {
  let win = null;
  for (const [pid, v] of Object.entries(g || {})) if (!win || Math.abs(v - m) < Math.abs(win[1] - m)) win = [pid, v];
  return win;
}
// what the planner would suggest when we come off this ride (from its exit, counting it as done)
function nextAfter(a) {
  if (!S.live || !S.park || !S.fam) return null;
  const k = `${a.id}:${S.live.t}:${JSON.stringify(S.fam.done)}:${meId()}`;
  if (nextAfter.k === k) return nextAfter.v;
  let v = null;
  try {
    const from = S.park.fromHere(a);
    const ps = plans({ ...planCtx(), done: { ...(S.fam.done || {}), [a.id]: num(S.fam.done?.[a.id]) + 1 }, walk: (x) => from.metres(x) });
    // the first suggestion that isn't this same ride again
    const pick = (pl) => pl.parts.find((x) => x.group.includes(meId()) && !x.rest) || pl.parts.find((x) => !x.rest);
    const pt = ps.map(pick).find((x) => x && x.id !== a.id);
    if (pt && byId[pt.id]) v = { a: byId[pt.id], wait: status(S.live, pt.id).wait ?? pt.wait };
  } catch { v = null; }
  nextAfter.k = k; nextAfter.v = v;
  return v;
}
function questFor(Q) {
  const done = store.get('questsDone', []);
  const list = QUESTS.filter((x) => !done.includes(x));
  const pool = list.length ? list : QUESTS;
  return pool[(Math.floor(Q.q.t / 1000) + num(S.questSkip)) % pool.length];
}
function queueCard() {
  const Q = myQueue(); if (!Q) return '';
  const { a, q, t } = Q;
  const split = t.plan.type === 'split';
  const meet = split ? byId[t.plan.meet] : null;
  const meetLine = meet ? `<div class="meet">📍 Daarna afspreken aan de uitgang van <b>${esc(meet.name)}</b></div>` : '';
  const readyBtn = split && !t.ready?.[Q.i] ? '<div class="row1"><button data-go="ready">✅ Wij zijn klaar</button></div>' : '';
  const tail = `${meetLine}
    <div class="row2"><button data-go="done">✓ Gedaan</button><button data-go="untarget">✕ Iets anders</button></div>
    ${readyBtn}`;
  if (q.b) {
    const m = Math.max(1, Math.round((q.b - q.t) / 60e3));
    const win = guessWinner(q.g, realWait(q));
    const mineReady = split && t.ready?.[Q.i];
    const others = split ? t.plan.parts[1 - Q.i] : null;
    return `<section class="qcard on" aria-label="Aan de beurt"><p class="kicker">🎢 Aan de beurt</p>
      <h2>${icon(a)} ${esc(a.name)}: veel plezier!</h2>
      <p>Jullie stonden <b>${m} min</b> in de rij${q.w != null ? ` (aangekondigd: ${num(q.w)} min)` : ''}.${win ? `<br>🏆 <b>${esc(person(win[0])?.name || '')}</b> zat er het dichtst bij met ${num(win[1])} min!` : ''}</p>
      ${mineReady ? `<p class="small">✅ De anderen weten dat jullie klaar zijn. Tik op Gedaan als jullie weer samen zijn.</p><button class="primary big" data-go="done">✓ Iedereen terug: Gedaan</button>`
        : `<button class="primary big" data-go="done">✓ ${split && others && !others.rest ? 'We zijn eraf' : 'Gedaan: we zijn eraf'}</button>`}${meetLine}${readyBtn}</section>`;
  }
  const L = queueLeft(Q);
  const now = status(S.live, a.id).wait;
  const nG = Object.keys(q.g || {}).length;
  const facts = FACTS[a.name];
  const nQ = Object.values(FACTS).reduce((s, f) => s + (f.quiz?.length || 0), 0);
  const next = nextAfter(a);
  const pct = Math.round(L.frac * 100);
  return `<section class="qcard" aria-label="In de rij"><p class="kicker">⏳ In de rij · ${esc(a.name)}</p>
    <div class="qtop">${photoSrc(a) ? `<img class="qph" src="${photoSrc(a)}" alt="">` : `<span class="qph ic" aria-hidden="true">${a.icon}</span>`}
      <div class="qtime" aria-live="polite">${L.left ? `<b>±${L.left}</b><span>min nog</span>` : '<b>Bijna!</b><span>nog even</span>'}</div></div>
    <div class="qbar" role="progressbar" aria-label="Rij" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>
    <p class="small muted">Al ${L.gone} min in de rij · aangekondigd ${q.w != null ? num(q.w) + ' min' : 'onbekend'}${now != null ? ` · nu ${num(now)} min` : ''}</p>
    <button class="primary big" data-go="board">🎢 We zijn aan de beurt!</button>
    <div class="qgames">
      ${nQ ? `<button data-go="quiz"><span aria-hidden="true">🧠</span><b>Weetjes &amp; quiz</b><i>${facts ? `Over ${esc(a.name)}` : 'Over Walibi'}</i></button>` : ''}
      <button data-go="quest"><span aria-hidden="true">🎃</span><b>Foto-opdracht</b><i>${esc(questFor(Q))}</i></button>
      <button data-go="guess"><span aria-hidden="true">🔮</span><b>Raad de wachttijd</b><i>${nG ? `${nG} ${nG === 1 ? 'gok' : 'gokken'} binnen` : 'Wie zit het dichtst?'}</i></button>
      ${split ? '<button data-go="signal"><span aria-hidden="true">📣</span><b>Seintje aan de anderen</b><i>Wanneer we klaar zijn</i></button>'
        : '<button data-go="chat"><span aria-hidden="true">💬</span><b>Gezinschat</b><i>Berichtje sturen</i></button>'}
    </div>
    ${next ? `<p class="small muted qnext">Hierna waarschijnlijk: ${next.a.icon} <b>${esc(next.a.name)}</b>${next.wait != null ? ` (${num(next.wait)} min wachten)` : ''}. Bij “Gedaan” kijk ik opnieuw.</p>` : ''}
    ${tail}</section>`;
}
// "Gedaan" (tapped, or recognised: auto = true). In a split, while the other half is still in its queue, it says
// "wij zijn klaar" instead and keeps the plan. The done action names the plan (target = setAt) so it counts once.
async function finishPlan({ auto = false, at } = {}) {
  const plan = S.fam.target?.plan;
  const ids = plan ? plan.parts.filter((p) => !p.rest).map((p) => p.id) : S.guide ? [S.guide.id] : [];
  const mine = plan ? myPart(plan) : null;
  const rated = mine && !mine.rest ? mine.id : ids[0];
  const who = mine && !mine.rest ? mine.ride || [] : plan ? [] : people().filter((p) => byId[rated] && canRide(p, byId[rated])).map((p) => p.id);
  const unknown = plan?.type === 'split' && !meId(); // don't rate or report for the wrong half
  if (S.guide && !auto) closeGuide();
  await flushGuesses();
  const t = S.fam.target, i = plan ? myIdx(plan) : 0;
  if (plan && !t) return; // finished meanwhile (the other phone)
  const other = plan?.type === 'split' ? plan.parts[1 - i] : null;
  const name = byId[rated]?.name || '';
  if (auto && other && !other.rest && !t.ready?.[1 - i]) {
    // recognising our own ride never ends the other half's plan: say "wij zijn klaar" (once) and leave it there
    if (!unknown && !t.ready?.[i] && !(await act({ type: 'ready', part: i, device, ...(at ? { at } : {}) }, true))) return false;
    autoLog(`✅ ${name} gedaan: de anderen weten het`);
    S.pendingRate = !unknown && who.length && byId[rated]?.cat ? { id: rated, who, t: Date.now() } : null;
    render();
    return;
  }
  // tapped: the other half is still in their queue → tell them we're done, keep the plan until everyone is back
  if (!auto && !unknown && other && !other.rest && !t.ready?.[i] && !t.ready?.[1 - i] && t.q?.[1 - i] && !t.q[1 - i].b) {
    if (!(await act({ type: 'ready', part: i, device }))) return;
    toast('✅ De anderen krijgen een seintje. Tik nog eens op Gedaan als jullie weer samen zijn.', null, 6000);
    if (who.length && byId[rated]?.cat) rateSheet(rated, who);
    return;
  }
  const before = ids.map((id) => num(S.fam.done?.[id]));
  if (!(await act({ type: 'done', ids, ...(t && auto ? { target: t.setAt } : {}), ...(t && !auto ? { plan: t.setAt } : {}), ...(plan && !unknown ? { part: i } : {}), ...(at ? { at } : {}) }, auto))) return auto ? false : undefined;
  if (auto) {
    // only offer "Klopt niet" when our done really counted (not when the other phone had already finished it)
    const counted = ids.some((id, k) => num(S.fam.done?.[id]) > before[k]);
    S.pendingRate = !unknown && who.length && byId[rated]?.cat ? { id: rated, who, t: Date.now() } : null;
    autoLog(`🎉 ${name} gedaan`, counted ? async () => {
      for (const [k, id] of ids.entries()) await act({ type: 'undo', id, ...(k === 0 && t ? { restore: t.setAt } : {}) }, true);
      if (plan && !S.fam.target) await act({ type: 'target', plan, device }); // only when nothing newer was chosen
      S.pendingRate = null;
    } : null, `🎉 ${name} gedaan (automatisch)`);
    render();
    return;
  }
  // a misclick: "Ongedaan" in the toast takes the ride(s) back and puts the plan back (when nothing newer was chosen)
  const counted = ids.some((id, k) => num(S.fam.done?.[id]) > before[k]);
  celebrate(counted ? async () => {
    // the first undo brings the plan back as it was (restore = its setAt); a fresh plan only if that didn't work
    for (const [k, id] of ids.entries()) await act({ type: 'undo', id, ...(k === 0 && t ? { restore: t.setAt } : {}) }, true);
    if (plan && !S.fam.target) await act({ type: 'target', plan, device }, true);
  } : null); scrollTo(0, 0);
  if (!unknown && who.length && byId[rated]?.cat) rateSheet(rated, who); else photoMoment(ids);
}
// "we're done around 14:35 at the exit of X", rounded up to 5 minutes, sent to the family chat (and pushed)
function signalOthers() {
  const Q = myQueue(); if (!Q) return;
  const L = queueLeft(Q), meet = byId[Q.t.plan.meet];
  const walk = meet && meet.id !== Q.a.id ? walkMin(distM(Q.a, meet) * 1.35) : 0;
  const at = Math.ceil((Date.now() + (L.left + Q.a.ride + 2 + walk) * 60e3) / 300e3) * 300e3;
  sendChat({ kind: 'text', text: `⏳ Wij staan in de rij voor ${Q.a.name}${L.left ? `, nog ±${L.left} min` : ', bijna aan de beurt'}. Rond ${hhmm(at)} zijn we ${meet ? `aan de uitgang van ${meet.name}` : 'klaar'}.` });
  buzz(); toast(`📣 Seintje verstuurd: rond ${hhmm(at)}`);
}
function questSheet() {
  const Q = myQueue(); const quest = Q ? questFor(Q) : QUESTS[num(S.questSkip) % QUESTS.length];
  S.quest = quest;
  openSheet(`<h2>🎃 Foto-opdracht</h2><p class="quest">${esc(quest)}</p>
    <p class="small muted">De foto komt in jullie album en in “Ons dagverslag”, met de opdracht erbij.</p>
    <label class="filebtn solid big"><input type="file" id="questIn" accept="image/*" capture="environment" hidden><span>📸 Foto nemen</span></label>
    <div class="row2"><button data-go="questskip">🔄 Andere opdracht</button><button data-go="sheetclose">Sluiten</button></div>`);
}
function quizList() {
  return Object.entries(FACTS).flatMap(([name, f]) => (f.quiz || []).map((x, i) => ({ ...x, id: `${slug(name)}-${i}`, ride: name })));
}
function quizSheet(answered, keepPlace = !!answered) {
  const Q = myQueue();
  const group = groupOf(Q);
  if (!group.some((p) => p.id === S.quizWho)) S.quizWho = (group.find((p) => p.kind === 'child' && p.height >= 110) || group.find((p) => p.kind === 'child') || group[0])?.id;
  const pid = S.quizWho;
  const a = Q?.a;
  const seen = new Set([...(S.fam.quiz?.[pid]?.ids || []), ...(S.quizSeen?.[pid] || [])]); // + answers still on their way
  const all = quizList();
  // this ride's questions first, then the others in a fixed shuffled order (the same on both phones)
  const order = [...all.filter((x) => x.ride === a?.name), ...all.filter((x) => x.ride !== a?.name).sort((x, y) => hashOf(x.id) - hashOf(y.id) || (x.id < y.id ? -1 : 1))];
  const q = answered || order.find((x) => !seen.has(x.id));
  const facts = (a && FACTS[a.name]?.facts) || [];
  const other = Object.entries(FACTS).filter(([n, f]) => n !== a?.name && f.facts?.length);
  const extra = !facts.length && other.length ? other[Math.floor(Date.now() / 60e3) % other.length] : null;
  const factBox = facts.length ? `<div class="facts"><h3>Wist je dat… over ${esc(a.name)}</h3><ul>${facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>`
    : extra ? `<div class="facts"><h3>Wist je dat… over ${esc(extra[0])}</h3><ul>${extra[1].facts.slice(0, 2).map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>` : '';
  const board = group.map((p) => `<button data-quizwho="${p.id}" aria-pressed="${p.id === pid}">${emoji(p)} ${esc(p.name)} <b>${quizPts(p.id)}</b></button>`).join('');
  const quiz = q ? `<div class="quiz"><p class="small muted">Vraag over ${esc(q.ride)}</p><h3>${esc(q.q)}</h3>
      <div class="qopts">${q.options.map((o, i) => {
        const cls = answered ? (i === q.answer ? 'right' : i === answered.picked ? 'wrong' : '') : '';
        return `<button data-quizans="${i}" class="${cls}" ${answered ? 'disabled' : ''}>${esc(o)}</button>`;
      }).join('')}</div>
      ${answered ? `<p class="why">${answered.picked === q.answer ? '🎉 Juist! +1 punt.' : '❌ Helaas.'} ${esc(q.why || '')}</p><button class="primary" data-go="quiznext" style="width:100%">Volgende vraag ›</button>` : ''}</div>`
    : '<p class="quest">Alle vragen beantwoord! 🎉 Kies iemand anders om verder te spelen.</p>';
  S.quizQ = answered ? null : q;
  openSheet(`<h2>🧠 Weetjes &amp; quiz</h2>${factBox}
    <p class="small muted" style="margin:12px 0 6px">Wie speelt? Punten tellen de hele dag.</p>
    <div class="quizwho" role="group" aria-label="Wie speelt">${board}</div>${quiz}
    <button data-go="sheetclose" style="width:100%;margin-top:12px">Sluiten</button>`);
  // after an answer, "next" or a new player: keep the question in view (the facts are above it)
  if (keepPlace) { const s = $('#sheet'), w = s.querySelector('.quizwho'); if (w) s.scrollTop = Math.max(0, w.offsetTop - 60); }
}
function guessSheet() {
  const Q = myQueue(); if (!Q) return;
  const g = { ...(Q.q.g || {}), ...(S.gdraft || {}) };
  openSheet(`<h2>🔮 Raad de wachttijd</h2>
    <p class="small muted">Hoeveel minuten staan jullie écht in de rij? Aangekondigd was ${Q.q.w != null ? num(Q.q.w) + ' min' : 'onbekend'}. Tik op “We zijn aan de beurt” als het zover is: wie het dichtst zit, wint.</p>
    <div class="guesses">${groupOf(Q).map((p) => `<div class="guess"><span class="gname">${emoji(p)} ${esc(p.name)}</span>
      <span class="gctl"><button data-guess="${p.id}:-5" aria-label="5 minuten minder">−5</button><button data-guess="${p.id}:-1" aria-label="1 minuut minder">−1</button>
      <b id="g-${p.id}" aria-live="polite">${g[p.id] != null ? num(g[p.id]) : '?'}</b>
      <button data-guess="${p.id}:1" aria-label="1 minuut meer">+1</button><button data-guess="${p.id}:5" aria-label="5 minuten meer">+5</button></span></div>`).join('')}</div>
    <button class="primary" data-go="sheetclose" style="width:100%;margin-top:12px">Klaar</button>`);
}
function guessTap(pid, d) {
  const Q = myQueue(); if (!Q) return;
  S.gdraft = S.gdraft || {};
  const cur = S.gdraft[pid] ?? Q.q.g?.[pid] ?? Q.q.w ?? 15;
  const v = Math.min(240, Math.max(1, (S.gdraft[pid] == null && Q.q.g?.[pid] == null ? cur : cur + d)));
  S.gdraft[pid] = v; buzz();
  const el = $('#g-' + pid); if (el) el.textContent = v;
  clearTimeout(guessTap.t);
  guessTap.t = setTimeout(() => { flushGuesses().then(() => { if (S.tab === 'now') renderNow(); }); }, 900);
}
// send the guesses still on this phone (also right before "aan de beurt"), one chain so nothing overtakes them
function flushGuesses() {
  clearTimeout(guessTap.t);
  const Q = myQueue(), draft = S.gdraft; S.gdraft = null;
  if (Q && draft) S.guessSend = (S.guessSend || Promise.resolve()).then(async () => { for (const [p, m] of Object.entries(draft)) await act({ type: 'guess', part: Q.i, person: p, min: m }, true); });
  return S.guessSend || Promise.resolve();
}
// after "Gedaan": how was it? (per person who rode on this phone's side) + the photo moment
function rateSheet(id, who) {
  const a = byId[id]; if (!a) return;
  const ps = who.map(person).filter(Boolean);
  if (!ps.length) { photoMoment([id]); return; }
  const r = S.fam.rates?.[id] || {};
  openSheet(`<h2>${icon(a)} Hoe was ${esc(a.name)}?</h2>
    <div class="rates">${ps.map((p) => `<div class="rate"><span>${emoji(p)} ${esc(p.name)}</span><span class="faces" role="group" aria-label="${esc(p.name)}">${[[3, '😍', 'Super, nog eens!'], [2, '🙂', 'Leuk'], [1, '😬', 'Liever niet meer']].map(([v, e, l]) => `<button data-rate="${id}:${p.id}:${v}" aria-pressed="${r[p.id] === v}" aria-label="${l}" title="${l}">${e}</button>`).join('')}</span></div>`).join('')}</div>
    <p class="small muted">😍 = graag nog eens · 😬 = liever niet meer. Het plan houdt er rekening mee.</p>
    <label class="filebtn solid big"><input type="file" id="camIn" accept="image/*" capture="environment" hidden><span>📸 Foto voor het dagverslag</span></label>
    <button data-go="sheetclose" style="width:100%">Verder</button>`);
}
// the day's fun for "Ons dagverslag": best rides, quiz champion, guessing game, measured waits
function storyFun() {
  const out = [];
  const rated = Object.entries(S.fam?.rates || {}).map(([id, r]) => { const v = Object.values(r); return { a: byId[id], r, avg: v.reduce((s, x) => s + x, 0) / v.length, n: v.length }; })
    .filter((x) => x.a).sort((x, y) => y.avg - x.avg || y.n - x.n).slice(0, 5);
  const face = { 3: '😍', 2: '🙂', 1: '😬' };
  if (rated.length) out.push(`<section class="st-fun"><h3>🏆 Onze toppers</h3><ol>${rated.map((x) => `<li>${x.a.icon} <b>${esc(x.a.name)}</b> <span>${Object.entries(x.r).map(([pid, v]) => `<span title="${esc(person(pid)?.name || '')}">${face[v]}</span>`).join('')}</span></li>`).join('')}</ol></section>`);
  const qz = people().map((p) => ({ p, ...(S.fam?.quiz?.[p.id] || {}) })).filter((x) => x.n).sort((x, y) => y.pts - x.pts);
  if (qz.length) out.push(`<section class="st-fun"><h3>🧠 Quizkampioen</h3><ol>${qz.map((x, i) => `<li>${i === 0 ? '👑' : emoji(x.p)} <b>${esc(x.p.name)}</b> <span>${num(x.pts)} van ${num(x.n)} juist</span></li>`).join('')}</ol></section>`);
  const ws = S.fam?.waits || [];
  if (ws.length) {
    const wins = {}; for (const w of ws) if (w.win) wins[w.win] = (wins[w.win] || 0) + 1;
    const real = ws.reduce((s, w) => s + w.m, 0), posted = ws.filter((w) => w.w != null);
    const best = Object.entries(wins).sort((x, y) => y[1] - x[1]);
    out.push(`<section class="st-fun"><h3>⏱ In de rij</h3><p>Samen <b>${Math.round(real)} min</b> aangeschoven in ${ws.length} ${ws.length === 1 ? 'rij' : 'rijen'}${posted.length ? `; aangekondigd was ${Math.round(posted.reduce((s, w) => s + w.w, 0))} min voor ${Math.round(posted.reduce((s, w) => s + w.m, 0))} min echt` : ''}.</p>
      ${best.length ? `<p>🔮 Beste rader: <b>${esc(person(best[0][0])?.name || '')}</b> (${best[0][1]}×)</p>` : ''}</section>`);
  }
  return out.join('');
}


// ---------- OwnTracks: background location while Pretpark is closed (free app → /api/ot/<token> → server detection)
const OT_IOS = 'https://apps.apple.com/app/owntracks/id692424691';
const OT_ANDROID = 'https://play.google.com/store/apps/details?id=org.owntracks.android';
const isAndroid = /Android/.test(navigator.userAgent);
const otUrl = (token) => `${location.origin}/api/ot/${token}`;
function otConfigLink(token) {
  const me = person(meId());
  const tid = ((me?.name || 'PP').normalize('NFD').replace(/[^A-Za-z]/g, '').slice(0, 2) || 'PP').toUpperCase();
  // HTTP mode (3), "Move" monitoring (2): frequent GPS fixes in the background; we filter ourselves (ignore… = 0)
  const cfg = { _type: 'configuration', mode: 3, url: otUrl(token), auth: false, deviceId: 'pretpark', tid, monitoring: 2,
    locatorInterval: 30, locatorDisplacement: 10, moveModeLocatorInterval: 15, ignoreInaccurateLocations: 0, extendedData: false, cmd: false, remoteConfiguration: false };
  return 'owntracks:///config?inline=' + btoa(unescape(encodeURIComponent(JSON.stringify(cfg))));
}
async function openOt() {
  S.ot = S.ot || { st: null, busy: false };
  $('#otview').hidden = false; openDialog($('#otview'));
  renderOt();
  await otStatus(true);
  clearInterval(openOt.timer); openOt.timer = setInterval(() => { if (!document.hidden && !$('#otview').hidden) otStatus(false); }, 5000);
}
function closeOt() { clearInterval(openOt.timer); $('#otview').hidden = true; closeDialog($('#otview')); render(); }
async function otStatus(create) {
  if (!S.famId) return;
  try {
    let st = await api(`/api/otsetup/${S.famId}?device=${device}`);
    if (!st.active && meId() && (create || !S.ot.stopped)) st = await api(`/api/otsetup/${S.famId}`, { method: 'POST', body: { device } }); // a link to tap right away
    const relink = st?.token !== S.ot.st?.token;
    S.ot.st = st; store.set('otActive', !!st.active && !!st.info?.t);
    // a poll only refreshes the status line (an open "Zelf instellen" or a selection stays as it is)
    if (relink || create || !$('#otview .otstate')) renderOt(); else { const n = document.createElement('div'); n.innerHTML = otState(); $('#otview .otstate').replaceWith(n.firstElementChild || n); }
    return;
  } catch { S.ot.st = S.ot.st || null; }
  renderOt();
}
function otState() {
  const st = S.ot?.st, info = st?.info || {};
  const fresh = info.t && Date.now() - info.t < 10 * 60e3;
  return !S.famId ? '<div class="otstate"></div>' : !meId() ? '<div class="otstate warn">🙋 Kies eerst wie je bent op deze gsm, dan weet Pretpark welke rij van jou is. <button class="primary" data-go="onboard">Kies</button></div>'
    : !st ? '<div class="otstate">⏳ Laden… (geen bereik?)</div>'
    : !st.active ? '<div class="otstate">⚪ Nog niet gekoppeld.</div>'
    : fresh ? `<div class="otstate ok">✅ <b>Verbonden.</b> Laatste locatie ${hhmm(info.t)} (±${info.acc ?? '?'} m${info.batt != null ? `, batterij ${info.batt}%` : ''}). Je mag Pretpark nu sluiten.</div>`
    : info.t ? `<div class="otstate warn">⚠️ Laatste locatie om ${hhmm(info.t)}: al een tijd niets. Staat OwnTracks bovenaan op <b>Actie</b> en mag het <b>altijd</b> je locatie gebruiken?</div>`
    : info.contact ? `<div class="otstate warn">🔗 <b>OwnTracks is verbonden</b> (laatste contact ${hhmm(info.contact)}), maar stuurde nog geen locatie. Kies in OwnTracks bovenaan <b>Actie</b> (niet “Significant”) en tik op <b>↑</b>.</div>`
    : '<div class="otstate">⏳ Gekoppeld, wacht op de eerste locatie. Tik in OwnTracks op <b>↑</b> (publiceer) om te testen.</div>';
}
function renderOt() {
  const el = $('#otview'); if (!el || el.hidden) return;
  const st = S.ot?.st;
  const state = otState();
  const store1 = isAndroid ? `<a class="btn primary" href="${OT_ANDROID}" target="_blank" rel="noopener">▶️ OwnTracks in de Play Store</a>`
    : isIOS ? `<a class="btn primary" href="${OT_IOS}" target="_blank" rel="noopener"> App Store: OwnTracks</a>`
    : `<a class="btn" href="${OT_IOS}" target="_blank" rel="noopener">iPhone: App Store</a> <a class="btn" href="${OT_ANDROID}" target="_blank" rel="noopener">Android: Play Store</a>`;
  const token = st?.active ? st.token : null;
  const perm = isAndroid
    ? 'Sta locatie toe met <b>Altijd toestaan</b>. Zet daarna bij Instellingen › Apps › OwnTracks › Batterij op <b>Onbeperkt</b> (anders legt Android het stil). Laat de melding van OwnTracks staan.'
    : 'Tik op <b>Toestaan</b>. Kies daarna in Instellingen › OwnTracks › Locatie: <b>Altijd</b>, en zet <b>Exacte locatie</b> aan. Laat “Ververs op achtergrond” aan.';
  el.innerHTML = `<div class="st-top"><button data-go="otclose" aria-label="Sluiten">✕</button></div>
    <header class="ot-head"><p class="kicker">Volgen met de app dicht</p><h2>📡 Pretpark in je zak</h2>
      <p class="muted">Een web-app krijgt geen locatie als ze dicht is: iPhone en Android laten dat niet toe. De gratis app <b>OwnTracks</b> wel. Die stuurt je locatie op de achtergrond naar jullie eigen Pretpark-server. Pretpark herkent dan zelf dat je in de rij staat, aan de beurt bent of klaar bent, en stuurt je een melding.</p></header>
    ${state}
    <ol class="ot-steps">
      <li><h3>Installeer OwnTracks</h3><p class="small muted">Gratis, zonder account, open source.</p><div class="ot-btns">${store1}</div></li>
      <li><h3>Koppel aan Pretpark</h3>
        ${token ? `<div class="ot-ways">
          <h4>Manier 1: zelf invullen (werkt altijd)</h4>
          <ol class="small ot-sub">
            <li><button data-go="otcopy">📋 Kopieer je geheime link</button></li>
            <li>In OwnTracks: tik linksboven op <b>ⓘ</b> › <b>Instellingen</b>${isAndroid ? ' (Android: menu ☰ › Voorkeuren › Verbinding)' : ''}.</li>
            <li><b>Modus</b>: kies <b>HTTP</b>. Bij <b>URL</b>: plak de link. Gebruikersnaam en wachtwoord: leeg laten.</li>
            <li>Terug naar de kaart en kies bovenaan <b>Actie</b> (in het Engels: <i>Move</i>).</li>
          </ol>
          <p class="ot-url"><code>${esc(otUrl(token))}</code></p>
          <h4>Manier 2: met één knop</h4>
          <p class="small">OwnTracks laat dat pas toe als je het eerst zelf aanzet: in OwnTracks › <b>ⓘ</b> › <b>Instellingen</b>, de schakelaar om <b>configuratie via URL/bestand</b> toe te staan, en bevestig. Krijg je “URI or file configuration not allowed”, dan staat die nog uit.</p>
          <div class="ot-btns"><a class="btn primary big" href="${otConfigLink(token)}">⚙️ Instellen in OwnTracks</a></div>
          <p class="small muted">Zet die schakelaar daarna gerust weer uit. De link is geheim: wie hem heeft, kan locaties naar jullie gezin sturen. Deel hem niet.</p></div>`
          : '<p class="small muted">Verschijnt zodra je gekozen hebt wie je bent.</p>'}</li>
      <li><h3>Locatie altijd toestaan</h3><p class="small">${perm}</p></li>
      <li><h3>Test</h3><p class="small">Kies in OwnTracks bovenaan <b>Actie</b> (niet “Significant”: dat meet maar om de paar honderd meter). Tik op <b>↑</b> (delen/publiceren) om je locatie nu te sturen: bovenaan deze pagina verschijnt ✅ binnen enkele seconden.</p></li>
    </ol>
    <div class="card ot-info"><h3>Goed om te weten</h3>
      <ul class="small"><li>🔋 De modus Actie (Move) gebruikt de GPS op de achtergrond: reken op flink wat batterij. Een powerbank helpt.</li>
      <li>🔒 Je locatie gaat alleen naar jullie Pretpark-server. Die houdt het spoor van de laatste 45 minuten bij (om te herkennen wat jullie doen) en je laatste positie (het puntje bij je partner). De koppeling verdwijnt na een dag zonder locaties.</li>
      <li>🤖 Wat het herkent: in de rij, aan de beurt, gedaan (bij splitsen: “wij zijn klaar”), uit de rij, eten, rust en de parkeerplek. Klopt iets niet: open Pretpark en tik “Klopt niet”.</li>
      <li>🌙 Na het park: tik hieronder op <b>Stoppen</b> en zet OwnTracks op <b>Quiet</b> of verwijder de app.</li></ul></div>
    ${st?.active ? '<div class="row2"><button data-go="otstop">⏹️ Stoppen met volgen</button><button data-go="otnew">🔄 Nieuwe koppeling</button></div>' : ''}`;
}

// ---------- location check: per person of the family, is location coming in? (Gezin card + a banner for the partner)
// One person can have several "devices" (Safari and the iPhone home-screen app have separate storage, an old
// browser…), so everything is merged per person: their newest position from any of their devices.
const ago = (t) => { const m = Math.round((Date.now() - t) / 60e3); return m < 1 ? 'net nu' : m < 60 ? `${m} min geleden` : `om ${hhmm(t)}`; };
const REJ = { acc: 'te onnauwkeurig', jump: 'onmogelijke sprong', stale: 'te oud', old: 'dubbel', approx: '“ongeveer”', bad: 'ongeldig' };
function personLoc(pid) {
  const devs = Object.keys(S.fam?.me || {}).filter((d) => S.fam.me[d] === pid);
  if (pid === meId() && !devs.includes(device)) devs.push(device);
  const links = (S.otAll || []).filter((l) => devs.includes(l.device));
  const ot = links.sort((x, y) => (y.info?.t || y.info?.contact || 0) - (x.info?.t || x.info?.contact || 0))[0] || null;
  const pos = Math.max(0, ...devs.map((d) => S.fam?.positions?.[d]?.t || 0));
  const otT = ot?.info?.t || 0;
  return { devs, ot, pos, otT, newest: Math.max(pos, otT) };
}
function locLevel(pid) {
  const { newest, ot } = personLoc(pid);
  if (pid === meId() && S.gpsGoodAt && Date.now() - S.gpsGoodAt < 2 * 60e3) return 'ok';
  if (!newest) return ot ? 'bad' : 'off';
  const age = Date.now() - newest;
  return age < 10 * 60e3 ? 'ok' : age < 30 * 60e3 ? 'warn' : ot ? 'bad' : 'off';
}
function renderLocCheck() {
  const el = $('#locCheck'); if (!el) return;
  el.hidden = !S.fam; if (!S.fam) return;
  // the people who have a phone in this family (this phone's person first)
  const pids = [...new Set([meId(), ...Object.values(S.fam.me || {})].filter((x) => x && person(x)))];
  const dot = { ok: '🟢', warn: '🟠', bad: '🔴', off: '⚪' };
  const rows = pids.map((pid) => {
    const p = person(pid);
    const { pos, ot, otT } = personLoc(pid);
    const lines = [];
    if (ot) {
      const i = ot.info || {};
      lines.push(otT ? `📡 OwnTracks: ${ago(otT)}${i.acc != null ? ` · ±${num(i.acc)} m` : ''}${i.batt != null ? ` · 🔋 ${num(i.batt)}%` : ''}${Date.now() - otT > 10 * 60e3 ? ' · staat OwnTracks op <b>Actie</b>?' : ''}`
        : i.contact ? `📡 OwnTracks verbonden (${ago(i.contact)}), nog geen locatie: kies <b>Actie</b> en tik ↑` : '📡 OwnTracks gekoppeld, nog niets ontvangen');
    } else lines.push('📡 OwnTracks: niet gekoppeld <span class="muted">(volgt alleen als Pretpark open is)</span>');
    if (pid === meId()) {
      const st = S.gpsStats, rej = Object.entries(st).filter(([k, v]) => REJ[k] && v).map(([k, v]) => `${v}× ${REJ[k]}`);
      lines.push(S.sim === 'off' ? '🛰️ GPS in de app: <b>locatie staat uit</b>'
        : S.gpsGoodAt ? `🛰️ GPS in de app: ${ago(S.gpsGoodAt)} · ±${Math.round(S.gps?.acc || 0)} m · ${st.ok} goed${rej.length ? `, genegeerd: ${rej.join(', ')}` : ''}`
        : `🛰️ GPS in de app: nog geen goede locatie${rej.length ? ` (genegeerd: ${rej.join(', ')})` : ''}`);
      if (Date.now() - (S.tr.approx || 0) < 10 * 60e3) lines.push('⚠️ “Ongeveer”-locatie: zet <b>Exacte locatie</b> aan');
      const a = S.autoLog[0];
      lines.push(S.auto ? `🤖 Herkenning: ${a ? `${esc(a.text)} (${hhmm(a.t)})` : 'nog niets herkend'}` : '🤖 Herkenning staat uit');
    } else if (pos) lines.push(`📍 Laatste positie bij de server: ${ago(pos)}`);
    return `<div class="locrow"><div class="locwho">${dot[locLevel(pid)]} <b>${emoji(p)} ${esc(p.name)}</b>${pid === meId() ? ' <span class="muted">(jij)</span>' : ''}</div>
      <ul class="small">${lines.map((l) => `<li>${l}</li>`).join('')}</ul></div>`;
  }).join('') || '<p class="small muted">Kies op elke gsm “wie ben jij” om hier iedereen te zien.</p>';
  el.innerHTML = `<h2>📍 Locatie-check</h2>${rows}
    <p class="small muted" style="margin:6px 0 0">🟢 locatie van de laatste 10 min · 🟠 10–30 min · 🔴 OwnTracks gekoppeld maar stil · ⚪ alleen als de app open is.</p>
    <button class="ghost small" data-go="loccheck" style="width:100%">🔄 Vernieuwen</button>`;
}
// someone else's OwnTracks went silent for 30 min during opening hours (not right after eating or a pause: sitting
// still, OwnTracks sends less): say so, once per silence, dismissable
function partnerSilent() {
  const L = S.live, f = S.fam;
  if (!f || !S.otAll?.length || !L?.open || Date.now() < L.open || (L.close && Date.now() > L.close)) return null;
  if (Date.now() - Math.max(f.ate || 0, f.pause || 0) < 45 * 60e3) return null;
  const pids = [...new Set((S.otAll || []).map((l) => f.me?.[l.device]).filter((pid) => pid && pid !== meId() && person(pid)))];
  for (const pid of pids) {
    const { newest, otT } = personLoc(pid);
    if (otT && Date.now() - newest > 30 * 60e3) return { pid, t: newest, who: person(pid) };
  }
  return null;
}

// ---------- stickers: every ride you do is a sticker
const stickerCount = () => ATTRACTIONS.filter((a) => S.fam?.done?.[a.id]).length;
function stickerSheet() {
  const ps = people();
  const list = [...ATTRACTIONS].sort((x, y) => (!!S.fam.done?.[y.id] - !!S.fam.done?.[x.id]) || x.name.localeCompare(y.name));
  openSheet(`<h2>🏅 Ons stickerboek</h2><p class="small muted">${stickerCount()} van ${ATTRACTIONS.length} attracties gedaan. Grijze stickers kunnen nog verdiend worden${ps.some((p) => p.kind === 'child') ? ', als je groot genoeg bent' : ''}!</p>
    <div class="stickers">${list.map((a) => {
      const n = num(S.fam.done?.[a.id]); const can = ps.some((p) => canRide(p, a));
      return `<button class="sticker ${n ? 'got' : can ? '' : 'locked'}" data-ride="${a.id}" aria-label="${esc(a.name)}: ${n ? n + '× gedaan' : can ? 'nog niet gedaan' : 'nog te klein'}"><span aria-hidden="true">${a.icon}</span><b>${esc(a.name)}</b>${n > 1 ? `<i>${n}×</i>` : ''}</button>`;
    }).join('')}</div>
    <button data-go="sheetclose" style="width:100%;margin-top:10px">Sluiten</button>`);
}

// ---------- parking ticket: €13 per car (walibi.be/nl/faq). Walibi's online shop doesn't sell it (Nov 2026: its own
// FAQ link WBETOCS2025PARKING redirects to an add-on list without parking), so the app points to the ticket booths at
// the entrance and lets you add the parking ticket you got, marked 🚗 Parking, to show it at the barrier (also offline).
const parkingTicketIndex = () => shownTickets().findIndex((t) => t.person === 'car');
function parkingCard(compact) {
  const i = parkingTicketIndex();
  if (i >= 0) return `<div class="pcard ok"><span class="pico" aria-hidden="true">🅿️</span><span><b>Parkeerticket staat klaar</b><br><span class="small muted">Toon het aan de slagboom.</span></span><button class="primary" data-tview="${i}">Toon</button></div>`;
  if (compact) return `<div class="pcard"><span class="pico" aria-hidden="true">🅿️</span><span><b>Parking: €13 per auto</b><br><span class="small muted">Betalen aan de kassa’s bij de ingang.</span></span><button data-tab="tickets">＋ Ticket</button></div>`;
  return `<div class="pcard wide"><span class="pico" aria-hidden="true">🅿️</span><span><b>Parkeerticket: €13 per auto</b><br><span class="small muted">Te koop aan de kassa’s bij de ingang van het park (online verkoopt Walibi het nu niet). Krijg je een ticket met een code? Neem er een foto van, voeg die hieronder toe en kies <b>🚗 Parking</b>: dan staat het klaar voor de slagboom.</span></span></div>`;
}

// ---------- tickets (IndexedDB on the phone + shared via the server)
const shownTickets = () => S.tickets.filter((t) => !pendingDelete.has('t:' + t.id));
// a data: image scaled to ≤ max px (JPEG); the original when the browser can't draw it
async function shrinkDataUrl(src, max) {
  try {
    const img = new Image(); img.src = src; await img.decode();
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.92);
  } catch { return src; }
}
async function syncTickets() {
  const local = await idb.all('tickets');
  if (local) S.tickets = local; // null = IndexedDB hiccup: keep what is on screen
  if (local && S.famId) {
    // send pending ones one by one: one rejected ticket must not block the rest
    for (const t of local.filter((x) => x.pending && !x.refused)) {
      if ((t.crop?.length || 0) > 850_000) t.crop = await shrinkDataUrl(t.crop, 1000); // imported before the crop was capped
      try { await api(`/api/tickets/${S.famId}`, { method: 'POST', body: { ...t, pending: undefined, error: undefined, refused: undefined }, timeout: 20000 }); t.pending = false; t.error = null; }
      catch (e) {
        if (e.offline || e.status === 401) break;
        t.error = e.error || 'niet gedeeld';
        if (e.status === 413 || (e.status === 400 && e.error !== 'too many tickets')) t.refused = true; // the same bytes would be refused again: stays on this phone only
      }
      await idb.put('tickets', t);
    }
    try {
      // deletes that didn't reach the server yet go first, and a deleted ticket is never written back
      const gone = store.get('tgone', []);
      for (const id of gone) { try { await api(`/api/tickets/${S.famId}/${id}`, { method: 'DELETE' }); store.set('tgone', store.get('tgone', []).filter((x) => x !== id)); } catch (e) { if (e.offline) throw e; } }
      const still = new Set(store.get('tgone', []));
      const remote = (await api(`/api/tickets/${S.famId}`, { timeout: 20000 })).filter((t) => !still.has(t.id));
      const ids = new Set(remote.map((t) => t.id));
      for (const t of local) if (!ids.has(t.id) && !t.pending) await idb.del('tickets', t.id);
      for (const t of remote) await idb.put('tickets', t);
      S.tickets = (await idb.all('tickets')) || S.tickets;
    } catch { /* offline: the phone's copy is enough */ }
  }
  S.tickets.sort((a, b) => (a.person || 'z').localeCompare(b.person || 'z') || a.created - b.created);
  if (S.tab === 'tickets') renderTickets();
}
async function importTickets(files) {
  if (!files.length) return;
  S.ticketBusy = 'Tickets lezen…'; renderTickets();
  try {
    const { readTickets } = await import('./tickets.js');
    const found = await readTickets(files, (msg) => { S.ticketBusy = msg; const el = $('#tbusy'); if (el) el.textContent = msg; });
    // a ticket without a code is recognised by file name + page + image size (two different "image.jpeg" don't collide)
    const keyOf = (t) => t.code || `${t.source}#${t.pageNo}#${(t.page || '').length}`;
    const known = new Set(S.tickets.map(keyOf));
    let added = 0, nr = S.tickets.length;
    for (const f of found) {
      if (known.has(keyOf(f))) continue; // importing the same file again adds nothing
      const isParking = /parking|parkeer|stationnement/i.test(`${f.source} ${f.code || ''}`);
      const t = { ...f, id: rnd(16), name: isParking ? 'Parkeerticket' : `Ticket ${++nr}`, person: isParking ? 'car' : null, created: Date.now() + nr, pending: true };
      await idb.put('tickets', t); added++;
    }
    const noCode = found.filter((f) => !f.code).length;
    const bad = (found.failed?.length ? ` · niet gelukt: ${found.failed.slice(0, 2).join(', ')}${found.failed.length > 2 ? '…' : ''}` : '')
      + (found.skipped ? ` · ${found.skipped} pagina${found.skipped > 1 ? "'s" : ''} zonder code overgeslagen` : '');
    toast((added ? `🎟️ ${added} ticket${added > 1 ? 's' : ''} toegevoegd${noCode ? ` (${noCode} zonder herkende code)` : ''}` : 'Geen nieuwe tickets gevonden') + bad, null, bad ? 6000 : undefined);
  } catch (e) {
    console.error(e); toast('Inlezen lukte niet. Probeer een screenshot van de code.');
  }
  S.ticketBusy = '';
  await syncTickets();
}
const imgSrc = (s) => (typeof s === 'string' && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(s) ? s : '');
function renderTickets() {
  const el = $('#view-tickets');
  if (!el) return;
  const ps = people();
  const list = shownTickets();
  el.innerHTML = `<p class="kicker">Onze tickets</p>
    ${parkingCard(false)}
    ${S.ticketBusy ? `<div class="card"><p id="tbusy" class="say">⏳ ${esc(S.ticketBusy)}</p></div>` : ''}
    ${list.length ? `<button class="primary big" data-tview="0" style="margin-bottom:12px">🎟️ Toon aan de ingang</button>
      <div class="tlist">${list.map((t, i) => `
      <div class="tcard">
        <button class="tthumb" data-tview="${i}" aria-label="Toon ${esc(t.name)}">${imgSrc(t.crop) ? `<img src="${imgSrc(t.crop)}" alt="">` : imgSrc(t.page) ? `<img src="${imgSrc(t.page)}" alt="" class="page">` : '🎟️'}</button>
        <div class="tinfo">
          <input type="text" data-tname="${esc(t.id)}" value="${esc(t.name)}" maxlength="40" aria-label="Naam van het ticket">
          <select data-tperson="${esc(t.id)}" aria-label="Voor wie">
            <option value="">Voor wie?</option>${ps.map((p) => `<option value="${p.id}" ${t.person === p.id ? 'selected' : ''}>${emoji(p)} ${esc(p.name)}</option>`).join('')}
            <option value="car" ${t.person === 'car' ? 'selected' : ''}>🚗 Parking</option>
          </select>
          <span class="small muted">${t.code ? `${esc(t.format)} · …${esc(String(t.code).slice(-6))}` : 'Code niet herkend: toont het hele ticket'}${t.pending ? ' · ⏳ nog niet gedeeld' : ''}${t.error ? ` · ⚠️ ${esc(t.error)}` : ''}</span>
        </div>
        <button class="ghost" data-tdel="${esc(t.id)}" aria-label="Verwijder ${esc(t.name)}">🗑️</button>
      </div>`).join('')}</div>` :
    `<div class="card"><h2>Nog geen tickets</h2><p class="muted small">Voeg jullie e-tickets toe (PDF uit de mail, of een screenshot van de QR- of barcode). Ze staan daarna op deze gsm, ook zonder bereik, en ook op de gsm van je partner.</p></div>`}
    <label class="filebtn"><input type="file" id="tfile" accept="application/pdf,image/*" multiple hidden> <span>＋ Tickets toevoegen (PDF of foto)</span></label>
    <p class="muted small">Tip: zet je scherm op maximale helderheid aan de ingang. Bij een PDF met meerdere tickets maak ik van elke code een apart ticket.</p>`;
}
let tv = { i: 0, page: false };
function openViewer(i) {
  if (!shownTickets().length) return;
  tv = { i: Math.max(0, Math.min(i, shownTickets().length - 1)), page: false };
  $('#tview').hidden = false; openDialog($('#tview')); wake(true); drawViewer();
}
function drawViewer() {
  const list = shownTickets(); const t = list[tv.i]; if (!t) return closeViewer();
  const p = person(t.person);
  const showPage = tv.page || !imgSrc(t.crop);
  $('#tview').innerHTML = `<div class="tv-top"><span>${tv.i + 1} / ${list.length}</span><button data-go="tvclose" aria-label="Sluiten">✕</button></div>
    <div class="tv-who">${t.person === 'car' ? '🚗 Parkeerticket' : p ? `${emoji(p)} ${esc(p.name)}` : esc(t.name)}</div>
    <div class="tv-code ${showPage ? 'page' : ''}"><img src="${showPage ? imgSrc(t.page) : imgSrc(t.crop)}" alt="Ticketcode van ${esc(p?.name || t.name)}"></div>
    <p class="tv-hint">☀️ Scherm op maximale helderheid · swipe voor het volgende ticket</p>
    <div class="tv-nav"><button data-go="tvprev" ${tv.i === 0 ? 'disabled' : ''}>‹ Vorige</button>
      ${imgSrc(t.crop) && imgSrc(t.page) ? `<button data-go="tvpage">${showPage ? 'Alleen de code' : 'Hele ticket'}</button>` : ''}
      <button data-go="tvnext" ${tv.i === list.length - 1 ? 'disabled' : ''}>Volgende ›</button></div>`;
}
function closeViewer() { $('#tview').hidden = true; closeDialog($('#tview')); if (!S.guide) wake(false); }

// ---------- photo album: originals go to R2 via the Worker; a queue in IndexedDB survives no signal and reloads
const photoUrl = (id, kind = 'full') => `/api/photos/${S.famId}/${encodeURIComponent(id)}/${kind}`;
const byName = (email) => { const n = String(email || '').split('@')[0].split(/[._]/)[0]; return n ? n[0].toUpperCase() + n.slice(1) : ''; };
const thumbUrls = new Map();
async function loadAlbum() {
  try {
    S.album = await api(`/api/photos/${S.famId}`, { timeout: 15000 }); S.albumOff = false;
    cached.save('album', S.album);
  } catch (e) { if (e.status === 503) S.albumOff = true; diag('album-load', `${e.status || ''} ${e.error || e.message || ''} offline=${!!e.offline}`); }
  if (S.tab === 'album') renderAlbum(); // the family's photos first, without waiting for this phone's storage
  await refreshUploads();
}
async function refreshUploads() {
  const stored = await idb.all('uploads');
  if (!stored) return;
  const q = [...stored, ...S.mem];
  const ids = new Set(q.map((u) => u.id));
  for (const [id, url] of thumbUrls) if (!ids.has(id)) { URL.revokeObjectURL(url); thumbUrls.delete(id); }
  S.queue = new Map(q.map((u) => [u.id, u]));
  // not yet in the shared album (the small version didn't go out yet)
  S.uploads = q.filter((u) => !S.album.some((a) => a.id === u.id)).map((u) => {
    const local = keepUrls.get(u.id);
    if (!local && !thumbUrls.has(u.id) && (u.thumb || u.file)) thumbUrls.set(u.id, URL.createObjectURL(u.thumb || u.file));
    return { id: u.id, t: u.meta.t, near: u.meta.near, caption: u.meta.caption || '', pending: true, src: local || thumbUrls.get(u.id) };
  });
  // kept on this phone but neither online nor queued (the server refused it): still in the album, marked
  for (const k of S.keep.values()) {
    if (ids.has(k.id) || S.album.some((a) => a.id === k.id)) continue;
    S.uploads.push({ id: k.id, t: k.meta.t, near: k.meta.near, caption: k.meta.caption || '', pending: true, onlyHere: k.refused || 'wacht', src: keepUrls.get(k.id) });
  }
  if (S.tab === 'album') renderAlbum();
}
function nearest(here) {
  let best = null;
  for (const x of [...ATTRACTIONS, ...FOOD]) { const d = distM(here, x); if (d < 90 && (!best || d < best.d)) best = { d, name: x.name }; }
  return best?.name || '';
}
async function thumbOf(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file);
    const k = Math.min(1, 640 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const thumb = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
    c.width = c.height = 0; // free the canvas memory now (iOS)
    return { thumb, w: bmp.width, h: bmp.height };
  } catch { return { thumb: null, w: null, h: null }; } // e.g. HEIC in a browser that can't decode it: the original still goes up
  finally { bmp?.close?.(); }
}
// Every album photo taken or added on this phone is kept in IndexedDB `keep` (original + thumbnail), also after
// the upload, so nothing is ever lost (photos taken in Pretpark don't go to the phone's own Photos app). Uploading is
// two steps: the small version first (seconds, even on a weak signal → in the shared album at once), then the original.
const mb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);
const keepUrls = new Map();
async function loadKeep() {
  const all = await idb.all('keep');
  if (!all) return;
  S.keep = new Map(all.map((k) => [k.id, k]));
  for (const [id, url] of keepUrls) if (!S.keep.has(id)) { URL.revokeObjectURL(url); keepUrls.delete(id); }
  for (const k of all) if (!keepUrls.has(k.id) && (k.thumb || k.file)) keepUrls.set(k.id, URL.createObjectURL(k.thumb || k.file));
}
const fresh = new Map(); // photos added since the app opened: id → { file, thumb }
// The photo's bytes in memory, as a new File. iOS Safari can send a File from the picker or from IndexedDB as an empty
// or cut-off upload body ("No initial boundary string" on the server); a copy read into memory is always sent whole.
// null (reported) when the phone can't read it at all.
async function solid(blob, name) {
  try {
    const buf = await blob.arrayBuffer();
    if (!buf.byteLength) throw new Error('empty file');
    return new File([buf], name || blob.name || 'photo.jpg', { type: blob.type || 'image/jpeg', lastModified: blob.lastModified || Date.now() });
  } catch (e) { diag('read-file', `${name || blob?.name || ''} ${blob?.type || ''} ${blob?.size ?? '?'} B: ${e?.name} ${e?.message}`); return null; }
}
async function addPhotos(files, fromCamera, caption = '') {
  const live = S.gps && !S.sim ? S.gps : null;
  let n = 0, memN = 0;
  for (const picked of files) {
    if (!picked.type.startsWith('image/') && !/\.(heic|heif)$/i.test(picked.name)) continue;
    // stored and sent as bytes in memory, not as a reference to the picker's file (see solid)
    const file = (await solid(picked, picked.name)) || picked;
    const t = fromCamera ? Date.now() : (file.lastModified || Date.now());
    const here = live && Math.abs(Date.now() - t) < 10 * 60e3 ? live : null; // only tag a place when it was taken just now
    const { thumb, w, h } = await thumbOf(file);
    const meta = { t, lat: here?.lat ?? null, lon: here?.lon ?? null, near: here ? nearest(here) : '', w, h, ...(caption ? { caption: caption.slice(0, 200) } : {}) };
    const id = rnd(16);
    // the kept copy first; the queue then only refers to it (one copy of the original on the phone).
    // From the gallery it's already in the phone's Photos app (saved: 1); from the camera it isn't.
    fresh.set(id, { id, file, thumb, meta }); // uploads use this copy while the app stays open (no storage read needed)
    const kept = await idb.put('keep', { id, file, thumb, meta, up: 0, saved: fromCamera ? 0 : 1 });
    if (!kept) diag('keep-write', `${id} ${file.type} ${mb(file.size)}`);
    const queued = kept ? await idb.put('uploads', { id, ref: 1, meta, stage: 'thumb', size: file.size })
      : await idb.put('uploads', { id, file, thumb, meta, stage: 'thumb' }); // no room for both: at least the queue
    if (!queued && !kept) {
      // this browser won't store it (private browsing, full disk): keep it in memory and send it right away
      S.mem.push({ id, file, thumb, meta, stage: 'thumb', mem: 1 }); memN++; continue;
    }
    n++;
  }
  if (memN) toast(`⚠️ ${memN === 1 ? 'Deze foto kon' : `${memN} foto’s konden`} niet op de gsm bewaard worden (privénavigatie of geheugen vol?). Laat Pretpark open tot ze online ${memN === 1 ? 'staat' : 'staan'}.`, null, 8000);
  else if (n) { buzz(); toast(n === 1 ? '📸 Foto bewaard op deze gsm' : `📸 ${n} foto’s bewaard op deze gsm`); }
  await loadKeep();
  await refreshUploads();
  processUploads();
}
let uploading = false, uploadAgain = false;
const takeAlbumItem = (p) => { S.album = [...S.album.filter((x) => x.id !== p.id), p].sort((a, b) => a.t - b.t); cached.save('album', S.album); };
const goneIds = new Set(); // deleted on purpose on this phone: an upload in flight must not bring them back
async function putPhoto(u, file, ms) {
  const t0 = Date.now();
  try {
    const r = await fetch(`/api/photos/${S.famId}/${u.id}`, { method: 'PUT', body: file, redirect: 'manual', signal: timeoutSignal(ms),
      headers: { 'content-type': file.type || 'image/jpeg', 'x-pretpark-size': String(file.size), 'x-pretpark-meta': encodeURIComponent(JSON.stringify(u.meta)) } });
    if (!r.ok) diag('up-http', `${u.id} full PUT ${file.size} B: ${r.status} ${r.type} ${(await r.clone().text().catch(() => '')).slice(0, 200)}`);
    return r;
  } catch (e) {
    diag('up-fail', `${u.id} full PUT ${file.size} B after ${Math.round((Date.now() - t0) / 1000)} s: ${e?.name} ${e?.message} · online=${navigator.onLine}`);
    return null;
  }
}
async function postPhoto(u, fd, ms) {
  const t0 = Date.now();
  try {
    const r = await fetch(`/api/photos/${S.famId}/${u.id}`, { method: 'POST', body: fd, redirect: 'manual', signal: timeoutSignal(ms) });
    if (!r.ok) diag('up-http', `${u.id} ${fd.has('full') ? 'full' : 'thumb'}: ${r.status} ${r.type} ${(await r.clone().text().catch(() => '')).slice(0, 260)}`);
    return r;
  } catch (e) { // no signal or too slow: try again later
    diag('up-fail', `${u.id} ${fd.has('full') ? 'full' : 'thumb'} after ${Math.round((Date.now() - t0) / 1000)} s: ${e?.name} ${e?.message} · online=${navigator.onLine}`);
    return null;
  }
}
// a kept photo that isn't online and isn't queued (a failed queue write, an old app version): queue it again
async function requeueKept() {
  const q = await idb.all('uploads'); if (!q) return;
  const queued = new Set(q.map((u) => u.id));
  for (const k of S.keep.values()) {
    if (k.up || k.refused || queued.has(k.id) || goneIds.has(k.id) || S.album.some((a) => a.id === k.id && a.full !== false)) continue;
    await idb.put('uploads', { id: k.id, ref: 1, meta: k.meta, stage: S.album.some((a) => a.id === k.id) ? 'full' : 'thumb', size: k.file?.size || 0 });
  }
}
// The server won't take it ('bad photo', 'photo too big', or deleted on another phone: 410): off the queue, but the
// photo stays on this phone (marked, so it isn't queued again)
async function dropFromQueue(u, k, why) {
  if (u.mem) { S.mem = S.mem.filter((x) => x.id !== u.id); return; }
  const cur = await idb.get('keep', u.id).catch(() => k);
  const kept = await idb.put('keep', { ...(cur || { id: u.id, file: k.file, thumb: k.thumb, meta: u.meta, saved: 0 }), up: 0, refused: why });
  if (kept) await idb.del('uploads', u.id); // never drop the queue entry when the photo isn't safe elsewhere
}
async function processUploads() {
  if (!S.famId) return;
  if (uploading) { uploadAgain = true; return; } // new photos while an upload runs: another round right after
  uploading = true;
  try {
    await requeueKept();
    const q = [...((await idb.all('uploads')) || []), ...S.mem].filter((u) => !goneIds.has(u.id)).sort((a, b) => a.meta.t - b.meta.t);
    const items = [];
    for (const u of q) {
      let k;
      if (!u.ref) k = u;
      // a kept photo that can't be read now is skipped (and reported): one bad entry must never block all the others
      else { try { k = fresh.get(u.id) || S.keep.get(u.id) || await idb.get('keep', u.id); } catch (e) { diag('up-read', `${u.id}: ${e?.name} ${e?.message}`); continue; } }
      if (!k?.file) { if (k === undefined) await idb.del('uploads', u.id); continue; } // its kept copy was deleted on purpose
      items.push({ u, k });
    }
    const fail = (res) => {
      if (!res) { S.offline = true; return true; }
      if (res.type === 'opaqueredirect' || res.status === 401) { S.auth = true; renderBanners(); return true; }
      if (res.status === 503) { S.albumOff = true; return true; }
      return false;
    };
    // 1. every small version first (+ details): all new photos are in the shared album within seconds
    let i = 0, stop = false;
    for (const { u, k } of items) {
      i++;
      if ((u.stage || 'thumb') !== 'thumb' || !k.thumb) continue;
      S.upMsg = `Delen ${i} van ${items.length}…`; if (S.tab === 'album') renderAlbum();
      const fd = new FormData();
      const tb = await solid(k.thumb, 'thumb.jpg'); if (!tb) continue;
      fd.append('thumb', tb, 'thumb.jpg');
      fd.append('meta', JSON.stringify({ ...u.meta, thumbOnly: true, size: k.file.size }));
      const res = await postPhoto(u, fd, 60e3);
      if (fail(res)) { stop = true; break; }
      if (goneIds.has(u.id)) continue;
      if (res.ok) { takeAlbumItem(await res.json()); u.stage = 'full'; if (!u.mem) await idb.put('uploads', u); }
      else if (res.status === 410) { await dropFromQueue(u, k, 'deleted'); u.dropped = true; }
      else if (res.status === 400 && (await res.json().catch(() => ({}))).error === 'bad photo') u.stage = 'full'; // an old server: send the original
      else { stop = true; break; }
    }
    // 2. the originals: time for their size on a slow park network (≥ 30 kB/s), up to 15 min each
    i = 0;
    for (const { u, k } of stop ? [] : items) {
      i++;
      if (u.dropped || goneIds.has(u.id)) continue;
      const size = k.file.size;
      S.upMsg = `Origineel ${i} van ${items.length} (${mb(size)})…`; if (S.tab === 'album') renderAlbum();
      // read the original into memory first: a stored file can come out empty on iOS (then: try again later)
      const body = await solid(k.file, k.file.name || `${u.id}.jpg`);
      if (!body) continue;
      // the original as raw bytes (PUT), not multipart: iOS cut big multipart bodies short; the server checks the size
      const res = await putPhoto(u, body, Math.min(15 * 60e3, 60e3 + size / 30));
      if (fail(res)) break;
      if (goneIds.has(u.id)) continue; // deleted while it was uploading: the delete removes it from the server
      if (res.ok) {
        takeAlbumItem(await res.json());
        if (u.mem) S.mem = S.mem.filter((x) => x.id !== u.id);
        else {
          let cur; try { cur = await idb.get('keep', u.id); } catch { cur = null; }
          // stays on the phone (re-read first: "saved" may have changed meanwhile)
          const ok = await idb.put('keep', { ...(cur || { id: u.id, file: k.file, thumb: k.thumb, meta: u.meta, saved: 0 }), up: 1 });
          if (ok) await idb.del('uploads', u.id);
        }
      } else {
        const err = res.status === 410 ? 'deleted' : (await res.json().catch(() => ({}))).error;
        if (err === 'bad photo' || err === 'photo too big' || err === 'deleted') {
          await dropFromQueue(u, k, err);
          if (err !== 'deleted') toast('Eén foto kon niet online, ze blijft wel op deze gsm');
        } else if (res.status >= 500 || res.status === 409) continue; // this one failed (a cut-off body…): the next still go
        else break;
      }
    }
  } finally {
    uploading = false; S.upMsg = '';
    await loadKeep();
    await refreshUploads();
    if (uploadAgain) { uploadAgain = false; setTimeout(processUploads, 0); }
  }
}
// shared photos (with this phone's own thumbnail when it has the photo: also offline) + not-yet-shared ones;
// origWait = the original of a shared photo is still on its way from this phone
function albumItems() {
  return [...S.album.map((p) => ({ ...p, src: keepUrls.get(p.id) || photoUrl(p.id, 'thumb'), local: S.keep.has(p.id), origWait: S.queue.has(p.id) })), ...S.uploads.map((x) => ({ ...x, local: S.keep.has(x.id) }))]
    .filter((x) => !pendingDelete.has(x.id)).sort((a, b) => a.t - b.t);
}
const hourOf = (t) => new Date(t).toLocaleString('nl-BE', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit' }).replace(/ om (\d+)$/, ' · $1u');
function renderAlbum() {
  const el = $('#view-album'); if (!el) return;
  const items = albumItems();
  const groups = [];
  for (const it of items) { const k = hourOf(it.t); if (groups.at(-1)?.k !== k) groups.push({ k, items: [] }); groups.at(-1).items.push(it); }
  el.innerHTML = `<p class="kicker">Ons album</p>
    ${S.albumOff ? '<div class="banner">☁️ De fotoserver is even niet bereikbaar. Je foto’s blijven veilig op deze gsm en gaan vanzelf online.</div>' : ''}
    <div class="row2" style="margin-top:0">
      <label class="filebtn solid"><input type="file" id="camIn" accept="image/*" capture="environment" hidden><span>📸 Foto nemen</span></label>
      <label class="filebtn"><input type="file" id="galIn" accept="image/*" multiple hidden><span>🖼️ Uit galerij</span></label>
    </div>
    ${store.get('camLost', 0) ? '<p class="small upwait">💡 Je gsm sloot Pretpark al eens terwijl de camera open stond (die foto kwam niet aan). Veiliger: fotografeer met de camera-app van je gsm en voeg toe met 🖼️ Uit galerij.</p>' : ''}
    <p class="small muted">${items.length} foto’s · 📱 ${S.keep.size} staan op deze gsm${S.queue.size ? ` · ⏳ ${S.queue.size} ${S.queue.size === 1 ? 'gaat' : 'gaan'} nog online` : ''}${S.upMsg ? ` · ${esc(S.upMsg)}` : ''}. Originele kwaliteit, gedeeld met het gezin.</p>
    ${S.queue.size && !S.upMsg ? `<p class="small upwait">⏳ ${S.offline ? 'Wacht op bereik.' : 'Houd Pretpark even open (in de app, scherm aan), dan gaan ze online.'} Ze staan veilig op deze gsm.</p>` : ''}
    ${unsaved().length && navigator.canShare ? `<button class="ghost small" data-go="savephotos" style="width:100%">💾 Bewaar ${Math.min(10, unsaved().length)} ${unsaved().length > 10 ? `van ${unsaved().length} ` : ''}foto’s ook in je Foto’s-app</button>` : ''}
    <div class="row2 tight"><button class="primary" data-go="story">📖 Ons dagverslag</button><button data-go="stickers">🏅 Stickers ${stickerCount()}/${ATTRACTIONS.length}</button></div>
    ${groups.map((g) => `<h3 class="ghead">${esc(g.k)}</h3><div class="grid">${g.items.map((it) => `
      <button class="ph" data-photo="${esc(it.id)}" aria-label="Foto ${hhmm(it.t)}${it.near ? ' bij ' + esc(it.near) : ''}">
        <img src="${esc(it.src)}" alt="" loading="lazy">${it.pending || it.origWait ? '<span class="badge">⏳</span>' : it.star ? '<span class="badge">⭐</span>' : ''}</button>`).join('')}</div>`).join('')
      || '<div class="empty">Nog geen foto’s. Tik op 📸 en maak er samen een mooie dag van!</div>'}`;
}
let pv = { i: 0, blob: null, blobId: null };
function openPhoto(id) {
  const items = albumItems();
  pv = { i: Math.max(0, items.findIndex((x) => x.id === id)), blob: null, blobId: null };
  $('#pview').hidden = false; openDialog($('#pview')); drawPhoto();
}
function drawPhoto() {
  const items = albumItems(); const it = items[pv.i]; if (!it) return closePhoto();
  const when = new Date(it.t).toLocaleString('nl-BE', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  $('#pview').innerHTML = `<div class="pv-top"><span>${pv.i + 1} / ${items.length}</span><button data-go="pvclose" aria-label="Sluiten">✕</button></div>
    <div class="pv-img"><img src="${esc(localFull(it.id) || (it.pending ? it.src : photoUrl(it.id)))}" alt="" data-fb="${esc(it.src || '')}" onerror="this.onerror=null;if(this.dataset.fb)this.src=this.dataset.fb" style="background-image:url('${esc(it.src || '')}')"></div>
    <div class="pv-info"><b>${when}</b>${it.near ? ` · 📍 ${esc(it.near)}` : ''}${it.by ? ` · 📷 ${esc(byName(it.by))}` : ''}${it.onlyHere ? ' · 📱 alleen op deze gsm' : it.pending ? ' · ⏳ nog niet gedeeld, staat veilig op deze gsm' : it.origWait ? ` · ⏳ origineel volgt${S.queue.get(it.id)?.size ? ` (${mb(S.queue.get(it.id).size)})` : ''}: houd Pretpark even open` : it.full === false && !it.local ? ' · ⏳ het origineel komt nog van een andere gsm' : ''}${it.local ? ' · 📱 op deze gsm' : ''}</div>
    ${it.pending ? `<div class="pv-actions">${navigator.canShare ? '<button data-go="pvshare">💾 Bewaar in Foto’s</button>' : ''}<button data-go="pvdel" aria-label="Verwijder">🗑️</button></div>` : `<div class="pv-actions">
      <button data-go="pvstar" aria-pressed="${!!it.star}">${it.star ? '⭐ Favoriet' : '☆ Favoriet'}</button>
      ${it.full === false && !it.local ? '' : `<a class="btn" href="${esc(photoUrl(it.id))}?dl=1" download>⬇️ Bewaar</a>
      ${navigator.canShare ? '<button data-go="pvshare">📤 Deel</button>' : ''}`}
      <button data-go="pvdel" aria-label="Verwijder">🗑️</button></div>`}
    <div class="pv-nav"><button data-go="pvprev" ${pv.i === 0 ? 'disabled' : ''} aria-label="Vorige">‹</button><button data-go="pvnext" ${pv.i === items.length - 1 ? 'disabled' : ''} aria-label="Volgende">›</button></div>`;
  // fetch the original now, so "Deel" can open the share sheet straight from the tap (iOS requires that)
  if (S.keep.get(it.id)?.file) { pv.blob = S.keep.get(it.id).file; pv.blobId = it.id; } // the original on this phone
  else if (navigator.canShare && !it.pending && it.full !== false && pv.blobId !== it.id) {
    pv.blob = null; pv.blobId = it.id;
    fetch(photoUrl(it.id)).then((r) => r.blob()).then((b) => { if (pv.blobId === it.id) pv.blob = b; }).catch(() => {});
  }
}
// an object URL of this phone's original, for the open photo only (released when another one is shown)
function localFull(id) {
  const f = S.keep.get(id)?.file; if (!f) return null;
  if (localFull.id !== id) { if (localFull.url) URL.revokeObjectURL(localFull.url); localFull.url = URL.createObjectURL(f); localFull.id = id; }
  return localFull.url;
}
function closePhoto() { $('#pview').hidden = true; closeDialog($('#pview')); pv.blob = null; if (localFull.url) { URL.revokeObjectURL(localFull.url); localFull.url = null; localFull.id = null; } }
// photos taken in Pretpark that aren't in the phone's own Photos app yet
const unsaved = () => [...S.keep.values()].filter((k) => !k.saved && k.file).sort((a, b) => a.meta.t - b.meta.t);
const asFile = (k) => (k.file instanceof File && k.file.name ? k.file : new File([k.file], `walibi-${k.id}.${(k.file.type || 'image/jpeg').split('/')[1].replace('jpeg', 'jpg')}`, { type: k.file.type || 'image/jpeg' }));

// The wrap-up: the day as a timeline of rides done and photos taken, favourites big
function openStory() {
  const items = albumItems().filter((x) => !x.pending);
  const log = (S.fam?.log || []).flatMap((l) => (l.ids || []).map((id) => ({ t: l.t, ride: byId[id] }))).filter((x) => x.ride);
  const all = [...items.map((p) => ({ t: p.t, photo: p })), ...log].sort((a, b) => a.t - b.t);
  const rides = Object.values(S.fam?.done || {}).reduce((a, b) => a + num(b), 0);
  const fav = Object.entries(S.fam?.done || {}).sort((a, b) => b[1] - a[1])[0];
  const day = all.length ? new Date(all[0].t).toLocaleDateString('nl-BE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const first = all[0]?.t, last = all.at(-1)?.t;
  $('#story').innerHTML = `<div class="st-top"><button data-go="storyclose" aria-label="Sluiten">✕</button></div>
    <header class="st-head"><p class="kicker">Onze dag in Walibi</p><h2>${esc(day)}</h2>
      <div class="stats st-stats"><div class="stat"><b>${rides}</b><span>${rides === 1 ? 'ritje' : 'ritjes'}</span></div><div class="stat"><b>${items.length}</b><span>foto’s</span></div>
      <div class="stat"><b>${stickerCount()}</b><span>stickers</span></div>
      ${first ? `<div class="stat"><b>${hhmm(first)}</b><span>tot ${hhmm(last)}</span></div>` : ''}${fav ? `<div class="stat"><b>${num(fav[1])}×</b><span>${esc(byId[fav[0]]?.name || '')}</span></div>` : ''}</div></header>
    ${storyFun()}
    <ol class="st-line">${all.map((x) => x.photo
      ? `<li class="${x.photo.star ? 'big' : ''}"><time>${hhmm(x.t)}</time><button class="ph" data-photo="${esc(x.photo.id)}"><img src="${esc(photoUrl(x.photo.id, x.photo.star ? 'full' : 'thumb'))}" alt="" loading="lazy"></button>${x.photo.caption ? `<span class="cap">${esc(x.photo.caption)}</span>` : ''}${x.photo.near ? `<span class="small muted">📍 ${esc(x.photo.near)}</span>` : ''}</li>`
      : `<li class="ride"><time>${hhmm(x.t)}</time><span>${x.ride.icon} <b>${esc(x.ride.name)}</b></span></li>`).join('')}</ol>
    <p class="muted small" style="text-align:center;margin:24px 0">Tip: markeer je mooiste foto’s met ⭐, dan komen ze groot in het verslag.</p>`;
  $('#story').hidden = false; $('#story').scrollTop = 0; openDialog($('#story'));
}

// ---------- undo instead of "are you sure?": deletes wait 5 s
const pendingDelete = new Map();
function deleteLater(id, label, doIt) {
  pendingDelete.set(id, setTimeout(async () => { pendingDelete.delete(id); await doIt(); }, 5000));
  toast(`${label} verwijderd`, { label: 'Ongedaan maken', fn: () => { clearTimeout(pendingDelete.get(id)); pendingDelete.delete(id); render(); toast('Teruggezet'); } }, 5000);
}

// ---------- family chat: messages on the server (D1), a send queue on the phone for no-signal moments
const QUICK = ['Waar zijn jullie?', 'We zijn klaar 👍', 'Kom naar ons', 'Even rusten 🪑', 'Wij gaan eten 🍽️'];
const msgName = (m) => (m.device === device ? 'Jij' : person(m.person)?.name || byName(m.by) || 'Gezin');
const unread = () => S.chat.filter((m) => m.device !== device && m.t > S.chatRead).length;
async function loadChat() {
  if (!S.famId) return;
  try {
    const last = S.chat.at(-1)?.t || 0;
    const fresh = await api(`/api/chat/${S.famId}${last ? `?after=${last - 60e3}` : ''}`);
    const ids = new Set(S.chat.map((m) => m.id));
    const added = fresh.filter((m) => !ids.has(m.id)); // the 60-s overlap brings back messages we already have
    if (added.length) {
      const before = unread();
      S.chat = [...S.chat, ...added].sort((a, b) => a.t - b.t).slice(-300);
      cached.save('chat', S.chat);
      if (S.chatOpen) markRead(); else if (unread() > before) buzz([30, 30, 30]);
      renderChatBadge(); if (S.chatOpen) renderChat();
    }
  } catch { /* next time */ }
}
let chatSending = false;
async function flushChat() {
  if (chatSending) return; // one sender: two at once would send one message twice and drop the next
  chatSending = true;
  try {
    while (S.chatQ.length && S.famId) {
      const msg = S.chatQ[0];
      try {
        const m = await api(`/api/chat/${S.famId}`, { method: 'POST', body: msg });
        S.chat = [...S.chat.filter((x) => x.id !== m.id), m].sort((a, b) => a.t - b.t);
        cached.save('chat', S.chat);
      } catch (e) { if (e.status !== 400) break; } // keep it for later, unless the server says it's invalid
      S.chatQ = S.chatQ.filter((x) => x.id !== msg.id); store.set('chatq', S.chatQ);
    }
  } finally { chatSending = false; }
  if (S.chatOpen) renderChat();
}
function sendChat(body) {
  const m = { id: rnd(12), t: Date.now(), person: meId(), device, ...body };
  S.chatQ.push(m); store.set('chatq', S.chatQ);
  buzz(); if (S.chatOpen) renderChat();
  flushChat();
}
function markRead() { S.chatRead = Math.max(S.chatRead, S.chat.at(-1)?.t || 0); store.set('chatRead', S.chatRead); renderChatBadge(); }
function renderChatBadge() {
  const n = unread(); const b = $('#chatBadge');
  if (b) { b.textContent = n > 9 ? '9+' : n; b.hidden = !n; }
  $('#chatBtn')?.setAttribute('aria-label', n ? `Gezinschat, ${n} nieuw` : 'Gezinschat');
}
function openChat() {
  S.chatOpen = true; $('#chat').hidden = false;
  $('#chat').innerHTML = `<div class="ch-head"><h2>💬 Gezinschat</h2><button data-go="chatclose" aria-label="Sluiten">✕</button></div>
    <div class="ch-list" id="chList" aria-live="polite"></div>
    <div class="ch-quick">${QUICK.map((q) => `<button data-quick="${esc(q)}">${esc(q)}</button>`).join('')}<button data-go="chatloc">📍 Deel mijn plek</button></div>
    <form id="chatForm" class="ch-form"><input type="text" name="text" maxlength="500" placeholder="Bericht aan het gezin…" autocomplete="off" aria-label="Bericht"><button class="primary" type="submit" aria-label="Versturen">➤</button></form>`;
  openDialog($('#chat'));
  renderChat(); markRead(); loadChat(); flushChat();
  clearInterval(openChat.timer); openChat.timer = setInterval(() => { if (!document.hidden) loadChat(); }, 4000);
}
// iOS doesn't shrink the page for the keyboard: size the chat to the visible part of the screen
const vv = window.visualViewport;
if (vv) {
  const fit = () => { const r = document.documentElement.style; r.setProperty('--vvh', vv.height + 'px'); r.setProperty('--vvt', vv.offsetTop + 'px'); };
  vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit();
}
function closeChat() { S.chatOpen = false; clearInterval(openChat.timer); $('#chat').hidden = true; closeDialog($('#chat')); renderChatBadge(); }
function renderChat() {
  const list = $('#chList'); if (!list) return;
  const all = [...S.chat, ...S.chatQ.map((m) => ({ ...m, t: m.t || Date.now(), pending: true }))];
  let lastDay = '';
  list.innerHTML = all.length ? all.map((m) => {
    const mine = m.device === device;
    const day = new Date(m.t).toLocaleDateString('nl-BE', { weekday: 'long', day: 'numeric', month: 'long' });
    const sep = day !== lastDay ? `<p class="ch-day">${esc(day)}</p>` : ''; lastDay = day;
    const body = m.kind === 'loc'
      ? `<b>📍 Hier ben ik${m.near ? ` · bij ${esc(m.near)}` : ''}</b>${m.text ? `<br>${esc(m.text)}` : ''}${mine ? '' : `<br><button class="ch-go" data-chatgo="${esc(m.id)}">🧭 Breng me erheen (${mins(walkOf(m))})</button>`}`
      : esc(m.text);
    return `${sep}<div class="ch-msg ${mine ? 'mine' : ''}"><span class="ch-who">${esc(msgName(m))} · ${m.pending ? '⏳' : hhmm(m.t)}</span><div class="ch-bubble">${body}</div></div>`;
  }).join('') : '<p class="empty">Nog geen berichten. Zeg iets tegen het gezin, of deel je plek als jullie gesplitst zijn.</p>';
  list.scrollTop = list.scrollHeight;
}

// ---------- car and lost child
function carSheet() {
  const c = S.fam.car;
  const canSave = S.gps && !S.manual && !S.sim;
  openSheet(`<h2>🚗 De auto</h2>
    ${parkingCard(true)}
    ${c ? `<p class="small muted">Bewaard om ${hhmm(c.t)}${c.note ? ` · ${esc(c.note)}` : ''} · ${mins(walkOf(c))} stappen</p>
      <button class="primary big" data-go="carguide">🧭 Breng me naar de auto</button>` : '<p class="small muted">Bewaar waar de auto staat als je hem parkeert. Vanavond brengt de pijl je terug, ook in het donker.</p>'}
    <label style="display:block;margin:12px 0 6px"><span class="small muted">Notitie (bv. rij C12)</span>
      <input type="text" id="carNote" maxlength="60" value="${esc(c?.note || '')}" class="field"></label>
    <div class="row2"><button ${canSave || S.gps ? '' : 'disabled'} data-go="carsave">📍 ${c ? 'Opnieuw bewaren' : 'Auto staat hier'}</button><button data-go="sheetclose">Sluiten</button></div>
    ${S.gps ? '' : '<p class="small muted">Zet locatie aan om de plek te bewaren.</p>'}`);
}
async function lostSheet() {
  const photos = ((await idb.all('photos')) || []).sort((a, b) => b.t - a.t);
  const today = photos.filter((x) => new Date(x.t).toDateString() === new Date().toDateString());
  const partner = Object.entries(S.fam.positions || {}).some(([d, p]) => d !== device && Date.now() - p.t < 15 * 60e3);
  const ps = people();
  const kids = ps.filter((p) => p.kind === 'child' && phoneOf(p.phone));
  const others = ps.filter((p) => p.kind === 'adult' && p.id !== meId() && phoneOf(p.phone));
  const sms = encodeURIComponent('Waar ben je? Blijf staan waar je bent en zoek iemand in Walibi-kleren. Ik kom eraan!');
  const callRow = (p, primary) => { const n = phoneOf(p.phone); return `<div class="callrow"><a class="btn ${primary ? 'primary' : ''}" href="tel:${n}">📞 Bel ${esc(p.name)}</a><a class="btn" href="sms:${n}?&body=${sms}">💬 Sms</a></div>`; };
  const calls = kids.map((p) => callRow(p, true)).join('') + others.map((p) => callRow(p, false)).join('');
  openSheet(`<h2>🆘 Kind kwijt?</h2>
    ${calls ? `<div class="calls">${calls}</div>` : ''}
    ${ps.some((p) => p.kind === 'child') && !kids.length ? '<p class="small muted">Heeft een kind een eigen gsm? Vul het nummer in bij <button class="linkbtn" data-tab="fam">Gezin</button>, dan kun je hier met één tik bellen.</p>' : ''}
    <ol class="steps"><li><b>Blijf waar je bent</b> en spreek meteen een <b>Walibi-medewerker</b> aan. Zij hebben een procedure voor verloren kinderen.</li>
      <li>Toon de <b>foto van vandaag</b> hieronder (kleren!).</li>
      <li>${kids.length ? 'Bel je kind (knop hierboven), en bel' : 'Bel'} je partner.${partner ? ' Hun laatste plek staat op de kaart (paarse stip).' : ''}</li>
      <li>Leer je kinderen vooraf: <b>blijf staan en zoek iemand in Walibi-kleren</b>.</li></ol>
    ${today.length ? `<div class="photos">${today.map((x) => `<img src="${imgSrc(x.data)}" alt="Foto van vandaag">`).join('')}</div>` : '<p class="small muted">Nog geen foto van vandaag. Neem er ’s morgens één van de kinderen: dan zie je precies welke kleren ze aanhebben.</p>'}
    <label class="filebtn"><input type="file" id="photoIn" accept="image/*" capture="environment" hidden><span>📸 Foto van de kinderen nemen</span></label>
    <p class="small muted">Deze foto’s blijven alleen op deze gsm en worden niet geüpload. Tip: schrijf je gsm-nummer op de arm of een polsbandje van de kinderen.</p>
    <button data-go="sheetclose" style="width:100%;margin-top:8px">Sluiten</button>`);
}
async function savePhoto(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = bmp.width * k; c.height = bmp.height * k;
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
  await idb.put('photos', { id: rnd(12), t: Date.now(), data: c.toDataURL('image/jpeg', 0.8) });
  const all = ((await idb.all('photos')) || []).sort((a, b) => b.t - a.t);
  for (const x of all.slice(6)) await idb.del('photos', x.id); // keep only the last 6
  lostSheet();
}

// ---------- onboarding: new family or join one; who am I; names
function onboard(step = S.fam ? 'who' : 'start') {
  const el = $('#onboard');
  el.hidden = false;
  if (step === 'start') {
    el.innerHTML = `<div class="ob"><img src="icon.svg" alt="" width="64" height="64"><h2>Welkom bij Pretpark</h2>
      <p class="muted">Jullie gids voor Walibi: wat nu doen, hoe er te geraken, waar eten.</p>
      <button class="primary big" data-go="obnew">✨ Nieuw gezin starten</button>
      <form id="joinForm" class="joinrow ob-join"><input type="text" name="link" placeholder="Of plak de link van de andere gsm" autocomplete="off" aria-label="Gezinslink"><button type="submit">Openen</button></form>
      <p class="small muted">Op de iPhone-beginscherm-app? Plak de gezinslink van Safari of van je partner.</p></div>`;
  } else {
    const ps = people();
    el.innerHTML = `<form class="ob" id="obForm"><h2>Wie zijn jullie?</h2><p class="muted small">Echte namen maken de suggesties persoonlijk (“Jij en Lotte → Kondaa”).</p>
      ${ps.map((p) => `<label class="obp"><span aria-hidden="true">${emoji(p)}</span><input type="text" name="${p.id}" value="${esc(/^(Volwassene \d|Groot kind|Peuter)$/.test(p.name) ? '' : p.name)}" placeholder="${esc(p.name)}" maxlength="24" autocomplete="off"></label>`).join('')}
      <h3>Wie gebruikt deze gsm?</h3>
      <div class="seg">${ps.filter((p) => p.kind === 'adult').map((p, i) => `<label class="segopt"><input type="radio" name="me" value="${p.id}" ${meId() === p.id || (!meId() && p.id === freeAdult()) ? 'checked' : ''}> <span>${emoji(p)} ${esc(p.name)}${claimed().has(p.id) ? ' <small class="muted">(ook op een andere gsm)</small>' : ''}</span></label>`).join('')}</div>
      <button class="primary big" type="submit">Klaar</button>
      <button type="button" class="ghost small" data-go="obskip">Later</button></form>`;
  }
  openDialog(el);
}
function closeOnboard() { $('#onboard').hidden = true; closeDialog($('#onboard')); store.set('onboarded', true); }

// ---------- banners (only what needs attention; the weather & opening hours sit in the status line)
const isDark = () => !isDaylight(new Date()); // real sunset/sunrise at Walibi
function renderBanners() {
  const b = [];
  if (S.newVersion) b.push(['update', '✨', 'Er is een nieuwe versie. <button class="x" data-go="reload">Herladen</button>']);
  if (S.auth) b.push(['auth', '🔒', '<b>Opnieuw inloggen nodig.</b> <button class="x" data-go="relogin">Log in</button>']);
  if (S.offline) b.push(['offline', '📶', `<b>Geen bereik.</b> Ik werk verder met de laatste gegevens${S.live?.t ? ` (wachttijden van ${hhmm(S.live.t)})` : ''}.${S.outbox.length ? ` ${S.outbox.length} wijziging(en) wachten.` : ''}`]);
  if (!S.manual && S.sim === 'far') b.push(['far', '📍', '<b>Je bent niet in Walibi.</b> Ik reken vanaf de ingang.']);
  if (!S.manual && S.sim === 'off') b.push(['off', '📍', '<b>Locatie staat uit.</b> Ik reken vanaf de ingang. Zet locatie aan voor de wandelgids.']);
  if (!S.manual && S.sim !== 'off' && Date.now() - S.tr.approx < 5 * 60e3 && (!S.gps || Date.now() - S.gpsAt > 2 * 60e3)) b.push(['approx', '📍', `<b>Locatie is maar “ongeveer”.</b> Zet <b>Exacte locatie</b> aan: ${/iPhone|iPad/.test(navigator.userAgent) ? 'Instellingen › Privacy en beveiliging › Locatievoorzieningen › Safari-websites › Exacte locatie' : 'Instellingen › Apps › Chrome › Rechten › Locatie'}.`]);
  if (S.manual) b.push(['manual', '📍', 'Je hebt je positie zelf gekozen op de kaart.']);
  const L = S.live;
  if (L?.open && Date.now() < L.open) b.push(['before', '🕙', `Walibi opent om <b>${hhmm(L.open)}</b>.`]);
  else if (L && L.close && Date.now() > L.close) b.push(['closed', '🌙', 'Walibi is nu gesloten. Wachttijden zijn van de laatste meting.']);
  else if (L && !L.close && !Object.values(L.rides || {}).some((r) => r.s === 'OPERATING')) b.push(['closed', '🌙', 'Er is nu niets open.']);
  if (L?.close && Date.now() < L.close && L.close - Date.now() <= 45 * 60e3) {
    b.push(['closing', '⏰', `<b>Nog ${Math.round((L.close - Date.now()) / 60e3)} min open.</b> Tijd voor de laatste ronde${S.fam?.car ? ', daarna brengt 🚗 Auto je terug' : ''}.`]);
  }
  const ps = partnerSilent();
  if (ps && !S.dismissed['loc:' + ps.pid + ':' + ps.t]) {
    b.push(['loc:' + ps.pid + ':' + ps.t, '📍', `<b>Geen locatie van ${esc(ps.who?.name || 'de andere gsm')} sinds ${ps.t ? hhmm(ps.t) : 'lang'}.</b> Staat OwnTracks daar nog op Actie? Bel even via 🆘 als je ze zoekt.`]);
  }
  if (isDark() && new Date().getMonth() >= 9 && hasToddler() && !S.dismissed['night' + new Date().toDateString()]) {
    b.push(['night' + new Date().toDateString(), '🎃', '<b>Donker: scare zones.</b> Met de peuter op de brede paden blijven. Te eng? Hand op en “stop” zeggen.', 'night']);
  }
  $('#banners').innerHTML = b.map(([k, i, t, cls]) => `<div class="banner ${cls || ''}"><span aria-hidden="true">${i}</span><span>${t}</span>${(k.startsWith('night') || k.startsWith('loc:')) ? `<button class="x" data-dismiss="${k}" aria-label="Verbergen">✕</button>` : ''}</div>`).join('');
  const pill = $('#livePill');
  if (L) {
    pill.textContent = `${S.liveStale ? 'Laatst' : 'Live'} ${hhmm(L.t)}`;
    pill.classList.toggle('stale', Date.now() - L.t > 5 * 60e3 || S.liveStale);
  } else pill.textContent = '—';
}
// Light while it's light outside, dark from sunset (or a fixed choice). Sets the colours, the phone's status bar
// colour, and a timer for the exact next sunrise/sunset so the switch happens on time, not up to 30 s late.
const phoneDark = matchMedia('(prefers-color-scheme: dark)');
phoneDark.addEventListener?.('change', () => applyTheme());
let themeTimer = null;
function applyTheme() {
  const now = new Date();
  const dark = S.theme === 'dark' || (S.theme === 'system' && phoneDark.matches) || (S.theme === 'sun' && !isDaylight(now));
  const root = document.documentElement;
  const want = dark ? 'dark' : 'light';
  if (root.dataset.theme !== want) {
    root.dataset.theme = want;
    root.style.colorScheme = want;
    try { localStorage.setItem('pp:lastTheme', want); } catch { /* fine */ }
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = dark ? '#171127' : '#fff6ec';
    if (MAP.svg) drawPins(); // map labels use theme colours
  }
  clearTimeout(themeTimer);
  if (S.theme === 'sun') {
    const { rise, set } = sunTimes(now);
    const next = [rise, set, sunTimes(new Date(now.getTime() + 864e5)).rise].find((t) => t > now);
    if (next) themeTimer = setTimeout(applyTheme, Math.min(next - now + 1000, 6 * 3600e3));
  }
}

function render() {
  applyTheme();
  renderBanners();
  for (const t of ['now', 'map', 'album', 'tickets', 'fam']) $('#view-' + t).hidden = S.tab !== t;
  document.querySelectorAll('.tabs button').forEach((b) => (b.dataset.tab === S.tab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  if (S.tab === 'tickets' && !document.activeElement?.closest('#view-tickets input, #view-tickets select')) renderTickets();
  if (!S.fam) return;
  if (S.tab === 'now') renderNow();
  if (S.tab === 'map') renderMapView();
  if (S.tab === 'album') renderAlbum();
  if (S.tab === 'fam') { if (S.famDirty || document.activeElement?.closest('#view-fam form, #view-fam input, #view-fam details[open]')) renderLocCheck(); else renderFam(); }
  if (S.guide) updateGuide();
}

let toastTimer;
function toast(t, action, ms = 2600) {
  if (S.pocket) return; // the black pocket screen shows nothing that a tap through the fabric could hit
  const el = $('#toast');
  el.innerHTML = `<span>${esc(t)}</span>${action ? `<button data-go="toastaction">${esc(action.label)}</button>` : ''}`;
  el.classList.add('on'); el.classList.toggle('act', !!action);
  toast.action = action || null;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.classList.remove('on'); toast.action = null; }, ms);
}

// ---------- events
function guideTap(target) { enableCompass(true); openGuide(target); } // compass permission must be asked inside the tap
document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, [data-ride], [data-food], [data-wc]');
  if (!t || t.disabled) return;
  const d = t.dataset;
  if (d.tab) { S.tab = d.tab; S.famDirty = false; buzz(); closeSheet(); render(); scrollTo(0, 0); return; }
  if (d.mapmode) { S.mapMode = d.mapmode; renderMapView(); return; }
  if (d.tview) { openViewer(+d.tview); return; }
  if (d.quick) { sendChat({ kind: 'text', text: d.quick }); return; }
  if (d.chatgo) { const m = S.chat.find((x) => x.id === d.chatgo); if (m) { closeChat(); guideTap({ kind: 'meet', id: 'chat-' + m.id, name: `Naar ${msgName(m)}`, icon: '📍', lat: m.lat, lon: m.lon }); } return; }
  if (d.photo) { openPhoto(d.photo); return; }
  if (d.tdel) {
    const id = d.tdel;
    deleteLater('t:' + id, 'Ticket', async () => {
      store.set('tgone', [...new Set([...store.get('tgone', []), id])]);
      await idb.del('tickets', id); S.tickets = S.tickets.filter((x) => x.id !== id); renderTickets();
      api(`/api/tickets/${S.famId}/${id}`, { method: 'DELETE' }).then(() => store.set('tgone', store.get('tgone', []).filter((x) => x !== id))).catch(() => {});
    });
    renderTickets();
    return;
  }
  if (d.themepick) { S.theme = d.themepick; store.set('theme', S.theme); applyTheme(); renderFam(); return; }
  if (d.walk) { await act({ type: 'walk', pref: d.walk }); toast(d.walk === 'low' ? 'Ik hou de wandelingen kort 👟' : 'Normaal stappen'); return; }
  if (d.me) { await act({ type: 'me', device, person: d.me }); toast('Top! 👋'); return; }
  if (d.filter) { S.filter = d.filter; renderList(); return; }
  if (d.fav) { buzz(); await act({ type: 'fav', id: d.fav, on: !(S.fam.favs || []).includes(d.fav) }); if (!$('#sheet').hidden && $('#sheet').querySelector(`[data-goride="${d.fav}"]`)) rideSheet(d.fav); return; }
  if (d.undo) { await act({ type: 'undo', id: d.undo }); return; }
  if (d.showgo) { showGo(d.showgo); return; }
  if (d.hdel) { await histDelete(JSON.parse(d.hdel)); return; }
  if (d.quizwho) { S.quizWho = d.quizwho; quizSheet(null, true); return; }
  if (d.quizans != null && S.quizQ) {
    const q = S.quizQ, picked = +d.quizans, ok = picked === q.answer;
    S.quizSeen = S.quizSeen || {}; (S.quizSeen[S.quizWho] ||= []).push(q.id);
    buzz(ok ? [20, 40, 20] : 60);
    quizSheet({ ...q, picked });
    const who = S.quizWho;
    act({ type: 'quiz', person: who, q: q.id, ok }, true).then((sent) => {
      if (!sent) S.quizSeen[who] = S.quizSeen[who].filter((x) => x !== q.id); $('#sheet').querySelectorAll('[data-quizwho] b').forEach((b) => { b.textContent = quizPts(b.parentElement.dataset.quizwho); }); });
    return;
  }
  if (d.guess) { const [pid, n] = d.guess.split(':'); guessTap(pid, +n); return; }
  if (d.rate) {
    const [id, pid, v] = d.rate.split(':'); buzz();
    t.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
    act({ type: 'rate', id, person: pid, v: +v }, true);
    return;
  }
  if (d.closed) {
    const on = !markedClosed(S.fam.closed, d.closed);
    await act({ type: 'closed', id: d.closed, on });
    toast(on ? '🚫 Gemeld: ik stel deze attractie vandaag niet meer voor' : '✅ Weer open'); rideSheet(d.closed); return;
  }
  if (d.queueride) {
    const id = d.queueride, t = S.fam.target;
    // the ride of our current plan: just "in de rij"; any other ride: that ride becomes our plan (our half in a split)
    if (t?.plan && myPart(t.plan)?.id === id) await queueAt(t.plan); else await queueAt(planForRide(id));
    return;
  }
  if (d.qplan) { await queueAt(shownPlans.get(d.qplan)); return; }
  if (d.doneone) {
    const id = d.doneone; closeSheet(); if (S.guide) closeGuide();
    // the ride of the current plan: the normal "Gedaan" (ends the plan); any other ride: counted, the plan stays
    if (S.fam.target?.plan?.parts?.some((p) => p.id === id)) { await finishPlan(); return; }
    const when = Date.now();
    if (!(await act({ type: 'ridelog', id, when }))) return;
    celebrate(() => act({ type: 'histdel', k: 'ride', id, t: when }, true)); photoMoment([id]); return;
  }
  if (d.dismiss) { S.dismissed[d.dismiss] = 1; store.set('dismissed', S.dismissed); renderBanners(); return; }
  if (d.goride) { const a = byId[d.goride]; closeSheet(); guideTap({ kind: 'ride-solo', id: a.id, name: a.name, icon: a.icon, lat: a.lat, lon: a.lon }); return; }
  if (d.food) { const f = byId[d.food]; closeSheet(); guideTap({ kind: 'food', id: f.id, name: f.name, icon: '🍽️', lat: f.lat, lon: f.lon }); return; }
  if (d.wc) { const p = S.park.toilets[+d.wc.slice(2)]; if (p) guideTap({ kind: 'wc', id: 'wc', name: 'Toilet', icon: '🚻', ...p }); return; }
  if (d.ride && !t.matches('button.star')) { closeSheet(); rideSheet(d.ride); return; }
  const go = d.go; if (!go) return;
  if (go.startsWith('choose:')) {
    const plan = (d.pkey && shownPlans.get(d.pkey)) || S.plans[+go.slice(7)]; if (!plan) return;
    guideTap(guideTargetFor(plan));
    act({ type: 'target', plan, device });
    return;
  }
  switch (go) {
    case 'guide': if (S.fam.target?.plan) guideTap(guideTargetFor(S.fam.target.plan)); break;
    case 'guideclose': closeGuide(); break;
    case 'done': await finishPlan(); break;
    case 'askyes': S.ask = null; await finishPlan({ at: Date.now() }); break;
    case 'askno': S.ask = null; render(); break;
    case 'rateopen': { const pr = S.pendingRate; S.pendingRate = null; if (pr) rateSheet(pr.id, pr.who); render(); break; }
    case 'ratelater': S.pendingRate = null; render(); break;
    case 'pocket': openPocket(); break;
    case 'autoundo': await undoLast(); break;
    case 'diaperdone': await act({ type: 'diaper' }); toast('🚼 Top! Ik herinner je er later weer aan'); break;
    case 'diaperlater': store.set('diaperLater', Date.now()); render(); break;
    case 'loccheck': S.otAllAt = 0; await loadOtAll(); renderLocCheck(); break;
    case 'ot': openOt(); break;
    case 'otclose': closeOt(); break;
    case 'otcopy': { const u = S.ot?.st?.token ? otUrl(S.ot.st.token) : ''; try { await navigator.clipboard.writeText(u); toast('Link gekopieerd'); } catch { toast('Kopiëren lukte niet: houd de link ingedrukt'); } break; }
    case 'otstop': S.ot.stopped = true; try { await api(`/api/otsetup/${S.famId}?device=${device}`, { method: 'DELETE' }); S.ot.st = { active: false }; store.set('otActive', false); toast('Gestopt. Zet OwnTracks op Quiet of verwijder de app.', null, 6000); } catch { toast('Geen verbinding. Probeer zo opnieuw.'); } renderOt(); break;
    case 'otnew': S.ot.stopped = false; try { S.ot.st = await api(`/api/otsetup/${S.famId}`, { method: 'POST', body: { device } }); toast('Nieuwe koppeling: tik opnieuw op “Instellen in OwnTracks”.', null, 6000); } catch { toast('Geen verbinding. Probeer zo opnieuw.'); } renderOt(); break;
    case 'queue': {
      const plan = S.fam.target?.plan; if (!plan) break;
      if (plan.type === 'split' && !meId()) { toast('Kies eerst wie je bent, dan weet ik welke rij van jullie is'); onboard('who'); break; }
      const i = myIdx(plan), pt = plan.parts[i];
      if (!(await act({ type: 'queue', part: i, wait: pt?.id && status(S.live, pt.id).known ? status(S.live, pt.id).wait : null }))) break;
      if (S.guide) closeGuide(); scrollTo(0, 0);
      toast('⏳ Rij-modus aan: spelletjes en aftellen op Nu'); break;
    }
    case 'board': {
      const Q = myQueue(); if (!Q) break;
      await flushGuesses();
      if (!(await act({ type: 'board', part: Q.i }))) break;
      buzz([40, 40, 80]);
      const q = S.fam.target?.q?.[Q.i];
      const win = q?.b && guessWinner(q.g, realWait(q));
      toast(win ? `🏆 ${person(win[0])?.name || ''} raadde het best!` : '🎢 Veel plezier!'); break;
    }
    case 'signal': signalOthers(); break;
    case 'quest': questSheet(); break;
    case 'questskip': S.questSkip = num(S.questSkip) + 1; questSheet(); if (S.tab === 'now') renderNow(); break;
    case 'quiz': quizSheet(); break;
    case 'quiznext': quizSheet(null, true); break;
    case 'guess': guessSheet(); break;
    case 'ready': {
      const plan = S.fam.target?.plan; if (!plan) break;
      if (plan.type === 'split' && !meId()) { toast('Kies eerst wie je bent, dan weet ik welke helft klaar is'); onboard('who'); break; }
      await act({ type: 'ready', part: plan.parts.indexOf(myPart(plan)), device });
      toast('✅ De anderen krijgen een seintje'); break;
    }
    case 'untarget': await act({ type: 'untarget' }); break;
    case 'food': foodSheet(); break;
    case 'toilet': toiletGo(); break;
    case 'history': openHistory(); break;
    case 'shows': openShows(); break;
    case 'histadd': {
      const sel = $('#histRide'), tm = $('#histAddT');
      const when = timeToday(tm?.value);
      if (!sel?.value) { toast('Kies eerst een attractie'); break; }
      if (when == null) { toast('Die tijd klopt niet (vandaag, niet later dan nu)'); break; }
      if (await act({ type: 'ridelog', id: sel.value, when }, true)) { toast(`✓ ${byId[sel.value]?.name} toegevoegd om ${hhmm(when)}`); openHistory(); render(); }
      break;
    }
    case 'pause': await act({ type: 'pause' }); { const r = restSpot(pos()); toast(`🪑 Rust goed!${r ? ` Dichtbij: ${r.name} (${mins(walkOf(r))})` : ''}`); } break;
    case 'ate': await act({ type: 'ate' }); closeSheet(); if (S.guide) closeGuide(); toast('Smakelijk! 😋'); break;
    case 'sheetclose': closeSheet(); break;
    case 'stickers': stickerSheet(); break;
    case 'chat': openChat(); break;
    case 'chatclose': closeChat(); break;
    case 'chatloc': {
      const here = S.manual && Date.now() - S.manual.t < 20 * 60e3 ? S.manual : S.gps && !S.sim ? S.gps : null;
      if (!here) { toast('Geen locatie: zet GPS aan of kies je plek op de kaart'); break; }
      sendChat({ kind: 'loc', lat: +here.lat.toFixed(6), lon: +here.lon.toFixed(6), near: nearest(here), text: '' });
      break;
    }
    case 'tvclose': closeViewer(); break;
    case 'story': openStory(); break;
    case 'storyclose': closeStory(); break;
    case 'pvclose': closePhoto(); break;
    case 'pvprev': pv.i = Math.max(0, pv.i - 1); drawPhoto(); break;
    case 'pvnext': pv.i = Math.min(albumItems().length - 1, pv.i + 1); drawPhoto(); break;
    case 'pvstar': {
      const it = albumItems()[pv.i]; if (!it) break; it.star = !it.star;
      const p = S.album.find((x) => x.id === it.id); if (p) p.star = it.star;
      drawPhoto(); renderAlbum();
      api(`/api/photos/${S.famId}/${it.id}`, { method: 'PATCH', body: { star: it.star } }).catch(() => toast('Opslaan lukte niet'));
      break;
    }
    case 'pvshare': {
      const it = albumItems()[pv.i];
      if (!pv.blob || pv.blobId !== it?.id) { toast('Foto wordt nog geladen, probeer zo opnieuw'); break; }
      const type = pv.blob.type || 'image/jpeg';
      const file = new File([pv.blob], `walibi-${it.id}.${type.split('/')[1] === 'jpeg' ? 'jpg' : type.split('/')[1]}`, { type });
      navigator.share({ files: [file] }).then(() => { const k = S.keep.get(it.id); if (k) { k.saved = 1; idb.put('keep', k); } })
        .catch((err) => { if (err.name !== 'AbortError') toast('Delen lukte niet'); });
      break;
    }
    case 'savephotos': {
      // the share sheet → "Bewaar N afbeeldingen" (iOS) / "Opslaan" (Android); 10 at a time, straight from the tap
      const batch = []; let total = 0;
      for (const k of unsaved()) { if (batch.length >= 10 || (batch.length && total + k.file.size > 40e6)) break; batch.push(k); total += k.file.size; }
      const files = batch.map(asFile);
      if (!files.length) break;
      if (navigator.canShare && !navigator.canShare({ files })) { toast('Deze gsm kan foto’s niet zo bewaren. Open een foto en tik op ⬇️ Bewaar.'); break; }
      navigator.share({ files }).then(async () => {
        for (const k of batch) { k.saved = 1; await idb.put('keep', k); }
        toast(`💾 ${batch.length} foto’s doorgegeven: kies “Bewaar afbeeldingen”`); renderAlbum();
      }).catch((err) => { if (err.name !== 'AbortError') toast('Bewaren lukte niet'); });
      break;
    }
    case 'pvdel': {
      const it = albumItems()[pv.i]; if (!it) break;
      deleteLater(it.id, 'Foto', async () => {
        goneIds.add(it.id);
        // deleting on purpose removes it everywhere: the shared album, the queue and the copy on this phone
        await idb.del('uploads', it.id); await idb.del('keep', it.id);
        S.mem = S.mem.filter((x) => x.id !== it.id);
        // always (also for a photo that seemed not uploaded: it may have gone up during the 5-s undo)
        try { await api(`/api/photos/${S.famId}/${it.id}`, { method: 'DELETE' }); S.album = S.album.filter((x) => x.id !== it.id); cached.save('album', S.album); }
        catch { if (!it.pending) toast('Verwijderen lukte niet'); }
        await loadKeep(); await refreshUploads(); renderAlbum();
      });
      if (!albumItems().length) closePhoto(); else { pv.i = Math.min(pv.i, albumItems().length - 1); drawPhoto(); }
      renderAlbum();
      break;
    }
    case 'toastaction': { const a = toast.action; $('#toast').classList.remove('on'); a?.fn(); if (!$('#pview').hidden) drawPhoto(); break; }
    case 'tvprev': tv.i = Math.max(0, tv.i - 1); tv.page = false; drawViewer(); break;
    case 'tvnext': tv.i = Math.min(shownTickets().length - 1, tv.i + 1); tv.page = false; drawViewer(); break;
    case 'tvpage': tv.page = !tv.page; drawViewer(); break;
    case 'car': carSheet(); break;
    case 'carsave': if (S.gps) { await act({ type: 'car', lat: S.gps.lat, lon: S.gps.lon, note: $('#carNote')?.value || '' }); toast('🚗 Plek bewaard'); closeSheet(); } break;
    case 'carguide': { const c = S.fam.car; closeSheet(); guideTap({ kind: 'car', id: 'car', name: 'De auto', icon: '🚗', lat: c.lat, lon: c.lon }); break; }
    case 'lost': lostSheet(); break;
    case 'relogin': location.href = '/?g=' + (S.famId || '') + '&fresh=' + Date.now(); break;
    case 'reload': location.reload(); break;
    case 'compass': if (await enableCompass(true)) { toast('🧭 Kompas aan'); setTimeout(() => updateGuide(true), 600); } else toast('Kompas niet beschikbaar op dit toestel'); break;
    case 'voice': S.voice = !S.voice; store.set('voice', S.voice); if (S.voice) say('Gesproken aanwijzingen staan aan.', true); updateGuide(true); break;
    case 'mapme': { const h = S.park.toXY(pos()); MAP.cx = h.x; MAP.cy = h.y; MAP.R = 160; drawPins(); break; }
    case 'mappark': MAP.cx = -20; MAP.cy = -40; MAP.R = 420; drawPins(); break;
    case 'place': S.placing = !S.placing; renderMapView(); if (S.placing) toast('Tik op de kaart waar je staat'); break;
    case 'gps': S.manual = null; store.set('manual', null); recompute(); render(); break;
    case 'share': {
      const url = `${location.origin}/?g=${S.famId}`;
      if (navigator.share) navigator.share({ title: 'Pretpark', text: 'Ons plan voor Walibi', url }).catch(() => {});
      else { await navigator.clipboard?.writeText(url).catch(() => {}); toast('Link gekopieerd'); }
      break;
    }
    case 'copy': await navigator.clipboard?.writeText(`${location.origin}/?g=${S.famId}`).then(() => toast('Link gekopieerd'), () => toast('Kopiëren lukte niet')); break;
    case 'pushon': await pushOn(); break;
    case 'pushoff': await pushOff(); break;
    case 'pushtest': try { const r = await api('/api/push', { method: 'POST', body: { device, family: S.famId, prefs: pushPrefs(), test: true } }); toast(r.ok ? 'Testmelding verstuurd' : 'Versturen lukte niet'); } catch { toast('Versturen lukte niet'); } break;
    case 'onboard': onboard('who'); break;
    case 'obnew': try { await newFamily(); await afterFamily(); onboard('who'); } catch { toast('Geen verbinding. Probeer zo opnieuw.'); } break;
    case 'obskip': closeOnboard(); render(); break;
  }
});
function celebrate(undo) {
  buzz([20, 40, 20]);
  const n = Object.values(S.fam?.done || {}).reduce((a, b) => a + num(b), 0);
  const fix = undo ? { label: 'Ongedaan', fn: async () => { if (!$('#sheet').hidden) closeSheet(); await undo(); toast('Teruggezet. Ook later kan het via 📜 Geschiedenis.', null, 4000); render(); } } : null;
  toast(n && n % 5 === 0 ? `🎉 Al ${n} ritjes! Hier is het volgende.` : '✓ Gedaan! Hier is het volgende.', fix, undo ? 7000 : undefined);
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#chat').hidden) closeChat(); else if (!$('#pview').hidden) closePhoto(); else if (!$('#story').hidden) closeStory();
    else if (!$('#tview').hidden) closeViewer(); else if (!$('#sheet').hidden) closeSheet(); else if (S.guide) closeGuide();
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('g.pin')) {
    e.preventDefault(); e.target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
});
$('#sheetBack').addEventListener('click', closeSheet);
document.addEventListener('change', async (e) => {
  const id = e.target.id;
  if (e.target.dataset.hmove) {
    const it = JSON.parse(e.target.dataset.hmove), to = timeToday(e.target.value);
    if (to == null) { toast('Die tijd klopt niet (vandaag, niet later dan nu)'); e.target.value = hhmmIn(it.t); return; }
    if (Math.abs(to - it.t) < 60e3) return;
    if (await act({ type: 'histmove', ...it, to }, true)) { toast(`Tijd aangepast: ${hhmm(to)}`); openHistory(); render(); }
    return;
  }
  if (id === 'tfile') { importTickets([...e.target.files]); return; }
  if (id === 'camIn' || id === 'hdrCam') { const f = [...e.target.files]; e.target.value = ''; store.set('camOpen', 0); if (!$('#sheet').hidden && $('#sheet').contains(e.target)) closeSheet(); addPhotos(f, true); return; }
  if (id === 'questIn' && e.target.files[0]) {
    const f = [...e.target.files]; e.target.value = ''; const quest = S.quest || '';
    store.set('questsDone', [...store.get('questsDone', []), quest].slice(-40)); S.questSkip = 0;
    closeSheet(); addPhotos(f, true, '🎃 ' + quest); if (S.tab === 'now') renderNow(); return;
  }
  if (id === 'galIn') { addPhotos([...e.target.files], false); e.target.value = ''; return; }
  if (id === 'photoIn' && e.target.files[0]) { savePhoto(e.target.files[0]).catch(() => toast('Foto bewaren lukte niet')); return; }
  if (e.target.dataset.setting) {
    const k = e.target.dataset.setting; S[k] = e.target.checked; store.set(k, S[k]); applyTheme(); return;
  }
  const tid = e.target.dataset.tname || e.target.dataset.tperson;
  if (tid) {
    const t = S.tickets.find((x) => x.id === tid); if (!t) return;
    const patch = e.target.dataset.tname ? { name: e.target.value.slice(0, 40) } : { person: e.target.value || null };
    Object.assign(t, patch); await idb.put('tickets', t);
    if (!t.pending) api(`/api/tickets/${S.famId}/${t.id}`, { method: 'PATCH', body: patch }).catch(() => { t.pending = true; idb.put('tickets', t); });
    if (e.target.dataset.tperson) renderTickets(); // the parking card and the order follow the choice
    return;
  }
  if (e.target.dataset.pref) {
    const p = pushPrefs(); p[e.target.dataset.pref] = e.target.checked; store.set('pushPrefs', p);
    api('/api/push', { method: 'POST', body: { device, family: S.famId, prefs: p } }).catch(() => toast('Opslaan lukte niet'));
  }
});
document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'joinForm') { await joinFamily(f.link.value); return; }
  if (f.id === 'chatForm') { const v = f.text.value.trim(); if (v) { sendChat({ kind: 'text', text: v.slice(0, 500) }); f.text.value = ''; } f.text.focus(); return; }
  if (f.id === 'obForm') {
    const ps = people().map((p) => ({ ...p, name: (f[p.id]?.value || '').trim() || p.name }));
    const me = f.querySelector('[name=me]:checked')?.value;
    await act({ type: 'people', people: ps });
    if (me) await act({ type: 'me', device, person: me });
    closeOnboard(); render(); toast('Top! Veel plezier 🎢'); return;
  }
  if (f.id === 'peopleForm') {
    const ps = [...f.querySelectorAll('.person')].map((row) => ({
      id: row.dataset.id, kind: row.dataset.kind, name: row.querySelector('[name=name]').value,
      height: +row.querySelector('[name=height]').value, pregnant: !!row.querySelector('[name=pregnant]')?.checked,
      phone: row.querySelector('[name=phone]')?.value || '',
    }));
    const bad = [...f.querySelectorAll('[name=phone]')].find((i) => i.value.trim() && !phoneOf(i.value));
    if (bad) { bad.focus(); toast('Dat gsm-nummer klopt niet (bv. +32 470 12 34 56)'); return; }
    document.activeElement?.blur();
    if (await act({ type: 'people', people: ps })) { S.famDirty = false; toast('Opgeslagen ✓'); renderFam(); }
  }
});
let swipeX = null, swipeY = null, swipeIn = null;
document.addEventListener('touchstart', (e) => {
  swipeIn = e.target.closest('#tview') ? 't' : e.target.closest('#pview') ? 'p' : null;
  swipeX = swipeIn ? e.touches[0].clientX : null; swipeY = swipeIn ? e.touches[0].clientY : null;
}, { passive: true });
document.addEventListener('touchend', (e) => {
  if (swipeX == null) return;
  const dx = e.changedTouches[0].clientX - swipeX, dy = e.changedTouches[0].clientY - swipeY; swipeX = null;
  if (dy > 110 && Math.abs(dy) > Math.abs(dx) * 1.5) { if (swipeIn === 't') closeViewer(); else closePhoto(); return; } // swipe down closes
  if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy)) return;
  if (swipeIn === 't') { tv.i = Math.max(0, Math.min(shownTickets().length - 1, tv.i + (dx < 0 ? 1 : -1))); tv.page = false; drawViewer(); }
  if (swipeIn === 'p') { pv.i = Math.max(0, Math.min(albumItems().length - 1, pv.i + (dx < 0 ? 1 : -1))); drawPhoto(); }
});
addEventListener('online', () => { flushOutbox(); syncTickets(); loadLive(); processUploads(); flushChat(); loadChat(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { store.set('tracker', S.tr); if (S.pocket) S.pocketBroke = Date.now(); return; }
  processUploads(); // photos waiting for the app to be open: go on right away
  if (S.pocket && S.pocketBroke) { S.pocketBroke = 0; S.afterPocket = 'Het scherm ging toch uit: in die tijd kreeg de app geen locatie. Ik vul het gat zelf aan.'; } // shown when the pocket screen opens (no toasts on it)
  loadLive(); pollFamily();
  if (S.guide || !$('#tview').hidden || S.pocket) wake(true); // the system drops the wake lock when the app goes to the background
  // phones pause the location watch in the background and usually resume it; only when no fix came within 8 s start a
  // fresh one (restarting always can ask for permission again on iOS), and never after location was refused
  const back = Date.now();
  setTimeout(() => { if (!document.hidden && S.sim !== 'off' && (S.tr.raw?.t || 0) < back) startGps(); }, 8000);
});

// ---------- start
async function afterFamily() {
  recompute(); render();
  await loadLive();
  flushOutbox(); syncTickets(); loadAlbum().then(processUploads).then(() => reportAlbumState('start')); syncPushFamily();
  renderChatBadge(); flushChat(); loadChat();
  // warm the offline cache with the ride photos (small, once per version)
  setTimeout(() => { for (const p of Object.values(PHOTOS)) fetch(`/img/rides/${p.fn}`).catch(() => {}); }, 4000);
}
(async function start() {
  S.outbox = store.get('outbox', []);
  { const m = store.get('inflight', null); const list = (m?.aid ? [m] : Object.values(m || {})).filter((f) => f?.aid && !S.outbox.some((x) => x.aid === f.aid)).sort((a, b) => a.at - b.at);
    if (list.length) { S.outbox.unshift(...list); store.set('outbox', S.outbox); } store.set('inflight', null); } // the server de-dupes by aid
  applyTheme();
  render(); // first paint never waits for the phone's storage (iOS can leave IndexedDB hanging)
  checkLostCamera();
  S.tickets = (await idb.all('tickets')) || [];
  await loadKeep();
  navigator.storage?.persist?.().catch(() => {});
  render();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type !== 'open') return;
      let u; try { u = new URL(e.data.url, location.origin); } catch { return; }
      const go = u.searchParams.get('go');
      if (go && byId[go]) { S.tab = 'now'; render(); rideSheet(go); }
      else if (u.searchParams.get('food')) foodSheet();
      else if (u.searchParams.get('tickets')) { S.tab = 'tickets'; render(); }
      else if (u.searchParams.get('chat')) openChat();
      else if (u.searchParams.get('shows')) openShows();
      else { pollFamily(); loadLive(); }
    });
    // Updates: an iPhone home-screen app is never reloaded by itself and iOS rarely looks for a new service worker,
    // so a phone could run old code all day (7 Nov: Pieter's phone kept the broken photo upload). Look for an update
    // at every return and every 10 min; once the new version is installed, load it at a safe moment: when the app
    // comes back to the front (nothing half-typed), or right away when nothing is open.
    const hadSw = !!navigator.serviceWorker.controller; // the very first install is no "update" (no reload then)
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      const ready = () => { if (!hadSw) return; S.newVersion = true; renderBanners(); if (calmMoment()) location.reload(); };
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => { if (w.state === 'activated' && S.swAt) ready(); else if (w.state === 'installed' && navigator.serviceWorker.controller) { S.newVersion = true; renderBanners(); } });
      });
      S.swAt = Date.now();
      const check = () => { if (Date.now() - (S.swCheck || 0) > 60e3) { S.swCheck = Date.now(); reg.update().catch(() => {}); } };
      setInterval(check, 10 * 60e3);
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) { S.hiddenAt = Date.now(); return; }
        if (S.newVersion && Date.now() - (S.hiddenAt || 0) > 2e3) { location.reload(); return; } // back from elsewhere
        check();
      });
    }).catch(() => {});
  }
  const url = new URL(location.href);
  try {
    const parkData = await fetch('park.json').then((r) => r.json());
    S.park = makePark(parkData);
    startGps();
    if (typeof window.DeviceOrientationEvent?.requestPermission !== 'function') enableCompass(false);
    const have = await loadFamily();
    if (!have) { onboard('start'); }
    else {
      if (!meId() && !store.get('onboarded')) onboard('who');
      await afterFamily();
    }
    const go = url.searchParams.get('go');
    if (go && byId[go]) { S.tab = 'now'; render(); rideSheet(go); }
    if (url.searchParams.get('food')) foodSheet();
    if (url.searchParams.get('tickets')) { S.tab = 'tickets'; render(); }
    if (url.searchParams.get('chat')) openChat();
    if (url.searchParams.get('shows')) openShows();
  } catch (err) {
    console.error(err);
    $('#view-now').innerHTML = `<div class="card"><h2>${S.auth ? 'Even opnieuw inloggen' : 'Oei, dat lukte niet'}</h2><p class="muted">${S.auth ? 'Je sessie is verlopen.' : 'Geen verbinding en nog geen opgeslagen gegevens op deze gsm.'}</p><button class="primary" data-go="relogin">Opnieuw</button></div>`
      + (S.tickets.length ? '<button class="primary big" data-tab="tickets">🎟️ Toon onze tickets</button>' : '');
  }
  setInterval(loadLive, 60e3);
  setInterval(pollFamily, 15e3);
  setInterval(() => { if (!document.hidden) { processUploads(); if (S.tab === 'album' && !uploading) loadAlbum(); } }, 60e3);
  setInterval(() => { applyTheme(); if (S.tab === 'now' && !S.guide && !document.activeElement?.closest('#view-now')) renderNow(); if (S.tab === 'fam' && !document.hidden) renderLocCheck(); }, 30e3);
})();

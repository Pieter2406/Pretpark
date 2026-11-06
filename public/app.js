// Pretpark: the screens. State lives in S; changes call render(). The shared family state lives on the server
// (family.js actions, versioned by `updated`); wait times come from /api/live; walking routes from route.js.
import { ATTRACTIONS, FOOD, ENTRANCE } from './data.js';
import { plans, foodOptions, canRide, status, byId, walkMin, isMealTime, distM, raining, WX_ICON } from './logic.js';
import { makePark, pathLength, bearingXY } from './route.js';
import { apply, phoneOf } from './family.js';
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
  tickets: [], ticketBusy: '', auth: false, liveStale: false, outbox: [], offline: false,
  album: store.get('c:album', null)?.v || [], uploads: [], upMsg: '', albumOff: false,
  tab: 'now', mapMode: 'map', guide: null, filter: 'us', placing: false, dismissed: store.get('dismissed', {}),
  history: store.get('history', []), voice: store.get('voice', false), autoNight: store.get('autoNight', true),
  newVersion: false,
  chat: store.get('c:chat', null)?.v || [], chatQ: store.get('chatq', []), chatRead: store.get('chatRead', 0), chatOpen: false,
};

// ---------- people
const people = () => S.fam?.people || [];
const meId = () => S.fam?.me?.[device] || null;
const person = (id) => people().find((p) => p.id === id);
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
async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...opts, redirect: 'manual', signal: AbortSignal.timeout?.(opts.timeout || 7000),
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
  saveFam();
  return true;
}

// Change the shared family state. Every action carries an id (the server ignores repeats) and the time it happened.
// Offline: apply it here with the same rules as the server and send it later.
async function act(a, quiet = false) {
  a = { ...a, aid: a.aid || rnd(10), at: a.at || Date.now() };
  try {
    const r = await api('/api/family/' + S.famId, { method: 'POST', body: a });
    takeFam(r); recompute(); if (!quiet) render();
    return true;
  } catch (e) {
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
      try { takeFam(await api('/api/family/' + S.famId, { method: 'POST', body: S.outbox[0] })); }
      catch (e) { if (e.status !== 400) break; } // only a rejected (invalid) action is dropped; anything else retries later
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
    S.live = await api('/api/live'); S.liveStale = false; cached.save('live', S.live);
    rememberWaits(S.live);
  } catch { if (!S.live) S.live = cached.load('live')?.v || null; S.liveStale = !!S.live; }
  recompute(); render();
}
async function pollFamily() {
  if (document.hidden || !S.famId) return;
  if (!S.chatOpen) loadChat();
  await flushOutbox();
  if (S.outbox.length) return; // keep local changes until they're sent
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
let lastPlanPos = null, lastPost = { t: 0, p: null };
function onGps(p) {
  S.gps = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }; S.gpsAt = Date.now();
  S.sim = distM(S.gps, ENTRANCE) > 1500 ? 'far' : null;
  if (S.headingSrc !== 'compass' && p.coords.heading != null && p.coords.speed > 0.6) { S.heading = p.coords.heading; S.headingSrc = 'gps'; }
  const here = pos();
  if (!lastPlanPos || distM(lastPlanPos, here) > 12) { recompute(); render(); }
  else if (S.guide) { S.here = S.park.fromHere(here); updateGuide(); } // the guide follows every fix, the plan only every 12 m
  if (!S.sim && (!lastPost.p || (distM(lastPost.p, here) > 25 && Date.now() - lastPost.t > 60e3) || Date.now() - lastPost.t > 180e3)) {
    lastPost = { t: Date.now(), p: here };
    act({ type: 'pos', device, lat: here.lat, lon: here.lon }, true);
  }
}
function onGpsError(err) {
  // only "not allowed" means no location; a timeout in a queue or between buildings keeps the last fix
  if (err.code === 1) { S.sim = 'off'; recompute(); render(); }
}
function startGps() {
  if (!navigator.geolocation) { S.sim = 'off'; return; }
  navigator.geolocation.watchPosition(onGps, onGpsError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
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
  const minutesLeft = S.live?.close ? Math.round((S.live.close - Date.now()) / 60e3) : null;
  const closed = S.live?.close && Date.now() > S.live.close; // after closing time: nothing to suggest
  S.plans = S.live && !closed ? plans({
    people: people(), favs: S.fam.favs || [], done: S.fam.done || {}, live: S.live, walk: (a) => S.here.metres(a),
    month: new Date().getMonth(), minutesLeft: minutesLeft != null && minutesLeft > 0 ? minutesLeft : null, rain: raining(S.live), walkPref: S.fam.walk,
    clock: S.live.close ? { now: new Date().getHours() * 60 + new Date().getMinutes(), close: new Date().getHours() * 60 + new Date().getMinutes() + Math.round((S.live.close - Date.now()) / 60e3) } : null,
  }) : [];
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
  if (!st.known) return '<span class="wait w-off">geen info</span>';
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
  if (part.waitKnown === false) out.push(['❔', 'Wachttijd niet bekend']);
  return out;
}
const notesHtml = (n) => (n.length ? `<ul class="notes">${n.map(([i, t]) => `<li><span aria-hidden="true">${i}</span><span>${t}</span></li>`).join('')}</ul>` : '');

function planActions(plan, chosen) {
  if (!chosen) return `<button class="primary big" data-go="choose:0">🧭 Doen! Breng me erheen</button>`;
  const t = S.fam.target;
  const mine = plan.parts.indexOf(myPart(plan));
  const queued = t.queued ? `<p class="queued">⏳ In de rij sinds ${hhmm(t.queued)} (${Math.max(0, Math.round((Date.now() - t.queued) / 60e3))} min)</p>` : '';
  const ready = plan.type === 'split'
    ? (t.ready?.[mine] ? '<button disabled>✅ Gemeld: wij zijn klaar</button>' : '<button data-go="ready">✅ Wij zijn klaar</button>') : '';
  return `${queued}<button class="primary big" data-go="guide">🧭 Breng me erheen</button>
    <div class="row3">${t.queued ? '' : '<button data-go="queue">⏳ In de rij</button>'}<button data-go="done">✓ Gedaan</button><button data-go="untarget">✕ Iets anders</button></div>
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
    const done = t?.ready?.[i] ? '<span class="chip ok">✅ klaar</span>' : '';
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
  if (shownTickets().length && (S.sim === 'far' || (L?.open && Date.now() < L.open + 90 * 60e3))) {
    html += `<button class="primary big" data-tview="0" style="margin:8px 0 4px">🎟️ Toon onze tickets (${shownTickets().length})</button>`;
  }
  const t = S.fam.target;
  if (t?.plan) {
    const ago = Math.round((Date.now() - t.setAt) / 60e3);
    html += `<p class="kicker">Jullie plan · ${ago < 1 ? 'net gekozen' : ago + ' min geleden'}</p>` + ticket(t.plan, true);
  } else if (!S.live) {
    html += '<p class="kicker">Doe nu dit</p><div class="ticket"><div class="what"><p class="empty">Wachttijden laden…</p></div></div>';
  } else if (!S.plans.length) {
    html += `<p class="kicker">Doe nu dit</p><div class="ticket"><div class="what"><h2>Niets open op dit moment</h2>
      <p class="muted">Er zijn geen attracties open (of het park is dicht). Tijd voor een snack?</p></div></div>`;
  } else {
    html += '<p class="kicker">Doe nu dit</p>' + ticket(S.plans[0], false);
  }
  if (!meId() && people().some((p) => p.kind === 'adult')) html += '<button class="ghost small whoami" data-go="onboard">🙋 Wie ben jij op deze gsm? Tik om te kiezen</button>';
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
        return `<button class="alt" data-go="choose:${i}"><span class="ic">${icon(a)}</span>
          <span><span class="t">${esc(a.name)}</span><span class="s">Iedereen samen · ${mins(walkOf(a))} stappen</span></span>${waitBadge(a.id)}</button>`;
      }
      const [x, y] = p.parts; const a = byId[x.id];
      return `<button class="alt" data-go="choose:${i}"><span class="ic">${icon(a)}</span>
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
  let rows = ATTRACTIONS.map((a) => ({ a, st: status(S.live, a.id), can: can(a), walk: walkOf(a) }));
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
  const rides = ATTRACTIONS.map((a) => ({ a, st: status(S.live, a.id), xy: S.park.toXY(a), can: ps.some((p) => canRide(p, a)) }))
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
    if (dev === device || Date.now() - p.t > 15 * 60e3) continue;
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
    const scale = (2 * MAP.R) / Math.min(box.clientWidth, box.clientHeight);
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
      <label class="tog"><input type="checkbox" data-setting="autoNight" ${S.autoNight ? 'checked' : ''}> 🌙 Donkere modus na zonsondergang</label>
      <label class="tog"><input type="checkbox" data-setting="voice" ${S.voice ? 'checked' : ''}> 🔊 Gesproken aanwijzingen in de wandelgids</label></div>
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
    <div class="card"><h2>✓ Vandaag gedaan</h2>
      ${Object.keys(S.fam.done || {}).length ? `<div class="list">${Object.entries(S.fam.done).map(([id, n]) => `<div class="ride" style="grid-template-columns:auto 1fr auto"><span aria-hidden="true">${byId[id]?.icon}</span><span><b>${esc(byId[id]?.name)}</b> <span class="muted">${num(n)}×</span></span><button data-undo="${id}">Ongedaan</button></div>`).join('')}</div>` : '<p class="muted small">Nog niets. Tik op “Gedaan” na een attractie.</p>'}</div>
    <p class="muted small">Wachttijden: ThemeParks.wiki (live). Weer: MET Norway. Kaart: © OpenStreetMap-bijdragers. Foto’s blijven bewaard tot je ze verwijdert.</p>`;
  renderPush();
}

// ---------- push notifications
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushPrefs = () => ({ chat: true, ...store.get('pushPrefs', { fav: true, best: true, food: true, down: true }) });
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
      <div style="display:grid">${tog('fav', '⭐ Wachttijd zakt bij een favoriet')}${tog('best', '👉 Nieuwe beste suggestie')}${tog('food', '🍽️ Tijd om te eten / pauze')}${tog('down', '⚠️ Attractie in storing')}${tog('chat', '💬 Berichten in de gezinschat')}</div>
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
  G.svg = null; G.lastSay = ''; G.lastDist = null;
  if (S.here) { S.here = S.park.fromHere(pos()); }
  updateGuide(true);
}
function closeGuide() { S.guide = null; $('#guide').hidden = true; closeDialog($('#guide')); if ($('#tview').hidden) wake(false); window.speechSynthesis?.cancel(); render(); }
let wakeLock = null;
async function wake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not supported */ }
}
function say(text, force) {
  if (!S.voice || !window.speechSynthesis || !text) return;
  if (!force && Date.now() - G.lastSpoke < 5000) return;
  G.lastSpoke = Date.now();
  const u = new SpeechSynthesisUtterance(text); u.lang = 'nl-BE'; u.rate = 1.02;
  speechSynthesis.cancel(); speechSynthesis.speak(u);
}
let arrowAngle = 0, guideState = null;
function guideCalc() {
  const g = S.guide; if (!g || !S.here) return null;
  const path = S.here.path(g);
  const dist = pathLength(path);
  const here = path[0];
  const brg = bearingXY(here, S.park.lookahead(path, 25));
  return { g, path, dist, here, brg, arrived: dist < 25 };
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
          ${g.kind === 'ride' && S.fam.target && !S.fam.target.queued ? '<button class="big" data-go="queue" style="margin-top:10px">⏳ We staan in de rij</button>' : ''}</div>`
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
    if (arrived) { buzz([80, 60, 80]); say(`Je bent er. ${g.name}.`, true); }
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
    const r = Math.abs(rel);
    const text = !hasHeading ? 'De pijl wijst zoals op een kaart (noorden boven).'
      : r < 25 ? '⬆️ Rechtdoor' : r < 70 ? (rel > 0 ? '↗️ Schuin rechts' : '↖️ Schuin links') : r < 135 ? (rel > 0 ? '➡️ Rechts afslaan' : '⬅️ Links afslaan') : '↩️ Draai je om';
    if (text !== G.lastSay) {
      sayEl.textContent = text;
      if (hasHeading && G.lastSay) { buzz(text.includes('Rechtdoor') ? 10 : [30, 40, 30]); say(text.replace(/^\S+\s/, '')); }
      G.lastSay = text;
    }
  }
}

// ---------- dialogs: focus goes in, Tab stays in, focus returns on close
const dialogStack = [];
function openDialog(el) {
  dialogStack.push({ el, back: document.activeElement });
  setTimeout(() => el.querySelector('button, [href], input, select, [tabindex="0"]')?.focus(), 30);
}
function closeDialog(el) {
  const i = dialogStack.findLastIndex((d) => d.el === el);
  if (i < 0) return;
  const [d] = dialogStack.splice(i, 1);
  d.back?.focus?.();
}
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
  s.innerHTML = html; s.hidden = false; $('#sheetBack').hidden = false;
  if (!was) openDialog(s);
}
function closeSheet() { if ($('#sheet').hidden) return; $('#sheet').hidden = true; $('#sheetBack').hidden = true; closeDialog($('#sheet')); }
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
      <span class="muted small">${{ kids: 'Kinderattractie', family: 'Gezinsattractie', thrill: 'Spanning' }[a.cat]} · ${mins(walkOf(a))} stappen</span></div>${waitBadge(id)}</div>
    <ul class="notes" style="margin-top:12px">${people().map((p) => `<li><span aria-hidden="true">${emoji(p)}</span><span><b>${esc(p.name)}</b> (${num(p.height)} cm): ${rule(p)}</span></li>`).join('')}</ul>
    ${a.wet ? '<p class="small">💧 Je kan nat worden.</p>' : ''}
    <p class="muted small">Min. ${a.alone ?? '–'} cm alleen${a.withAdult ? `, ${a.withAdult} cm met volwassene` : ''}${a.max ? `, max. ${a.max} cm` : ''}. Check het bordje aan de ingang.</p>
    <button class="primary big" data-goride="${a.id}" ${st.known && !st.open ? 'disabled' : ''}>🧭 Breng me erheen</button>
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

// ---------- tickets (IndexedDB on the phone + shared via the server)
const shownTickets = () => S.tickets.filter((t) => !pendingDelete.has('t:' + t.id));
async function syncTickets() {
  const local = await idb.all('tickets');
  if (local) S.tickets = local; // null = IndexedDB hiccup: keep what is on screen
  if (local && S.famId) {
    // send pending ones one by one: one rejected ticket must not block the rest
    for (const t of local.filter((x) => x.pending)) {
      try { await api(`/api/tickets/${S.famId}`, { method: 'POST', body: { ...t, pending: undefined, error: undefined }, timeout: 20000 }); t.pending = false; t.error = null; }
      catch (e) { if (e.offline || e.status === 401) break; t.error = e.error || 'niet gedeeld'; }
      await idb.put('tickets', t);
    }
    try {
      const remote = await api(`/api/tickets/${S.famId}`, { timeout: 20000 });
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
    const known = new Set(S.tickets.map((t) => t.code).filter(Boolean));
    let added = 0, nr = S.tickets.length;
    for (const f of found) {
      if (f.code && known.has(f.code)) continue;
      const t = { ...f, id: rnd(16), name: `Ticket ${++nr}`, person: null, created: Date.now() + nr, pending: true };
      await idb.put('tickets', t); added++;
    }
    const noCode = found.filter((f) => !f.code).length;
    toast(added ? `🎟️ ${added} ticket${added > 1 ? 's' : ''} toegevoegd${noCode ? ` (${noCode} zonder herkende code)` : ''}` : 'Geen nieuwe tickets gevonden');
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
    ${S.ticketBusy ? `<div class="card"><p id="tbusy" class="say">⏳ ${esc(S.ticketBusy)}</p></div>` : ''}
    ${list.length ? `<button class="primary big" data-tview="0" style="margin-bottom:12px">🎟️ Toon aan de ingang</button>
      <div class="tlist">${list.map((t, i) => `
      <div class="tcard">
        <button class="tthumb" data-tview="${i}" aria-label="Toon ${esc(t.name)}">${imgSrc(t.crop) ? `<img src="${imgSrc(t.crop)}" alt="">` : imgSrc(t.page) ? `<img src="${imgSrc(t.page)}" alt="" class="page">` : '🎟️'}</button>
        <div class="tinfo">
          <input type="text" data-tname="${esc(t.id)}" value="${esc(t.name)}" maxlength="40" aria-label="Naam van het ticket">
          <select data-tperson="${esc(t.id)}" aria-label="Voor wie">
            <option value="">Voor wie?</option>${ps.map((p) => `<option value="${p.id}" ${t.person === p.id ? 'selected' : ''}>${emoji(p)} ${esc(p.name)}</option>`).join('')}
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
    <div class="tv-who">${p ? `${emoji(p)} ${esc(p.name)}` : esc(t.name)}</div>
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
  } catch (e) { if (e.status === 503) S.albumOff = true; }
  await refreshUploads();
}
async function refreshUploads() {
  const q = await idb.all('uploads');
  if (!q) return;
  const ids = new Set(q.map((u) => u.id));
  for (const [id, url] of thumbUrls) if (!ids.has(id)) { URL.revokeObjectURL(url); thumbUrls.delete(id); }
  S.uploads = q.map((u) => {
    if (!thumbUrls.has(u.id)) thumbUrls.set(u.id, URL.createObjectURL(u.thumb || u.file));
    return { id: u.id, t: u.meta.t, near: u.meta.near, pending: true, src: thumbUrls.get(u.id) };
  });
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
async function addPhotos(files, fromCamera) {
  const live = S.gps && !S.sim ? S.gps : null;
  let n = 0;
  for (const file of files) {
    if (!file.type.startsWith('image/') && !/\.(heic|heif)$/i.test(file.name)) continue;
    const t = fromCamera ? Date.now() : (file.lastModified || Date.now());
    const here = live && Math.abs(Date.now() - t) < 10 * 60e3 ? live : null; // only tag a place when it was taken just now
    const { thumb, w, h } = await thumbOf(file);
    const meta = { t, lat: here?.lat ?? null, lon: here?.lon ?? null, near: here ? nearest(here) : '', w, h };
    if ((await idb.put('uploads', { id: rnd(16), file, thumb, meta })) === false) { toast('Foto bewaren lukte niet (geheugen vol?)'); continue; }
    n++;
  }
  if (n) { buzz(); toast(n === 1 ? '📸 Foto bewaard' : `📸 ${n} foto’s bewaard`); }
  await refreshUploads();
  processUploads();
}
let uploading = false;
async function processUploads() {
  if (uploading || !S.famId) return;
  uploading = true;
  try {
    const q = ((await idb.all('uploads')) || []).sort((a, b) => a.meta.t - b.meta.t);
    let i = 0;
    for (const u of q) {
      S.upMsg = `Uploaden ${++i} van ${q.length}…`; if (S.tab === 'album') renderAlbum();
      const fd = new FormData();
      fd.append('full', u.file, u.file.name || `${u.id}.jpg`);
      if (u.thumb) fd.append('thumb', u.thumb, 'thumb.jpg');
      fd.append('meta', JSON.stringify(u.meta));
      let res;
      try { res = await fetch(`/api/photos/${S.famId}/${u.id}`, { method: 'POST', body: fd, redirect: 'manual', signal: AbortSignal.timeout?.(120000) }); }
      catch { S.offline = true; break; } // no signal: try again later
      if (res.type === 'opaqueredirect' || res.status === 401) { S.auth = true; renderBanners(); break; }
      if (res.status === 503) { S.albumOff = true; break; }
      if (res.ok) {
        const p = await res.json();
        S.album = [...S.album.filter((x) => x.id !== p.id), p].sort((a, b) => a.t - b.t);
        cached.save('album', S.album);
        await idb.del('uploads', u.id);
      } else {
        const err = (await res.json().catch(() => ({}))).error;
        // only a photo the server says is unusable is removed; anything else stays queued (it may be the only copy)
        if (err === 'bad photo' || err === 'photo too big') { await idb.del('uploads', u.id); toast('Eén bestand was geen bruikbare foto'); }
        else break;
      }
    }
  } finally {
    uploading = false; S.upMsg = '';
    await refreshUploads();
  }
}
function albumItems() {
  return [...S.album.map((p) => ({ ...p, src: photoUrl(p.id, 'thumb') })), ...S.uploads].filter((x) => !pendingDelete.has(x.id)).sort((a, b) => a.t - b.t);
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
    <p class="small muted">${items.length} foto’s${S.uploads.length ? ` · ⏳ ${S.uploads.length} wachten op upload` : ''}${S.upMsg ? ` · ${esc(S.upMsg)}` : ''}. Originele kwaliteit, gedeeld met het gezin.</p>
    <div class="row2 tight"><button class="primary" data-go="story">📖 Ons dagverslag</button><button data-go="stickers">🏅 Stickers ${stickerCount()}/${ATTRACTIONS.length}</button></div>
    ${groups.map((g) => `<h3 class="ghead">${esc(g.k)}</h3><div class="grid">${g.items.map((it) => `
      <button class="ph" data-photo="${esc(it.id)}" aria-label="Foto ${hhmm(it.t)}${it.near ? ' bij ' + esc(it.near) : ''}">
        <img src="${esc(it.src)}" alt="" loading="lazy">${it.pending ? '<span class="badge">⏳</span>' : it.star ? '<span class="badge">⭐</span>' : ''}</button>`).join('')}</div>`).join('')
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
    <div class="pv-img"><img src="${esc(it.pending ? it.src : photoUrl(it.id))}" alt="" style="background-image:url('${it.pending ? '' : esc(photoUrl(it.id, 'thumb'))}')"></div>
    <div class="pv-info"><b>${when}</b>${it.near ? ` · 📍 ${esc(it.near)}` : ''}${it.by ? ` · 📷 ${esc(byName(it.by))}` : ''}${it.pending ? ' · ⏳ nog niet geüpload' : ''}</div>
    ${it.pending ? '' : `<div class="pv-actions">
      <button data-go="pvstar" aria-pressed="${!!it.star}">${it.star ? '⭐ Favoriet' : '☆ Favoriet'}</button>
      <a class="btn" href="${esc(photoUrl(it.id))}?dl=1" download>⬇️ Bewaar</a>
      ${navigator.canShare ? '<button data-go="pvshare">📤 Deel</button>' : ''}
      <button data-go="pvdel" aria-label="Verwijder">🗑️</button></div>`}
    <div class="pv-nav"><button data-go="pvprev" ${pv.i === 0 ? 'disabled' : ''} aria-label="Vorige">‹</button><button data-go="pvnext" ${pv.i === items.length - 1 ? 'disabled' : ''} aria-label="Volgende">›</button></div>`;
  // fetch the original now, so "Deel" can open the share sheet straight from the tap (iOS requires that)
  if (navigator.canShare && !it.pending && pv.blobId !== it.id) {
    pv.blob = null; pv.blobId = it.id;
    fetch(photoUrl(it.id)).then((r) => r.blob()).then((b) => { if (pv.blobId === it.id) pv.blob = b; }).catch(() => {});
  }
}
function closePhoto() { $('#pview').hidden = true; closeDialog($('#pview')); pv.blob = null; }

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
    <ol class="st-line">${all.map((x) => x.photo
      ? `<li class="${x.photo.star ? 'big' : ''}"><time>${hhmm(x.t)}</time><button class="ph" data-photo="${esc(x.photo.id)}"><img src="${esc(photoUrl(x.photo.id, x.photo.star ? 'full' : 'thumb'))}" alt="" loading="lazy"></button>${x.photo.near ? `<span class="small muted">📍 ${esc(x.photo.near)}</span>` : ''}</li>`
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
    const fresh = await api(`/api/chat/${S.famId}${last ? `?after=${last}` : ''}`);
    if (fresh.length) {
      const ids = new Set(S.chat.map((m) => m.id));
      const before = unread();
      S.chat = [...S.chat, ...fresh.filter((m) => !ids.has(m.id))].sort((a, b) => a.t - b.t).slice(-300);
      cached.save('chat', S.chat);
      if (S.chatOpen) markRead(); else if (unread() > before) buzz([30, 30, 30]);
      renderChatBadge(); if (S.chatOpen) renderChat();
    }
  } catch { /* next time */ }
}
async function flushChat() {
  while (S.chatQ.length && S.famId) {
    try {
      const m = await api(`/api/chat/${S.famId}`, { method: 'POST', body: S.chatQ[0] });
      S.chat = [...S.chat.filter((x) => x.id !== m.id), m].sort((a, b) => a.t - b.t);
      cached.save('chat', S.chat);
    } catch (e) { if (e.status !== 400) break; } // keep it for later, unless the server says it's invalid
    S.chatQ.shift(); store.set('chatq', S.chatQ);
  }
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
      <div class="seg">${ps.filter((p) => p.kind === 'adult').map((p, i) => `<label class="segopt"><input type="radio" name="me" value="${p.id}" ${meId() === p.id || (!meId() && i === 0) ? 'checked' : ''}> <span>${emoji(p)} ${esc(p.name)}</span></label>`).join('')}</div>
      <button class="primary big" type="submit">Klaar</button>
      <button type="button" class="ghost small" data-go="obskip">Later</button></form>`;
  }
  openDialog(el);
}
function closeOnboard() { $('#onboard').hidden = true; closeDialog($('#onboard')); store.set('onboarded', true); }

// ---------- banners (only what needs attention; the weather & opening hours sit in the status line)
const isDark = () => { const d = new Date(); const h = d.getHours() + d.getMinutes() / 60; const m = d.getMonth(); return (m >= 9 || m <= 1) ? h >= 17.2 || h < 7.5 : h >= 21; };
function renderBanners() {
  const b = [];
  if (S.newVersion) b.push(['update', '✨', 'Er is een nieuwe versie. <button class="x" data-go="reload">Herladen</button>']);
  if (S.auth) b.push(['auth', '🔒', '<b>Opnieuw inloggen nodig.</b> <button class="x" data-go="relogin">Log in</button>']);
  if (S.offline) b.push(['offline', '📶', `<b>Geen bereik.</b> Ik werk verder met de laatste gegevens${S.live?.t ? ` (wachttijden van ${hhmm(S.live.t)})` : ''}.${S.outbox.length ? ` ${S.outbox.length} wijziging(en) wachten.` : ''}`]);
  if (!S.manual && S.sim === 'far') b.push(['far', '📍', '<b>Je bent niet in Walibi.</b> Ik reken vanaf de ingang.']);
  if (!S.manual && S.sim === 'off') b.push(['off', '📍', '<b>Locatie staat uit.</b> Ik reken vanaf de ingang. Zet locatie aan voor de wandelgids.']);
  if (S.manual) b.push(['manual', '📍', 'Je hebt je positie zelf gekozen op de kaart.']);
  const L = S.live;
  if (L?.open && Date.now() < L.open) b.push(['before', '🕙', `Walibi opent om <b>${hhmm(L.open)}</b>.`]);
  else if (L && L.close && Date.now() > L.close) b.push(['closed', '🌙', 'Walibi is nu gesloten. Wachttijden zijn van de laatste meting.']);
  else if (L && !L.close && !Object.values(L.rides || {}).some((r) => r.s === 'OPERATING')) b.push(['closed', '🌙', 'Er is nu niets open.']);
  if (L?.close && Date.now() < L.close && L.close - Date.now() <= 45 * 60e3) {
    b.push(['closing', '⏰', `<b>Nog ${Math.round((L.close - Date.now()) / 60e3)} min open.</b> Tijd voor de laatste ronde${S.fam?.car ? ', daarna brengt 🚗 Auto je terug' : ''}.`]);
  }
  if (isDark() && new Date().getMonth() >= 9 && hasToddler() && !S.dismissed['night' + new Date().toDateString()]) {
    b.push(['night' + new Date().toDateString(), '🎃', '<b>Donker: scare zones.</b> Met de peuter op de brede paden blijven. Te eng? Hand op en “stop” zeggen.', 'night']);
  }
  $('#banners').innerHTML = b.map(([k, i, t, cls]) => `<div class="banner ${cls || ''}"><span aria-hidden="true">${i}</span><span>${t}</span>${k.startsWith('night') ? `<button class="x" data-dismiss="${k}" aria-label="Verbergen">✕</button>` : ''}</div>`).join('');
  const pill = $('#livePill');
  if (L) {
    pill.textContent = `${S.liveStale ? 'Laatst' : 'Live'} ${hhmm(L.t)}`;
    pill.classList.toggle('stale', Date.now() - L.t > 5 * 60e3 || S.liveStale);
  } else pill.textContent = '—';
}
function applyTheme() {
  const night = S.autoNight && isDark();
  if (night) document.documentElement.dataset.theme = 'dark'; else delete document.documentElement.dataset.theme;
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
  if (S.tab === 'fam' && !document.activeElement?.closest('#view-fam form, #view-fam input')) renderFam();
  if (S.guide) updateGuide();
}

let toastTimer;
function toast(t, action, ms = 2600) {
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
  if (d.tab) { S.tab = d.tab; buzz(); closeSheet(); render(); scrollTo(0, 0); return; }
  if (d.mapmode) { S.mapMode = d.mapmode; renderMapView(); return; }
  if (d.tview) { openViewer(+d.tview); return; }
  if (d.quick) { sendChat({ kind: 'text', text: d.quick }); return; }
  if (d.chatgo) { const m = S.chat.find((x) => x.id === d.chatgo); if (m) { closeChat(); guideTap({ kind: 'meet', id: 'chat-' + m.id, name: `Naar ${msgName(m)}`, icon: '📍', lat: m.lat, lon: m.lon }); } return; }
  if (d.photo) { openPhoto(d.photo); return; }
  if (d.tdel) {
    const id = d.tdel;
    deleteLater('t:' + id, 'Ticket', async () => { await idb.del('tickets', id); api(`/api/tickets/${S.famId}/${id}`, { method: 'DELETE' }).catch(() => {}); S.tickets = S.tickets.filter((x) => x.id !== id); renderTickets(); });
    renderTickets();
    return;
  }
  if (d.walk) { await act({ type: 'walk', pref: d.walk }); toast(d.walk === 'low' ? 'Ik hou de wandelingen kort 👟' : 'Normaal stappen'); return; }
  if (d.me) { await act({ type: 'me', device, person: d.me }); toast('Top! 👋'); return; }
  if (d.filter) { S.filter = d.filter; renderList(); return; }
  if (d.fav) { buzz(); await act({ type: 'fav', id: d.fav, on: !(S.fam.favs || []).includes(d.fav) }); if (!$('#sheet').hidden && $('#sheet').querySelector(`[data-goride="${d.fav}"]`)) rideSheet(d.fav); return; }
  if (d.undo) { await act({ type: 'undo', id: d.undo }); return; }
  if (d.doneone) { closeSheet(); if (S.guide) closeGuide(); await act({ type: 'done', ids: [d.doneone] }); celebrate(); photoMoment([d.doneone]); return; }
  if (d.dismiss) { S.dismissed[d.dismiss] = 1; store.set('dismissed', S.dismissed); renderBanners(); return; }
  if (d.goride) { const a = byId[d.goride]; closeSheet(); guideTap({ kind: 'ride-solo', id: a.id, name: a.name, icon: a.icon, lat: a.lat, lon: a.lon }); return; }
  if (d.food) { const f = byId[d.food]; closeSheet(); guideTap({ kind: 'food', id: f.id, name: f.name, icon: '🍽️', lat: f.lat, lon: f.lon }); return; }
  if (d.wc) { const p = S.park.toilets[+d.wc.slice(2)]; if (p) guideTap({ kind: 'wc', id: 'wc', name: 'Toilet', icon: '🚻', ...p }); return; }
  if (d.ride && !t.matches('button.star')) { closeSheet(); rideSheet(d.ride); return; }
  const go = d.go; if (!go) return;
  if (go.startsWith('choose:')) {
    const plan = S.plans[+go.slice(7)]; if (!plan) return;
    guideTap(guideTargetFor(plan));
    act({ type: 'target', plan, device });
    return;
  }
  switch (go) {
    case 'guide': if (S.fam.target?.plan) guideTap(guideTargetFor(S.fam.target.plan)); break;
    case 'guideclose': closeGuide(); break;
    case 'done': {
      const ids = S.fam.target ? S.fam.target.plan.parts.filter((p) => !p.rest).map((p) => p.id) : S.guide ? [S.guide.id] : [];
      if (S.guide) closeGuide();
      await act({ type: 'done', ids }); celebrate(); scrollTo(0, 0); photoMoment(ids); break;
    }
    case 'queue': await act({ type: 'queue' }); if (S.guide) closeGuide(); toast('⏳ Veel geduld! Tik op “Gedaan” als jullie eraf komen.'); break;
    case 'ready': {
      const plan = S.fam.target?.plan; if (!plan) break;
      await act({ type: 'ready', part: plan.parts.indexOf(myPart(plan)), device });
      toast('✅ De anderen krijgen een seintje'); break;
    }
    case 'untarget': await act({ type: 'untarget' }); break;
    case 'food': foodSheet(); break;
    case 'toilet': toiletGo(); break;
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
    case 'storyclose': $('#story').hidden = true; closeDialog($('#story')); break;
    case 'pvclose': closePhoto(); break;
    case 'pvprev': pv.i = Math.max(0, pv.i - 1); drawPhoto(); break;
    case 'pvnext': pv.i = Math.min(albumItems().length - 1, pv.i + 1); drawPhoto(); break;
    case 'pvstar': {
      const it = albumItems()[pv.i]; if (!it) break; it.star = !it.star;
      const p = S.album.find((x) => x.id === it.id); if (p) p.star = it.star;
      drawPhoto(); renderAlbum();
      api(`/api/photos/${S.famId}/${it.id}`, { method: 'PATCH', body: { star: it.star, caption: it.caption || '' } }).catch(() => toast('Opslaan lukte niet'));
      break;
    }
    case 'pvshare': {
      const it = albumItems()[pv.i];
      if (!pv.blob || pv.blobId !== it?.id) { toast('Foto wordt nog geladen, probeer zo opnieuw'); break; }
      const type = pv.blob.type || 'image/jpeg';
      const file = new File([pv.blob], `walibi-${it.id}.${type.split('/')[1] === 'jpeg' ? 'jpg' : type.split('/')[1]}`, { type });
      navigator.share({ files: [file] }).catch((err) => { if (err.name !== 'AbortError') toast('Delen lukte niet'); });
      break;
    }
    case 'pvdel': {
      const it = albumItems()[pv.i]; if (!it) break;
      deleteLater(it.id, 'Foto', async () => {
        try { await api(`/api/photos/${S.famId}/${it.id}`, { method: 'DELETE' }); S.album = S.album.filter((x) => x.id !== it.id); cached.save('album', S.album); }
        catch { toast('Verwijderen lukte niet'); }
        renderAlbum();
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
function celebrate() {
  buzz([20, 40, 20]);
  const n = Object.values(S.fam?.done || {}).reduce((a, b) => a + num(b), 0);
  toast(n && n % 5 === 0 ? `🎉 Al ${n} ritjes! Hier is het volgende.` : '✓ Gedaan! Hier is het volgende.');
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#chat').hidden) closeChat(); else if (!$('#pview').hidden) closePhoto(); else if (!$('#story').hidden) { $('#story').hidden = true; closeDialog($('#story')); }
    else if (!$('#tview').hidden) closeViewer(); else if (!$('#sheet').hidden) closeSheet(); else if (S.guide) closeGuide();
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('g.pin')) {
    e.preventDefault(); e.target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
});
$('#sheetBack').addEventListener('click', closeSheet);
document.addEventListener('change', async (e) => {
  const id = e.target.id;
  if (id === 'tfile') { importTickets([...e.target.files]); return; }
  if (id === 'camIn' || id === 'hdrCam') { const f = [...e.target.files]; e.target.value = ''; if (!$('#sheet').hidden && $('#sheet').contains(e.target)) closeSheet(); addPhotos(f, true); return; }
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
    if (await act({ type: 'people', people: ps })) toast('Opgeslagen ✓');
  }
});
let swipeX = null, swipeIn = null;
document.addEventListener('touchstart', (e) => { swipeIn = e.target.closest('#tview') ? 't' : e.target.closest('#pview') ? 'p' : null; swipeX = swipeIn ? e.touches[0].clientX : null; }, { passive: true });
document.addEventListener('touchend', (e) => {
  if (swipeX == null) return;
  const dx = e.changedTouches[0].clientX - swipeX; swipeX = null;
  if (Math.abs(dx) < 60) return;
  if (swipeIn === 't') { tv.i = Math.max(0, Math.min(shownTickets().length - 1, tv.i + (dx < 0 ? 1 : -1))); tv.page = false; drawViewer(); }
  if (swipeIn === 'p') { pv.i = Math.max(0, Math.min(albumItems().length - 1, pv.i + (dx < 0 ? 1 : -1))); drawPhoto(); }
});
addEventListener('online', () => { flushOutbox(); syncTickets(); loadLive(); processUploads(); flushChat(); loadChat(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  loadLive(); pollFamily();
  if (S.guide || !$('#tview').hidden) wake(true); // the system drops the wake lock when the app goes to the background
});

// ---------- start
async function afterFamily() {
  recompute(); render();
  await loadLive();
  flushOutbox(); syncTickets(); loadAlbum().then(processUploads); syncPushFamily();
  renderChatBadge(); flushChat(); loadChat();
  // warm the offline cache with the ride photos (small, once per version)
  setTimeout(() => { for (const p of Object.values(PHOTOS)) fetch(`/img/rides/${p.fn}`).catch(() => {}); }, 4000);
}
(async function start() {
  S.outbox = store.get('outbox', []);
  S.tickets = (await idb.all('tickets')) || [];
  applyTheme();
  render();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) { S.newVersion = true; renderBanners(); } });
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
  } catch (err) {
    console.error(err);
    $('#view-now').innerHTML = `<div class="card"><h2>${S.auth ? 'Even opnieuw inloggen' : 'Oei, dat lukte niet'}</h2><p class="muted">${S.auth ? 'Je sessie is verlopen.' : 'Geen verbinding en nog geen opgeslagen gegevens op deze gsm.'}</p><button class="primary" data-go="relogin">Opnieuw</button></div>`
      + (S.tickets.length ? '<button class="primary big" data-tab="tickets">🎟️ Toon onze tickets</button>' : '');
  }
  setInterval(loadLive, 60e3);
  setInterval(pollFamily, 15e3);
  setInterval(() => { if (!document.hidden) { processUploads(); if (S.tab === 'album' && !uploading) loadAlbum(); } }, 60e3);
  setInterval(() => { applyTheme(); if (S.tab === 'now' && !S.guide && !document.activeElement?.closest('#view-now')) renderNow(); }, 30e3);
})();

// Location → "what are we doing?" for a family walking around a theme park with phones in their pockets.
// Pure (no DOM), so the browser and the tests share it. Two steps:
//
// 1. addFix(): clean the raw fixes. Phones report fixes that are stale (cached), out of order, far too inaccurate
//    (Wi-Fi/cell fallback, iOS "approximate location"), or that teleport hundreds of metres for a few seconds
//    (multipath between buildings, Wi-Fi positioning). We gate on accuracy and age, reject jumps faster than a walking
//    family can move, re-anchor when several rejected fixes agree with each other (the truth moved, e.g. after a gap),
//    and smooth the rest with a small Kalman filter whose measurement noise is the reported accuracy.
// 2. detect(): turn the cleaned track + time into events, with hysteresis and minimum dwell times so a single odd fix
//    never changes anything: arrived and stayed at the target ride (→ queue), moving fast there (→ on the ride),
//    left the ride area after enough time (→ done) or too soon (→ left the queue), sat at a restaurant (→ ate),
//    sat elsewhere (→ rest), stopped driving near the park (→ car spot), and what must have happened while the app
//    was closed (a gap between fixes).
//
// The tracker is a plain object, so app.js can keep it in localStorage across reloads.

const R_EARTH = 6371000;
const toXY = (o, p) => ({ x: (p.lon - o.lon) * Math.cos((o.lat * Math.PI) / 180) * (Math.PI / 180) * R_EARTH, y: (p.lat - o.lat) * (Math.PI / 180) * R_EARTH });
const toLL = (o, q) => ({ lat: o.lat + (q.y / R_EARTH) * (180 / Math.PI), lon: o.lon + (q.x / (R_EARTH * Math.cos((o.lat * Math.PI) / 180))) * (180 / Math.PI) });
export const dist = (a, b) => { const q = toXY(a, b); return Math.hypot(q.x, q.y); };

export const LIMITS = {
  maxAcc: 65, // m: worse fixes say nothing useful about which ride you're at (approximate location is ≥ 1 km)
  approxAcc: 1000, // m: iOS "Precise Location" off
  maxAge: 60e3, // ms: older fixes are cached ones
  walk: 3, // m/s: a family with a pushchair; faster jumps are anomalies…
  drive: 45, // m/s: …unless the phone itself reports a speed (Doppler), e.g. arriving by car
  reanchor: 3, // rejected fixes that agree with each other replace the anchor
  gap: 10 * 60e3, // ms: after this long without fixes, don't apply the speed test (the app was closed)
  q: 1.5, // m/s: Kalman process noise (how fast the true position may wander)
  histMin: 45, // minutes of cleaned history kept
};

// A tracker saved more than 6 h ago (yesterday) starts fresh: old drives, "been near" and history mean nothing now
// (the metres walked today survive that: walkAdd starts a new count on a new day itself)
export const freshTracker = (t, now) => (t && Array.isArray(t.hist) && t.far && now - (t.lastGood || 0) < 6 * 3600e3 ? t : { ...newTracker(), ...(t?.walk ? { walk: t.walk } : {}) });
export function newTracker() {
  return { kf: null, raw: null, rej: [], hist: [], fast: 0, drive: null, far: { n: 0, since: 0, on: false }, approx: 0, emitted: {}, lastGood: 0 };
}

// fix = { lat, lon, acc, t, speed? (m/s, null when unknown) }; now = Date.now()
// → { ok, reason, pos?: {lat, lon, acc}, gap?: ms since the previous good fix }
export function addFix(tr, fix, now) {
  const L = LIMITS;
  if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return { ok: false, reason: 'bad' };
  const acc = Number.isFinite(fix.acc) ? fix.acc : 999;
  const t = Number.isFinite(fix.t) ? fix.t : now;
  if (acc >= L.approxAcc) { tr.approx = now; return { ok: false, reason: 'approx' }; }
  if (now - t > L.maxAge) return { ok: false, reason: 'stale' };
  if (tr.raw && t <= tr.raw.t) return { ok: false, reason: 'old' };
  // driving evidence for the car spot: the phone's own speed, reliable when present
  if (fix.speed != null && fix.speed >= 5 && acc <= 40) tr.drive = { lat: fix.lat, lon: fix.lon, t, n: (tr.drive && t - tr.drive.t < 90e3 ? tr.drive.n : 0) + 1 };
  if (fix.speed != null && fix.speed >= 6 && acc <= 50) tr.fast = t; // on a coaster / in a car
  if (acc > L.maxAcc) {
    tr.raw = { ...fix, acc, t };
    // indoors (restaurant, dark ride, covered queue) fixes get poor but stay consistent with where we were: keep a
    // "still here" point at the filtered position (not at the poor fix), at most once a minute
    const k = tr.kf, h = tr.hist;
    if (k && acc <= 200 && dist(k, fix) <= acc + 30 && h.length && t - h.at(-1).t >= 60e3) h.push({ lat: h.at(-1).lat, lon: h.at(-1).lon, t, a: Math.round(Math.sqrt(k.v)), p: 1 });
    return { ok: false, reason: 'acc' };
  }
  const prev = tr.kf;
  const gap = prev ? t - prev.t : Infinity;
  if (prev && gap < L.gap) {
    const d = dist(prev, fix);
    // what we could have walked, plus the noise of both positions
    const allowed = (fix.speed != null && fix.speed > L.walk ? L.drive : L.walk) * (gap / 1000) + Math.max(20, 2 * acc, Math.sqrt(prev.v) + acc);
    if (d > allowed) {
      tr.raw = { ...fix, acc, t };
      tr.rej.push({ lat: fix.lat, lon: fix.lon, acc, t });
      tr.rej = tr.rej.filter((r) => t - r.t < 3 * 60e3).slice(-8);
      // the latest rejected fixes that agree with each other (walkable among themselves), at least 3 spanning ≥ 20 s:
      // the anchor was wrong (or we really moved while fixes were missing)
      const r = tr.rej;
      let i = r.length - 1;
      while (i > 0 && dist(r[i - 1], r[i]) <= L.walk * ((r[i].t - r[i - 1].t) / 1000) + Math.max(20, r[i].acc + r[i - 1].acc)) i--;
      const run = r.slice(i);
      const agree = run.length >= L.reanchor && run.at(-1).t - run[0].t >= 20e3;
      if (!agree) return { ok: false, reason: 'jump' };
      tr.kf = null; tr.rej = []; // re-anchor below
    }
  }
  tr.raw = { ...fix, acc, t };
  tr.rej = [];
  // Kalman filter on a local plane: variance grows with time (q² per s), shrinks with each measurement (acc²)
  if (!tr.kf || gap >= L.gap) tr.kf = { lat: fix.lat, lon: fix.lon, v: acc * acc, t };
  else {
    const k = tr.kf;
    const v = k.v + (gap / 1000) * L.q * L.q;
    const K = v / (v + acc * acc);
    const m = toXY(k, fix);
    const p = toLL(k, { x: m.x * K, y: m.y * K });
    tr.kf = { lat: p.lat, lon: p.lon, v: (1 - K) * v, t };
  }
  const pos = { lat: tr.kf.lat, lon: tr.kf.lon, acc: Math.sqrt(tr.kf.v), t };
  // history thinned to one point per 10 s, last 45 min
  const h = tr.hist;
  const pt = { lat: +pos.lat.toFixed(6), lon: +pos.lon.toFixed(6), t, a: Math.round(pos.acc) };
  const lastPt = h.at(-1);
  if (!lastPt || t - (lastPt.t0 ?? lastPt.t) >= 10e3) h.push({ ...pt, t0: t });
  else h[h.length - 1] = { ...pt, t0: lastPt.t0 ?? lastPt.t }; // same 10 s bucket: keep the newest position
  // keep 45 min, but always the last 30 points: after the app was closed for an hour we still need to know where we were
  while (h.length > 30 && t - h[0].t > L.histMin * 60e3) h.shift();
  const out = { ok: true, pos, gap: tr.lastGood ? t - tr.lastGood : null };
  tr.lastGood = t;
  walkAdd(tr, pos);
  return out;
}

// ---------- metres walked today (for the Wrapped), from the cleaned track
// Counted only when we really moved: ≥ 15 m (or the position's own uncertainty) from the last counted point, so GPS
// wobble in a 40-min queue adds nothing; and only at walking speed (≤ 2.5 m/s: not on a coaster, the train or in the
// car). After a gap (app closed, no OwnTracks) the straight line × 1.3, as paths aren't straight. A new day (Brussels)
// starts at 0. tr.walk = { day: 'YYYY-MM-DD', m, at: last counted point, last: last position }
export const WALK = { minMove: 15, maxSpeed: 2.5, gap: 120e3, detour: 1.3 };
let dayFmt = null;
export function dayKey(t) {
  dayFmt ||= new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Brussels', year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = Object.fromEntries(dayFmt.formatToParts(t).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export function walkAdd(tr, pos) {
  const day = dayKey(pos.t);
  if (!tr.walk || tr.walk.day !== day) tr.walk = { day, m: 0, at: null };
  const w = tr.walk, here = { lat: +pos.lat.toFixed(6), lon: +pos.lon.toFixed(6), t: pos.t };
  if (!w.at) { w.at = w.last = here; return; }
  const prev = w.last || w.at;
  if (pos.t <= prev.t) return;
  w.last = here;
  // speed and gap from the previous position (the counted point can be 40 min old after a queue)
  const step = pos.t - prev.t;
  if (dist(prev, pos) / (step / 1000) > WALK.maxSpeed) { w.at = here; return; } // on a ride / in the car
  const d = dist(w.at, pos);
  if (d < Math.max(WALK.minMove, pos.acc || 0)) return;
  w.m = Math.round(w.m + (step > WALK.gap ? d * WALK.detour : d));
  w.at = here;
}

// "Not in the park": once we've been near, only after 3 good fixes over ≥ 60 s far away; back after 2 near (hysteresis)
export function farState(tr, pos, center, km = 1.5) {
  const f = tr.far;
  const away = dist(center, pos) > km * 1000;
  // before we were ever near the park (at home, on the way) the first far fix is enough
  if (away) { if (!f.n) f.since = pos.t; f.n++; if (!f.on && (!f.near || (f.n >= 3 && pos.t - f.since >= 60e3))) f.on = true; f.back = 0; }
  else { f.near = true; f.n = 0; f.back = (f.back || 0) + 1; if (f.on && f.back >= 2) f.on = false; }
  return f.on;
}

// How long (ms) the track has been within r of c, counting back from the last point; short excursions (≤ 45 s)
// and gaps are tolerated. Returns { ms, since, n } (n = points inside).
export function dwell(hist, c, r, now) {
  let since = null, n = 0, outSince = null;
  for (let i = hist.length - 1; i >= 0; i--) {
    const p = hist[i];
    const inside = dist(c, p) <= r + Math.min(p.a || 0, 25);
    if (inside) { since = p.t; n++; outSince = null; continue; }
    if (outSince == null) outSince = p.t;
    if (since == null || (since - p.t) > 45e3 || (outSince - p.t) > 45e3) break;
  }
  return since == null ? { ms: 0, since: null, n: 0 } : { ms: now - since, since, n };
}
// Visits to an area since `from`: runs of points inside (excursions ≤ 45 s tolerated) that last ≥ minMs with ≥ 3
// points. A lone point inside (a teleport that got through, a wrong first fix) is not a visit.
export function visits(hist, c, r, from, minMs = 90e3) {
  const out = [];
  let cur = null;
  for (const p of hist) {
    if (p.t < from) continue;
    const inside = dist(c, p) <= r + Math.min(p.a || 0, 25);
    if (inside) {
      if (cur && p.t - cur.e <= 45e3 + 15e3) { cur.e = p.t; cur.n++; } else { if (cur) out.push(cur); cur = { s: p.t, e: p.t, n: 1 }; }
    }
  }
  if (cur) out.push(cur);
  return out.filter((v) => v.e - v.s >= minMs && v.n >= 3);
}
// Max distance of the last `ms` of track from its centroid: small = standing/sitting still
export function spread(hist, ms, now) {
  const pts = hist.filter((p) => now - p.t <= ms);
  if (pts.length < 3) return { r: Infinity, n: pts.length, c: null };
  const c = { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lon: pts.reduce((s, p) => s + p.lon, 0) / pts.length };
  return { r: Math.max(...pts.map((p) => dist(c, p))), n: pts.length, c };
}

// Ride area sizes: big coasters have long queues away from their map point; rides are dense (median 37 m apart),
// so we only ever ask "are we at the TARGET ride", never "which ride is this".
export const rideRadius = (a) => ({ thrill: 70, family: 50, kids: 35 }[a?.cat] || 50);
const EXIT_EXTRA = 50; // m: hysteresis between "at the ride" and "left the ride"

// ctx = {
//   now, target: { a (attraction), setAt, queuedAt, boardedAt, rest (my part rests) } | null,
//   foods: [{ id, name, lat, lon, seat, approx }], mealTime: bool, ate: ms, pause: ms,
//   entrance: {lat, lon}, inPark: (pos) => bool, carT: ms (last saved car spot), gap: ms (of the latest fix, from addFix)
//   target.wait = posted wait when we joined the queue (or now); target.queuedAuto = the queue was started by detect
//   queueing: some queue of the current plan is open (no sitting/eating detection then)
// }
// → [{ type: 'queue'|'board'|'done'|'unqueue'|'ate'|'pause'|'car'|'ask-done', at, ...}]
export function detect(tr, ctx) {
  const ev = [];
  const h = tr.hist, now = ctx.now;
  const last = h.at(-1);
  if (!last || now - last.t > 3 * 60e3) return ev; // no fresh position: decide nothing
  const once = (key, e) => { if (tr.emitted[key]) return; tr.emitted[key] = now; ev.push({ ...e, key }); };
  const T = ctx.target;
  if (T?.a && !T.rest) {
    const a = T.a, rIn = rideRadius(a), rOut = rIn + EXIT_EXTRA;
    const key = `${a.id}:${T.setAt}`;
    const at = dwell(h, a, rIn, now);
    // visits since the plan (and, once queued, around/after the queue start: a queue tapped far from the ride's map
    // point, e.g. at the end of a long coaster queue, has no visit and is never auto-ended)
    const vis = visits(h, a, rIn, T.setAt - 60e3).filter((v) => !T.queuedAt || v.e >= T.queuedAt - 60e3);
    const outNow = h.filter((p) => now - p.t <= 90e3);
    const leftFor = outNow.length >= 2 && outNow.every((p) => dist(a, p) > rOut + Math.min(p.a || 0, 25)) && now - outNow[0].t >= 60e3;
    // (gap) the app was closed: the last fix before the gap was at the ride, the first one after is far away
    // a single fix after a long gap only decides when it is a good one (≤ 25 m); otherwise wait for 60 s of fixes
    const gapLeft = ctx.gap != null && ctx.gap >= LIMITS.gap && vis.length && (last.a || 99) <= 25 && dist(a, last) > rOut + 50;
    const from = at.since == null ? null : Math.max(at.since, T.setAt);
    if (!T.queuedAt && from != null && now - from >= 3 * 60e3 && at.n >= 3) {
      const sp = spread(h, 3 * 60e3, now);
      if (sp.r <= rIn) once(`q:${key}`, { type: 'queue', at: from });
    }
    if (T.queuedAt && !T.boardedAt && tr.fast > T.queuedAt && now - tr.fast < 10 * 60e3 && dist(a, last) <= rOut + 150) {
      once(`b:${key}`, { type: 'board', at: tr.fast - 30e3 });
    }
    const start = T.queuedAt || (vis.some((v) => v.e - v.s >= 3 * 60e3) ? vis[0].s : null);
    // the app was closed right after our last visit (the next fix came ≥ 10 min later): how long we stayed is unknown,
    // so estimate it like a gap, also when the decision itself waits for a minute of good fixes
    const vEnd = vis.at(-1)?.e, nxt = vEnd != null ? h.find((p) => p.t > vEnd) : null;
    const closedThere = !!nxt && nxt.t - vEnd >= LIMITS.gap;
    if (start && vis.length && (leftFor || gapLeft)) {
      const lastIn = vis.at(-1)?.e || start;
      // How long we were at the ride decides: long enough for (part of) the posted wait + the ride → done; barely
      // longer than the ride → left the queue; in between it could be either (posted waits are often too high) → ask.
      const wait = T.wait ?? 10, ride = a.ride || 3;
      const sure = ride + Math.max(1, 0.4 * wait - 1);
      const gapMode = gapLeft || closedThere;
      const doneAt = gapMode ? Math.min(now, Math.max(lastIn, start + (wait + ride) * 60e3)) : Math.min(now, lastIn + 60e3);
      const mins = ((gapMode ? doneAt : lastIn) - start) / 60e3;
      if (mins >= sure || T.boardedAt) once(`d:${key}`, { type: 'done', at: doneAt, gap: !!gapMode });
      else if (mins < ride + 2 && T.queuedAt && T.queuedAuto) once(`u:${key}`, { type: 'unqueue', at: lastIn }); // never end a tapped queue
      else if (T.queuedAt && (T.queuedAuto || mins >= ride + 2)) once(`ask:${key}`, { type: 'ask-done', at: now });
    }
    // closed the app before reaching the ride, back much later somewhere else: ask, don't guess
    if (!start && ctx.gap != null && ctx.gap >= 20 * 60e3 && now - T.setAt > 25 * 60e3 && dist(a, last) > rOut + 50) once(`ask:${key}`, { type: 'ask-done', at: now });
  }
  // sitting still for a while
  const still = spread(h, 12 * 60e3, now);
  const span = h.length ? now - h.find((p) => now - p.t <= 12 * 60e3)?.t : 0;
  const atTarget = T?.a && dist(T.a, last) <= rideRadius(T.a) + EXIT_EXTRA;
  // standing still in any queue (also the other half's ride when we don't know who we are) is not eating or resting
  if (still.c && still.r <= 30 && span >= 11 * 60e3 && !atTarget && !ctx.queueing) {
    const sat = dwell(h, still.c, 35, now);
    const food = (ctx.foods || []).map((f) => ({ f, d: dist(f, still.c) })).filter(({ f, d }) => d <= (f.approx ? 90 : 40)).sort((x, y) => x.d - y.d)[0];
    const sitAt = sat.since || now - 12 * 60e3;
    const eating = food && (ctx.mealTime || food.f.kind === 'meal') && now - (ctx.ate || 0) > 2 * 3600e3;
    if (eating) { if (sat.ms >= 15 * 60e3) once(`ate:${Math.floor(sitAt / 3600e3)}`, { type: 'ate', at: sitAt, where: food.f.name }); }
    else if (sat.ms >= 12 * 60e3 && now - (ctx.pause || 0) > 60 * 60e3 && now - (ctx.ate || 0) > 30 * 60e3) once(`pause:${Math.floor(sitAt / 1800e3)}`, { type: 'pause', at: sitAt });
  }
  // the car: we were driving (phone speed ≥ 5 m/s on 2+ fixes) and now walk or stand within 1 km of the entrance
  if (ctx.entrance && tr.drive?.n >= 2 && now - tr.drive.t < 2 * 3600e3 && now - (ctx.carT || 0) > 12 * 3600e3 && !ctx.inPark?.(tr.drive)) { // a coaster is fast too
    const d = tr.drive;
    const slow = h.filter((p) => p.t > d.t);
    const parked = slow.length >= 2 && slow.at(-1).t - slow[0].t >= 30e3 && dist(ctx.entrance, d) <= 1000 && dist(ctx.entrance, d) >= 60;
    if (parked) once(`car:${Math.floor(d.t / 3600e3)}`, { type: 'car', at: d.t, lat: slow[0].lat, lon: slow[0].lon });
  }
  return ev;
}

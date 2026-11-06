// Planner: pure functions on plain data, shared by the browser (app.js) and the Worker (cron notifications).
// Nothing here touches the DOM, storage or the network.
import { ATTRACTIONS, FOOD } from './data.js';

export const WALK_M_PER_MIN = 60; // relaxed pace with a toddler and a pregnant adult
export const PATH_FACTOR = 1.35; // straight line → real path, when no path graph is available

export const DEFAULT_PEOPLE = [
  { id: 'p1', name: 'Volwassene 1', kind: 'adult', height: 178, pregnant: false },
  { id: 'p2', name: 'Volwassene 2', kind: 'adult', height: 166, pregnant: true },
  { id: 'p3', name: 'Groot kind', kind: 'child', height: 145, pregnant: false },
  { id: 'p4', name: 'Peuter', kind: 'child', height: 95, pregnant: false },
];

export const byId = Object.fromEntries([...ATTRACTIONS, ...FOOD].map((x) => [x.id, x]));

// ---------- geometry
export function distM(a, b) {
  const ky = 111320, kx = 111320 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot((a.lon - b.lon) * kx, (a.lat - b.lat) * ky);
}
export function bearing(a, b) {
  const kx = Math.cos(a.lat * Math.PI / 180);
  const deg = Math.atan2((b.lon - a.lon) * kx, b.lat - a.lat) * 180 / Math.PI;
  return (deg + 360) % 360;
}
export const walkMin = (m) => Math.max(1, Math.round(m / WALK_M_PER_MIN));

// ---------- rules per person
// 'alone' | 'adult' (needs an accompanying adult who rides) | null (not allowed)
export function canRide(p, a) {
  if (p.pregnant && !a.preg) return null;
  if (a.max && p.height > a.max) return null;
  if (a.alone != null && p.height >= a.alone) return 'alone';
  if (a.withAdult != null && p.height >= a.withAdult) return 'adult';
  return null;
}

const isToddler = (p) => p.kind === 'child' && p.height < 110;
export function enjoy(p, a, month = new Date().getMonth()) {
  let v;
  if (isToddler(p)) v = { kids: 5, family: 3, thrill: 0 }[a.cat];
  else if (p.kind === 'child') v = { kids: 1.2, family: 3, thrill: 5 }[a.cat];
  else if (p.pregnant) v = 1.5;
  else v = { kids: 0.8, family: 2, thrill: 3 }[a.cat];
  const cold = month >= 9 || month <= 2; // Oct–Mar: getting wet is no fun
  if (a.wet && cold) v = Math.max(0.3, v - 1.5);
  return v;
}

// Who of this group can ride, taking "with adult" into account.
export function riders(group, a) {
  const can = group.map((p) => [p, canRide(p, a)]);
  const escorts = can.filter(([p, c]) => p.kind === 'adult' && c === 'alone').length;
  const ride = [], watch = [], escorted = [];
  let needEscort = 0;
  for (const [p, c] of can) {
    if (c === 'alone') ride.push(p);
    else if (c === 'adult' && needEscort < escorts * 2) { ride.push(p); escorted.push(p); needEscort++; }
    else watch.push(p);
  }
  return { ride, watch, escorted };
}

// Split the family into an "adventure" group and a "calm" group (one adult each).
export function splitGroups(people) {
  const adults = people.filter((p) => p.kind === 'adult').sort((a, b) => a.pregnant - b.pregnant);
  const big = people.filter((p) => p.kind === 'child' && p.height >= 120);
  const small = people.filter((p) => p.kind === 'child' && p.height < 120);
  if (adults.length < 2 || !big.length || !small.length) return null;
  return [[adults[0], ...big], [...adults.slice(1), ...small]];
}

// ---------- live data helpers
// live = { rides: { [id]: { s: 'OPERATING'|'CLOSED'|'DOWN'|'REFURBISHMENT', w: minutes|null } } }
export function status(live, id) {
  const r = live?.rides?.[id];
  if (!r) return { open: false, wait: null, known: false, s: 'UNKNOWN' };
  return { open: r.s === 'OPERATING', wait: r.w ?? null, known: true, s: r.s };
}

// ---------- weather (MET Norway, in live.weather: { now: {t, mm, p, sym}, hours: [{h, t, mm, p, sym}] })
export function raining(live) {
  const w = live?.weather?.now;
  return !!w && ((w.mm ?? 0) >= 0.2 || /rain|sleet|thunder/.test(w.sym || ''));
}
export const WX_ICON = (sym = '') => /thunder/.test(sym) ? '⛈️' : /snow|sleet/.test(sym) ? '🌨️' : /rain/.test(sym) ? '🌧️'
  : /fog/.test(sym) ? '🌫️' : /^cloudy/.test(sym) ? '☁️' : /partly|fair/.test(sym) ? '🌤️' : /clearsky_night/.test(sym) ? '🌙' : /clear/.test(sym) ? '☀️' : '🌡️';

// ---------- sun: sunrise and sunset (standard sunrise equation, accurate to ~1–2 minutes), for the light/dark theme
const RAD = Math.PI / 180;
export const PARK_SPOT = { lat: 50.7, lon: 4.59 };
export function sunTimes(when = new Date(), { lat, lon } = PARK_SPOT) {
  // Julian day of local noon for this calendar date, then the solar transit, declination and hour angle
  const noon = Date.UTC(when.getFullYear(), when.getMonth(), when.getDate(), 12);
  const n = Math.round(noon / 864e5 + 2440587.5 - 2451545.0 + 0.0008);
  const Jstar = n - lon / 360;
  const M = (357.5291 + 0.98560028 * Jstar) % 360;
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const L = (M + C + 180 + 102.9372) % 360;
  const Jtransit = 2451545.0 + Jstar + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * L * RAD);
  const sinD = Math.sin(L * RAD) * Math.sin(23.4397 * RAD);
  const cosD = Math.cos(Math.asin(sinD));
  const cosW = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * sinD) / (Math.cos(lat * RAD) * cosD);
  const w = Math.acos(Math.max(-1, Math.min(1, cosW))) / RAD;
  const toMs = (J) => (J - 2440587.5) * 864e5;
  return { rise: new Date(toMs(Jtransit - w / 360)), set: new Date(toMs(Jtransit + w / 360)) };
}
export function isDaylight(when = new Date(), spot = PARK_SPOT) {
  const { rise, set } = sunTimes(when, spot);
  return when >= rise && when < set;
}

// ---------- the planner
// Walking weight per minute, relative to a minute in the queue. Tuned with sim/simulate.mjs (40 simulated days):
// 'normal' gave the most fun (−13% walking vs. weight 1); 'low' walks ~20% less again for ~5% less fun.
// Expected crowd over the day (0..1) as the planner assumes it: quiet first hour, peak early afternoon, a second
// peak on Halloween evenings (research: rope-drop and late-evening waits are the lowest of the day).
export function crowdCurve(min) {
  const h = min / 60;
  const afternoon = Math.exp(-((h - 14.5) ** 2) / 6);
  const evening = 0.75 * Math.exp(-((h - 19.5) ** 2) / 3);
  return Math.min(1, 0.15 + 0.85 * Math.max(afternoon, evening));
}
// "Short now, long later": favour a ride whose queue is short now compared with what it will probably be later today
// (and avoid long queues at the peak). Tuned with sim/simulate.mjs on 4 crowd scenarios × 20 days, including days whose
// real crowd curve differs from crowdCurve: urgency 4 gave +10–13% rides per person and ~40 min less queueing a day,
// clearly more than simply weighting waits heavier (+3–6%). Stronger values gained a little more but made the
// pregnant adult walk more and ride less on busy days. Needs ctx.clock = { now, close } in minutes since midnight
// (park time); without it (or without a schedule) the factor is 1. waitWeight stays 1 (kept for experiments).
export const TUNE = { urgency: 4, waitWeight: 1 };
// park time in minutes since midnight, from /api/live (localTime is Brussels wall-clock written as UTC)
export function parkClock(live, nowMs = Date.now()) {
  if (!live?.localTime || live.minutesLeft == null) return null;
  const d = new Date(live.localTime);
  const now = d.getUTCHours() * 60 + d.getUTCMinutes() + Math.max(0, Math.round((nowMs - (live.t || nowMs)) / 60e3));
  return { now, close: now + live.minutesLeft - Math.max(0, Math.round((nowMs - (live.t || nowMs)) / 60e3)) };
}
export function urgencyFactor(wait, ctx) {
  const c = ctx.clock; if (!TUNE.urgency || !c || c.close == null) return 1;
  const now = c.now, end = c.close;
  if (end - now < 45) return 1;
  let sum = 0, n = 0;
  for (let t = now + 30; t <= end; t += 15) { sum += crowdCurve(t); n++; }
  const later = (wait + 3) / Math.max(crowdCurve(now), 0.15) * (sum / n); // this ride's likely wait later today
  const gain = Math.max(-0.5, Math.min(1.5, (later - wait) / (wait + 15)));
  return 1 + TUNE.urgency * gain;
}
// After a ride each person says 😍 (3), 🙂 (2) or 😬 (1). 😍 makes doing it again more attractive for that person
// (it partly undoes the 0.35ⁿ "done" decay), 😬 makes it unattractive.
export const RATE_MUL = { 1: 0.25, 2: 1, 3: 1.7 };
// Posted waits vs. the waits this family really had today (queue → "aan de beurt"): the median ratio of the last
// measurements, from 2 samples on, kept within 0.5–1.3 so one odd queue can't throw the planner off.
export function waitFactor(waits, now = Date.now()) {
  const r = (waits || []).filter((x) => x.w >= 5 && x.m > 0 && now - x.t < 12 * 3600e3).slice(-8).map((x) => x.m / x.w).sort((a, b) => a - b);
  if (r.length < 2) return 1;
  const med = r.length % 2 ? r[(r.length - 1) / 2] : (r[r.length / 2 - 1] + r[r.length / 2]) / 2;
  return Math.min(1.3, Math.max(0.5, Math.round(med * 100) / 100));
}
export const WALK_WEIGHT = { normal: { heavy: 2, light: 1.2 }, low: { heavy: 6, light: 2 } };
// ctx = { people, favs:[id], done:{id:n}, rates:{id:{person:1-3}}, waitFactor, live, walk:(attraction)=>meters, minutesLeft, month, rain, walkPref }
function scoreOne(group, a, ctx, extraWalkM = 0) {
  const st = status(ctx.live, a.id);
  if (!st.open) return null;
  const { ride, watch, escorted } = riders(group, a);
  if (!ride.length) return null;
  // people who only watch cost something: a bored toddler more than an adult on a bench
  let value = ride.reduce((s, p) => s + enjoy(p, a, ctx.month) * RATE_MUL[ctx.rates?.[a.id]?.[p.id] ?? 2], 0) - watch.reduce((s, p) => s + (p.kind === 'child' ? 1.5 : 0.7), 0);
  const done = ctx.done?.[a.id] || 0;
  value *= Math.pow(0.35, done);
  if (ctx.favs?.includes(a.id)) value *= 2;
  if (ctx.rain) value *= a.indoor ? 1.6 : a.wet ? 0.5 : 0.85; // raining now: prefer indoor rides
  if (value <= 0.2) return null;
  const walkM = ctx.walk(a) + extraWalkM;
  const wait = st.wait ?? 10;
  // a minute walking costs more than a minute in the queue for a pregnant adult or a toddler (tired legs, buggy),
  // tuned with sim/simulate.mjs; walk is also slower with a pregnant adult
  const ww = WALK_WEIGHT[ctx.walkPref] || WALK_WEIGHT.normal;
  const heavy = group.some((p) => p.pregnant || isToddler(p));
  const realWait = wait * (ctx.waitFactor || 1); // posted waits corrected by what this family measured today
  const minutes = walkMin(walkM) * (group.some((p) => p.pregnant) ? 1.25 : 1) * (heavy ? ww.heavy : ww.light) + realWait * TUNE.waitWeight + a.ride;
  if (ctx.minutesLeft != null && walkMin(walkM) + realWait > ctx.minutesLeft) return null;
  value *= urgencyFactor(wait, ctx);
  return { a, ride, watch, escorted, value, walkM, wait, waitKnown: st.wait != null, minutes };
}

export function plans(ctx) {
  const people = ctx.people;
  const out = [];
  // 1. Everyone together (non-riders watch at the exit)
  for (const a of ATTRACTIONS) {
    const s = scoreOne(people, a, ctx);
    if (!s) continue;
    out.push({ type: 'together', key: a.id, parts: [{ group: people.map((p) => p.id), ...pick(s) }], score: s.value / (s.minutes + 3), minutes: s.minutes });
  }
  // 2. Split: adventure group on one ride, calm group on a nearby ride (or resting), meet at the first ride's exit
  const groups = splitGroups(people);
  if (groups) {
    const [g1, g2] = groups;
    const firsts = ATTRACTIONS.map((a) => scoreOne(g1, a, ctx)).filter(Boolean)
      .filter((s) => s.ride.length === g1.length) // the whole adventure group rides
      .sort((x, y) => y.value / y.minutes - x.value / x.minutes).slice(0, 10);
    for (const s1 of firsts) {
      let best = null;
      for (const a2 of ATTRACTIONS) {
        if (a2.id === s1.a.id) continue;
        const back = distM(a2, s1.a) * PATH_FACTOR;
        if (back > 300) continue;
        const s2 = scoreOne(g2, a2, ctx, 0);
        if (!s2 || !s2.ride.some((p) => p.kind === 'child')) continue;
        const t2 = s2.minutes + walkMin(back);
        const sc = s2.value / Math.max(1, t2);
        if (!best || sc > best.sc) best = { s2, t2, sc };
      }
      const t1 = s1.minutes;
      if (best) {
        const T = Math.max(t1, best.t2);
        out.push({
          type: 'split', key: s1.a.id + '+' + best.s2.a.id,
          parts: [{ group: g1.map((p) => p.id), ...pick(s1) }, { group: g2.map((p) => p.id), ...pick(best.s2) }],
          meet: s1.a.id, score: 0.9 * (s1.value + best.s2.value) / (T + 4), minutes: T,
        });
      } else if (g2.some((p) => p.pregnant)) {
        // calm group rests on a bench near the ride: still worth something for a pregnant adult
        out.push({
          type: 'split', key: s1.a.id + '+rest',
          parts: [{ group: g1.map((p) => p.id), ...pick(s1) }, { group: g2.map((p) => p.id), rest: true, id: null, walkM: s1.walkM, wait: 0, minutes: t1 }],
          meet: s1.a.id, score: 0.85 * (s1.value + 1) / (t1 + 4), minutes: t1,
        });
      }
    }
  }
  out.sort((x, y) => y.score - x.score);
  // keep variety: no two plans with the same main attraction
  const seen = new Set();
  return out.filter((p) => { const k = p.parts[0].id; if (seen.has(k)) return false; seen.add(k); return true; });
}

function pick(s) {
  return { id: s.a.id, ride: s.ride.map((p) => p.id), watch: s.watch.map((p) => p.id), escorted: s.escorted.map((p) => p.id), walkM: Math.round(s.walkM), wait: s.wait, waitKnown: s.waitKnown, minutes: Math.round(s.minutes) };
}

// ---------- food and rest
export function foodOptions(walk, { mealTime = false } = {}) {
  return FOOD.map((f) => {
    const m = walk(f);
    let cost = walkMin(m) + (f.seat ? 0 : 6) + (mealTime && f.kind === 'snack' ? 5 : 0);
    return { f, walkM: Math.round(m), cost };
  }).sort((a, b) => a.cost - b.cost);
}

const early = (d) => { const h = d.getHours() + d.getMinutes() / 60; return h < 12.25 || (h >= 17 && h < 17.75); };
export function isMealTime(d) {
  const h = d.getHours() + d.getMinutes() / 60;
  // a little before the rush: eat while the restaurants are still quiet, then ride while everyone else eats
  return (h >= 11.5 && h <= 13.5) || (h >= 17 && h <= 19);
}

// ---------- notifications (used by the Worker every minute, per device)
// Is the park open (or about to open/just closed) at `now`? With an unknown schedule (live.open null):
// open when at least one ride is running.
export function parkOpen(live, now) {
  if (!live) return false;
  if (live.open) return now >= live.open - 15 * 60e3 && now <= (live.close || live.open + 12 * 3600e3) + 15 * 60e3;
  return Object.values(live.rides || {}).some((r) => r?.s === 'OPERATING');
}

// memo is this device's notification memory; returns { notes:[{tag,title,body,url}], memo }
export function decideNotifications({ fam, deviceId, live, now, prefs, memo }) {
  memo = { w: {}, sent: {}, ...memo };
  const notes = [];
  const people = fam.people?.length ? fam.people : DEFAULT_PEOPLE;
  const pos = fam.positions?.[deviceId];
  const fresh = pos && now - pos.t < 45 * 60e3;
  const here = fresh ? pos : null;
  const walk = (x) => (here ? distM(here, x) * PATH_FACTOR : 400);
  const ctx = { people, favs: fam.favs || [], done: fam.done || {}, rates: fam.rates || {}, waitFactor: waitFactor(fam.waits, now), live, walk, month: new Date(now).getMonth(), minutesLeft: live.minutesLeft, rain: raining(live), walkPref: fam.walk, clock: parkClock(live) };
  const since = (k) => now - (memo.sent[k] || 0);
  const quiet = since('any') < 8 * 60e3;
  const nm = (id) => byId[id]?.name || 'attractie';

  // 1. the ride you're heading to broke down (not a planned closure), only while the target is recent
  const target = fam.target;
  if (prefs.down !== false && target?.plan && now - (target.setAt || 0) < 90 * 60e3) {
    for (const part of target.plan.parts) {
      if (!part.id) continue;
      const st = status(live, part.id);
      if (st.s === 'DOWN' && memo.down !== target.setAt + part.id) {
        const alt = plans(ctx)[0];
        memo.down = target.setAt + part.id;
        notes.push({ tag: 'down', title: `⚠️ ${nm(part.id)} ligt stil`, body: alt ? `Nieuw voorstel: ${describe(alt, people)}` : 'Open de app voor een nieuw voorstel.', url: '/' });
        break;
      }
    }
  }
  // 2. favourite got short
  if (!notes.length && prefs.fav !== false) {
    for (const id of ctx.favs) {
      const st = status(live, id);
      if (!st.open || st.wait == null) continue;
      const before = memo.w[id];
      if (before != null && before - st.wait >= 10 && st.wait <= 15 && !quiet) {
        const a = byId[id];
        notes.push({ tag: 'fav-' + id, title: `⭐ ${a.name}: nog maar ${st.wait} min`, body: here ? `Je staat er op ${walkMin(walk(a))} min stappen.` : 'Nu snel erheen?', url: '/?go=' + id });
        memo.w[id] = st.wait; // reset the high-water mark after telling
        break;
      }
    }
  }
  // remember the highest wait since the last message, so a slow drop over an hour still counts
  for (const id of ctx.favs) { const st = status(live, id); if (st.wait != null) memo.w[id] = Math.max(memo.w[id] ?? st.wait, st.wait); }

  // 2b. closing soon: last round, and how far the exit is
  if (!notes.length && live.minutesLeft != null && live.minutesLeft <= 45 && live.minutesLeft > 15 && memo.closing !== new Date(now).toDateString()) {
    memo.closing = new Date(now).toDateString();
    const best = plans({ ...ctx, minutesLeft: live.minutesLeft - 10 })[0];
    notes.push({ tag: 'closing', title: `⏰ Nog ${live.minutesLeft} min open`, body: best ? `Laatste ronde: ${describe(best, people)}. Daarna richting uitgang${fam.car ? ' en auto' : ''}.` : 'Tijd om richting uitgang te gaan.', url: '/' });
  }
  const date = new Date(now);
  const local = live.localTime ? new Date(live.localTime) : date;
  // 3. time to eat
  if (!notes.length && prefs.food !== false && !quiet && isMealTime(local) && now - (fam.ate || 0) > 3 * 3600e3) {
    const slot = local.getHours() < 15 ? 'lunch' : 'diner';
    if (memo.food !== slot + local.toDateString()) {
      memo.food = slot + local.toDateString();
      const f = foodOptions(walk, { mealTime: true })[0];
      notes.push({ tag: 'food', title: `🍽️ Tijd voor ${slot === 'lunch' ? 'middageten' : 'avondeten'}?`, body: `${early(local) ? 'Eet nu, vóór de drukte: daarna zijn de rijen korter terwijl iedereen eet. ' : ''}${f.f.name}${f.f.seat ? ' (zitplaatsen)' : ''}${here ? ` op ${walkMin(f.walkM)} min` : ''}.`, url: '/?food=1' });
    }
  }
  // 4. rest for the pregnant adult
  if (!notes.length && prefs.food !== false && !quiet && people.some((p) => p.pregnant)) {
    // counted from the last meal/pause, or from opening time (no reminder right after arriving)
    const lastRest = Math.max(fam.ate || 0, fam.pause || 0, fam.created || 0, live.open || 0);
    if (now - lastRest > 100 * 60e3 && since('pause') > 100 * 60e3) {
      memo.sent.pause = now;
      const f = foodOptions(walk).find((o) => o.f.seat);
      notes.push({ tag: 'pause', title: '🪑 Even zitten?', body: `Al een tijd op de been. ${f ? `${f.f.name} heeft zitplaatsen${here ? `, ${walkMin(f.walkM)} min` : ''}.` : ''}`, url: '/?food=1' });
    }
  }
  // 5. a clearly better next step
  if (!notes.length && prefs.best !== false && !quiet && here && since('best') > 15 * 60e3) {
    const targetAge = target?.setAt ? now - target.setAt : Infinity;
    const inQueue = Object.values(target?.q || {}).some((q) => now - q.t < 90 * 60e3); // standing in line: no "better idea"
    if (targetAge > 30 * 60e3 && !inQueue) {
      const best = plans(ctx)[0];
      if (best && best.key !== memo.bestKey && best.parts[0].wait <= 15) {
        memo.bestKey = best.key; memo.sent.best = now;
        notes.push({ tag: 'best', title: '👉 Nu ideaal', body: describe(best, people), url: '/' });
      }
    }
  }
  if (notes.length) memo.sent.any = now;
  return { notes, memo };
}

export function describe(plan, people) {
  const name = (id) => people.find((p) => p.id === id)?.name || '';
  const part = (pt) => pt.rest ? 'even rusten in de buurt' : `${byId[pt.id].name} (${pt.wait} min wachten)`;
  if (plan.type === 'together') return `Iedereen → ${part(plan.parts[0])}`;
  return plan.parts.map((pt) => `${pt.group.map(name).join(' + ')} → ${part(pt)}`).join(' · ');
}

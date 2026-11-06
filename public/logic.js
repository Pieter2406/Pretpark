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

// ---------- the planner
// ctx = { people, favs:[id], done:{id:n}, live, walk:(attraction)=>meters, minutesLeft, month, rain }
function scoreOne(group, a, ctx, extraWalkM = 0) {
  const st = status(ctx.live, a.id);
  if (!st.open) return null;
  const { ride, watch, escorted } = riders(group, a);
  if (!ride.length) return null;
  // people who only watch cost something: a bored toddler more than an adult on a bench
  let value = ride.reduce((s, p) => s + enjoy(p, a, ctx.month), 0) - watch.reduce((s, p) => s + (p.kind === 'child' ? 1.5 : 0.7), 0);
  const done = ctx.done?.[a.id] || 0;
  value *= Math.pow(0.35, done);
  if (ctx.favs?.includes(a.id)) value *= 2;
  if (ctx.rain) value *= a.indoor ? 1.6 : a.wet ? 0.5 : 0.85; // raining now: prefer indoor rides
  if (value <= 0.2) return null;
  const walkM = ctx.walk(a) + extraWalkM;
  const wait = st.wait ?? 10;
  const slowWalk = group.some((p) => p.pregnant) ? 1.25 : 1; // walking costs more with a pregnant adult
  const minutes = walkMin(walkM) * slowWalk + wait + a.ride;
  if (ctx.minutesLeft != null && walkMin(walkM) + wait > ctx.minutesLeft) return null;
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

export function isMealTime(d) {
  const h = d.getHours() + d.getMinutes() / 60;
  return (h >= 11.75 && h <= 13.75) || (h >= 17.5 && h <= 19.5);
}

// ---------- notifications (used by the Worker every minute, per device)
// memo is this device's notification memory; returns { notes:[{tag,title,body,url}], memo }
export function decideNotifications({ fam, deviceId, live, now, prefs, memo }) {
  memo = { w: {}, sent: {}, ...memo };
  const notes = [];
  const people = fam.people?.length ? fam.people : DEFAULT_PEOPLE;
  const pos = fam.positions?.[deviceId];
  const fresh = pos && now - pos.t < 45 * 60e3;
  const here = fresh ? pos : null;
  const walk = (x) => (here ? distM(here, x) * PATH_FACTOR : 400);
  const ctx = { people, favs: fam.favs || [], done: fam.done || {}, live, walk, month: new Date(now).getMonth(), minutesLeft: live.minutesLeft, rain: raining(live) };
  const since = (k) => now - (memo.sent[k] || 0);
  const quiet = since('any') < 8 * 60e3;
  const nm = (id) => byId[id]?.name || 'attractie';

  // 1. the ride you're heading to stopped
  const target = fam.target;
  if (prefs.down !== false && target?.plan) {
    for (const part of target.plan.parts) {
      if (!part.id) continue;
      const st = status(live, part.id);
      if (st.known && !st.open && memo.down !== target.setAt + part.id) {
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
      notes.push({ tag: 'food', title: `🍽️ Tijd voor ${slot === 'lunch' ? 'middageten' : 'avondeten'}?`, body: `${f.f.name}${f.f.seat ? ' (zitplaatsen)' : ''}${here ? ` op ${walkMin(f.walkM)} min` : ''}.`, url: '/?food=1' });
    }
  }
  // 4. rest for the pregnant adult
  if (!notes.length && prefs.food !== false && !quiet && people.some((p) => p.pregnant)) {
    const lastRest = Math.max(fam.ate || 0, fam.pause || 0, fam.created || 0);
    if (now - lastRest > 100 * 60e3 && since('pause') > 100 * 60e3) {
      memo.sent.pause = now;
      const f = foodOptions(walk).find((o) => o.f.seat);
      notes.push({ tag: 'pause', title: '🪑 Even zitten?', body: `Al een tijd op de been. ${f ? `${f.f.name} heeft zitplaatsen${here ? `, ${walkMin(f.walkM)} min` : ''}.` : ''}`, url: '/?food=1' });
    }
  }
  // 5. a clearly better next step
  if (!notes.length && prefs.best !== false && !quiet && here && since('best') > 15 * 60e3) {
    const targetAge = target?.setAt ? now - target.setAt : Infinity;
    if (targetAge > 30 * 60e3) {
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

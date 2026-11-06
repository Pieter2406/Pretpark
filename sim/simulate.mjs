// Day simulator for the Pretpark planner. Plays whole park days minute by minute with a synthetic crowd model
// (wait times that rise and fall over the day, random breakdowns, optional rain) and lets a family follow either
// the app's suggestion or a simple baseline strategy. Run: node sim/simulate.mjs [days=40]
// Nothing here is published (outside public/).
import fs from 'node:fs';
import { ATTRACTIONS, FOOD, ENTRANCE } from '../public/data.js';
import { plans, canRide, riders, enjoy, DEFAULT_PEOPLE, splitGroups, distM, foodOptions } from '../public/logic.js';
import { makePark, pathLength } from '../public/route.js';

const park = makePark(JSON.parse(fs.readFileSync(new URL('../public/park.json', import.meta.url))));
const OPEN = 10 * 60, CLOSE = 22 * 60; // minutes since midnight (Halloween day: 10:00–22:00)
const MONTH = 10; // November

// ---------- deterministic randomness
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

// ---------- crowd model: every ride has a popularity; waits follow a day curve, with noise and breakdowns
const POP = { thrill: 1, family: 0.65, kids: 0.3 };
const BIG = new Set(['Kondaa', 'Pulsar', 'Calamity Mine', 'Loup-Garou', 'Vampire', 'Radja River', 'Tiki-Waka', 'Mecalodon']);
// the real day can differ from what the planner expects: 'early' = lunchtime peak and no evening, 'flat' = busy all day
let CURVE = 'default';
function dayCurve(min) { // 0..1 crowd level over the day, peaks early afternoon and again for the Halloween evening
  const h = min / 60;
  if (CURVE === 'early') return Math.min(1, 0.3 + 0.7 * Math.exp(-((h - 12.5) ** 2) / 5));
  if (CURVE === 'flat') return Math.min(1, 0.55 + 0.25 * Math.exp(-((h - 15) ** 2) / 8));
  const afternoon = Math.exp(-((h - 14.5) ** 2) / 6);
  const evening = 0.75 * Math.exp(-((h - 19.5) ** 2) / 3);
  return Math.min(1, 0.15 + 0.85 * Math.max(afternoon, evening));
}
export function makeDay(seed, { crowd = 1, rainFrom = null, rainTo = null, breakdowns = 1, closed = [], curve = 'default' } = {}) {
  CURVE = curve;
  const r = rng(seed);
  const base = Object.fromEntries(ATTRACTIONS.map((a) => [a.id, (BIG.has(a.name) ? 55 : 30) * POP[a.cat] * (0.7 + 0.6 * r())]));
  const downs = []; // [rideId, from, to]
  for (let i = 0; i < Math.round(6 * breakdowns); i++) {
    const a = ATTRACTIONS[Math.floor(r() * ATTRACTIONS.length)], from = OPEN + Math.floor(r() * (CLOSE - OPEN));
    downs.push([a.id, from, from + 15 + Math.floor(r() * 45)]);
  }
  const noise = Object.fromEntries(ATTRACTIONS.map((a) => [a.id, r() * 6]));
  return {
    rain: (min) => rainFrom != null && min >= rainFrom && min < rainTo,
    live(min) { // what the app would get from /api/live at this minute
      const rides = {};
      const rainNow = rainFrom != null && min >= rainFrom && min < rainTo;
      for (const a of ATTRACTIONS) {
        if (closed.includes(a.name)) continue; // not in live data = closed
        const down = downs.some(([id, f, t]) => id === a.id && min >= f && min < t);
        let w = base[a.id] * dayCurve(min) * crowd + noise[a.id] * Math.sin(min / 37 + noise[a.id]);
        if (rainNow) w *= a.indoor ? 1.8 : 0.5; // everyone runs inside
        w = Math.max(0, Math.round(w / 5) * 5); // the park reports in steps of 5
        rides[a.id] = { s: down ? 'DOWN' : 'OPERATING', w: down ? 0 : w };
      }
      return { rides, minutesLeft: CLOSE - min, weather: rainNow ? { now: { mm: 2, sym: 'rain' } } : { now: { mm: 0, sym: 'cloudy' } } };
    },
  };
}

// ---------- strategies: return a plan in the same shape as logic.plans()
const together = (people, a) => {
  const r = riders(people, a);
  return { type: 'together', parts: [{ id: a.id, group: people.map((p) => p.id), ride: r.ride.map((p) => p.id), watch: r.watch.map((p) => p.id) }] };
};
const open = (live, a) => live.rides[a.id]?.s === 'OPERATING';
export const STRATEGIES = {
  app: ({ people, live, here, done, favs, min, walkPref }) => {
    const h = park.fromHere(here);
    return plans({ people, favs, done, live, walk: (a) => h.metres(a), walkPref, month: MONTH, minutesLeft: CLOSE - min, rain: live.weather.now.mm > 0, clock: { now: min, close: CLOSE } })[0] || null;
  },
  // what many families do: the nearest open ride where at least two of us can ride, not done yet
  nearest: ({ people, live, here, done }) => {
    const h = park.fromHere(here);
    const c = ATTRACTIONS.filter((a) => open(live, a) && !done[a.id] && riders(people, a).ride.length >= 2).sort((x, y) => h.metres(x) - h.metres(y))[0];
    return c ? together(people, c) : null;
  },
  // chase the shortest queue anywhere, together
  shortest: ({ people, live, done }) => {
    const c = ATTRACTIONS.filter((a) => open(live, a) && !done[a.id] && riders(people, a).ride.length >= 2).sort((x, y) => live.rides[x.id].w - live.rides[y.id].w)[0];
    return c ? together(people, c) : null;
  },
  // walk around with the park map: random ride, together
  random: ({ people, live, done, rand }) => {
    const c = ATTRACTIONS.filter((a) => open(live, a) && !done[a.id] && riders(people, a).ride.length >= 2);
    return c.length ? together(people, c[Math.floor(rand() * c.length)]) : null;
  },
};

// ---------- one day
export function simulateDay(strategy, { seed = 1, people = DEFAULT_PEOPLE, favs = [], arrive = OPEN, scenario = {}, trace = false, walkPref = 'normal' } = {}) {
  const day = makeDay(seed, scenario);
  const rand = rng(seed * 7 + 3);
  const byId = Object.fromEntries(ATTRACTIONS.map((a) => [a.id, a]));
  const pregnant = people.some((p) => p.pregnant);
  const m = { rides: 0, fun: Object.fromEntries(people.map((p) => [p.id, 0])), rideCount: Object.fromEntries(people.map((p) => [p.id, 0])),
    idle: Object.fromEntries(people.map((p) => [p.id, 0])), walked: Object.fromEntries(people.map((p) => [p.id, 0])), wait: 0, walkM: 0, splits: 0, rests: 0, violations: [], log: [], repeats: 0, wetInRain: 0 };
  const done = {};
  let min = arrive, here = ENTRANCE, ate = { lunch: false, dinner: false }, lastPause = arrive;
  const walkFor = (from, to, slow) => { const d = pathLength(park.fromHere(from).path(to)); return { d, t: (d / 60) * (slow ? 1.25 : 1) }; };
  while (min < CLOSE - 3) {
    // meals and rest, the same for every strategy (the app's food button is not what is being compared)
    if ((!ate.lunch && min >= 12 * 60 + 30) || (!ate.dinner && min >= 18 * 60)) {
      const f = foodOptions((x) => park.fromHere(here).metres(x), { mealTime: true })[0].f;
      const w = walkFor(here, f, pregnant); m.walkM += w.d; min += w.t + 40; here = f;
      for (const p of people) m.walked[p.id] += w.d;
      if (!ate.lunch && min >= 12 * 60 + 30) ate.lunch = true; else ate.dinner = true;
      lastPause = min; continue;
    }
    if (pregnant && min - lastPause > 110) { min += 15; lastPause = min; continue; }

    const live = day.live(Math.round(min));
    const plan = STRATEGIES[strategy]({ people, live, here, done, favs, min, rand, walkPref });
    if (!plan) { min += 10; continue; }
    // check the plan against the rules (the planner must never break these)
    for (const part of plan.parts) {
      if (part.rest) continue;
      const a = byId[part.id];
      if (live.rides[a.id]?.s !== 'OPERATING') m.violations.push(`${a.name} not open`);
      const group = people.filter((p) => part.group.includes(p.id));
      if (!group.some((p) => p.kind === 'adult')) m.violations.push(`${a.name}: group without adult`);
      for (const id of part.ride) {
        const p = people.find((x) => x.id === id), c = canRide(p, a);
        if (!c) m.violations.push(`${p.name} on ${a.name}`);
        if (c === 'adult' && !part.ride.some((oid) => { const o = people.find((x) => x.id === oid); return o.kind === 'adult' && canRide(o, a) === 'alone'; })) m.violations.push(`${p.name} on ${a.name} without adult`);
      }
    }
    if (plan.type === 'split') m.splits++;
    // execute: every group walks, queues and rides; split groups meet at the first ride
    let longest = 0;
    const meet = plan.meet ? byId[plan.meet] : byId[plan.parts[0].id];
    for (const part of plan.parts) {
      const group = people.filter((p) => part.group.includes(p.id));
      const slow = group.some((p) => p.pregnant);
      if (part.rest) { m.rests++; const w = walkFor(here, meet, slow); longest = Math.max(longest, w.t); for (const p of group) m.walked[p.id] += w.d; continue; }
      const a = byId[part.id];
      const w = walkFor(here, a, slow);
      const arriveAt = min + w.t;
      if (arriveAt > CLOSE) { m.late = (m.late || 0) + 1; longest = Math.max(longest, w.t); continue; } // queue already closed
      const wait = day.live(Math.round(arriveAt)).rides[a.id]?.w ?? 10; // the queue when you actually get there
      const back = part === plan.parts[0] ? 0 : walkFor(a, meet, slow).t;
      const t = w.t + wait + a.ride + back;
      longest = Math.max(longest, t);
      m.walkM += w.d; m.wait += wait;
      for (const p of group) m.walked[p.id] += w.d + (back ? walkFor(a, meet, slow).d : 0);
      if (day.rain(arriveAt) && a.wet) m.wetInRain++;
      if (done[a.id]) m.repeats++;
      done[a.id] = (done[a.id] || 0) + 1;
      m.rides++;
      for (const id of part.ride) { const p = people.find((x) => x.id === id); m.fun[id] += enjoy(p, a, MONTH); m.rideCount[id]++; }
      m.log.push(`${String(Math.floor(arriveAt / 60)).padStart(2, '0')}:${String(Math.floor(arriveAt % 60)).padStart(2, '0')} ${plan.type === 'split' ? '[split] ' : ''}${a.name} (${wait}′) ${part.ride.map((id) => people.find((x) => x.id === id).name.slice(0, 3)).join('+')}`);
    }
    // whoever isn't riding during the slot is idle for its length (watching or resting)
    for (const p of people) {
      const riding = plan.parts.some((pt) => !pt.rest && pt.ride.includes(p.id));
      if (!riding) m.idle[p.id] += longest;
    }
    min += longest + 2;
    here = meet;
    if (min >= CLOSE) break;
  }
  m.totalFun = Object.values(m.fun).reduce((a, b) => a + b, 0);
  m.walkKm = Math.max(...Object.values(m.walked)) / 1000; // the person who walked most
  m.walkedKm = Object.fromEntries(Object.entries(m.walked).map(([k, v]) => [k, v / 1000]));
  if (trace) m.trace = m.log;
  return m;
}

// ---------- the report
function avg(strategy, opts, days) {
  const runs = Array.from({ length: days }, (_, i) => simulateDay(strategy, { ...opts, seed: i + 1 }));
  const mean = (f) => runs.reduce((s, r) => s + f(r), 0) / runs.length;
  const people = opts.people || DEFAULT_PEOPLE;
  return {
    rides: mean((r) => r.rides), fun: mean((r) => r.totalFun), wait: mean((r) => r.wait), walk: mean((r) => r.walkKm),
    splits: mean((r) => r.splits), rests: mean((r) => r.rests), repeats: mean((r) => r.repeats), wetInRain: mean((r) => r.wetInRain),
    per: Object.fromEntries(people.map((p) => [p.name, { rides: mean((r) => r.rideCount[p.id]), fun: mean((r) => r.fun[p.id]), idle: mean((r) => r.idle[p.id]), km: mean((r) => r.walkedKm[p.id]) }])),
    violations: runs.flatMap((r) => r.violations),
  };
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const days = Number(process.argv[2]) || 40;
  const scenarios = {
    'Gewone dag (ons gezin)': {},
    'Drukke dag (+60%)': { scenario: { crowd: 1.6 } },
    'Regen 13u–16u': { scenario: { rainFrom: 13 * 60, rainTo: 16 * 60 } },
    'Veel storingen (3×)': { scenario: { breakdowns: 3 } },
    'Pas om 16u binnen': { arrive: 16 * 60 },
  };
  for (const [name, opts] of Object.entries(scenarios)) {
    console.log(`\n=== ${name} · ${days} gesimuleerde dagen ===`);
    console.log('strategie   ritten  plezier  wachten(min)  max km/pers  splits  rust  herhaald  nat-in-regen');
    for (const s of Object.keys(STRATEGIES)) {
      const r = avg(s, opts, days);
      console.log(`${s.padEnd(10)} ${r.rides.toFixed(1).padStart(7)} ${r.fun.toFixed(0).padStart(8)} ${r.wait.toFixed(0).padStart(13)} ${r.walk.toFixed(1).padStart(12)} ${r.splits.toFixed(1).padStart(7)} ${r.rests.toFixed(1).padStart(5)} ${r.repeats.toFixed(1).padStart(9)} ${r.wetInRain.toFixed(1).padStart(13)}${r.violations.length ? '  ⚠️ ' + r.violations.length + ' regelovertredingen' : ''}`);
      if (s === 'app') for (const [n, v] of Object.entries(r.per)) console.log(`   ${n.padEnd(14)} ritten ${v.rides.toFixed(1).padStart(5)}  plezier ${v.fun.toFixed(0).padStart(4)}  aan de kant ${v.idle.toFixed(0).padStart(4)} min  gestapt ${v.km.toFixed(1)} km`);
    }
  }
}

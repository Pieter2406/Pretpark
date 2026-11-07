// Location cleaning and activity detection on synthetic GPS traces: noise, teleports, stale/approximate fixes,
// queue → ride → leave, walk-on rides, passing by, giving up, the app closed for a while, eating, resting, the car.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newTracker, addFix, detect, dist, farState, LIMITS } from '../public/activity.js';
import { ATTRACTIONS, FOOD, ENTRANCE } from '../public/data.js';

const T0 = Date.UTC(2026, 10, 7, 10, 0, 0);
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const move = (p, dx, dy) => ({ lat: p.lat + dy / 111194, lon: p.lon + dx / (111194 * Math.cos((p.lat * Math.PI) / 180)) });
const noisy = (p, acc) => move(p, gauss() * acc * 0.5, gauss() * acc * 0.5);
const cobra = ATTRACTIONS.find((a) => a.name === 'Cobra');
const kids = ATTRACTIONS.find((a) => a.cat === 'kids');

// a little world: feed fixes every `step` s, run detect after each, collect events
function world({ target = null, foods = [], mealTime = false, inPark = () => true, carT = 0 } = {}) {
  const tr = newTracker();
  const T = target ? { ...target } : null;
  let now = T0;
  const events = [];
  const fam = { ate: 0, pause: 0 };
  const feed = (truth, { acc = 12, speed = null, raw = null } = {}) => {
    const p = raw || noisy(truth, acc);
    const r = addFix(tr, { lat: p.lat, lon: p.lon, acc, t: now, speed }, now);
    const ev = detect(tr, { now, target: T, foods, mealTime, ate: fam.ate, pause: fam.pause, entrance: ENTRANCE, inPark, carT, gap: r.ok ? r.gap : null });
    for (const e of ev) {
      events.push(e);
      if (T && e.type === 'queue') T.queuedAt = e.at;
      if (T && e.type === 'board') T.boardedAt = e.at;
      if (e.type === 'ate') fam.ate = e.at;
      if (e.type === 'pause') fam.pause = e.at;
    }
    return r;
  };
  const stay = (p, sec, o = {}) => { for (let s = 0; s < sec; s += o.step || 5) { feed(p, o); now += (o.step || 5) * 1000; } };
  const walk = (a, b, o = {}) => {
    const d = dist(a, b), n = Math.max(1, Math.round(d / 1.2 / 5));
    for (let i = 0; i <= n; i++) { const f = i / n; feed({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f }, o); now += 5000; }
  };
  return { tr, T, events, feed, stay, walk, skip: (ms) => { now += ms; }, now: () => now, types: () => events.map((e) => e.type) };
}

test('anomalies: teleports, stale, out of order and approximate fixes are ignored; drift is smoothed', () => {
  const w = world();
  const here = move(cobra, 0, 200);
  const reasons = [];
  for (let i = 0; i < 120; i++) {
    let r;
    if (i === 30 || i === 31 || i === 70) r = w.feed(here, { raw: move(here, 450, -300), acc: 20 }); // teleports (Wi-Fi/multipath)
    else if (i === 40) r = w.feed(here, { acc: 2500 }); // approximate location
    else r = w.feed(here, { acc: 15 });
    if (!r.ok) reasons.push(r.reason);
    w.skip(5000);
  }
  const jumps = reasons.filter((x) => x === 'jump').length;
  assert.ok(jumps >= 3 && jumps <= 4, 'teleports rejected, at most one noisy fix too: ' + jumps);
  assert.ok(reasons.includes('approx'));
  assert.ok(w.tr.approx > 0);
  // filtered position stays close to the truth (raw noise σ ≈ 7.5 m)
  assert.ok(dist(w.tr.kf, here) < 10, 'filtered ' + dist(w.tr.kf, here).toFixed(1));
  // stale (cached) and out-of-order fixes
  const tr = newTracker();
  assert.equal(addFix(tr, { ...here, acc: 10, t: T0 - 5 * 60e3 }, T0).reason, 'stale');
  assert.ok(addFix(tr, { ...here, acc: 10, t: T0 }, T0).ok);
  assert.equal(addFix(tr, { ...here, acc: 10, t: T0 - 1000 }, T0 + 1000).reason, 'old');
  assert.equal(addFix(tr, { ...here, acc: 300, t: T0 + 2000 }, T0 + 2000).reason, 'acc');
});

test('re-anchor: a wrong first fix is replaced once 3 agreeing fixes over ≥ 20 s say otherwise', () => {
  const w = world();
  const truth = move(cobra, 0, -100);
  w.feed(truth, { raw: move(truth, 500, 0), acc: 40 }); // a bad Wi-Fi first fix
  w.skip(5000);
  for (let i = 0; i < 8; i++) { w.feed(truth, { acc: 10 }); w.skip(8000); }
  assert.ok(dist(w.tr.kf, truth) < 20, 'moved to truth: ' + dist(w.tr.kf, truth).toFixed(0));
});

test('queue → ride → leave: queue at arrival, board on high speed, done after leaving', () => {
  const w = world({ target: { a: cobra, setAt: T0, wait: 20 } });
  const start = move(cobra, -300, 0);
  w.walk(start, move(cobra, -20, 0));
  const arrived = w.now();
  w.stay(move(cobra, -10, 5), 18 * 60, { acc: 14 }); // creeping in the queue
  for (let i = 0; i < 4; i++) { w.feed(cobra, { speed: 15, acc: 20 }); w.skip(4000); } // on the coaster
  w.stay(move(cobra, 10, -10), 60);
  w.walk(cobra, move(cobra, 250, 120));
  assert.deepEqual(w.types(), ['queue', 'board', 'done']);
  const q = w.events[0];
  assert.ok(Math.abs(q.at - arrived) < 90e3, 'queue time ≈ arrival');
});

test('walk-on ride: arrive, ride, leave after ~4 min → done (not "left the queue")', () => {
  const w = world({ target: { a: kids, setAt: T0, wait: 5 } });
  w.walk(move(kids, -200, 0), kids);
  w.stay(kids, 4 * 60, { acc: 10 });
  w.walk(kids, move(kids, 0, 300));
  assert.deepEqual(w.types(), ['queue', 'done']);
});

test('passing by the target ride does nothing; giving up the queue → unqueue', () => {
  const w = world({ target: { a: cobra, setAt: T0, wait: 20 } });
  w.walk(move(cobra, -250, 0), move(cobra, 250, 0));
  assert.deepEqual(w.types(), []);
  // left after a few minutes of a 20-min queue: could be done (posted waits run high) or given up → ask
  const g = world({ target: { a: cobra, setAt: T0, wait: 20 } });
  g.walk(move(cobra, -200, 0), cobra);
  g.stay(cobra, 4 * 60);
  g.walk(cobra, move(cobra, 0, 350));
  assert.deepEqual(g.types(), ['queue', 'ask-done']);
  // queued, then gone again within a minute or so → left the queue
  const u = world({ target: { a: kids, setAt: T0, wait: 30 } });
  u.feed(move(kids, -300, 0)); u.skip(5000);
  u.walk(move(kids, -40, 0), kids);
  u.stay(kids, 170, { acc: 8 });
  u.walk(kids, move(kids, 300, 0));
  assert.deepEqual(u.types(), ['queue', 'unqueue']);
});

test('app closed in the queue, reopened far away → done (estimated time), right away', () => {
  const w = world({ target: { a: cobra, setAt: T0, wait: 25 } });
  w.walk(move(cobra, -150, 0), cobra);
  w.stay(cobra, 5 * 60);
  assert.deepEqual(w.types(), ['queue']);
  const qAt = w.events[0].at;
  w.skip(50 * 60e3); // pocket, screen off: no fixes
  w.feed(move(cobra, 300, 250), { acc: 12 });
  assert.deepEqual(w.types(), ['queue', 'done']);
  const d = w.events[1];
  assert.ok(d.gap);
  assert.ok(d.at >= qAt + 25 * 60e3 && d.at <= w.now(), 'done ≈ queue start + wait + ride');
});

test('closed before arriving, back much later elsewhere → ask, do not guess', () => {
  const w = world({ target: { a: cobra, setAt: T0, wait: 20 } });
  w.walk(move(cobra, -400, 0), move(cobra, -250, 0));
  w.skip(40 * 60e3);
  w.feed(move(cobra, -600, 300), { acc: 10 });
  assert.deepEqual(w.types(), ['ask-done']);
});

test('sitting at a restaurant at lunch → ate; sitting elsewhere → pause; neither while queueing at the target', () => {
  const food = FOOD.find((f) => f.seat && !f.approx);
  const w = world({ foods: FOOD, mealTime: true });
  w.walk(move(food, -150, 0), food);
  w.stay(move(food, 5, 5), 17 * 60, { step: 10 });
  assert.deepEqual(w.types(), ['ate']);
  assert.equal(w.events[0].where, food.name);
  const far = ATTRACTIONS.map((a) => a).sort((a, b) => dist(b, ENTRANCE) - dist(a, ENTRANCE))[0];
  const spot = move(far, 0, 60);
  const nearFood = FOOD.some((f) => dist(f, spot) < 100);
  const p = world({ foods: nearFood ? [] : FOOD, mealTime: false });
  p.stay(spot, 14 * 60, { step: 10 });
  assert.deepEqual(p.types(), ['pause']);
  const q = world({ target: { a: cobra, setAt: T0, wait: 45 }, foods: FOOD, mealTime: true });
  q.stay(cobra, 30 * 60, { step: 10 });
  assert.deepEqual(q.types(), ['queue']);
});

test('car: driving then walking near the entrance saves the spot; a coaster inside the park does not', () => {
  const lot = move(ENTRANCE, -250, 180);
  const w = world({ inPark: () => false });
  w.walk(move(lot, -1500, 0), lot, { speed: 12 }); // the walk helper is slow, but the phone says 12 m/s
  w.stay(lot, 40, { speed: 0 });
  w.walk(lot, ENTRANCE, { speed: 1.2 });
  assert.ok(w.types().includes('car'));
  const car = w.events.find((e) => e.type === 'car');
  assert.ok(dist(car, lot) < 40, 'car spot ' + dist(car, lot).toFixed(0) + ' m from the real spot');
  const c = world({ inPark: () => true });
  for (let i = 0; i < 5; i++) { c.feed(cobra, { speed: 18, acc: 15 }); c.skip(3000); }
  c.stay(move(cobra, 30, 0), 60);
  assert.ok(!c.types().includes('car'));
});

test('"not in the park" needs 3 far fixes over a minute; back after 2 near ones', () => {
  const home = newTracker();
  const far = move(ENTRANCE, 4000, 0);
  assert.equal(farState(home, { ...far, t: T0 }, ENTRANCE), true, 'at home: far at once');
  const tr = newTracker();
  assert.equal(farState(tr, { ...ENTRANCE, t: T0 - 5000 }, ENTRANCE), false);
  assert.equal(farState(tr, { ...far, t: T0 }, ENTRANCE), false);
  assert.equal(farState(tr, { ...ENTRANCE, t: T0 + 5000 }, ENTRANCE), false);
  assert.equal(farState(tr, { ...far, t: T0 + 10e3 }, ENTRANCE), false);
  assert.equal(farState(tr, { ...far, t: T0 + 40e3 }, ENTRANCE), false);
  assert.equal(farState(tr, { ...far, t: T0 + 75e3 }, ENTRANCE), true);
  assert.equal(farState(tr, { ...ENTRANCE, t: T0 + 80e3 }, ENTRANCE), true);
  assert.equal(farState(tr, { ...ENTRANCE, t: T0 + 85e3 }, ENTRANCE), false);
  assert.ok(LIMITS.maxAcc <= 100);
});

test('fuzz: 200 random walks with teleports (also into the target area) never fake a queue, ride or meal', () => {
  for (let k = 0; k < 200; k++) {
    seed = 1000 + k;
    const target = ATTRACTIONS[k % ATTRACTIONS.length];
    const w = world({ target: { a: target, setAt: T0, wait: 15 }, foods: FOOD, mealTime: true });
    // walk a random route that stays ≥ 250 m from the target, with teleports landing right on the target
    const ang = rnd() * Math.PI * 2;
    let p = move(target, Math.cos(ang) * 300, Math.sin(ang) * 300);
    for (let i = 0; i < 150; i++) {
      const out = rnd() < 0.08;
      const acc = 5 + rnd() * 40;
      w.feed(p, out ? { raw: move(target, gauss() * 10, gauss() * 10), acc: 10 + rnd() * 20 } : { acc, speed: rnd() < 0.2 ? null : 1.1 });
      w.skip(4000 + rnd() * 8000);
      const away = move(target, Math.cos(ang + i / 40) * 300, Math.sin(ang + i / 40) * 300);
      p = { lat: (p.lat + away.lat) / 2, lon: (p.lon + away.lon) / 2 };
    }
    const bad = w.types().filter((t) => t === 'queue' || t === 'board' || t === 'done' || t === 'ate');
    assert.deepEqual(bad, [], `seed ${1000 + k}, target ${target.name}`);
  }
});

test('fuzz: 60 real queue → ride → leave days with noise and teleports are still recognised', () => {
  let ok = 0;
  for (let k = 0; k < 60; k++) {
    seed = 5000 + k;
    const a = ATTRACTIONS.filter((x) => x.cat !== 'kids')[k % 20];
    const w = world({ target: { a, setAt: T0, wait: 25 } });
    const ang = rnd() * Math.PI * 2;
    w.walk(move(a, Math.cos(ang) * 300, Math.sin(ang) * 300), move(a, Math.cos(ang) * 20, Math.sin(ang) * 20), { acc: 15 });
    for (let i = 0; i < 20 * 60 / 6; i++) { // 20 min in the queue, fixes every ~6 s, 8% teleports
      const out = rnd() < 0.08;
      w.feed(move(a, gauss() * 8, gauss() * 8), out ? { raw: move(a, 300 * gauss(), 300 * gauss()), acc: 20 } : { acc: 8 + rnd() * 25 });
      w.skip(6000);
    }
    w.walk(a, move(a, -Math.cos(ang) * 350, -Math.sin(ang) * 350), { acc: 15 });
    const t = w.types();
    if (t[0] === 'queue' && t.includes('done')) ok++;
  }
  assert.ok(ok >= 57, `recognised ${ok}/60`);
});

// Kilometres walked: the counter on the cleaned track (activity.js), how the family state keeps it (family.js) and the
// per-person result for the Wrapped (wrapdata.js: measured, or estimated along the rides and photos)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newTracker, addFix, freshTracker, walkAdd, dayKey } from '../public/activity.js';
import { apply, newFamily } from '../public/family.js';
import { walkStats } from '../public/wrapdata.js';
import { ATTRACTIONS, ENTRANCE } from '../public/data.js';
import { DEFAULT_PEOPLE, distM } from '../public/logic.js';

const T0 = Date.UTC(2026, 10, 7, 10, 0, 0); // 11:00 in Brussels
const move = (p, dx, dy) => ({ lat: p.lat + dy / 111194, lon: p.lon + dx / (111194 * Math.cos((p.lat * Math.PI) / 180)) });
const ride = (n) => ATTRACTIONS.find((a) => a.name === n);

test('walkAdd: walking counts, wobble in a queue and coasters/cars do not', () => {
  const tr = newTracker();
  let p = ENTRANCE;
  // 300 m east at 1.2 m/s, a fix every 5 s
  for (let i = 0; i <= 50; i++) { walkAdd(tr, { ...move(p, i * 6, 0), acc: 5, t: T0 + i * 5e3 }); }
  assert.ok(Math.abs(tr.walk.m - 300) <= 15, `walked ${tr.walk.m}`);
  p = move(p, 300, 0);
  // 40 min in a queue with ±8 m wobble: nothing
  const before = tr.walk.m;
  for (let i = 1; i <= 480; i++) walkAdd(tr, { ...move(p, (i % 3) * 4 - 4, (i % 5) * 3 - 6), acc: 8, t: T0 + 250e3 + i * 5e3 });
  assert.ok(tr.walk.m - before <= 20, `queue ${tr.walk.m - before}`); // at most the last step (the counted point lags ≤ 15 m)
  const inQueue = tr.walk.m;
  // a coaster: 600 m in 60 s (10 m/s): nothing
  const t1 = T0 + 250e3 + 481 * 5e3;
  for (let i = 1; i <= 12; i++) walkAdd(tr, { ...move(p, 0, i * 50), acc: 10, t: t1 + i * 5e3 });
  assert.equal(tr.walk.m, inQueue);
  // app closed 20 min, then 400 m further: straight line × 1.3
  const t2 = t1 + 60e3 + 20 * 60e3;
  walkAdd(tr, { ...move(p, 400, 600), acc: 10, t: t2 });
  assert.ok(Math.abs(tr.walk.m - inQueue - 520) <= 2, `after gap ${tr.walk.m - inQueue}`);
  assert.equal(tr.walk.day, '2026-11-07');
  // a new day starts at 0
  walkAdd(tr, { ...move(p, 500, 600), acc: 10, t: T0 + 24 * 3600e3 });
  assert.deepEqual([tr.walk.day, tr.walk.m], ['2026-11-08', 0]);
});

test('addFix feeds the counter; freshTracker keeps it', () => {
  const tr = newTracker();
  for (let i = 0; i <= 60; i++) { const t = T0 + i * 4e3; addFix(tr, { ...move(ENTRANCE, -i * 5, 0), acc: 6, t }, t); }
  assert.ok(tr.walk.m >= 270 && tr.walk.m <= 310, `walked ${tr.walk.m}`);
  const fresh = freshTracker(tr, T0 + 8 * 3600e3); // stale tracker: history dropped, today's metres kept
  assert.deepEqual(fresh.hist, []); assert.equal(fresh.walk.m, tr.walk.m);
  assert.equal(dayKey(Date.UTC(2026, 10, 7, 23, 30)), '2026-11-08'); // Brussels midnight
});

test('family pos: metres per phone and source, never lowered within a day, a new day replaces', () => {
  let f = newFamily(T0);
  const pos = (m, day, extra = {}) => ({ type: 'pos', device: 'phoneaaa1', lat: ENTRANCE.lat, lon: ENTRANCE.lon, m, day, ...extra });
  f = apply(f, pos(1200, '2026-11-07'), T0);
  f = apply(f, pos(900, '2026-11-07'), T0 + 1000); // an older copy arriving late
  f = apply(f, pos(3000, '2026-11-07', { src: 'ot' }), T0 + 2000);
  assert.deepEqual(f.walked.phoneaaa1, { day: '2026-11-07', app: 1200, ot: 3000 });
  f = apply(f, pos(50, '2026-11-06'), T0 + 3000); // yesterday's count changes nothing
  assert.equal(f.walked.phoneaaa1.app, 1200);
  f = apply(f, pos(10, '2026-11-08'), T0 + 86400e3);
  assert.deepEqual(f.walked.phoneaaa1, { day: '2026-11-08', app: 10 });
  f = apply(f, pos(1e9, 'nope'), T0 + 86401e3); // no valid day: ignored
  assert.equal(f.walked.phoneaaa1.app, 10);
});

test('walkStats: estimate per person (split halves, photos), measured wins when larger', () => {
  const people = DEFAULT_PEOPLE.map((p, i) => ({ ...p, name: ['Pieter', 'Marjan', 'Louise', 'Ellie'][i] }));
  const NOW = T0 + 9 * 3600e3;
  const P = ride('Pulsar'), K = ride('Kondaa'), TT = ride('Tchou-Tchou Express');
  const fam = {
    me: { phonep1: 'p1', phonep2: 'p2' },
    walked: { phonep1: { day: '2026-11-07', app: 15000 }, phonep2: { day: '2026-11-07', app: 300 } },
    log: [{ t: T0 + 3600e3, ids: [P.id, TT.id] }, // old split entry: who rode what from the rules (pregnant / 95 cm → Tchou-Tchou)
      { t: T0 + 2 * 3600e3, ids: [K.id, TT.id], who: { [K.id]: ['p1', 'p3'], [TT.id]: ['p2', 'p4'] } }],
  };
  const album = [{ t: T0 + 3 * 3600e3, near: 'Calamity Mine', by: 'marjan.x@example.com' }];
  const w = walkStats({ fam, people, album, now: NOW, ended: true });
  const by = Object.fromEntries(w.map((x) => [x.name, x]));
  assert.equal(by.Pieter.how, 'gemeten'); assert.equal(by.Pieter.m, 15000);
  const S = (a, b) => distM(a, b) * 1.3;
  const route = (...ps) => ps.slice(1).reduce((s, p, i) => s + S(ps[i], p), 0);
  assert.equal(by.Marjan.how, 'geschat');
  assert.equal(by.Marjan.m, Math.round(route(ENTRANCE, TT, TT, ride('Calamity Mine'), ENTRANCE)));
  // children: their own rides, but at least the shortest adult walk (they are always with an adult)
  assert.equal(by.Louise.m, Math.max(Math.round(route(ENTRANCE, P, K, ENTRANCE)), by.Marjan.m));
  assert.equal(by.Ellie.m, by.Marjan.m); assert.equal(by.Ellie.how, 'geschat');
  assert.equal(w[0].name, 'Pieter'); // most first
  // this phone's own newer count overrides the family copy; not ended → no walk back
  const w2 = walkStats({ fam, people, album, now: NOW, local: { device: 'phonep2', walk: { day: '2026-11-07', m: 20000 } } });
  assert.equal(w2.find((x) => x.name === 'Marjan').m, 20000);
  assert.equal(w2.find((x) => x.name === 'Louise').m, 15000); // the shortest adult walk is now 15 km
  // opened after midnight: the evening still counts (the last 14 h), with that day's measured counts
  const late = walkStats({ fam, people, album, now: Date.UTC(2026, 10, 8, 0, 30), ended: true });
  assert.equal(late.find((x) => x.name === 'Pieter').m, 15000); assert.equal(late.length, 4);
  // nothing today → nobody
  assert.deepEqual(walkStats({ fam: { log: [] }, people, album: [], now: NOW }), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRide, riders, plans, splitGroups, DEFAULT_PEOPLE, decideNotifications, byId } from '../public/logic.js';
import { apply, newFamily } from '../public/family.js';
import { ATTRACTIONS } from '../public/data.js';

const find = (n) => ATTRACTIONS.find((a) => a.name === n);
const [adult, pregnant, big, toddler] = DEFAULT_PEOPLE;
const allOpen = (w = 5) => ({ rides: Object.fromEntries(ATTRACTIONS.map((a) => [a.id, { s: 'OPERATING', w }])) });

test('height and pregnancy rules', () => {
  assert.equal(canRide(big, find('Kondaa')), 'alone');
  assert.equal(canRide(toddler, find('Kondaa')), null);
  assert.equal(canRide(pregnant, find('Kondaa')), null);
  assert.equal(canRide(toddler, find('Tchou-Tchou Express')), 'adult');
  assert.equal(canRide(toddler, find('Calamity Mine')), null); // 100 cm with adult
  assert.equal(canRide(adult, find('Poneys')), null); // max 140
});

test('a toddler only rides with a riding adult', () => {
  const r = riders([pregnant, toddler], find('Tchou-Tchou Express')); // pregnant may ride this gentle train
  assert.deepEqual(r.ride.map((p) => p.id).sort(), ['p2', 'p4']);
  const r2 = riders([pregnant, toddler], find('Flash Back'));
  assert.equal(r2.ride.length, 0);
});

test('split groups: one adult with the big kid, the pregnant adult with the toddler', () => {
  const [g1, g2] = splitGroups(DEFAULT_PEOPLE);
  assert.deepEqual(g1.map((p) => p.id), ['p1', 'p3']);
  assert.deepEqual(g2.map((p) => p.id), ['p2', 'p4']);
});

test('plans never send someone on a ride they may not do, and skip closed rides', () => {
  const live = allOpen();
  live.rides[find('Kondaa').id] = { s: 'DOWN', w: 0 };
  const ps = plans({ people: DEFAULT_PEOPLE, favs: [], done: {}, live, walk: () => 200, month: 10 });
  assert.ok(ps.length > 5);
  for (const p of ps) for (const part of p.parts) {
    if (part.rest) continue;
    assert.notEqual(part.id, find('Kondaa').id);
    for (const id of part.ride) assert.ok(canRide(DEFAULT_PEOPLE.find((x) => x.id === id), byId[part.id]));
  }
});

test('done rides drop, favourites rise', () => {
  const live = allOpen();
  const base = { people: DEFAULT_PEOPLE, favs: [], live, walk: () => 200, month: 10 };
  const top = plans({ ...base, done: {} })[0];
  const again = plans({ ...base, done: { [top.parts[0].id]: 2 } })[0];
  assert.notEqual(again.parts[0].id, top.parts[0].id);
  const fav = find('Tiki-Waka').id;
  const withFav = plans({ ...base, done: {}, favs: [fav] });
  assert.ok(withFav.findIndex((p) => p.parts.some((x) => x.id === fav)) <= 5);
});

test('family actions are validated', () => {
  let f = newFamily(1);
  f = apply(f, { type: 'fav', id: find('Kondaa').id }, 2);
  assert.equal(f.favs.length, 1);
  f = apply(f, { type: 'done', ids: [find('Kondaa').id, 'nope'] }, 3);
  assert.equal(f.done[find('Kondaa').id], 1);
  assert.throws(() => apply(f, { type: 'fav', id: 'nope' }, 4));
  assert.throws(() => apply(f, { type: 'hack' }, 4));
  f = apply(f, { type: 'people', people: [{ id: 'p1', name: '<b>x</b>', kind: 'child', height: 9999, pregnant: true }] }, 5);
  assert.equal(f.people[0].height, 220);
  assert.equal(f.people[0].pregnant, false);
});

test('notifications: a stopped target ride is reported once', () => {
  const live = allOpen();
  const fam = { ...newFamily(0), positions: { dev12345678: { lat: 50.699, lon: 4.59, t: Date.now() } } };
  const k = find('Kondaa').id;
  const now = Date.now();
  fam.target = { plan: { type: 'together', parts: [{ id: k, group: ['p1'] }] }, setAt: now - 60e3 };
  live.rides[k] = { s: 'DOWN', w: 0 };
  const r1 = decideNotifications({ fam, deviceId: 'dev12345678', live, now, prefs: {}, memo: {} });
  assert.equal(r1.notes[0]?.tag, 'down');
  const r2 = decideNotifications({ fam, deviceId: 'dev12345678', live, now: now + 60e3, prefs: {}, memo: r1.memo });
  assert.ok(!r2.notes.some((n) => n.tag === 'down'));
});

test('notifications: a favourite that gets short', () => {
  const k = find('Kondaa').id;
  const fam = { ...newFamily(Date.now()), favs: [k], positions: { d1234567890: { lat: 50.699, lon: 4.59, t: Date.now() } } };
  const now = Date.now();
  const live = allOpen(); live.rides[k] = { s: 'OPERATING', w: 40 }; live.localTime = '2026-11-07T10:30:00Z';
  const r1 = decideNotifications({ fam, deviceId: 'd1234567890', live, now, prefs: { best: false }, memo: {} });
  live.rides[k] = { s: 'OPERATING', w: 10 };
  const r2 = decideNotifications({ fam, deviceId: 'd1234567890', live, now: now + 30 * 60e3, prefs: { best: false }, memo: r1.memo });
  assert.equal(r2.notes[0]?.tag, 'fav-' + k);
});

test('"short now, long later": morning queues get a bonus, peak-time queues a penalty', async () => {
  const { urgencyFactor, parkClock } = await import('../public/logic.js');
  const morning = { clock: { now: 10 * 60 + 15, close: 22 * 60 } }, peak = { clock: { now: 14 * 60 + 30, close: 22 * 60 } };
  assert.ok(urgencyFactor(10, morning) > 1.5, 'a 10-minute queue at 10:15 is a bargain');
  assert.ok(urgencyFactor(40, peak) < 1, 'a 40-minute queue at the peak is not');
  assert.equal(urgencyFactor(10, {}), 1, 'no clock: no effect');
  assert.equal(urgencyFactor(10, { clock: { now: 21 * 60 + 30, close: 22 * 60 } }), 1, 'last half hour: no effect');
  const c = parkClock({ localTime: '2026-11-07T10:30:00Z', minutesLeft: 690, t: 0 }, 0);
  assert.deepEqual(c, { now: 630, close: 1320 });
});

test('sunrise and sunset at Walibi (light theme by day, dark after sunset)', async () => {
  const { sunTimes, isDaylight } = await import('../public/logic.js');
  const hm = (d) => d.toLocaleTimeString('nl-BE', { timeZone: 'Europe/Brussels', hour: '2-digit', minute: '2-digit' });
  const near = (d, hhmm, tol = 6) => { const [h, m] = hhmm.split(':').map(Number); const [a, b] = hm(d).split(':').map(Number); return Math.abs((a * 60 + b) - (h * 60 + m)) <= tol; };
  const nov7 = sunTimes(new Date('2026-11-07T12:00:00+01:00'));
  assert.ok(near(nov7.rise, '07:45', 8), 'sunrise 7 Nov ≈ 07:45, got ' + hm(nov7.rise));
  assert.ok(near(nov7.set, '17:03', 8), 'sunset 7 Nov ≈ 17:03, got ' + hm(nov7.set));
  const dec21 = sunTimes(new Date('2026-12-21T12:00:00+01:00'));
  assert.ok(near(dec21.rise, '08:43') && near(dec21.set, '16:39'), 'winter solstice ≈ 08:43–16:39');
  const jun21 = sunTimes(new Date('2026-06-21T12:00:00+02:00'));
  assert.ok(near(jun21.set, '22:00'), 'sunset 21 Jun ≈ 22:00, got ' + hm(jun21.set));
  assert.equal(isDaylight(new Date('2026-11-07T14:00:00+01:00')), true);
  assert.equal(isDaylight(new Date('2026-11-07T17:30:00+01:00')), false);
  assert.equal(isDaylight(new Date('2026-11-07T07:00:00+01:00')), false);
});

test('waitFactor: median of measured/posted, from 2 samples, clamped to 0.5–1.3', async () => {
  const { waitFactor } = await import('../public/logic.js');
  const now = Date.UTC(2026, 10, 7, 14);
  const s = (w, m, ago = 60) => ({ w, m, t: now - ago * 60e3 });
  assert.equal(waitFactor([], now), 1);
  assert.equal(waitFactor([s(20, 10)], now), 1); // one sample isn't enough
  assert.equal(waitFactor([s(20, 10), s(30, 21), s(10, 8)], now), 0.7);
  assert.equal(waitFactor([s(20, 2), s(20, 3)], now), 0.5);
  assert.equal(waitFactor([s(10, 40), s(10, 40)], now), 1.3);
  assert.equal(waitFactor([s(3, 10), s(2, 10)], now), 1); // tiny posted waits say nothing
  assert.equal(waitFactor([s(20, 10, 13 * 60), s(20, 10, 13 * 60)], now), 1); // yesterday's
});

test('ratings steer repeats: 😍 makes a done ride come back sooner, 😬 keeps it away', async () => {
  const { plans, DEFAULT_PEOPLE } = await import('../public/logic.js');
  const { ATTRACTIONS } = await import('../public/data.js');
  const live = { rides: Object.fromEntries(ATTRACTIONS.map((a) => [a.id, { s: 'OPERATING', w: 10 }])) };
  const base = { people: DEFAULT_PEOPLE, favs: [], live, walk: () => 200, month: 10 };
  const top = (ctx) => plans(ctx)[0].parts[0].id;
  const first = top({ ...base, done: {} });
  const love = Object.fromEntries(DEFAULT_PEOPLE.map((p) => [p.id, 3]));
  const hate = Object.fromEntries(DEFAULT_PEOPLE.map((p) => [p.id, 1]));
  const score = (rates) => plans({ ...base, done: { [first]: 1 }, rates: { [first]: rates } }).find((p) => p.parts.some((x) => x.id === first))?.score ?? 0;
  assert.ok(score(love) > score({}), 'loved ride scores higher than unrated');
  assert.ok(score(hate) < score({}), 'disliked ride scores lower');
});

test('round 1: rides missing from the feed are open while the park is (kids rides get suggested); "Is dicht" removes them', async () => {
  const { plans, status, DEFAULT_PEOPLE, markedClosed } = await import('../public/logic.js');
  const { ATTRACTIONS } = await import('../public/data.js');
  const now = Date.UTC(2026, 10, 7, 12);
  // like the real feed: only the big rides are reported
  const reported = ATTRACTIONS.filter((a) => a.cat !== 'kids').slice(0, 16);
  const live = { t: now, open: now - 3 * 3600e3, close: now + 6 * 3600e3, rides: Object.fromEntries(reported.map((a) => [a.id, { s: 'OPERATING', w: 25 }])) };
  const kid = ATTRACTIONS.find((a) => a.cat === 'kids' && !live.rides[a.id]);
  assert.deepEqual(status(live, kid.id), { open: true, wait: null, known: false, s: 'ASSUMED', assumed: true });
  assert.equal(status({ ...live, t: now + 7 * 3600e3 }, kid.id).open, false, 'after closing: not assumed open');
  const ps = plans({ people: DEFAULT_PEOPLE, favs: [], done: {}, live, walk: () => 150, month: 10, now });
  const kidsSuggested = ps.some((p) => p.parts.some((pt) => byIdCat(pt.id) === 'kids'));
  function byIdCat(id) { return ATTRACTIONS.find((a) => a.id === id)?.cat; }
  assert.ok(kidsSuggested, 'a kids ride is suggested for the toddler');
  const closed = Object.fromEntries(ATTRACTIONS.filter((a) => a.cat === 'kids').map((a) => [a.id, now - 60e3]));
  const ps2 = plans({ people: DEFAULT_PEOPLE, favs: [], done: {}, live, walk: () => 150, month: 10, now, closed });
  assert.ok(!ps2.some((p) => p.parts.some((pt) => byIdCat(pt.id) === 'kids')), 'marked closed: never suggested');
  assert.equal(markedClosed(closed, kid.id, now + 13 * 3600e3), false, 'a closed mark lasts the day');
});

test('round 1: notifications never invent a wait, skip the chosen plan, and see CLOSED-after-running as a breakdown', async () => {
  const { decideNotifications, describe, DEFAULT_PEOPLE } = await import('../public/logic.js');
  const { ATTRACTIONS } = await import('../public/data.js');
  const { newFamily } = await import('../public/family.js');
  const NOW = Date.UTC(2026, 10, 7, 13);
  const k = ATTRACTIONS.find((a) => a.name === 'Kondaa');
  const unknown = { type: 'together', key: k.id, parts: [{ group: ['p1'], id: k.id, wait: 10, waitKnown: false }] };
  assert.match(describe(unknown, DEFAULT_PEOPLE), /wachttijd onbekend/);
  const DEV = 'dev12345678';
  const fam = { ...newFamily(NOW - 5 * 3600e3), positions: { [DEV]: { lat: 50.699, lon: 4.59, t: NOW } }, ate: NOW - 10 * 60e3, pause: NOW - 10 * 60e3 };
  const allNull = { rides: Object.fromEntries(ATTRACTIONS.map((a) => [a.id, { s: 'OPERATING', w: null }])), localTime: '2026-11-07T14:00:00Z', open: NOW - 3600e3, close: NOW + 8 * 3600e3, minutesLeft: 480, t: NOW };
  const prefs = { best: true, fav: false, food: false, down: true };
  assert.ok(!decideNotifications({ fam, deviceId: DEV, live: allNull, now: NOW, prefs, memo: {} }).notes.some((n) => n.tag === 'best'), 'no "Nu ideaal" with unknown waits');
  // the target ride was running, now CLOSED mid-day → breakdown alert
  const plan = { type: 'together', key: k.id, score: 1, minutes: 10, parts: [{ group: ['p1'], id: k.id, ride: ['p1'], watch: [], escorted: [], walkM: 100, wait: 5, waitKnown: true, minutes: 10 }] };
  const f2 = { ...fam, target: { plan, setAt: NOW - 10 * 60e3 } };
  const run = { ...allNull, rides: { ...allNull.rides, [k.id]: { s: 'OPERATING', w: 10 } } };
  const r1 = decideNotifications({ fam: f2, deviceId: DEV, live: run, now: NOW - 60e3, prefs, memo: {} });
  const r2 = decideNotifications({ fam: f2, deviceId: DEV, live: { ...run, rides: { ...run.rides, [k.id]: { s: 'CLOSED', w: null } } }, now: NOW, prefs, memo: r1.memo });
  assert.ok(r2.notes.some((n) => n.tag === 'down'), 'CLOSED after running = breakdown');
});

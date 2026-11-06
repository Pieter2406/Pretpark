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
  fam.target = { plan: { type: 'together', parts: [{ id: k, group: ['p1'] }] }, setAt: 1 };
  live.rides[k] = { s: 'DOWN', w: 0 };
  const now = Date.now();
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

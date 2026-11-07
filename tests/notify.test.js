// Notification decisions: no rest reminder right after opening, "ligt stil" only for a fresh target that broke
// down, and the cron's "is the park open" check when the schedule is unknown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideNotifications, parkOpen, DEFAULT_PEOPLE } from '../public/logic.js';
import { newFamily } from '../public/family.js';
import { ATTRACTIONS } from '../public/data.js';

const k = ATTRACTIONS.find((a) => a.name === 'Kondaa').id;
const allOpen = (w = 5) => ({ rides: Object.fromEntries(ATTRACTIONS.map((a) => [a.id, { s: 'OPERATING', w }])) });
const DEV = 'dev12345678';
const NOW = Date.UTC(2026, 10, 7, 13, 0, 0); // 14:00 in Brussels: not a meal time
const LOCAL = '2026-11-07T14:00:00Z';
const famAt = (created, extra = {}) => ({ ...newFamily(created), positions: { [DEV]: { lat: 50.699, lon: 4.59, t: NOW } }, ...extra });
const decide = (fam, live, prefs = { best: false, fav: false }) => decideNotifications({ fam, deviceId: DEV, live, now: NOW, prefs, memo: {} });

test('rest reminder: not right after opening, yes after 100 min on your feet', () => {
  const live = { ...allOpen(), localTime: LOCAL };
  const fam = famAt(NOW - 5 * 3600e3); // family made days/hours before
  assert.ok(DEFAULT_PEOPLE.some((p) => p.pregnant));
  // park opened 30 min ago: no pause reminder
  assert.ok(!decide(fam, { ...live, open: NOW - 30 * 60e3 }).notes.some((n) => n.tag === 'pause'));
  // park opened 2 h ago, no meal/pause since: reminder
  assert.ok(decide(fam, { ...live, open: NOW - 2 * 3600e3 }).notes.some((n) => n.tag === 'pause'));
  // a recent pause counts too
  assert.ok(!decide({ ...fam, pause: NOW - 20 * 60e3 }, { ...live, open: NOW - 2 * 3600e3 }).notes.some((n) => n.tag === 'pause'));
  // unknown schedule: counted from the first ride done today; nothing done yet → no reminder
  assert.ok(!decide(fam, { ...live, open: null }).notes.some((n) => n.tag === 'pause'));
  assert.ok(decide({ ...fam, log: [{ t: NOW - 2 * 3600e3, ids: [k] }] }, { ...live, open: null }).notes.some((n) => n.tag === 'pause'));
});

test('"ligt stil": only for DOWN, and only while the target is younger than 90 min', () => {
  const plan = { type: 'together', key: k, parts: [{ id: k, group: ['p1', 'p3'] }] };
  const prefs = { best: false, fav: false, food: false };
  const down = (s, age) => {
    const live = { ...allOpen(), localTime: LOCAL, open: NOW - 3600e3 };
    live.rides[k] = { s, w: null };
    const fam = famAt(NOW - 3600e3, { target: { plan, setAt: NOW - age } });
    return decide(fam, live, prefs).notes.some((n) => n.tag === 'down');
  };
  assert.equal(down('DOWN', 10 * 60e3), true);
  assert.equal(down('CLOSED', 10 * 60e3), false);
  assert.equal(down('REFURBISHMENT', 10 * 60e3), false);
  assert.equal(down('OPERATING', 10 * 60e3), false);
  assert.equal(down('DOWN', 89 * 60e3), true);
  assert.equal(down('DOWN', 91 * 60e3), false);
  // missing from live data (unknown) is no breakdown either
  const live = { ...allOpen(), localTime: LOCAL }; delete live.rides[k];
  assert.ok(!decide(famAt(NOW - 3600e3, { target: { plan, setAt: NOW - 60e3 } }), live, prefs).notes.some((n) => n.tag === 'down'));
});

test('cron: park open by schedule window, or (schedule unknown) by a running ride', () => {
  const open = NOW - 3 * 3600e3, close = NOW + 3 * 3600e3;
  assert.equal(parkOpen({ ...allOpen(), open, close }, NOW), true);
  assert.equal(parkOpen({ ...allOpen(), open, close }, open - 10 * 60e3), true);
  assert.equal(parkOpen({ ...allOpen(), open, close }, open - 20 * 60e3), false);
  assert.equal(parkOpen({ ...allOpen(), open, close }, close + 20 * 60e3), false);
  assert.equal(parkOpen({ rides: {}, open, close }, NOW), true, 'the schedule decides when known');
  // unknown schedule
  assert.equal(parkOpen({ ...allOpen(), open: null, close: null }, NOW), true);
  const closed = { rides: Object.fromEntries(ATTRACTIONS.map((a) => [a.id, { s: 'CLOSED', w: null }])), open: null, close: null };
  assert.equal(parkOpen(closed, NOW), false);
  closed.rides[k] = { s: 'OPERATING', w: 5 };
  assert.equal(parkOpen(closed, NOW), true);
  assert.equal(parkOpen(null, NOW), false);
  assert.equal(parkOpen({ open: null }, NOW), false);
});

test('"Nu ideaal": not while the family stands in a queue', () => {
  const live = { ...allOpen(5), localTime: LOCAL, open: NOW - 2 * 3600e3 };
  const plan = { type: 'together', key: k, score: 1, minutes: 10, parts: [{ group: ['p1'], id: k, ride: ['p1'], watch: [], escorted: [], walkM: 100, wait: 5, waitKnown: true, minutes: 10 }] };
  const prefs = { best: true, fav: false, food: false, pause: false, rest: false, close: false };
  const fam = famAt(NOW - 5 * 3600e3, { ate: NOW - 10 * 60e3, pause: NOW - 10 * 60e3, target: { plan, setAt: NOW - 50 * 60e3 } });
  assert.ok(decide(fam, live, prefs).notes.some((n) => n.tag === 'best'), 'old target, not queued: suggest');
  const queued = { ...fam, target: { ...fam.target, q: { 0: { t: NOW - 40 * 60e3, w: 45, g: {} } } } };
  assert.ok(!decide(queued, live, prefs).notes.some((n) => n.tag === 'best'), 'in the queue: quiet');
  const oldClient = { ...fam, target: { ...fam.target, queued: NOW - 40 * 60e3 } };
  assert.ok(!decide(oldClient, live, prefs).notes.some((n) => n.tag === 'best'), 'old client in the queue: quiet');
});

test('diaper check: near a toilet, ≥ 90 min since the last check, only the phone with the toddler', async () => {
  const { TOILETS } = await import('../worker/owntracks.js');
  const wc = TOILETS[0];
  const live = { ...allOpen(), localTime: LOCAL, open: NOW - 3 * 3600e3, close: NOW + 6 * 3600e3, minutesLeft: 360 };
  const at = { lat: wc.lat + 0.0002, lon: wc.lon }; // ~22 m
  const base = { ...newFamily(NOW - 5 * 3600e3), positions: { [DEV]: { ...at, t: NOW } }, ate: NOW - 20 * 60e3, pause: NOW - 20 * 60e3 };
  const prefs = { best: false, fav: false, food: false, down: false };
  const d = (fam, p = prefs, memo = {}) => decideNotifications({ fam, deviceId: DEV, live, now: NOW, prefs: p, memo, toilets: TOILETS });
  const r = d(base);
  assert.ok(r.notes.some((n) => n.tag === 'diaper' && /luier/.test(n.body)), 'due + near a toilet');
  assert.ok(!d({ ...base, diaper: NOW - 30 * 60e3 }).notes.some((n) => n.tag === 'diaper'), 'checked 30 min ago');
  assert.ok(!d({ ...base, positions: { [DEV]: { lat: wc.lat + 0.003, lon: wc.lon, t: NOW } } }).notes.some((n) => n.tag === 'diaper'), 'far from a toilet');
  assert.ok(!d(base, { ...prefs, diaper: false }).notes.some((n) => n.tag === 'diaper'), 'switched off');
  assert.ok(!d(base, prefs, r.memo).notes.some((n) => n.tag === 'diaper'), 'not again within 45 min');
  // a split: the toddler (p4) is with p2; this phone is p1 → nothing
  const plan = { type: 'split', key: 'x', meet: ATTRACTIONS[0].id, parts: [{ group: ['p1', 'p3'], id: ATTRACTIONS[0].id }, { group: ['p2', 'p4'], rest: true }] };
  assert.ok(!d({ ...base, me: { [DEV]: 'p1' }, target: { plan, setAt: NOW - 60e3 } }).notes.some((n) => n.tag === 'diaper'), 'not the toddler\'s phone');
  assert.ok(d({ ...base, me: { [DEV]: 'p2' }, target: { plan, setAt: NOW - 60e3 } }).notes.some((n) => n.tag === 'diaper'), 'the toddler\'s phone');
});

test('rest reminder: a family arriving 2 h after opening is not told to sit down on arrival', () => {
  const live = { ...allOpen(), localTime: LOCAL, open: NOW - 3 * 3600e3 };
  const fam = famAt(NOW - 3 * 3600e3, { log: [{ t: NOW - 30 * 60e3, ids: [k] }] }); // first ride 30 min ago
  assert.ok(!decide(fam, live).notes.some((n) => n.tag === 'pause'));
});

test('diaper push: only on a recent position (not one from before the app was closed)', () => {
  const live = { ...allOpen(), localTime: LOCAL, open: NOW - 3 * 3600e3 };
  const wc = { lat: 50.70157, lon: 4.5936 };
  const at = (age) => famAt(NOW - 3 * 3600e3, { positions: { dev1: { lat: wc.lat + 10 / 111194, lon: wc.lon, t: NOW - age } } });
  const tag = (f) => decideNotifications({ fam: f, deviceId: 'dev1', live, now: NOW, prefs: { best: false, fav: false, food: false }, memo: {}, toilets: [wc] }).notes.map((n) => n.tag);
  assert.ok(tag(at(60e3)).includes('diaper'));
  assert.ok(!tag(at(40 * 60e3)).includes('diaper'));
});

test('"ligt stil": a split with both rides stopped tells each once, not alternating every minute', () => {
  const k2 = ATTRACTIONS.find((a) => a.name !== 'Kondaa' && a.cat === 'family').id;
  const plan = { type: 'split', key: k + k2, parts: [{ id: k, group: ['p1', 'p3'] }, { id: k2, group: ['p2', 'p4'] }] };
  const live = { ...allOpen(), localTime: LOCAL, open: NOW - 3600e3 };
  live.rides[k] = { s: 'DOWN', w: null }; live.rides[k2] = { s: 'DOWN', w: null };
  const fam = famAt(NOW - 3600e3, { target: { plan, setAt: NOW - 10 * 60e3 } });
  let memo = {}, tags = [];
  for (let i = 0; i < 6; i++) {
    const r = decideNotifications({ fam, deviceId: DEV, live, now: NOW + i * 60e3, prefs: { best: false, fav: false, food: false }, memo });
    memo = r.memo; tags.push(...r.notes.map((n) => n.title));
  }
  assert.equal(tags.filter((t) => /ligt stil/.test(t)).length, 2);
});

test('favourite: not for the ride we are heading to, and at most once an hour', () => {
  const live = (w) => { const l = { ...allOpen(30), localTime: LOCAL, open: NOW - 3600e3 }; l.rides[k] = { s: 'OPERATING', w }; return l; };
  const prefs = { best: false, fav: true, food: false };
  const run = (fam) => { let memo = {}, n = 0; const seq = [30, 5, 25, 5]; seq.forEach((w, i) => { const r = decideNotifications({ fam, deviceId: DEV, live: live(w), now: NOW + i * 10 * 60e3, prefs, memo }); memo = r.memo; n += r.notes.filter((x) => x.tag === 'fav-' + k).length; }); return n; };
  assert.equal(run(famAt(NOW - 3600e3, { favs: [k] })), 1);
  const plan = { type: 'together', key: k, parts: [{ id: k, group: ['p1', 'p2', 'p3', 'p4'] }] };
  assert.equal(run(famAt(NOW - 3600e3, { favs: [k], target: { plan, setAt: NOW - 5 * 60e3 } })), 0);
});

test('went home early: no park tips when the phone is far from Walibi', () => {
  const live = { ...allOpen(), localTime: LOCAL, open: NOW - 5 * 3600e3 };
  const home = famAt(NOW - 6 * 3600e3, { positions: { [DEV]: { lat: 51.05, lon: 3.72, t: NOW - 20 * 60e3 } } });
  assert.deepEqual(decide(home, live, { best: true, fav: true }).notes, []);
  assert.ok(decide(famAt(NOW - 6 * 3600e3), live).notes.some((n) => n.tag === 'pause'));
});

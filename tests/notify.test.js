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
  // unknown schedule: falls back to the family's own times
  assert.ok(decide(fam, { ...live, open: null }).notes.some((n) => n.tag === 'pause'));
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
});

// OwnTracks payload parsing and the event → action mapping (split safety).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { otFixes, okToken, newToken, actionsFor, inPark } from '../worker/owntracks.js';
import { ATTRACTIONS, ENTRANCE } from '../public/data.js';

const NOW = Date.UTC(2026, 10, 7, 11);
test('otFixes: locations only, valid, today, sorted; km/h → m/s; accuracy missing = 999', () => {
  const t = Math.round(NOW / 1000);
  const f = otFixes(JSON.stringify([
    { _type: 'location', lat: 50.7, lon: 4.59, acc: 9, tst: t - 10, vel: 36, batt: 50 },
    { _type: 'location', lat: 50.71, lon: 4.6, tst: t - 20 },
    { _type: 'location', lat: 91, lon: 4.6, tst: t },
    { _type: 'location', lat: 50.7, lon: 4.59, tst: t - 13 * 3600 },
    { _type: 'location', lat: 50.7, lon: 4.59, tst: t + 3600 },
    { _type: 'waypoint' }, null, 5,
  ]), NOW);
  assert.equal(f.length, 2);
  assert.ok(f[0].t < f[1].t);
  assert.equal(f[0].acc, 999);
  assert.equal(f[1].speed, 10);
  assert.deepEqual(otFixes('{"_type":"location","lat":50.7,"lon":4.59,"tst":' + t + '}', NOW).length, 1);
  assert.deepEqual(otFixes('nope', NOW), []);
  assert.ok(okToken(newToken())); assert.ok(!okToken('short'));
  assert.ok(inPark(ATTRACTIONS[0])); assert.ok(!inPark({ lat: ENTRANCE.lat + 0.01, lon: ENTRANCE.lon }));
});

test('actionsFor: done in a split only says "ready" while the other half is busy; together it is done with target', () => {
  const a = ATTRACTIONS[0], b = ATTRACTIONS[1];
  const split = { type: 'split', meet: a.id, parts: [{ group: ['p1', 'p3'], id: a.id }, { group: ['p2', 'p4'], id: b.id }] };
  const T = { i: 0, plan: split, a, setAt: NOW - 3600e3 };
  const fam = { target: { plan: split, setAt: T.setAt } };
  const [x] = actionsFor({ type: 'done', at: NOW, key: 'k' }, T, fam, 'dev00000001');
  assert.equal(x.act.type, 'ready'); assert.equal(x.act.part, 0);
  assert.deepEqual(actionsFor({ type: 'done', at: NOW, key: 'k' }, T, { target: { ...fam.target, ready: { 0: NOW } } }, 'dev00000001'), []);
  const [y] = actionsFor({ type: 'done', at: NOW, key: 'k' }, T, { target: { ...fam.target, ready: { 1: NOW } } }, 'dev00000001');
  assert.equal(y.act.type, 'done'); assert.equal(y.act.target, T.setAt);
  const tg = { type: 'together', parts: [{ group: ['p1'], id: a.id }] };
  const [z] = actionsFor({ type: 'done', at: NOW, key: 'k' }, { i: 0, plan: tg, a, setAt: 1 }, { target: { plan: tg, setAt: 1 } }, 'dev00000001');
  assert.equal(z.act.type, 'done'); assert.deepEqual(z.act.ids, [a.id]);
  // aids are stable per device + event, valid for family.js
  const q1 = actionsFor({ type: 'queue', at: NOW, key: 'q:1' }, { ...T, wait: 10 }, fam, 'dev00000001')[0].act.aid;
  const q2 = actionsFor({ type: 'queue', at: NOW, key: 'q:1' }, { ...T, wait: 10 }, fam, 'dev00000001')[0].act.aid;
  assert.equal(q1, q2); assert.match(q1, /^[a-z0-9]{6,24}$/);
});

test('review fixes: newest 300 fixes; a split with an unknown person on this phone acts for nobody', async () => {
  const { targetFor } = await import('../worker/owntracks.js');
  const t = Math.round(NOW / 1000);
  const many = Array.from({ length: 700 }, (_, i) => ({ _type: 'location', lat: 50.7, lon: 4.59, acc: 5, tst: t - 700 + i }));
  const f = otFixes(JSON.stringify(many), NOW);
  assert.equal(f.length, 300);
  assert.equal(f.at(-1).t, (t - 1) * 1000);
  const a = ATTRACTIONS[0], b = ATTRACTIONS[1];
  const split = { type: 'split', meet: a.id, parts: [{ group: ['p1', 'p3'], id: a.id }, { group: ['p2', 'p4'], id: b.id }] };
  assert.equal(targetFor({ target: { plan: split, setAt: 1 }, me: { d1: 'p9' } }, 'd1', null), null);
  assert.equal(targetFor({ target: { plan: split, setAt: 1 }, me: {} }, 'd1', null), null);
  assert.equal(targetFor({ target: { plan: split, setAt: 1 }, me: { d1: 'p2' } }, 'd1', null).i, 1);
});

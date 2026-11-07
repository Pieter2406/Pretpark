// Family actions: idempotency (aid), the action's own time (at), new actions and the plan sanitiser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, newFamily, sanitizePlan, okDevice, MAX_AIDS } from '../public/family.js';
import { plans, DEFAULT_PEOPLE } from '../public/logic.js';
import { ATTRACTIONS, FOOD } from '../public/data.js';

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const find = (n) => ATTRACTIONS.find((a) => a.name === n);
const allOpen = (w = 5) => ({ rides: Object.fromEntries(ATTRACTIONS.map((a) => [a.id, { s: 'OPERATING', w }])) });
const allPlans = plans({ people: DEFAULT_PEOPLE, favs: [], done: {}, live: allOpen(), walk: () => 200, month: 10 });
const together = allPlans.find((p) => p.type === 'together');
const split = allPlans.find((p) => p.type === 'split' && !p.parts[1].rest);
const restPlan = (() => {
  const s1 = split.parts[0];
  return { type: 'split', key: s1.id + '+rest', meet: s1.id, score: 0.1, minutes: s1.minutes,
    parts: [s1, { group: ['p2', 'p4'], rest: true, id: null, walkM: s1.walkM, wait: 0, minutes: s1.minutes }] };
})();
const copy = (x) => JSON.parse(JSON.stringify(x));
const withTarget = (plan = together, setAt = NOW - 60e3) => ({ ...newFamily(NOW - 3600e3), target: { plan: copy(plan), setAt, by: 'dev12345678' } });

test('aid: the same action twice is applied once; the last 80 aids are kept', () => {
  const k = find('Kondaa').id;
  let f = newFamily(NOW);
  f = apply(f, { type: 'done', ids: [k], aid: 'abc123' }, NOW);
  const again = apply(f, { type: 'done', ids: [k], aid: 'abc123' }, NOW + 1000);
  assert.equal(again, f, 'a repeated aid returns the state unchanged');
  assert.equal(again.done[k], 1);
  assert.equal(again.log.length, 1);
  assert.deepEqual(f.aids, ['abc123']);
  // without aid (or with an invalid one) every send counts
  f = apply(f, { type: 'done', ids: [k] }, NOW + 2000);
  f = apply(f, { type: 'done', ids: [k], aid: 'BAD!' }, NOW + 3000);
  assert.equal(f.done[k], 3);
  assert.deepEqual(f.aids, ['abc123']);
  for (let i = 0; i < 100; i++) f = apply(f, { type: 'walk', pref: 'low', aid: 'aid' + String(i).padStart(4, '0') }, NOW);
  assert.equal(f.aids.length, MAX_AIDS);
  assert.equal(f.aids.at(-1), 'aid0099');
  assert.ok(!f.aids.includes('abc123'));
  // an old family without aids still works
  const old = newFamily(NOW); delete old.aids;
  assert.deepEqual(apply(old, { type: 'ate', aid: 'zzz999' }, NOW).aids, ['zzz999']);
  // a rejected action doesn't record its aid
  assert.throws(() => apply(f, { type: 'fav', id: 'nope', aid: 'qqq111' }, NOW));
});

test('at: the client time is used within [now − 12 h, now + 2 min], else now', () => {
  const f0 = newFamily(NOW - 13 * 3600e3);
  const t = (at) => apply(f0, { type: 'ate', at }, NOW).ate;
  assert.equal(t(NOW - 3600e3), NOW - 3600e3);
  assert.equal(t(NOW - 12 * 3600e3), NOW - 12 * 3600e3);
  assert.equal(t(NOW + 60e3), NOW + 60e3);
  assert.equal(t(NOW - 12 * 3600e3 - 1), NOW);
  assert.equal(t(NOW + 3 * 60e3), NOW);
  assert.equal(t('123'), NOW);
  assert.equal(t(NaN), NOW);
  assert.equal(t(undefined), NOW);
  const at = NOW - 20 * 60e3;
  const k = find('Kondaa').id;
  assert.equal(apply(f0, { type: 'done', ids: [k], at }, NOW).log[0].t, at);
  assert.equal(apply(f0, { type: 'pause', at }, NOW).pause, at);
  assert.equal(apply(f0, { type: 'car', lat: 50.7, lon: 4.59, at }, NOW).car.t, at);
  assert.equal(apply(f0, { type: 'pos', device: 'dev12345678', lat: 50.7, lon: 4.59, at }, NOW).positions.dev12345678.t, at);
  assert.equal(apply(f0, { type: 'target', plan: together, device: 'dev12345678', at }, NOW).target.setAt, at);
  const ft = withTarget(together, at - 60e3);
  assert.equal(apply(ft, { type: 'queue', at }, NOW).target.queued, at);
  assert.equal(apply(ft, { type: 'ready', part: 0, device: 'dev12345678', at }, NOW).target.ready[0], at);
});

test('at: a late replay does not overwrite newer state', () => {
  const k = find('Kondaa').id;
  let f = withTarget(together, NOW - 60e3);
  // a "done" queued 20 min ago (offline) must not clear the target the other phone set a minute ago
  f = apply(f, { type: 'done', ids: [k], at: NOW - 20 * 60e3 }, NOW);
  assert.equal(f.done[k], 1, 'still counted in the log');
  assert.ok(f.target, 'the newer target stays');
  assert.ok(apply(f, { type: 'untarget', at: NOW - 20 * 60e3 }, NOW).target);
  assert.equal(apply(f, { type: 'target', plan: split, at: NOW - 20 * 60e3 }, NOW).target.plan.key, together.key);
  assert.equal(apply(f, { type: 'untarget' }, NOW).target, null);
  // positions and meals only move forward
  f = apply(f, { type: 'pos', device: 'dev12345678', lat: 50.70, lon: 4.59 }, NOW);
  f = apply(f, { type: 'pos', device: 'dev12345678', lat: 50.69, lon: 4.58, at: NOW - 5 * 60e3 }, NOW);
  assert.equal(f.positions.dev12345678.lat, 50.70);
  f = apply(f, { type: 'ate' }, NOW);
  f = apply(f, { type: 'ate', at: NOW - 3600e3 }, NOW);
  assert.equal(f.ate, NOW);
});

test('fav: toggles, or sets with an explicit on', () => {
  const k = find('Kondaa').id;
  let f = newFamily(NOW);
  f = apply(f, { type: 'fav', id: k }, NOW);
  assert.deepEqual(f.favs, [k]);
  f = apply(f, { type: 'fav', id: k, on: true }, NOW);
  assert.deepEqual(f.favs, [k], 'on: true twice stays on');
  f = apply(f, { type: 'fav', id: k }, NOW);
  assert.deepEqual(f.favs, []);
  f = apply(f, { type: 'fav', id: k, on: false }, NOW);
  assert.deepEqual(f.favs, [], 'on: false twice stays off');
  f = apply(f, { type: 'fav', id: k, on: 'yes' }, NOW);
  assert.deepEqual(f.favs, [k], 'a non-boolean on toggles');
});

test('queue and ready: only with a target', () => {
  const none = newFamily(NOW);
  assert.equal(apply(none, { type: 'queue' }, NOW).target, null);
  assert.equal(apply(none, { type: 'ready', part: 0, device: 'dev12345678' }, NOW).target, null);
  let f = withTarget(split);
  f = apply(f, { type: 'queue' }, NOW);
  assert.equal(f.target.queued, NOW);
  f = apply(f, { type: 'ready', part: 1, device: 'dev12345678' }, NOW);
  f = apply(f, { type: 'ready', part: 0, device: 'dev87654321' }, NOW + 5000);
  assert.deepEqual(f.target.ready, { 0: NOW + 5000, 1: NOW });
  assert.throws(() => apply(f, { type: 'ready', part: 2 }, NOW), /bad part/);
  assert.throws(() => apply(f, { type: 'ready', part: '0' }, NOW), /bad part/);
  assert.throws(() => apply(f, { type: 'ready', part: 0, device: '<x>' }, NOW), /bad device/);
  // a new target starts without ready/queued
  f = apply(f, { type: 'target', plan: together }, NOW);
  assert.equal(f.target.ready, undefined);
  assert.equal(f.target.queued, undefined);
});

test('sanitizePlan: every plan the planner makes passes unchanged', () => {
  for (const live of [allOpen(5), allOpen(40), { rides: {} }]) {
    for (const p of plans({ people: DEFAULT_PEOPLE, favs: [], done: {}, live, walk: () => 350, month: 6 })) {
      assert.deepEqual(sanitizePlan(copy(p), DEFAULT_PEOPLE), copy(p));
    }
  }
  assert.ok(together && split, 'test plans exist');
});

test('sanitizePlan: valid together, split and rest plans; extra fields dropped', () => {
  const t = sanitizePlan({ ...copy(together), evil: '<script>', parts: [{ ...copy(together.parts[0]), html: '<img onerror=x>' }] }, DEFAULT_PEOPLE);
  assert.equal(t.evil, undefined);
  assert.equal(t.parts[0].html, undefined);
  assert.equal(t.meet, undefined);
  const s = sanitizePlan(copy(split), DEFAULT_PEOPLE);
  assert.equal(s.meet, split.parts[0].id);
  assert.equal(s.parts.length, 2);
  const r = sanitizePlan(copy(restPlan), DEFAULT_PEOPLE);
  assert.deepEqual(r.parts[1], { group: ['p2', 'p4'], rest: true, id: null, walkM: restPlan.parts[1].walkM, wait: 0, minutes: restPlan.parts[1].minutes });
  // ride/watch/escorted only keep people of that group; numbers are clamped; wait may be null
  const p0 = { ...copy(split.parts[0]), ride: [...split.parts[0].ride, 'p4', 'p9'], watch: ['p2'], walkM: 1e9, wait: null };
  const c = sanitizePlan({ ...copy(split), parts: [p0, copy(split.parts[1])] }, DEFAULT_PEOPLE);
  assert.deepEqual(c.parts[0].ride, split.parts[0].ride);
  assert.deepEqual(c.parts[0].watch, []);
  assert.equal(c.parts[0].walkM, 10000);
  assert.equal(c.parts[0].wait, null);
  // applied as an action
  const f = apply(newFamily(NOW), { type: 'target', plan: copy(split), device: 'dev12345678' }, NOW);
  assert.deepEqual(f.target, { plan: s, setAt: NOW, by: 'dev12345678' });
});

test('sanitizePlan: rejects bad plans', () => {
  const bad = (plan, people = DEFAULT_PEOPLE) => assert.throws(() => sanitizePlan(plan, people), /bad plan/);
  const sp = () => copy(split);
  bad(null); bad('x'); bad({});
  bad({ ...copy(together), type: 'solo' });
  bad({ ...copy(together), parts: [] });
  bad({ ...copy(together), parts: [...sp().parts, sp().parts[0]] });
  bad({ ...sp(), meet: 'nope' });
  bad({ ...sp(), meet: undefined });
  bad({ ...sp(), meet: sp().parts[1].id });
  bad({ ...copy(restPlan), parts: [copy(restPlan.parts[1]), copy(restPlan.parts[0])], meet: null }); // split starting with rest
  // foreign or missing person ids
  bad({ ...copy(together), parts: [{ ...copy(together.parts[0]), group: ['p1', 'p99'] }] });
  bad({ ...copy(together), parts: [{ ...copy(together.parts[0]), group: [] }] });
  bad({ ...copy(together), parts: [{ ...copy(together.parts[0]), group: 'p1' }] });
  bad(copy(together), [{ id: 'p7', name: 'X', kind: 'adult', height: 170 }]);
  // strings where numbers belong (injection), unknown or food ids, rest with an id
  bad({ ...copy(together), parts: [{ ...copy(together.parts[0]), wait: '<img src=x onerror=alert(1)>' }] });
  bad({ ...copy(together), parts: [{ ...copy(together.parts[0]), wait: '5' }] });
  bad({ ...copy(together), parts: [{ ...copy(together.parts[0]), walkM: 'far' }] });
  bad({ ...copy(together), parts: [{ ...copy(together.parts[0]), minutes: Infinity }] });
  bad({ ...copy(together), parts: [{ ...copy(together.parts[0]), id: '<b>' }] });
  bad({ ...copy(together), parts: [{ ...copy(together.parts[0]), id: FOOD[0].id }] });
  bad({ ...copy(restPlan), parts: [copy(restPlan.parts[0]), { ...copy(restPlan.parts[1]), id: find('Kondaa').id }] });
  bad({ ...copy(together), key: 'x'.repeat(81) });
  bad({ ...copy(together), key: 5 });
  bad({ ...copy(together), score: 'high' });
  bad({ ...copy(together), minutes: null });
  assert.throws(() => apply(newFamily(NOW), { type: 'target', plan: { ...sp(), meet: 'nope' } }, NOW), /bad plan/);
});

test('okDevice', () => {
  assert.ok(okDevice('dev12345678'));
  assert.ok(!okDevice('short'));
  assert.ok(!okDevice('dev-1234567'));
  assert.ok(!okDevice(12345678));
});

test('phone numbers: cleaned, validated, optional', async () => {
  const { apply, newFamily, phoneOf } = await import('../public/family.js');
  assert.equal(phoneOf('+32 470 12 34 56'), '+32470123456');
  assert.equal(phoneOf('0470/12.34.56'), '0470123456');
  assert.equal(phoneOf('12'), '');
  assert.equal(phoneOf('javascript:alert(1)'), '');
  const f = apply(newFamily(1), { type: 'people', people: [
    { id: 'p1', name: 'A', kind: 'adult', height: 180 },
    { id: 'p3', name: 'Lotte', kind: 'child', height: 145, phone: '+32 470 12 34 56' },
    { id: 'p4', name: 'Mats', kind: 'child', height: 95, phone: 'nope' },
  ] }, 2);
  assert.equal(f.people[1].phone, '+32470123456');
  assert.ok(!('phone' in f.people[2]));
  assert.ok(!('phone' in f.people[0]));
});

test('queue per part, guesses, "aan de beurt" records the real wait and the best guess', () => {
  let f = withTarget(split);
  f = apply(f, { type: 'queue', part: 1, wait: 20 }, NOW);
  assert.equal(f.target.queued, NOW);
  assert.deepEqual(f.target.q[1], { t: NOW, w: 20, g: {} });
  assert.equal(f.target.q[0], undefined);
  f = apply(f, { type: 'guess', part: 1, person: 'p2', min: 12 }, NOW + 60e3);
  f = apply(f, { type: 'guess', part: 1, person: 'p4', min: 25 }, NOW + 60e3);
  f = apply(f, { type: 'guess', part: 1, person: 'nobody', min: 5 }, NOW + 60e3); // unknown person: ignored
  f = apply(f, { type: 'guess', part: 1, person: 'p2', min: 999 }, NOW + 60e3); // clamped
  assert.deepEqual(f.target.q[1].g, { p2: 240, p4: 25 });
  f = apply(f, { type: 'guess', part: 1, person: 'p2', min: 14 }, NOW + 60e3);
  f = apply(f, { type: 'board', part: 1 }, NOW + 15 * 60e3);
  assert.equal(f.target.q[1].b, NOW + 15 * 60e3);
  assert.deepEqual(f.waits, [{ id: split.parts[1].id, w: 20, m: 15, t: NOW + 15 * 60e3, win: 'p2' }]);
  // boarding twice or guessing afterwards changes nothing
  const again = apply(f, { type: 'board', part: 1 }, NOW + 20 * 60e3);
  assert.equal(again.waits.length, 1);
  assert.deepEqual(apply(f, { type: 'guess', part: 1, person: 'p4', min: 15 }, NOW + 16 * 60e3).target.q[1].g, { p2: 14, p4: 25 });
  // done doesn't add a second sample for a boarded queue
  f = apply(f, { type: 'done', ids: [split.parts[0].id, split.parts[1].id] }, NOW + 20 * 60e3);
  assert.equal(f.waits.length, 1);
  assert.equal(f.target, null);
});

test('done without "aan de beurt" estimates the wait (queue → done minus ride and getting off)', () => {
  let f = withTarget(together);
  const a = ATTRACTIONS.find((x) => x.id === together.parts[0].id);
  f = apply(f, { type: 'queue', wait: 30 }, NOW);
  f = apply(f, { type: 'done', ids: [a.id] }, NOW + (25 + a.ride + 2) * 60e3);
  assert.equal(f.waits.length, 1);
  assert.equal(f.waits[0].m, 25);
  assert.equal(f.waits[0].w, 30);
  // a queue part on a rest half or an unknown part index falls back to part 0
  let g = withTarget(restPlan);
  g = apply(g, { type: 'queue', part: 7 }, NOW);
  assert.ok(g.target.q[0]);
});

test('quiz: points per person, a question counts once; rate: 1–3 per person per ride', () => {
  let f = newFamily(NOW);
  f = apply(f, { type: 'quiz', person: 'p3', q: 'kondaa-0', ok: true }, NOW);
  f = apply(f, { type: 'quiz', person: 'p3', q: 'kondaa-0', ok: true }, NOW);
  f = apply(f, { type: 'quiz', person: 'p3', q: 'pulsar-1', ok: false }, NOW);
  assert.deepEqual(f.quiz.p3, { pts: 1, n: 2, ids: ['kondaa-0', 'pulsar-1'] });
  assert.throws(() => apply(f, { type: 'quiz', person: 'p9', q: 'x', ok: true }, NOW), /bad quiz/);
  assert.throws(() => apply(f, { type: 'quiz', person: 'p3', q: '<script>', ok: true }, NOW), /bad quiz/);
  const k = find('Kondaa').id;
  f = apply(f, { type: 'rate', id: k, person: 'p1', v: 3 }, NOW);
  f = apply(f, { type: 'rate', id: k, person: 'p3', v: 9 }, NOW);
  assert.deepEqual(f.rates[k], { p1: 3, p3: 3 });
  f = apply(f, { type: 'rate', id: k, person: 'p1', v: 1 }, NOW);
  assert.equal(f.rates[k].p1, 1);
  assert.throws(() => apply(f, { type: 'rate', id: 'nope', person: 'p1', v: 2 }, NOW), /bad rate/);
  assert.throws(() => apply(f, { type: 'rate', id: k, person: 'p8', v: 2 }, NOW), /bad rate/);
});

test('review fixes: a second "queue" keeps the first start and the boarding; done estimates only its own part', () => {
  let f = withTarget(split, NOW - 3600e3);
  f = apply(f, { type: 'queue', part: 0, wait: 20 }, NOW - 30 * 60e3);
  f = apply(f, { type: 'board', part: 0 }, NOW - 5 * 60e3);
  f = apply(f, { type: 'queue', part: 0, wait: 25 }, NOW - 25 * 60e3); // late replay from the other phone
  assert.equal(f.target.q[0].t, NOW - 30 * 60e3);
  assert.equal(f.target.q[0].b, NOW - 5 * 60e3);
  assert.equal(f.target.q[0].w, 20);
  f = apply(f, { type: 'queue', part: 1, wait: 10 }, NOW - 20 * 60e3);
  // part 0's phone says done: part 1 (still in line) gets no estimate, part 0 was measured at board
  const a = apply(f, { type: 'done', ids: [split.parts[0].id], part: 0 }, NOW);
  assert.equal(a.waits.length, 1);
  // part 1's phone says done: its own estimate is added
  const b = apply(f, { type: 'done', ids: [split.parts[1].id], part: 1 }, NOW);
  assert.equal(b.waits.length, 2);
  // a "Gedaan" forgotten until much later is no measurement
  let g = withTarget(together, NOW - 4 * 3600e3);
  g = apply(g, { type: 'queue', wait: 10 }, NOW - 3 * 3600e3);
  g = apply(g, { type: 'done', ids: [together.parts[0].id], part: 0 }, NOW);
  assert.equal(g.waits, undefined);
  // without a posted wait: no estimate either
  let h = withTarget(together, NOW - 3600e3);
  h = apply(h, { type: 'queue' }, NOW - 20 * 60e3);
  h = apply(h, { type: 'done', ids: [together.parts[0].id] }, NOW);
  assert.equal(h.waits, undefined);
});

test('done for an old plan counts nothing (two phones detecting it); unqueue removes only an unboarded queue', () => {
  let f = withTarget(together, NOW - 3600e3);
  const setAt = f.target.setAt, id = together.parts[0].id;
  f = apply(f, { type: 'done', ids: [id], target: setAt }, NOW);
  assert.equal(f.done[id], 1);
  f = apply(f, { type: 'done', ids: [id], target: setAt }, NOW + 1000); // the other phone, a moment later
  assert.equal(f.done[id], 1);
  // without target (old clients, the guide's solo ride) it still counts
  f = apply(f, { type: 'done', ids: [id] }, NOW + 2000);
  assert.equal(f.done[id], 2);
  let g = withTarget(split, NOW - 3600e3);
  g = apply(g, { type: 'queue', part: 1, wait: 10 }, NOW - 30 * 60e3);
  g = apply(g, { type: 'queue', part: 0, wait: 10 }, NOW - 30 * 60e3);
  g = apply(g, { type: 'unqueue', part: 1 }, NOW - 20 * 60e3);
  assert.deepEqual(Object.keys(g.target.q), ['0']);
  g = apply(g, { type: 'board', part: 0 }, NOW - 10 * 60e3);
  g = apply(g, { type: 'unqueue', part: 0 }, NOW - 5 * 60e3); // boarded: stays
  assert.ok(g.target.q[0].b);
  let h = withTarget(together, NOW - 3600e3);
  h = apply(h, { type: 'queue', wait: 10 }, NOW - 30 * 60e3);
  h = apply(h, { type: 'unqueue' }, NOW - 25 * 60e3);
  assert.equal(h.target.q, undefined);
  assert.equal(h.target.queued, undefined);
});

test('queue: only the detection marks a queue as automatic', () => {
  let f = withTarget(together, NOW - 3600e3);
  f = apply(f, { type: 'queue', wait: 10, auto: true }, NOW - 10 * 60e3);
  assert.equal(f.target.q[0].auto, true);
  let g = withTarget(together, NOW - 3600e3);
  g = apply(g, { type: 'queue', wait: 10, auto: 'yes' }, NOW - 10 * 60e3);
  assert.equal(g.target.q[0].auto, undefined);
});

test('closed: mark and unmark a ride for today', () => {
  const k = find('Kondaa').id;
  let f = apply(newFamily(NOW), { type: 'closed', id: k, on: true }, NOW);
  assert.equal(f.closed[k], NOW);
  f = apply(f, { type: 'closed', id: k, on: false }, NOW + 1000);
  assert.equal(f.closed[k], undefined);
  assert.throws(() => apply(f, { type: 'closed', id: 'nope' }, NOW), /bad id/);
});

test('diaper: the last check is remembered (a late replay never moves it back)', () => {
  let f = apply(newFamily(NOW), { type: 'diaper' }, NOW);
  assert.equal(f.diaper, NOW);
  f = apply(f, { type: 'diaper', at: NOW - 3600e3 }, NOW);
  assert.equal(f.diaper, NOW);
});

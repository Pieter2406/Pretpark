// Property tests: whatever the park looks like, a suggestion must never break the rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plans, canRide, splitGroups, DEFAULT_PEOPLE, distM, byId } from '../public/logic.js';
import { ATTRACTIONS } from '../public/data.js';

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function randomWorld(r) {
  const nAdults = 1 + Math.floor(r() * 3), nKids = Math.floor(r() * 4);
  const people = [];
  for (let i = 0; i < nAdults; i++) people.push({ id: 'p' + (people.length + 1), name: 'A' + i, kind: 'adult', height: 150 + r() * 45, pregnant: r() < 0.3 });
  for (let i = 0; i < nKids; i++) people.push({ id: 'p' + (people.length + 1), name: 'K' + i, kind: 'child', height: 80 + r() * 90, pregnant: false });
  const rides = {};
  for (const a of ATTRACTIONS) {
    const x = r();
    if (x < 0.1) continue; // missing from live data
    rides[a.id] = { s: x < 0.2 ? 'DOWN' : x < 0.25 ? 'CLOSED' : 'OPERATING', w: r() < 0.05 ? null : Math.round(r() * 18) * 5 };
  }
  const here = { lat: 50.6965 + r() * 0.006, lon: 4.585 + r() * 0.01 };
  const done = {}; for (const a of ATTRACTIONS) if (r() < 0.2) done[a.id] = 1 + Math.floor(r() * 3);
  const favs = ATTRACTIONS.filter(() => r() < 0.1).map((a) => a.id);
  return {
    people, here,
    ctx: { people, favs, done, live: { rides }, walk: (a) => distM(here, a) * 1.35, month: Math.floor(r() * 12),
      minutesLeft: r() < 0.3 ? Math.floor(5 + r() * 60) : null, rain: r() < 0.3, walkPref: r() < 0.5 ? 'low' : 'normal' },
  };
}

test('fuzz: 600 random situations, every suggestion follows the rules', () => {
  const r = rng(42);
  let checked = 0;
  for (let n = 0; n < 600; n++) {
    const { people, ctx } = randomWorld(r);
    const ps = plans(ctx);
    const person = (id) => people.find((p) => p.id === id);
    const mains = new Set();
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      assert.ok(Number.isFinite(p.score) && p.score > 0, 'score is a positive number');
      if (i) assert.ok(ps[i - 1].score >= p.score, 'sorted best first');
      assert.ok(!mains.has(p.parts[0].id), 'no duplicate main ride'); mains.add(p.parts[0].id);
      if (p.type === 'split') {
        const ids = p.parts.flatMap((pt) => pt.group);
        assert.equal(new Set(ids).size, ids.length, 'groups do not overlap');
        assert.equal(ids.length, people.length, 'everyone is in a group');
        assert.equal(p.meet, p.parts[0].id, 'meet at the first ride');
        assert.ok(splitGroups(people), 'split only when the family can split');
      }
      for (const pt of p.parts) {
        assert.ok(pt.group.some((id) => person(id).kind === 'adult'), 'every group has an adult');
        if (pt.rest) { assert.ok(pt.group.some((id) => person(id).pregnant), 'rest only for a pregnant adult'); continue; }
        const a = byId[pt.id];
        assert.equal(ctx.live.rides[a.id]?.s, 'OPERATING', `${a.name} is open`);
        if (ctx.minutesLeft != null) assert.ok(Math.max(1, Math.round(ctx.walk(a) / 60)) + (ctx.live.rides[a.id].w ?? 10) <= ctx.minutesLeft, 'fits before closing');
        assert.ok(pt.ride.length > 0, 'someone rides');
        for (const id of pt.ride) {
          const p2 = person(id), c = canRide(p2, a);
          assert.ok(c, `${p2.name} (${Math.round(p2.height)} cm${p2.pregnant ? ', zwanger' : ''}) may ride ${a.name}`);
          if (p2.pregnant) assert.ok(a.preg, 'pregnant only on gentle rides');
          if (c === 'adult') assert.ok(pt.ride.some((o) => person(o).kind === 'adult' && canRide(person(o), a) === 'alone'), `${a.name}: escort rides along`);
        }
        const escorts = pt.ride.filter((o) => person(o).kind === 'adult' && canRide(person(o), a) === 'alone').length;
        assert.ok((pt.escorted || []).length <= escorts * 2, 'at most two escorted kids per adult');
        for (const id of pt.watch) assert.ok(!pt.ride.includes(id), 'nobody both rides and watches');
        checked++;
      }
    }
  }
  assert.ok(checked > 5000, `checked ${checked} ride assignments`);
});

test('rain makes indoor rides win more often', () => {
  let indoorDry = 0, indoorWet = 0;
  const r = rng(7);
  for (let n = 0; n < 300; n++) {
    const { ctx } = randomWorld(r);
    const top = (rain) => plans({ ...ctx, rain, people: DEFAULT_PEOPLE })[0];
    const d = top(false), w = top(true);
    if (d && byId[d.parts[0].id].indoor) indoorDry++;
    if (w && byId[w.parts[0].id].indoor) indoorWet++;
  }
  assert.ok(indoorWet > indoorDry * 1.5, `indoor first: ${indoorDry} dry vs ${indoorWet} in rain`);
});

test('nothing is suggested that cannot be done before closing', () => {
  const rides = Object.fromEntries(ATTRACTIONS.map((a) => [a.id, { s: 'OPERATING', w: 30 }]));
  const ps = plans({ people: DEFAULT_PEOPLE, favs: [], done: {}, live: { rides }, walk: () => 300, month: 10, minutesLeft: 20 });
  assert.equal(ps.length, 0);
});

test('family shapes: no split without two adults, no rest without pregnancy', () => {
  const rides = Object.fromEntries(ATTRACTIONS.map((a) => [a.id, { s: 'OPERATING', w: 10 }]));
  const base = { favs: [], done: {}, live: { rides }, walk: () => 200, month: 10 };
  const single = DEFAULT_PEOPLE.filter((p) => p.id !== 'p2');
  assert.ok(plans({ ...base, people: single }).every((p) => p.type === 'together'));
  const notPregnant = DEFAULT_PEOPLE.map((p) => ({ ...p, pregnant: false }));
  assert.ok(plans({ ...base, people: notPregnant }).every((p) => !p.parts.some((pt) => pt.rest)));
  const adults = DEFAULT_PEOPLE.filter((p) => p.kind === 'adult').map((p) => ({ ...p, pregnant: false }));
  assert.equal(byId[plans({ ...base, people: adults })[0].parts[0].id].cat, 'thrill', 'two adults go for thrills');
});

test('"liever weinig stappen" picks closer rides', () => {
  const r = rng(11);
  let normal = 0, low = 0;
  for (let n = 0; n < 200; n++) {
    const { ctx } = randomWorld(r);
    const c = { ...ctx, people: DEFAULT_PEOPLE, minutesLeft: null };
    normal += plans({ ...c, walkPref: 'normal' })[0]?.parts[0].walkM || 0;
    low += plans({ ...c, walkPref: 'low' })[0]?.parts[0].walkM || 0;
  }
  assert.ok(low < normal, `low ${Math.round(low / 200)} m vs normal ${Math.round(normal / 200)} m`);
});

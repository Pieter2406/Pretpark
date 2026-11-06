// Queue games data: every fact block belongs to a real ride, has a source, and every quiz question is well-formed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FACTS, QUESTS } from '../public/fun.js';
import { ATTRACTIONS } from '../public/data.js';

test('FACTS: known rides, sources, valid quiz questions', () => {
  const names = new Set(ATTRACTIONS.map((a) => a.name));
  for (const [name, f] of Object.entries(FACTS)) {
    assert.ok(names.has(name), `unknown ride ${name}`);
    assert.ok(f.sources?.length && f.sources.every((u) => /^https?:\/\//.test(u)), `${name}: no source`);
    for (const q of f.quiz || []) {
      assert.equal(q.options.length, 3, `${name}: 3 options`);
      assert.equal(new Set(q.options).size, 3, `${name}: distinct options`);
      assert.ok([0, 1, 2].includes(q.answer), `${name}: answer index`);
      assert.ok(q.q.length > 5);
    }
  }
});

test('QUESTS: short, distinct', () => {
  assert.ok(QUESTS.length >= 10);
  assert.equal(new Set(QUESTS).size, QUESTS.length);
  assert.ok(QUESTS.every((q) => q.length <= 80));
});

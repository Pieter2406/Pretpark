// A few whole simulated park days (sim/simulate.mjs): the app must keep the rules all day and beat simple strategies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateDay } from '../sim/simulate.mjs';

const days = (strategy, opts = {}) => [1, 2, 3].map((seed) => simulateDay(strategy, { seed, ...opts }));
const mean = (rs, f) => rs.reduce((s, r) => s + f(r), 0) / rs.length;

test('simulated days: no rule broken, more rides than the baselines', () => {
  const app = days('app'), nearest = days('nearest'), random = days('random');
  assert.deepEqual(app.flatMap((r) => r.violations), []);
  assert.ok(mean(app, (r) => r.rides) > mean(nearest, (r) => r.rides) * 1.15, 'more rides than nearest-first');
  assert.ok(mean(app, (r) => r.rides) > mean(random, (r) => r.rides) * 1.3, 'more rides than random');
  assert.ok(mean(app, (r) => r.fun.p4) > mean(nearest, (r) => r.fun.p4), 'the toddler has more fun');
  assert.ok(mean(app, (r) => r.fun.p3) > mean(nearest, (r) => r.fun.p3), 'the big kid has more fun');
});

test('simulated days: rain keeps you off wet rides, "weinig stappen" walks less', () => {
  const rain = days('app', { scenario: { rainFrom: 12 * 60, rainTo: 17 * 60 } });
  assert.equal(mean(rain, (r) => r.wetInRain), 0);
  const low = days('app', { walkPref: 'low' }), normal = days('app');
  assert.ok(mean(low, (r) => r.walkedKm.p2) < mean(normal, (r) => r.walkedKm.p2));
});

// Run with `npm test`. Put the app's logic in its own module under public/ and test it here;
// this folder is outside public/, so tests are never published.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the page names its language and title', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<html lang="[a-z]{2}"/);
  assert.match(html, /<title>[^<]+<\/title>/);
});

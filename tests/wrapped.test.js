import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dayData, slidesFor, bookPlan, makePdf } from '../public/wrapdata.js';
import { ATTRACTIONS } from '../public/data.js';
import { DEFAULT_PEOPLE } from '../public/logic.js';

const NOW = Date.UTC(2026, 10, 7, 19, 0);
const id = (n) => ATTRACTIONS.find((a) => a.name === n).id;
const fam = {
  log: [
    { t: NOW - 8 * 3600e3, ids: [id('Calamity Mine')] }, { t: NOW - 7 * 3600e3, ids: [id('Kondaa'), id('Fun Pilot')] },
    { t: NOW - 6 * 3600e3, ids: [id('Calamity Mine')] }, { t: NOW - 30 * 3600e3, ids: [id('Pulsar')] }, // yesterday: not today
  ],
  rates: { [id('Calamity Mine')]: { p1: 3, p3: 3 }, [id('Kondaa')]: { p1: 2 } },
  waits: [{ id: id('Kondaa'), w: 30, m: 24, t: NOW - 7 * 3600e3, win: 'p3' }, { id: id('Calamity Mine'), w: 15, m: 12, t: NOW - 6 * 3600e3, win: 'p3' }],
  quiz: { p1: { pts: 3, n: 4, ids: [] }, p3: { pts: 5, n: 6, ids: [] } },
  hist: [{ k: 'ate', t: NOW - 5 * 3600e3 }],
};
const photo = (min, near, extra = {}) => ({ id: 'ph' + min, t: NOW - 8 * 3600e3 + min * 60e3, near, ...extra });
const album = [photo(0, 'Calamity Mine'), photo(5, 'Calamity Mine'), photo(9, 'Calamity Mine'), photo(70, 'Kondaa', { star: true }),
  photo(130, 'Tiki-Waka'), photo(132, 'Tiki-Waka'), photo(300, 'Silverton'), photo(301, 'Silverton'), photo(302, 'Silverton'), photo(303, 'Silverton'), photo(304, 'Silverton')];

test('dayData: today only, toppers, the loved ride, queues, quiz, photos', () => {
  const d = dayData({ fam, album, people: DEFAULT_PEOPLE, now: NOW });
  assert.equal(d.rideCount, 4); assert.equal(d.distinct, 3);
  assert.deepEqual(d.toppers.done.sort(), ['Calamity Mine', 'Kondaa']);
  assert.equal(d.loved.a.name, 'Calamity Mine');
  assert.equal(d.most.a.name, 'Calamity Mine'); assert.equal(d.most.n, 2);
  assert.equal(d.queue.min, 36); assert.equal(d.queue.longest.a.name, 'Kondaa');
  assert.equal(d.guesser.wins, 2);
  assert.equal(d.quiz[0].pts, 5);
  assert.equal(d.photos.length, 11); assert.equal(d.starred.length, 1); assert.equal(d.meals, 1);
});

test('slides: only the ones with something to say', () => {
  const kinds = slidesFor(dayData({ fam, album, people: DEFAULT_PEOPLE, now: NOW })).map((s) => s.kind);
  assert.deepEqual(kinds, ['intro', 'rides', 'toppers', 'loved', 'queue', 'walk', 'quiz', 'photos', 'timeline', 'outro']);
  assert.deepEqual(slidesFor(dayData({ fam: {}, album: [], people: DEFAULT_PEOPLE, now: NOW })).map((s) => s.kind), ['intro', 'outro']);
});

test('photo book: moments of ≤ 4, a starred photo alone, layouts by count', () => {
  const pages = bookPlan(dayData({ fam, album, people: DEFAULT_PEOPLE, now: NOW }));
  assert.equal(pages[0].kind, 'cover'); assert.equal(pages[0].photo.id, 'ph70'); // the starred photo is the cover
  const ph = pages.filter((p) => p.kind === 'photos');
  assert.deepEqual(ph.map((p) => [p.layout, p.photos.length]), [['trio', 3], ['hero', 1], ['duo', 2], ['quad', 4], ['hero', 1]]);
  assert.equal(ph[0].title, 'Calamity Mine');
  assert.equal(pages.at(-1).kind, 'end'); assert.ok(pages.some((p) => p.kind === 'timeline'));
  // every photo exactly once
  assert.equal(ph.flatMap((p) => p.photos).length, album.length);
});

test('makePdf: a valid PDF with one full-page JPEG per page', () => {
  // the smallest valid baseline JPEG (1×1 px)
  const jpeg = Uint8Array.from(Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'));
  const pdf = makePdf([{ jpeg, w: 1, h: 1, pw: 842, ph: 595 }, { jpeg, w: 1, h: 1, pw: 595, ph: 595 }], 'Test (boek)');
  const text = Buffer.from(pdf).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4')); assert.ok(text.trimEnd().endsWith('%%EOF'));
  // every xref offset points at its object
  const xref = Number(text.match(/startxref\n(\d+)/)[1]);
  const rows = text.slice(xref).split('\n').slice(3).filter((l) => / n $/.test(l));
  rows.forEach((r, i) => assert.ok(text.startsWith(`${i + 1} 0 obj`, Number(r.slice(0, 10))), `object ${i + 1}`));
  // and a real PDF reader agrees (pdfinfo when installed)
  const dir = mkdtempSync(join(tmpdir(), 'pdf-')); const f = join(dir, 'b.pdf'); writeFileSync(f, pdf);
  let info = null; try { info = execFileSync('pdfinfo', [f], { encoding: 'utf8' }); } catch { /* not installed */ }
  if (info) { assert.match(info, /Pages:\s+2/); assert.match(info, /Page size:\s+842 x 595/); }
});

test('the Wrapped is about the whole last park day, also the morning after', () => {
  const next = Date.UTC(2026, 10, 8, 8, 0); // 09:00 the next day: the morning rides are > 14 h ago
  const d = dayData({ fam, album, people: DEFAULT_PEOPLE, now: next });
  assert.equal(d.day, '2026-11-07'); assert.equal(d.past, true);
  assert.equal(d.rideCount, 4); assert.equal(d.photos.length, 11); // the ride of the day before stays out
  // a week later: still that day; after a week: nothing
  assert.equal(dayData({ fam, album, people: DEFAULT_PEOPLE, now: NOW + 6 * 86400e3 }).rideCount, 4);
  assert.equal(dayData({ fam, album, people: DEFAULT_PEOPLE, now: NOW + 8 * 86400e3 }).rideCount, 0);
});

test('the day runs from the first to the last ride; the cover is a park photo', () => {
  const extra = [{ id: 'car', t: NOW - 9 * 3600e3, near: '' }, { id: 'home', t: NOW + 2 * 3600e3 - 1, near: '' }, ...album.map((p) => ({ ...p, star: false }))];
  const d = dayData({ fam, album: extra, people: DEFAULT_PEOPLE, now: NOW + 2 * 3600e3 });
  assert.equal(d.first, NOW - 8 * 3600e3); assert.equal(d.last, NOW - 6 * 3600e3);
  assert.equal(bookPlan(d)[0].photo.id, 'ph0'); // not the car photo
});

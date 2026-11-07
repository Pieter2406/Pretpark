import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readExif, exifTime, placeOf } from '../public/exif.js';
import { ATTRACTIONS, FOOD } from '../public/data.js';

// a tiny JPEG with an EXIF block (big-endian TIFF): DateTimeOriginal, OffsetTimeOriginal and GPS
function jpegWithExif({ dt = '2026:11:07 17:07:05', off = '+01:00', lat = [50, 42, 0.17], lon = [4, 35, 26.1], le = false } = {}) {
  const bytes = [];
  const u16 = (n) => (le ? [n & 255, n >> 8] : [n >> 8, n & 255]);
  const u32 = (n) => (le ? [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24] : [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
  const ascii = (s) => [...s].map((c) => c.charCodeAt(0)).concat(0);
  // layout: header(8) IFD0 @8 (2 entries) → EXIF IFD → GPS IFD → data
  const ifd = (entries) => 2 + entries * 12 + 4;
  const o0 = 8, oExif = o0 + ifd(2), oGps = oExif + ifd(2), oData = oGps + ifd(4);
  const dtB = ascii(dt), offB = ascii(off);
  const rat = (v) => [Math.round(v * 1000), 1000];
  const latR = lat.flatMap(rat), lonR = lon.flatMap(rat);
  const pDt = oData, pOff = pDt + dtB.length, pLat = pOff + offB.length, pLon = pLat + 24;
  const entry = (tag, type, count, val) => [...u16(tag), ...u16(type), ...u32(count), ...val];
  const inl = (arr) => [...arr, 0, 0, 0, 0].slice(0, 4);
  const tiff = [
    ...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8),
    ...u16(2), ...entry(0x8769, 4, 1, u32(oExif)), ...entry(0x8825, 4, 1, u32(oGps)), ...u32(0),
    ...u16(2), ...entry(0x9003, 2, dtB.length, u32(pDt)), ...entry(0x9011, 2, offB.length, u32(pOff)), ...u32(0),
    ...u16(4), ...entry(1, 2, 2, inl(ascii('N'))), ...entry(2, 5, 3, u32(pLat)), ...entry(3, 2, 2, inl(ascii('E'))), ...entry(4, 5, 3, u32(pLon)), ...u32(0),
    ...dtB, ...offB, ...latR.flatMap((x) => u32(x)), ...lonR.flatMap((x) => u32(x)),
  ];
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  bytes.push(0xff, 0xd8, 0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 255, ...app1, 0xff, 0xda, 0, 2, 0xff, 0xd9);
  return new Uint8Array(bytes).buffer;
}

test('readExif: time, offset and GPS, big- and little-endian; nothing for a JPEG without EXIF', () => {
  for (const le of [false, true]) {
    const r = readExif(jpegWithExif({ le }));
    assert.equal(r.local, '2026:11:07 17:07:05'); assert.equal(r.offset, '+01:00');
    assert.ok(Math.abs(r.lat - (50 + 42 / 60 + 0.17 / 3600)) < 1e-6); assert.ok(Math.abs(r.lon - (4 + 35 / 60 + 26.1 / 3600)) < 1e-6);
    assert.equal(exifTime(r), Date.UTC(2026, 10, 7, 16, 7, 5));
  }
  assert.equal(readExif(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]).buffer), null);
  assert.equal(readExif(new Uint8Array([1, 2, 3]).buffer), null);
});

test('placeOf: rides first, a restaurant only when clearly closer, measured Halloween spots while open, nothing far away', () => {
  const at = (n, dLat = 0) => { const a = [...ATTRACTIONS, ...FOOD].find((x) => x.name === n); return { lat: a.lat + dLat, lon: a.lon }; };
  assert.equal(placeOf(at('Turbine')), 'Turbine');
  // 7 Nov: photos 15 m from Turbine were labelled "Hungry Sharky" (30 m) — a ride within reach wins now
  assert.equal(placeOf({ lat: 50.697719, lon: 4.590717 }), 'Turbine');
  assert.equal(placeOf(at('Hungry Sharky')), 'Hungry Sharky'); // standing at the restaurant itself
  // Psycho Circus (measured from the family's photos) during its hours on 7 Nov; outside them: the ride next to it
  const circus = { lat: 50.700047, lon: 4.590583 };
  assert.equal(placeOf(circus, { t: new Date(2026, 10, 7, 17, 7).getTime() }), 'Psycho Circus (scare zone)');
  assert.equal(placeOf(circus, { t: new Date(2026, 10, 7, 9, 0).getTime() }), '4D Wanted Alive');
  // a spot that only sits on a ride's coordinates (Silence "bij Cobra") never steals the ride's photos
  assert.equal(placeOf(at('Cobra'), { t: new Date(2026, 10, 7, 21, 12).getTime() }), 'Cobra');
  assert.equal(placeOf({ lat: 51.0629, lon: 4.5453 }), ''); // at home
  assert.equal(placeOf(null), '');
});

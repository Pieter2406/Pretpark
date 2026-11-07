// Where and when a photo was really taken, and which attraction that is.
// - readExif(arrayBuffer): the JPEG's own EXIF: DateTimeOriginal (camera wall-clock) and GPS. Photos added from the
//   gallery carry these (Pieter's iPhone gallery imports and Marjan's OnePlus did on 7 Nov); photos taken with the
//   in-app camera usually don't (iOS strips GPS), so the app then uses its own fix, but only when the photo is fresh.
// - placeOf(pos): the attraction the photo belongs to. Rides come first: a restaurant or a Halloween spot only wins when
//   it is clearly closer (on 7 Nov photos at Turbine were labelled "Hungry Sharky", at Dalton Terror "Slush Factory").
// Pure (no DOM): tested on real photos in tests/exif.test.js.
import { ATTRACTIONS, FOOD } from './data.js';
import { distM } from './logic.js';
import { spookyOn } from './shows.js';

export function readExif(buf) {
  try {
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xffd8) return null;
    let o = 2;
    while (o + 4 < v.byteLength) {
      if (v.getUint8(o) !== 0xff) return null;
      const mark = v.getUint8(o + 1), len = v.getUint16(o + 2);
      if (mark === 0xe1 && v.getUint32(o + 4) === 0x45786966) return tiff(v, o + 10); // "Exif\0\0"
      if (mark === 0xda) return null; // image data: no EXIF before it
      o += 2 + len;
    }
  } catch { /* not a JPEG or a broken header */ }
  return null;
}
function tiff(v, base) {
  const le = v.getUint16(base) === 0x4949;
  const u16 = (p) => v.getUint16(p, le), u32 = (p) => v.getUint32(p, le);
  const ifd = (off) => {
    const out = {}; const p = base + off; const n = u16(p);
    for (let i = 0; i < n; i++) {
      const e = p + 2 + i * 12, tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 }[type] || 1;
      const at = size * count > 4 ? base + u32(e + 8) : e + 8;
      if (type === 2) { let s = ''; for (let k = 0; k < count - 1; k++) s += String.fromCharCode(v.getUint8(at + k)); out[tag] = s; }
      else if (type === 5 || type === 10) out[tag] = Array.from({ length: count }, (_, k) => u32(at + k * 8) / (u32(at + k * 8 + 4) || 1));
      else if (type === 3) out[tag] = count === 1 ? u16(at) : Array.from({ length: count }, (_, k) => u16(at + k * 2));
      else if (type === 4) out[tag] = u32(at);
      else out[tag] = v.getUint8(at);
    }
    return out;
  };
  const ifd0 = ifd(u32(base + 4));
  const exif = ifd0[0x8769] ? ifd(ifd0[0x8769]) : {};
  const gps = ifd0[0x8825] ? ifd(ifd0[0x8825]) : {};
  const r = {};
  const dt = exif[0x9003] || ifd0[0x0132]; // DateTimeOriginal, else DateTime: "2026:11:07 17:07:05" (camera wall-clock)
  if (dt && /^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d/.test(dt)) r.local = dt.slice(0, 19);
  if (exif[0x9011]) r.offset = exif[0x9011]; // OffsetTimeOriginal "+01:00"
  const dms = (a) => (Array.isArray(a) && a.length === 3 ? a[0] + a[1] / 60 + a[2] / 3600 : null);
  const lat = dms(gps[2]), lon = dms(gps[4]);
  if (lat != null && lon != null && (lat || lon)) { r.lat = gps[1] === 'S' ? -lat : lat; r.lon = gps[3] === 'W' ? -lon : lon; }
  return r;
}
// the EXIF time as ms: with its own offset when given, else read as this phone's local time
export function exifTime(r) {
  if (!r?.local) return null;
  const [d, t] = r.local.split(' '); const iso = `${d.replace(/:/g, '-')}T${t}`;
  const ms = r.offset && /^[+-]\d\d:\d\d$/.test(r.offset) ? Date.parse(iso + r.offset) : new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// Halloween spots with a known place (shows.js) count as places too, but only while they are open (by the photo's time)
export const spotLabel = (s) => (s.kind === 'house' ? `${s.name} (spookhuis)` : s.kind === 'zone' ? `${s.name} (scare zone)` : s.name);
const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function spotsAt(t) {
  if (!t) return [];
  const m = new Date(t).getHours() * 60 + new Date(t).getMinutes();
  // only spots whose place was measured (`seen`); the others sit on a ride's coordinates and would steal its photos
  return spookyOn(ymd(t)).filter((s) => s.seen && m >= s.from && m < s.to).map((s) => ({ name: spotLabel(s), lat: s.lat, lon: s.lon }));
}
// the places around a position, nearest first (suggestions when a place is chosen by hand)
export function placesNear(pos, { t = null, n = 5, max = 150 } = {}) {
  if (!pos || pos.lat == null) return [];
  return [...ATTRACTIONS, ...spotsAt(t), ...FOOD].map((x) => ({ name: x.name, d: distM(pos, x) })).filter((x) => x.d <= max).sort((a, b) => a.d - b.d).slice(0, n);
}
// pos {lat, lon}; t = when the photo was taken (ms, for the Halloween spots)
export function placeOf(pos, { t = null, max = 90 } = {}) {
  if (!pos || pos.lat == null) return '';
  const near = (list) => list.map((x) => ({ name: x.name, d: distM(pos, x) })).sort((a, b) => a.d - b.d)[0];
  const ride = near(ATTRACTIONS), food = near(FOOD), spot = near(spotsAt(t));
  if (spot && spot.d <= 25 && (!ride || spot.d < ride.d)) return spot.name; // standing in an open scare zone / house queue
  if (food && food.d <= 25 && (!ride || ride.d - food.d >= 20)) return food.name; // clearly at the restaurant
  if (ride && ride.d <= max) return ride.name;
  return food && food.d <= max ? food.name : '';
}

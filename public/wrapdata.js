// "Wrapped" of the day + photo book: the pure part (no DOM), so it can be tested in node.
// - dayData: everything worth telling about one park day, from the shared family state and the album
// - slidesFor: which story slides the Wrapped gets (only the ones with something to say)
// - bookPlan: the photo book's pages (cover, numbers, photo pages with a layout per page, timeline, end)
// - makePdf: a minimal PDF with one full-page JPEG per page (iOS home-screen apps can't print, so the app builds
//   the PDF itself and hands it to the share sheet: save to Files/Books, print, send)
import { byId, COOL, canRide, distM } from './logic.js';
import { ATTRACTIONS, FOOD, ENTRANCE } from './data.js';
import { SPOOKY } from './shows.js';
import { spotLabel } from './exif.js';
import { dayKey } from './activity.js';

// The day a Wrapped is about: the park day of the newest ride done in the last week (Brussels calendar day), so it
// still shows the whole day the morning after (or a week later), and only that day.
const WEEK = 7 * 86400e3;
export function parkDay(fam, now = Date.now()) {
  const ts = (fam?.log || []).map((l) => l.t).filter((t) => t && t <= now + 60e3 && now - t < WEEK);
  return dayKey(ts.length ? Math.max(...ts) : now);
}
const onDay = (day, now) => (t) => !!t && t <= now + 60e3 && now - t < WEEK + 86400e3 && dayKey(t) === day;
const TOP = Object.entries(COOL).filter(([, t]) => t === 1).map(([n]) => n);
const avg = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);

// fam: the family state; album: [{id, t, near, star, caption, by, w, h, full}]; people: [{id, name, …}]
// walk: the extra inputs of walkStats ({ metres, local, ended }), optional
export function dayData({ fam, album = [], people = [], now = Date.now(), walk = {} }) {
  const day = parkDay(fam, now), today = onDay(day, now);
  const rides = (fam?.log || []).filter((l) => today(l.t)).flatMap((l) => (l.ids || []).map((id) => ({ t: l.t, id, a: byId[id] })))
    .filter((r) => r.a && r.a.cat).sort((x, y) => x.t - y.t);
  const count = {};
  for (const r of rides) count[r.id] = (count[r.id] || 0) + 1;
  const most = Object.entries(count).sort((x, y) => y[1] - x[1])[0];
  // the ride the family loved most (ratings: 3 😍, 2 🙂, 1 😬), ridden today
  const loved = Object.entries(fam?.rates || {}).filter(([id]) => count[id])
    .map(([id, r]) => ({ a: byId[id], avg: avg(Object.values(r)), n: Object.values(r).length, r }))
    .filter((x) => x.a).sort((x, y) => y.avg - x.avg || y.n - x.n)[0] || null;
  const waits = (fam?.waits || []).filter((w) => today(w.t));
  const longest = waits.slice().sort((x, y) => y.m - x.m)[0];
  const wins = {}; for (const w of waits) if (w.win) wins[w.win] = (wins[w.win] || 0) + 1;
  const bestGuess = Object.entries(wins).sort((x, y) => y[1] - x[1])[0];
  const name = (pid) => people.find((p) => p.id === pid)?.name || '';
  const quiz = Object.entries(fam?.quiz || {}).map(([pid, q]) => ({ name: name(pid), pts: q.pts, n: q.n })).filter((x) => x.name && x.n).sort((x, y) => y.pts - x.pts || x.n - y.n);
  const photos = album.filter((p) => today(p.t)).sort((x, y) => x.t - y.t);
  const hist = (fam?.hist || []).filter((h) => today(h.t));
  // the day runs from the first to the last ride (photos in the car or at home don't stretch it); photos only without rides
  const all = rides.length ? rides.map((r) => r.t) : photos.map((p) => p.t);
  return {
    now, first: all.length ? Math.min(...all) : null, last: all.length ? Math.max(...all) : null,
    people: people.map((p) => ({ id: p.id, name: p.name, kind: p.kind, height: p.height })),
    rides, rideCount: rides.length, distinct: Object.keys(count).length,
    most: most && most[1] > 1 ? { a: byId[most[0]], n: most[1] } : null,
    toppers: { all: TOP, done: TOP.filter((n) => rides.some((r) => r.a.name === n)) },
    loved: loved && loved.avg >= 2.5 ? loved : null,
    queue: { min: Math.round(waits.reduce((s, w) => s + w.m, 0)), n: waits.length, longest: longest ? { a: byId[longest.id], m: Math.round(longest.m) } : null,
      posted: Math.round(waits.filter((w) => w.w != null).reduce((s, w) => s + w.w, 0)) },
    guesser: bestGuess ? { name: name(bestGuess[0]), wins: bestGuess[1] } : null,
    quiz,
    photos, starred: photos.filter((p) => p.star),
    meals: hist.filter((h) => h.k === 'ate').length, pauses: hist.filter((h) => h.k === 'pause').length,
    day, past: day < dayKey(now),
    walk: walkStats({ fam, people, album, now, ...walk }),
  };
}

// ---------- kilometres walked, per person
// Measured: the highest count of any of that person's phones today (fam.walked, app GPS or OwnTracks; `local` = this
// phone's own newer count). It misses the time the app was closed without OwnTracks, so it is a lower bound.
// Estimated: the walk over the park's paths (metres(a, b), straight line × 1.3 without the path graph) from the car and
// the entrance past every ride that person did (in a split: their own half's ride, else the first one they may ride)
// and every place where they took a photo, in time order, and back once the day is over (`ended`). Also a lower bound
// (no detours, toilets, food), so the larger of the two is shown, marked "gemeten" or "geschat". A child walks at
// least as far as the adult who walked least (children have no phone and take no photos).
const PLACES = new Map([...ATTRACTIONS.map((a) => [a.name, a]), ...FOOD.map((f) => [f.name, f]), ...SPOOKY.map((s) => [spotLabel(s), s])]);
const firstName = (email) => String(email || '').split('@')[0].split(/[._]/)[0].toLowerCase();
const straight = (a, b) => distM(a, b) * 1.3;
export function walkStats({ fam, people = [], album = [], now = Date.now(), metres = straight, local = null, ended = false }) {
  // the same day as dayData (parkDay); a day that is already over always ends at the exit/car
  const day = parkDay(fam, now), today = onDay(day, now);
  if (day < dayKey(now)) ended = true;
  const meas = {};
  const walked = { ...(fam?.walked || {}) };
  if (local?.device && local.walk?.day === day) { const w = walked[local.device]?.day === day ? walked[local.device] : { day }; walked[local.device] = { ...w, app: Math.max(w.app || 0, local.walk.m || 0) }; }
  for (const [dev, w] of Object.entries(walked)) {
    const pid = fam?.me?.[dev];
    if (pid && w?.day === day) meas[pid] = Math.max(meas[pid] || 0, w.app || 0, w.ot || 0);
  }
  const log = (fam?.log || []).filter((l) => today(l.t));
  const car = fam?.car && today(fam.car.t) ? fam.car : null;
  const res = people.map((p) => {
    const pts = [];
    for (const l of log) {
      const ids = (l.ids || []).filter((id) => byId[id]);
      if (!ids.length) continue;
      const mine = l.who ? ids.find((id) => l.who[id]?.includes(p.id)) : ids.length > 1 ? ids.find((id) => canRide(p, byId[id])) : null;
      const a = byId[mine || ids[0]]; // not on a ride of this entry: waiting at the meeting point (the first ride's exit)
      pts.push({ t: l.t, lat: a.lat, lon: a.lon });
    }
    for (const ph of album) {
      if (!today(ph.t) || !ph.near || firstName(ph.by) !== String(p.name || '').toLowerCase()) continue;
      const q = ph.lat != null && ph.lon != null ? ph : PLACES.get(ph.near);
      if (q?.lat != null) pts.push({ t: ph.t, lat: q.lat, lon: q.lon });
    }
    pts.sort((a, b) => a.t - b.t);
    let est = 0;
    if (pts.length) {
      const route = [...(car ? [car] : []), ENTRANCE, ...pts, ...(ended ? [ENTRANCE, ...(car ? [car] : [])] : [])];
      for (let i = 1; i < route.length; i++) est += metres(route[i - 1], route[i]);
    }
    const m = Math.round(Math.max(est, meas[p.id] || 0));
    return { id: p.id, name: p.name, kind: p.kind, height: p.height, m, how: m && (meas[p.id] || 0) >= est ? 'gemeten' : 'geschat' };
  });
  // a child has no phone and takes no photos, but is always with an adult: at least the shortest adult walk
  const adults = res.filter((x) => x.kind === 'adult' && x.m >= 100).map((x) => x.m);
  for (const x of res) if (x.kind !== 'adult' && adults.length && Math.min(...adults) > x.m) { x.m = Math.min(...adults); x.how = 'geschat'; }
  return res.filter((x) => x.m >= 100).sort((a, b) => b.m - a.m);
}

// the story slides, in order; each { kind, … } is drawn by wrapped.js
export function slidesFor(d) {
  const s = [{ kind: 'intro' }];
  if (d.rideCount) s.push({ kind: 'rides' });
  if (d.toppers.done.length) s.push({ kind: 'toppers' });
  if (d.loved || d.most) s.push({ kind: 'loved' });
  if (d.queue.n) s.push({ kind: 'queue' });
  if (d.walk?.length && d.walk[0].m >= 500) s.push({ kind: 'walk' });
  if (d.quiz.length) s.push({ kind: 'quiz' });
  if (d.photos.length) s.push({ kind: 'photos' });
  if (d.rides.length + d.photos.length >= 3) s.push({ kind: 'timeline' });
  s.push({ kind: 'outro' });
  return s;
}

// The photo book's pages. Photos in time order, grouped into moments (same ride, or within 20 min, at most 4 per
// page); a starred photo gets a page of its own. Layout per page from the count: hero (1), duo, trio, quad.
export const BOOK_STYLES = [
  { id: 'klassiek', name: 'Klassiek', about: 'Wit papier, veel ruimte, rustige letters' },
  { id: 'polaroid', name: 'Polaroid', about: 'Schuine polaroids op kraftpapier, handgeschreven' },
  { id: 'ibilaw', name: 'Ibilaw-nacht', about: 'Donker, oranje gloed, filmstrook' },
];
export const BOOK_SIZES = { landscape: { w: 2000, h: 1414, pw: 842, ph: 595, name: 'A4 liggend' }, square: { w: 1800, h: 1800, pw: 595, ph: 595, name: 'Vierkant 21 cm' } };
const LAYOUT = ['', 'hero', 'duo', 'trio', 'quad'];
export function bookPlan(d) {
  // cover: a starred photo, else the first one taken in the park (with a place; not the car or home), else any
  const pages = [{ kind: 'cover', photo: d.starred[0] || d.photos.find((p) => p.near && p.full !== false) || d.photos.find((p) => p.full !== false) || d.photos[0] || null }];
  if (d.rideCount || d.photos.length) pages.push({ kind: 'stats' });
  let cur = [];
  const flush = () => { if (cur.length) pages.push({ kind: 'photos', layout: LAYOUT[cur.length], photos: cur, title: titleOf(cur) }); cur = []; };
  for (const p of d.photos) {
    if (p.star) { flush(); pages.push({ kind: 'photos', layout: 'hero', photos: [p], title: titleOf([p]) }); continue; }
    const last = cur.at(-1);
    const sameMoment = last && ((p.near && p.near === last.near) || p.t - last.t < 20 * 60e3);
    if (cur.length && (!sameMoment || cur.length >= 4)) flush();
    cur.push(p);
  }
  flush();
  if (d.rides.length >= 2) pages.push({ kind: 'timeline' });
  pages.push({ kind: 'end' });
  return pages;
}
const titleOf = (ps) => ps.find((p) => p.caption)?.caption || ps.find((p) => p.near)?.near || '';

// ---------- PDF: one JPEG per page, filling the page. pages = [{ jpeg: Uint8Array, w, h, pw, ph }] → Uint8Array
export function makePdf(pages, title = 'Ons fotoboek') {
  const enc = new TextEncoder();
  const parts = [], offsets = [];
  let size = 0;
  const put = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); size += b.length; };
  const obj = (n, body) => { offsets[n] = size; put(`${n} 0 obj\n`); for (const b of [].concat(body)) put(b); put('\nendobj\n'); };
  put('%PDF-1.4\n%PRETPARK\n');
  const n = pages.length, kids = pages.map((_, i) => `${4 + i * 3} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  const t = title.replace(/[()\\]/g, '');
  obj(3, `<< /Title (${t}) /Producer (Pretpark) >>`);
  pages.forEach((p, i) => {
    const pg = 4 + i * 3, ct = pg + 1, im = pg + 2;
    const draw = `q ${p.pw} 0 0 ${p.ph} 0 0 cm /Im0 Do Q`;
    obj(pg, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.pw} ${p.ph}] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${ct} 0 R >>`);
    obj(ct, [`<< /Length ${draw.length} >>\nstream\n`, draw, '\nendstream']);
    obj(im, [`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`, p.jpeg, '\nendstream']);
  });
  const total = 4 + n * 3;
  const xref = size;
  put(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) put(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  put(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let o = 0; for (const b of parts) { out.set(b, o); o += b.length; }
  return out;
}

// "Wrapped" of the day + photo book: the pure part (no DOM), so it can be tested in node.
// - dayData: everything worth telling about one park day, from the shared family state and the album
// - slidesFor: which story slides the Wrapped gets (only the ones with something to say)
// - bookPlan: the photo book's pages (cover, numbers, photo pages with a layout per page, timeline, end)
// - makePdf: a minimal PDF with one full-page JPEG per page (iOS home-screen apps can't print, so the app builds
//   the PDF itself and hands it to the share sheet: save to Files/Books, print, send)
import { byId, COOL } from './logic.js';

const DAY = 14 * 3600e3;
const TOP = Object.entries(COOL).filter(([, t]) => t === 1).map(([n]) => n);
const avg = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);

// fam: the family state; album: [{id, t, near, star, caption, by, w, h, full}]; people: [{id, name, …}]
export function dayData({ fam, album = [], people = [], now = Date.now() }) {
  const today = (t) => t && now - t < DAY && t <= now + 60e3;
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
  const all = [...rides.map((r) => r.t), ...photos.map((p) => p.t)];
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
  };
}

// the story slides, in order; each { kind, … } is drawn by wrapped.js
export function slidesFor(d) {
  const s = [{ kind: 'intro' }];
  if (d.rideCount) s.push({ kind: 'rides' });
  if (d.toppers.done.length) s.push({ kind: 'toppers' });
  if (d.loved || d.most) s.push({ kind: 'loved' });
  if (d.queue.n) s.push({ kind: 'queue' });
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
  const pages = [{ kind: 'cover', photo: d.starred[0] || d.photos.find((p) => p.full !== false) || d.photos[0] || null }];
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

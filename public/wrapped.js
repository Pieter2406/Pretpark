// "Wrapped" of the day + photo book: drawing (canvas). Everything is drawn on a canvas, so what you see is exactly
// what you share: a story slide is a 1080×1920 PNG, a photo book page a JPEG that goes into the PDF (wrapdata.js).
// Loaded lazily by app.js. Photos come in as URLs (thumbnails for slides, originals for the book).
import { BOOK_SIZES } from './wrapdata.js';

export const SLIDE = { w: 1080, h: 1920 };
const FONT = 'Fredoka, ui-rounded, system-ui, sans-serif';
const HAND = 'Caveat, "Comic Sans MS", cursive';
const SERIF = 'Georgia, "Times New Roman", serif';

export async function fontsReady() {
  try { await Promise.all(['700 80px Fredoka', '600 40px Fredoka', '600 60px Caveat'].map((f) => document.fonts.load(f))); } catch { /* fallback fonts */ }
}

// ---------- images: loaded one at a time and dropped after drawing (originals are big on a phone)
export async function loadImg(url) {
  if (!url) return null;
  try {
    const img = new Image(); img.decoding = 'async'; img.crossOrigin = 'use-credentials'; img.src = url;
    await img.decode();
    return img;
  } catch { return null; }
}
function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}
// object-fit: cover into a (rounded) box
function cover(ctx, img, x, y, w, h, r = 0) {
  ctx.save(); rr(ctx, x, y, w, h, r); ctx.clip();
  if (img) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const k = Math.max(w / iw, h / ih), dw = iw * k, dh = ih * k;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2.4, dw, dh); // a little above centre: faces sit high
  } else { ctx.fillStyle = 'rgba(127,127,127,.25)'; ctx.fillRect(x, y, w, h); }
  ctx.restore();
}
// text with wrapping; returns the y after the last line
function text(ctx, s, x, y, { size = 48, weight = 600, color = '#fff', font = FONT, align = 'left', maxW = 9999, lh = 1.15, maxLines = 4 } = {}) {
  ctx.save(); ctx.fillStyle = color; ctx.font = `${weight} ${size}px ${font}`; ctx.textAlign = align; ctx.textBaseline = 'top';
  const words = String(s ?? '').split(/\s+/); const lines = []; let line = '';
  for (const w of words) { const tryL = line ? line + ' ' + w : w; if (ctx.measureText(tryL).width > maxW && line) { lines.push(line); line = w; } else line = tryL; }
  if (line) lines.push(line);
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) shown[maxLines - 1] = shown[maxLines - 1].replace(/.{0,2}$/, '…');
  shown.forEach((l, i) => ctx.fillText(l, x, y + i * size * lh));
  ctx.restore();
  return y + shown.length * size * lh;
}
const hhmm = (t) => new Date(t).toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' });
const dayName = (t) => new Date(t).toLocaleDateString('nl-BE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const emojiOf = (p) => (p.kind === 'adult' ? '🧑' : p.height < 110 ? '👶' : '🧒');

// ---------- Wrapped slides (1080×1920)
const PAL = [['#ff6b35', '#7b2cbf'], ['#f72585', '#3a0ca3'], ['#ffb703', '#fb5607'], ['#06d6a0', '#118ab2'], ['#9d4edd', '#240046'],
  ['#ff006e', '#ffbe0b'], ['#4cc9f0', '#4361ee'], ['#f77f00', '#d62828'], ['#2b2d42', '#8d0801']];
function bg(ctx, i) {
  const [a, b] = PAL[i % PAL.length];
  const g = ctx.createLinearGradient(0, 0, SLIDE.w, SLIDE.h); g.addColorStop(0, a); g.addColorStop(1, b);
  ctx.fillStyle = g; ctx.fillRect(0, 0, SLIDE.w, SLIDE.h);
  // soft shapes for depth
  ctx.save(); ctx.globalAlpha = 0.14; ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(SLIDE.w * 0.85, SLIDE.h * 0.12, 260, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(SLIDE.w * 0.1, SLIDE.h * 0.9, 340, 0, 7); ctx.fill(); ctx.restore();
}
function foot(ctx, d) {
  text(ctx, `Pretpark · Walibi · ${new Date(d.first || d.now).toLocaleDateString('nl-BE', { day: 'numeric', month: 'short', year: 'numeric' })}`, SLIDE.w / 2, SLIDE.h - 110, { size: 34, weight: 500, align: 'center', color: 'rgba(255,255,255,.8)' });
}
// assets: { photo(p) → thumbnail URL, ridePhoto(a) → URL | null }
export async function drawSlide(ctx, slide, i, d, assets) {
  const W = SLIDE.w, M = 90;
  bg(ctx, i);
  const big = (n, y, sub) => { text(ctx, String(n), M, y, { size: 300, weight: 700 }); if (sub) text(ctx, sub, M, y + 320, { size: 70, weight: 600, maxW: W - 2 * M }); };
  switch (slide.kind) {
    case 'intro': {
      const p = d.starred[0] || d.photos.filter((x) => x.near).at(-1) || d.photos.at(-1); // a park photo, not the one from home
      const img = p ? await loadImg(assets.photo(p)) : null;
      if (img) { ctx.save(); ctx.translate(W / 2, 760); ctx.rotate(-0.04); ctx.fillStyle = '#fff'; ctx.fillRect(-400, -460, 800, 960); cover(ctx, img, -370, -430, 740, 800, 8); ctx.restore(); }
      text(ctx, 'Onze dag in Walibi', M, img ? 1330 : 520, { size: 104, weight: 700, maxW: W - 2 * M });
      text(ctx, d.first ? dayName(d.first) : '', M, img ? 1560 : 800, { size: 52, weight: 500, color: 'rgba(255,255,255,.9)' });
      text(ctx, d.people.map((p) => `${emojiOf(p)} ${p.name}`).join('   '), M, img ? 1650 : 900, { size: 44, weight: 500, maxW: W - 2 * M, maxLines: 2 });
      break;
    }
    case 'rides':
      text(ctx, 'Jullie deden', M, 300, { size: 64 });
      big(d.rideCount, 400, d.rideCount === 1 ? 'ritje' : 'ritjes');
      text(ctx, `${d.distinct} verschillende attracties`, M, 1150, { size: 56, weight: 500 });
      if (d.first) text(ctx, `van ${hhmm(d.first)} tot ${hhmm(d.last)}`, M, 1240, { size: 56, weight: 500, color: 'rgba(255,255,255,.85)' });
      text(ctx, [...new Set(d.rides.map((r) => r.a.icon))].join(' '), M, 1400, { size: 90, maxW: W - 2 * M, lh: 1.3, maxLines: 3 });
      break;
    case 'toppers': {
      text(ctx, 'De grote toppers', M, 260, { size: 70 });
      big(`${d.toppers.done.length}/${d.toppers.all.length}`, 360);
      let y = 760;
      for (const n of d.toppers.all) { const ok = d.toppers.done.includes(n); text(ctx, `${ok ? '✅' : '◻️'}  ${n}`, M, y, { size: 58, weight: ok ? 700 : 500, color: ok ? '#fff' : 'rgba(255,255,255,.55)' }); y += 105; }
      text(ctx, d.toppers.done.length === d.toppers.all.length ? 'Allemaal gedaan. Respect!' : 'Volgende keer de rest?', M, y + 40, { size: 54, weight: 600 });
      break;
    }
    case 'loved': {
      const a = d.loved?.a || d.most?.a;
      text(ctx, d.loved ? 'Jullie favoriet' : 'Deden jullie het vaakst', M, 260, { size: 70 });
      const img = await loadImg(assets.ridePhoto(a) || (d.photos.find((p) => p.near === a.name) && assets.photo(d.photos.find((p) => p.near === a.name))));
      if (img) cover(ctx, img, M, 400, W - 2 * M, 800, 40);
      else text(ctx, a.icon, W / 2, 520, { size: 420, align: 'center' });
      text(ctx, a.name, M, 1260, { size: 110, weight: 700, maxW: W - 2 * M, maxLines: 2 });
      const faces = d.loved ? Object.values(d.loved.r).map((v) => ({ 3: '😍', 2: '🙂', 1: '😬' }[v])).join(' ') : `${d.most.n}× gedaan`;
      text(ctx, faces, M, 1520, { size: 90 });
      break;
    }
    case 'queue':
      text(ctx, 'Samen in de rij', M, 300, { size: 70 });
      big(d.queue.min, 400, d.queue.min === 1 ? 'minuut' : 'minuten');
      text(ctx, `in ${d.queue.n} ${d.queue.n === 1 ? 'rij' : 'rijen'}${d.queue.posted ? ` (aangekondigd: ${d.queue.posted} min)` : ''}`, M, 1150, { size: 54, weight: 500, maxW: W - 2 * M });
      if (d.queue.longest) text(ctx, `Langste: ${d.queue.longest.a.icon} ${d.queue.longest.a.name}, ${d.queue.longest.m} min`, M, 1300, { size: 54, maxW: W - 2 * M });
      if (d.guesser) text(ctx, `🔮 Beste rader: ${d.guesser.name} (${d.guesser.wins}×)`, M, 1460, { size: 58, weight: 700, maxW: W - 2 * M });
      break;
    case 'walk': {
      const w = d.walk, km = (m) => (m / 1000).toLocaleString('nl-BE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      const same = w.length > 1 && w.every((x) => km(x.m) === km(w[0].m)); // all together all day
      text(ctx, 'Gestapt vandaag', M, 260, { size: 70 });
      big(km(w[0].m), 360, same ? 'km · samen' : `km · ${w[0].name}`);
      text(ctx, '👟', W - M - 200, 300, { size: 200 });
      let y = 900;
      if (same) { text(ctx, w.map((x) => `${emojiOf(x)} ${x.name}`).join('   '), M, y, { size: 54, weight: 600, maxW: W - 2 * M, maxLines: 3 }); y += 220; }
      else for (const x of w.slice(1, 5)) { text(ctx, `${emojiOf(x)} ${x.name}: ${km(x.m)} km`, M, y, { size: 60, weight: 600, maxW: W - 2 * M, maxLines: 1 }); y += 95; }
      const steps = Math.round(w[0].m / 0.72 / 1000) * 1000; // ≈ 0.72 m per adult step
      text(ctx, `≈ ${steps.toLocaleString('nl-BE')} stappen ${same ? 'per volwassene' : `voor ${w[0].name}`}`, M, y + 30, { size: 52, weight: 500, color: 'rgba(255,255,255,.9)', maxW: W - 2 * M });
      const how = w.every((x) => x.how === 'gemeten') ? 'gemeten met de gps' : w.every((x) => x.how === 'geschat') ? 'geschat langs de paden van de attracties en foto’s' : 'gemeten met de gps of geschat langs de paden';
      text(ctx, how, M, y + 130, { size: 40, weight: 500, color: 'rgba(255,255,255,.75)', maxW: W - 2 * M, maxLines: 2 });
      break;
    }
    case 'quiz': {
      text(ctx, 'Quizkampioen', M, 300, { size: 80 });
      text(ctx, '👑', M, 450, { size: 200 });
      text(ctx, d.quiz[0].name, M, 720, { size: 130, weight: 700, maxW: W - 2 * M, maxLines: 2 });
      text(ctx, `${d.quiz[0].pts} van ${d.quiz[0].n} juist`, M, 1000, { size: 64, weight: 500 });
      let y = 1180; for (const q of d.quiz.slice(1, 4)) { text(ctx, `${q.name}: ${q.pts}/${q.n}`, M, y, { size: 52, weight: 500, color: 'rgba(255,255,255,.85)' }); y += 80; }
      break;
    }
    case 'photos': {
      text(ctx, `${d.photos.length} ${d.photos.length === 1 ? 'foto' : 'foto’s'}`, M, 230, { size: 110, weight: 700 });
      const pick = [...d.starred, ...d.photos.filter((p) => !p.star)].slice(0, 6);
      const cols = 2, gap = 30, cw = (W - 2 * M - gap) / cols, rows = Math.ceil(pick.length / cols);
      const ch = Math.min(cw * 1.15, (SLIDE.h - 420 - 200 - gap * (rows - 1)) / rows); // never into the footer
      for (let k = 0; k < pick.length; k++) {
        const img = await loadImg(assets.photo(pick[k]));
        const x = M + (k % cols) * (cw + gap), y = 420 + Math.floor(k / cols) * (ch + gap);
        ctx.save(); ctx.translate(x + cw / 2, y + ch / 2); ctx.rotate((k % 2 ? 1 : -1) * 0.025); cover(ctx, img, -cw / 2, -ch / 2, cw, ch, 24); ctx.restore();
      }
      break;
    }
    case 'timeline': {
      text(ctx, 'Zo verliep jullie dag', M, 220, { size: 74, maxW: W - 2 * M });
      const items = [...d.rides.map((r) => ({ t: r.t, s: `${r.a.icon} ${r.a.name}` })), ...d.photos.filter((p) => p.star).map((p) => ({ t: p.t, s: `📸 ${p.caption || p.near || 'foto'}` }))].sort((a, b) => a.t - b.t);
      const show = items.length > 13 ? [...items.slice(0, 6), { t: null, s: '…' }, ...items.slice(-6)] : items;
      ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.fillRect(M + 160, 420, 6, show.length * 100);
      show.forEach((x, k) => { const y = 400 + k * 100; if (x.t) text(ctx, hhmm(x.t), M, y, { size: 44, weight: 600 }); text(ctx, x.s, M + 200, y, { size: 48, weight: 500, maxW: W - M - 200 - M, maxLines: 1 }); });
      break;
    }
    case 'outro':
      text(ctx, 'Tot de volgende keer, Walibi!', M, 560, { size: 110, weight: 700, maxW: W - 2 * M });
      text(ctx, d.people.map(emojiOf).join(' '), M, 1000, { size: 140 });
      text(ctx, d.photos.length ? '📕 Maak er een fotoboek van in Pretpark' : 'Neem de volgende keer foto’s in het album 📸', M, 1300, { size: 54, weight: 500, maxW: W - 2 * M });
      break;
  }
  foot(ctx, d);
}

// ---------- photo book pages
const STY = {
  klassiek: { bg: '#fbf8f2', ink: '#2b2622', muted: '#8a8178', accent: '#c0392b', title: FONT, cap: SERIF },
  polaroid: { bg: '#c9a679', ink: '#2b1d10', muted: '#5b4630', accent: '#b5651d', title: HAND, cap: HAND },
  ibilaw: { bg: '#120b1c', ink: '#f6eeff', muted: '#b6a9cf', accent: '#ff7a1a', title: FONT, cap: FONT },
};
function paper(ctx, w, h, st, style) {
  ctx.fillStyle = st.bg; ctx.fillRect(0, 0, w, h);
  if (style === 'polaroid') { // kraft paper grain
    let s = 7; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    ctx.save(); for (let i = 0; i < 2600; i++) { ctx.globalAlpha = 0.05 + r() * 0.07; ctx.fillStyle = r() > 0.5 ? '#7a5a34' : '#e8d1ad'; ctx.fillRect(r() * w, r() * h, 2 + r() * 4, 1 + r() * 2); } ctx.restore();
  }
  if (style === 'ibilaw') { const g = ctx.createRadialGradient(w / 2, h * 1.1, 0, w / 2, h * 1.1, h); g.addColorStop(0, 'rgba(255,122,26,.25)'); g.addColorStop(1, 'rgba(255,122,26,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); }
}
// one photo in the page style; rot in radians (polaroid)
function framed(ctx, img, x, y, w, h, style, st, cap, rot = 0) {
  if (style === 'polaroid') {
    ctx.save(); ctx.translate(x + w / 2, y + h / 2); ctx.rotate(rot);
    const pad = w * 0.05, bottom = h * 0.16;
    ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 8;
    ctx.fillStyle = '#fffdf8'; ctx.fillRect(-w / 2, -h / 2, w, h); ctx.shadowColor = 'transparent';
    cover(ctx, img, -w / 2 + pad, -h / 2 + pad, w - 2 * pad, h - pad - bottom);
    if (cap) text(ctx, cap, 0, h / 2 - bottom + bottom * 0.18, { size: Math.min(64, bottom * 0.5), weight: 600, font: HAND, color: st.ink, align: 'center', maxW: w - 2 * pad, maxLines: 1 });
    // washi tape
    ctx.globalAlpha = 0.75; ctx.fillStyle = '#f2c14e'; ctx.rotate(-0.08); ctx.fillRect(-w * 0.12, -h / 2 - 22, w * 0.24, 46);
    ctx.restore(); return;
  }
  if (style === 'ibilaw') {
    ctx.save(); ctx.shadowColor = 'rgba(255,122,26,.7)'; ctx.shadowBlur = 40; ctx.fillStyle = '#000'; ctx.fillRect(x, y, w, h); ctx.restore();
    cover(ctx, img, x, y, w, h, 6);
    ctx.strokeStyle = st.accent; ctx.lineWidth = 4; rr(ctx, x, y, w, h, 6); ctx.stroke();
    if (cap) text(ctx, cap, x + 18, y + h - 70, { size: 40, weight: 600, color: '#fff', maxW: w - 36, maxLines: 1 });
    return;
  }
  cover(ctx, img, x, y, w, h, 4);
  if (cap) text(ctx, cap, x, y + h + 14, { size: 36, weight: 400, font: SERIF, color: st.muted, maxW: w, maxLines: 1 });
}
// boxes for 1–4 photos inside the content area
function boxes(layout, x, y, w, h, g) {
  if (layout === 'hero') return [[x, y, w, h]];
  if (layout === 'duo') return w >= h ? [[x, y, (w - g) / 2, h], [x + (w + g) / 2, y, (w - g) / 2, h]] : [[x, y, w, (h - g) / 2], [x, y + (h + g) / 2, w, (h - g) / 2]];
  if (layout === 'trio') { const bw = w * 0.6; return [[x, y, bw, h], [x + bw + g, y, w - bw - g, (h - g) / 2], [x + bw + g, y + (h + g) / 2, w - bw - g, (h - g) / 2]]; }
  return [[x, y, (w - g) / 2, (h - g) / 2], [x + (w + g) / 2, y, (w - g) / 2, (h - g) / 2], [x, y + (h + g) / 2, (w - g) / 2, (h - g) / 2], [x + (w + g) / 2, y + (h + g) / 2, (w - g) / 2, (h - g) / 2]];
}
// assets: { full(p) → original URL }
export async function drawPage(ctx, page, d, { style = 'klassiek', size = 'landscape', n = 1, of = 1 } = {}, assets) {
  const S = BOOK_SIZES[size], W = S.w, H = S.h, st = STY[style] || STY.klassiek;
  const M = Math.round(Math.min(W, H) * 0.07), k = Math.min(W, H) / 1414; // sizes scale with the page
  paper(ctx, W, H, st, style);
  const pageNo = () => { if (page.kind !== 'cover') text(ctx, String(n), W - M, H - M * 0.7, { size: 38 * k, weight: 500, color: st.muted, align: 'right' }); };
  switch (page.kind) {
    case 'cover': {
      const img = await loadImg(page.photo && assets.full(page.photo));
      const title = 'Onze dag in Walibi', sub = d.first ? dayName(d.first) : '';
      if (style === 'ibilaw') {
        cover(ctx, img, 0, 0, W, H);
        const g = ctx.createLinearGradient(0, H * 0.35, 0, H); g.addColorStop(0, 'rgba(18,11,28,0)'); g.addColorStop(1, 'rgba(18,11,28,.95)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        text(ctx, title, M, H - M - 230, { size: 120, weight: 700, color: st.accent, maxW: W - 2 * M });
        text(ctx, sub, M, H - M - 80, { size: 50, weight: 500, color: '#fff' });
      } else if (style === 'polaroid') {
        const fw = Math.min(W, H) * 0.62, fh = fw * 1.18;
        framed(ctx, img, W / 2 - fw / 2 - (W > H ? W * 0.12 : 0), (H - fh) / 2, fw, fh, style, st, '', -0.05);
        const tx = W > H ? W * 0.62 : W / 2;
        text(ctx, title, tx, H * (W > H ? 0.32 : 0.06), { size: 120, weight: 600, font: HAND, color: st.ink, align: W > H ? 'left' : 'center', maxW: W > H ? W * 0.34 : W - 2 * M });
        text(ctx, sub, tx, H * (W > H ? 0.62 : 0.9), { size: 54, weight: 600, font: HAND, color: st.muted, align: W > H ? 'left' : 'center', maxW: W > H ? W * 0.34 : W - 2 * M });
      } else {
        cover(ctx, img, M, M, W - 2 * M, H * 0.66, 4);
        text(ctx, title, M, H * 0.66 + M * 1.4, { size: 96, weight: 600, color: st.ink, maxW: W - 2 * M });
        text(ctx, `${sub} · ${d.people.map((p) => p.name).join(', ')}`, M, H * 0.66 + M * 1.4 + 120, { size: 38, weight: 400, font: SERIF, color: st.muted, maxW: W - 2 * M, maxLines: 2 });
      }
      break;
    }
    case 'stats': {
      text(ctx, 'Onze dag in cijfers', M, M, { size: (style === 'polaroid' ? 120 : 92) * k, weight: 600, font: st.title, color: style === 'ibilaw' ? st.accent : st.ink });
      const cells = [[d.rideCount, d.rideCount === 1 ? 'ritje' : 'ritjes'], [d.distinct, 'attracties'], [d.photos.length, 'foto’s'], [`${d.toppers.done.length}/${d.toppers.all.length}`, 'toppers'],
        ...(d.queue.n ? [[d.queue.min, 'minuten in de rij']] : []),
        ...(d.walk?.length && d.walk[0].m >= 500 ? [[`${(d.walk[0].m / 1000).toLocaleString('nl-BE', { maximumFractionDigits: 1 })} km`, d.walk.length > 1 && d.walk.every((x) => Math.round(x.m / 100) === Math.round(d.walk[0].m / 100)) ? 'gestapt, samen' : `gestapt (${d.walk[0].name})`]] : []), ...(d.first ? [[`${hhmm(d.first)}–${hhmm(d.last)}`, 'eerste–laatste rit']] : [])];
      const cols = W > H ? 3 : 2, cw = (W - 2 * M) / cols, top = M + 230 * k, rowH = (H - top - M - 110 * k) / Math.ceil(cells.length / cols);
      cells.forEach(([v, l], c) => {
        const x = M + (c % cols) * cw, y = top + Math.floor(c / cols) * rowH;
        const vs = String(v).length > 6 ? 120 : 170;
        text(ctx, String(v), x, y, { size: vs * k, weight: 700, color: style === 'ibilaw' ? st.accent : st.ink, font: FONT });
        text(ctx, l, x, y + (vs + 24) * k, { size: (style === 'polaroid' ? 70 : 56) * k, weight: 500, color: st.muted, font: style === 'polaroid' ? HAND : FONT, maxW: cw - 30, maxLines: 2 });
      });
      const fav = d.loved?.a || d.most?.a;
      if (fav) text(ctx, `Favoriet: ${fav.icon} ${fav.name}`, M, H - M - 70 * k, { size: (style === 'polaroid' ? 76 : 60) * k, weight: 600, color: st.ink, font: style === 'polaroid' ? HAND : FONT });
      pageNo(); break;
    }
    case 'photos': {
      const head = page.title ? 110 : 0;
      if (page.title) text(ctx, `${hhmm(page.photos[0].t)} · ${page.title}`, M, M * 0.8, { size: style === 'polaroid' ? 72 : 52, weight: 600, font: st.title, color: style === 'ibilaw' ? st.accent : st.ink, maxW: W - 2 * M, maxLines: 1 });
      const g = style === 'polaroid' ? M * 0.6 : M * 0.35;
      const bxs = boxes(page.layout, M, M * 0.8 + head, W - 2 * M, H - M * 1.6 - head - (style === 'klassiek' ? 60 : 0), g);
      for (let k = 0; k < page.photos.length; k++) {
        const p = page.photos[k], img = await loadImg(assets.full(p));
        const [x, y, w, h] = bxs[k];
        const cap = style === 'klassiek' ? (p.caption || '') : style === 'polaroid' ? (p.caption || p.near || hhmm(p.t)) : (p.caption || '');
        framed(ctx, img, x, y, w, h, style, st, cap, style === 'polaroid' ? [-0.035, 0.03, -0.02, 0.04][k] : 0);
        if (img) img.src = ''; // free the original's memory before the next one
      }
      pageNo(); break;
    }
    case 'timeline': {
      text(ctx, 'Wat we deden', M, M, { size: (style === 'polaroid' ? 120 : 92) * k, weight: 600, font: st.title, color: style === 'ibilaw' ? st.accent : st.ink });
      const rows = d.rides.map((r) => `${hhmm(r.t)}   ${r.a.icon} ${r.a.name}`);
      const top = M + 230 * k, cols = rows.length > 9 ? 2 : 1, per = Math.ceil(rows.length / cols), lh = Math.min(110 * k, (H - top - M) / per);
      rows.forEach((r, c) => text(ctx, r, M + Math.floor(c / per) * ((W - 2 * M) / cols), top + (c % per) * lh, { size: Math.min((style === 'polaroid' ? 76 : 62) * k, lh * 0.72), weight: 500, color: st.ink, font: style === 'polaroid' ? HAND : FONT, maxW: (W - 2 * M) / cols - 20, maxLines: 1 }));
      pageNo(); break;
    }
    case 'end':
      text(ctx, 'Tot de volgende keer!', W / 2, H * 0.36, { size: style === 'polaroid' ? 130 : 100, weight: 600, font: st.title, color: style === 'ibilaw' ? st.accent : st.ink, align: 'center', maxW: W - 2 * M });
      text(ctx, d.people.map(emojiOf).join(' '), W / 2, H * 0.56, { size: 110, align: 'center' });
      text(ctx, `Walibi · ${d.first ? dayName(d.first) : ''}`, W / 2, H * 0.76, { size: 40, weight: 500, color: st.muted, align: 'center', font: style === 'klassiek' ? SERIF : st.cap });
      break;
  }
  void of;
}

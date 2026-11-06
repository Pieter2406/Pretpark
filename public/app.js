// Pretpark: the screens. State lives in S; every change calls render(). The shared family state lives on the
// server (family.js actions); wait times come from /api/live; walking routes from route.js over park.json.
import { ATTRACTIONS, FOOD, ENTRANCE } from './data.js';
import { plans, foodOptions, canRide, status, byId, walkMin, isMealTime, distM } from './logic.js';
import { makePark, pathLength, bearingXY } from './route.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('pp:' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pp:' + k, JSON.stringify(v)); } catch { /* private mode: fine */ } },
};
const rnd = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
const buzz = () => navigator.vibrate?.(12);

const device = store.get('device') || (() => { const d = rnd(16); store.set('device', d); return d; })();
const S = {
  famId: null, fam: null, live: null, park: null, here: null, plans: [],
  gps: null, manual: store.get('manual', null), sim: 'wait', heading: null, headingSrc: null,
  tab: 'now', guide: null, filter: 'us', mapZoom: true, placing: false, dismissed: store.get('dismissed', {}), offline: false,
};

// ---------- people
const people = () => S.fam?.people || [];
const meId = () => S.fam?.me?.[device] || null;
const person = (id) => people().find((p) => p.id === id);
const emoji = (p) => (p.pregnant ? '🤰' : p.kind === 'adult' ? '🧑' : p.height < 110 ? '👶' : '🧒');
const pname = (p) => (p.id === meId() ? 'Jij' : p.name);

// ---------- network
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.status), { status: res.status });
  return data;
}
async function act(a, quiet = false) {
  try {
    const r = await api('/api/family/' + S.famId, { method: 'POST', body: a });
    S.fam = r.fam; S.offline = false;
    recompute(); if (!quiet) render();
    return true;
  } catch (e) {
    if (!quiet) toast('Geen verbinding. Probeer zo opnieuw.');
    S.offline = true; renderBanners();
    return false;
  }
}

async function loadFamily() {
  const url = new URL(location.href);
  let id = url.searchParams.get('g') || store.get('fam');
  if (id) {
    try { const r = await api('/api/family/' + id); S.fam = r.fam; S.famId = id; } catch (e) { if (e.status !== 404) throw e; id = null; }
  }
  if (!id) { const r = await api('/api/family', { method: 'POST' }); S.fam = r.fam; S.famId = r.id; }
  store.set('fam', S.famId);
  // keep the family in the address, so "Add to Home Screen" and sharing carry it
  url.searchParams.set('g', S.famId);
  history.replaceState(null, '', url.pathname + '?g=' + S.famId);
  return url;
}
async function loadLive() {
  try { S.live = await api('/api/live'); S.offline = false; } catch { S.offline = true; }
  recompute(); render();
}
async function pollFamily() {
  if (document.hidden) return;
  try {
    const r = await api('/api/family/' + S.famId);
    if (JSON.stringify(r.fam) !== JSON.stringify(S.fam)) { S.fam = r.fam; recompute(); render(); }
  } catch { /* next time */ }
}

// ---------- position
const pos = () => {
  if (S.manual && Date.now() - S.manual.t < 20 * 60e3) return S.manual;
  if (S.gps && S.sim === null) return S.gps;
  return ENTRANCE;
};
let lastPlanPos = null, lastPost = { t: 0, p: null };
function onGps(p) {
  S.gps = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
  S.sim = distM(S.gps, ENTRANCE) > 1500 ? 'far' : null;
  if (S.headingSrc !== 'compass' && p.coords.heading != null && p.coords.speed > 0.6) { S.heading = p.coords.heading; S.headingSrc = 'gps'; }
  const here = pos();
  if (!lastPlanPos || distM(lastPlanPos, here) > 12) { recompute(); render(); }
  else updateGuide();
  if (!S.sim && (!lastPost.p || (distM(lastPost.p, here) > 25 && Date.now() - lastPost.t > 60e3) || Date.now() - lastPost.t > 180e3)) {
    lastPost = { t: Date.now(), p: here };
    act({ type: 'pos', device, lat: here.lat, lon: here.lon }, true);
  }
}
function startGps() {
  if (!navigator.geolocation) { S.sim = 'off'; return; }
  navigator.geolocation.watchPosition(onGps, () => { S.sim = 'off'; recompute(); render(); }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}

// ---------- compass
let smooth = null;
function onOrientation(e) {
  let h = null;
  if (e.webkitCompassHeading != null) h = e.webkitCompassHeading;
  else if (e.absolute && e.alpha != null) h = 360 - e.alpha;
  if (h == null) return;
  h = (h + (screen.orientation?.angle || 0) + 360) % 360;
  if (smooth == null) smooth = h;
  else { let d = ((h - smooth + 540) % 360) - 180; smooth = (smooth + d * 0.25 + 360) % 360; }
  S.heading = smooth; S.headingSrc = 'compass';
  updateGuideSoon();
}
async function enableCompass(fromTap) {
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) return false;
  if (typeof DOE.requestPermission === 'function') {
    if (!fromTap) return false;
    try { if ((await DOE.requestPermission()) !== 'granted') { toast('Kompas niet toegestaan'); return false; } } catch { return false; }
  }
  addEventListener('deviceorientationabsolute', onOrientation, true);
  addEventListener('deviceorientation', onOrientation, true);
  store.set('compass', true);
  return true;
}
let guideTimer = null;
const updateGuideSoon = () => { if (!guideTimer) guideTimer = requestAnimationFrame(() => { guideTimer = null; updateGuide(); }); };

// ---------- planning
function recompute() {
  if (!S.park || !S.fam) return;
  const here = pos();
  lastPlanPos = here;
  S.here = S.park.fromHere(here);
  const minutesLeft = S.live?.close ? Math.round((S.live.close - Date.now()) / 60e3) : null;
  S.plans = S.live ? plans({
    people: people(), favs: S.fam.favs, done: S.fam.done, live: S.live, walk: (a) => S.here.metres(a),
    month: new Date().getMonth(), minutesLeft: minutesLeft != null && minutesLeft > 0 ? minutesLeft : null,
  }) : [];
}
const walkOf = (x) => (S.here ? S.here.metres(x) : distM(pos(), x) * 1.35);

// ---------- small render helpers
function waitBadge(id) {
  const st = status(S.live, id);
  if (!st.known) return '<span class="wait w-off">geen info</span>';
  if (!st.open) return `<span class="wait w-off">${st.s === 'DOWN' ? 'storing' : 'dicht'}</span>`;
  if (st.wait == null) return '<span class="wait w-off">open</span>';
  const cls = st.wait <= 10 ? 'w-ok' : st.wait <= 25 ? 'w-mid' : 'w-bad';
  return `<span class="wait ${cls}" aria-label="${st.wait} minuten wachten">${st.wait}′</span>`;
}
const chip = (id, watch) => { const p = person(id); if (!p) return ''; return `<span class="chip ${watch ? 'watch' : ''} ${id === meId() ? 'me' : ''}">${emoji(p)} ${esc(pname(p))}${watch ? ' · kijkt toe' : ''}</span>`; };
const mins = (m) => `${walkMin(m)} min`;

function notesFor(part) {
  const a = byId[part.id]; const out = [];
  if (!a) return out;
  for (const id of part.escorted || []) { const p = person(id); if (p) out.push(['🤝', `${esc(p.name)} rijdt mee met een volwassene`]); }
  for (const id of part.watch || []) {
    const p = person(id); if (!p) continue;
    out.push(['👀', p.pregnant ? `${esc(p.name)} kijkt toe: niet voor zwangeren` : `${esc(p.name)} mag niet mee en kijkt toe`]);
  }
  if (a.preg && people().some((p) => p.pregnant) && (part.ride || []).some((id) => person(id)?.pregnant)) out.push(['🤰', 'Rustige attractie, check het bordje voor zwangeren']);
  if (a.wet) out.push(['💧', 'Je kan nat worden']);
  if (a.indoor) out.push(['🏠', 'Binnen']);
  if (!part.waitKnown) out.push(['❔', 'Wachttijd niet bekend']);
  return out;
}
const notesHtml = (n) => (n.length ? `<ul class="notes">${n.map(([i, t]) => `<li><span aria-hidden="true">${i}</span><span>${t}</span></li>`).join('')}</ul>` : '');

function ticket(plan, chosen) {
  if (plan.type === 'together') {
    const pt = plan.parts[0], a = byId[pt.id];
    const live = status(S.live, pt.id);
    const wait = live.wait ?? pt.wait;
    return `<article class="ticket" style="--notch: 62%">
      <div class="what"><div class="icon" aria-hidden="true">${a.icon}</div><h2>${esc(a.name)}</h2>
        <div class="who">${(pt.ride || []).map((id) => chip(id)).join('')}${(pt.watch || []).map((id) => chip(id, true)).join('')}</div></div>
      <div class="how">
        <div class="stats"><div class="stat"><b>${live.open || !live.known ? wait + '′' : '—'}</b><span>${live.open || !live.known ? 'wachten' : 'nu dicht'}</span></div>
        <div class="stat"><b>${walkMin(walkOf(a))}′</b><span>stappen</span></div></div>
        ${notesHtml(notesFor(pt))}
        <button class="primary big" data-go="${chosen ? 'guide' : 'choose:0'}">🧭 ${chosen ? 'Breng me erheen' : 'Doen! Breng me erheen'}</button>
        ${chosen ? '<div class="row2"><button data-go="done">✓ Gedaan</button><button data-go="untarget">✕ Iets anders</button></div>' : ''}
      </div></article>`;
  }
  const mine = myPart(plan);
  const halves = plan.parts.map((pt) => {
    const isMine = pt === mine;
    const who = pt.group.map((id) => chip(id)).join('');
    if (pt.rest) {
      const m = byId[plan.meet];
      return `<div class="half ${isMine ? 'mine' : ''}"><div class="who">${who}</div><h3>🪑 Even rusten</h3>
        <div class="meta muted">Zoek een bankje of terras in de buurt van ${esc(m.name)}.</div></div>`;
    }
    const a = byId[pt.id], live = status(S.live, pt.id);
    return `<div class="half ${isMine ? 'mine' : ''}"><div class="who">${who}</div><h3><span aria-hidden="true">${a.icon}</span> ${esc(a.name)}</h3>
      <div class="meta">⏱ <b>${live.wait ?? pt.wait} min</b> wachten · 🚶 ${mins(walkOf(a))} stappen</div>
      ${notesHtml(notesFor(pt).filter(([i]) => i !== '👀'))}</div>`;
  }).join('');
  return `<article class="ticket" style="--notch: -100px">
    <div class="halves">${halves}</div>
    <div class="meet">📍 Daarna afspreken aan de uitgang van <b>${esc(byId[plan.meet].name)}</b></div>
    <div class="how">
      <button class="primary big" data-go="${chosen ? 'guide' : 'choose:0'}">🧭 ${chosen ? 'Breng me erheen' : 'Doen! Breng me erheen'}</button>
      ${chosen ? '<div class="row2"><button data-go="done">✓ Gedaan</button><button data-go="untarget">✕ Iets anders</button></div>' : ''}
    </div></article>`;
}
function myPart(plan) {
  return plan.parts.find((pt) => pt.group.includes(meId())) || plan.parts[0];
}
function guideTargetFor(plan) {
  const pt = myPart(plan);
  const a = byId[pt.rest ? plan.meet : pt.id];
  return { kind: pt.rest ? 'meet' : 'ride', id: a.id, name: pt.rest ? `Bij ${a.name}` : a.name, icon: pt.rest ? '🪑' : a.icon, lat: a.lat, lon: a.lon };
}

// ---------- views
function renderNow() {
  const el = $('#view-now');
  if (!S.fam) { el.innerHTML = '<p class="empty">Laden…</p>'; return; }
  let html = '';
  if (!meId()) {
    const adults = people().filter((p) => p.kind === 'adult');
    html += `<div class="card"><h2>Wie gebruikt deze gsm?</h2><p class="muted small">Dan weet ik wie waarheen moet als jullie splitsen.</p>
      <div class="seg">${adults.map((p) => `<button data-me="${p.id}">${emoji(p)} ${esc(p.name)}</button>`).join('')}</div></div>`;
  }
  const t = S.fam.target;
  if (t?.plan) {
    const ago = Math.round((Date.now() - t.setAt) / 60e3);
    html += `<p class="kicker">Jullie plan · ${ago < 1 ? 'net gekozen' : ago + ' min geleden'}</p>` + ticket(t.plan, true);
  } else if (!S.live) {
    html += '<p class="kicker">Doe nu dit</p><div class="ticket"><div class="what"><p class="empty">Wachttijden laden…</p></div></div>';
  } else if (!S.plans.length) {
    html += `<p class="kicker">Doe nu dit</p><div class="ticket"><div class="what"><h2>Niets open op dit moment</h2>
      <p class="muted">Er zijn geen attracties open (of het park is dicht). Tijd voor een snack?</p></div></div>`;
  } else {
    html += '<p class="kicker">Doe nu dit</p>' + ticket(S.plans[0], false);
  }
  html += `<div class="quick">
    <button data-go="food"><span aria-hidden="true">🍽️</span>Eten</button>
    <button data-go="toilet"><span aria-hidden="true">🚻</span>Toilet</button>
    <button data-go="pause"><span aria-hidden="true">🪑</span>Pauze</button>
    <button data-tab-go="map"><span aria-hidden="true">📍</span>Waar ben ik</button></div>`;
  const alts = S.plans.filter((p) => p.key !== t?.plan?.key).slice(t ? 0 : 1, t ? 3 : 4);
  if (alts.length) {
    html += `<p class="kicker">${t ? 'Of liever' : 'Ook goed'}</p><div class="alts">` + alts.map((p) => {
      const i = S.plans.indexOf(p);
      if (p.type === 'together') {
        const a = byId[p.parts[0].id];
        return `<button class="alt" data-go="choose:${i}"><span class="ic" aria-hidden="true">${a.icon}</span>
          <span><span class="t">${esc(a.name)}</span><span class="s">Iedereen · ${mins(walkOf(a))} stappen</span></span>${waitBadge(a.id)}</button>`;
      }
      const [x, y] = p.parts; const a = byId[x.id];
      return `<button class="alt" data-go="choose:${i}"><span class="ic" aria-hidden="true">${a.icon}</span>
        <span><span class="t">${esc(a.name)} <span class="muted">+ ${y.rest ? 'rust' : esc(byId[y.id].name)}</span></span>
        <span class="s">Splitsen · ${x.group.map((id) => emoji(person(id) || {})).join('')} / ${y.group.map((id) => emoji(person(id) || {})).join('')}</span></span>${waitBadge(a.id)}</button>`;
    }).join('') + '</div>';
  }
  el.innerHTML = html;
}

function renderList() {
  const el = $('#view-list');
  const ps = people();
  const f = S.filter;
  const can = (a) => ps.map((p) => canRide(p, a));
  let rows = ATTRACTIONS.map((a) => ({ a, st: status(S.live, a.id), can: can(a), walk: walkOf(a) }));
  rows = rows.filter(({ a, can: c }) => {
    if (f === 'fav') return S.fam.favs.includes(a.id);
    if (f === 'small') return ps.some((p, i) => p.kind === 'child' && p.height < 110 && c[i]);
    if (f === 'thrill') return a.cat === 'thrill';
    if (f === 'us') return c.some(Boolean);
    return true;
  });
  rows.sort((x, y) => (y.st.open - x.st.open) || ((x.st.wait ?? 99) - (y.st.wait ?? 99)) || (x.walk - y.walk));
  const fb = (k, t) => `<button data-filter="${k}" aria-pressed="${f === k}">${t}</button>`;
  el.innerHTML = `<p class="kicker">Alle attracties</p>
    <div class="filters" role="group" aria-label="Filter">${fb('us', 'Voor ons')}${fb('small', '👶 Peuter')}${fb('thrill', '🎢 Spanning')}${fb('fav', '⭐ Favorieten')}${fb('all', 'Alles')}</div>
    <div class="list">${rows.map(({ a, st, can: c, walk }) => `
      <div class="ride ${st.open ? '' : 'off'}">
        <button class="open" data-ride="${a.id}"><span style="font-size:1.6rem" aria-hidden="true">${a.icon}</span>
          <span><span class="name">${esc(a.name)}</span><span class="sub">${mins(walk)} stappen${S.fam.done[a.id] ? ` · ✓ ${S.fam.done[a.id]}× gedaan` : ''}</span>
          <span class="dots" aria-label="${ps.map((p, i) => `${p.name}: ${c[i] === 'alone' ? 'mag' : c[i] === 'adult' ? 'met volwassene' : 'mag niet'}`).join(', ')}">${ps.map((p, i) => `<span class="dot ${c[i] === 'alone' ? '' : c[i] === 'adult' ? 'adult' : 'no'}" aria-hidden="true">${emoji(p)}</span>`).join('')}</span></span></button>
        ${waitBadge(a.id)}
        <button class="star" data-fav="${a.id}" aria-pressed="${S.fam.favs.includes(a.id)}" aria-label="Favoriet">★</button>
      </div>`).join('') || '<p class="empty">Niets gevonden.</p>'}</div>
    <p class="muted small" style="margin-top:14px">🟢 mag · 🟠 met volwassene · doorstreept mag niet. Lengtes volgens walibi.be; zwangerschap is een voorzichtige inschatting. Check altijd het bordje aan de ingang.</p>`;
}

function renderMapView() {
  const el = $('#view-map');
  if (!S.park) return;
  const here = S.park.toXY(pos());
  const markers = mapMarkers(true);
  el.innerHTML = `<div class="map-tools">
      <button data-go="zoom" aria-pressed="${S.mapZoom}">${S.mapZoom ? '🗺️ Heel het park' : '🔍 Rond mij'}</button>
      <button data-go="place" aria-pressed="${S.placing}">${S.placing ? 'Tik op de kaart…' : '📍 Ik sta hier'}</button>
      ${S.manual ? '<button data-go="gps">🛰️ GPS gebruiken</button>' : ''}</div>
    <div class="mapwrap mapview" id="bigmap">${mapSvg({ center: S.mapZoom ? here : { x: -20, y: -40 }, R: S.mapZoom ? 180 : 420, markers, me: here, labels: true })}</div>
    <div class="legend"><span>🟢 ≤10′</span><span>🟠 ≤25′</span><span>🔴 langer</span><span>⚪ dicht</span><span>🍽️ eten</span><span>🚻 toilet</span><span>🔵 jij</span></div>`;
}

function renderFam() {
  const el = $('#view-fam');
  if (!S.fam) return;
  const link = `${location.origin}/?g=${S.famId}`;
  const ps = people();
  el.innerHTML = `
    <div class="card"><h2>📲 Op de andere gsm</h2>
      <p class="small muted">Open deze link op de gsm van je partner. Dan zien jullie hetzelfde plan.</p>
      <p class="small" style="word-break:break-all"><b>${esc(link)}</b></p>
      <div class="row2"><button class="primary" data-go="share">📤 Delen</button><button data-go="copy">Kopieer link</button></div></div>
    <div class="card"><h2>🙋 Wie ben jij op deze gsm?</h2>
      <div class="seg">${ps.filter((p) => p.kind === 'adult').map((p) => `<button data-me="${p.id}" aria-pressed="${p.id === meId()}">${emoji(p)} ${esc(p.name)}</button>`).join('')}</div></div>
    <div class="card" id="pushCard"><h2>🔔 Meldingen</h2><div id="pushBody"><p class="muted small">…</p></div></div>
    <div class="card"><h2>👨‍👩‍👧‍👦 Ons gezin</h2>
      <form id="peopleForm">${ps.map((p) => `
        <div class="person" data-id="${p.id}" data-kind="${p.kind}">
          <label><span class="small muted">${emoji(p)} Naam</span><input type="text" name="name" value="${esc(p.name)}" maxlength="24" autocomplete="off"></label>
          <label><span class="small muted">Lengte (cm)</span><input type="number" name="height" value="${p.height}" min="50" max="220" inputmode="numeric"></label>
          ${p.kind === 'adult' ? `<div class="opts"><label class="tog"><input type="checkbox" name="pregnant" ${p.pregnant ? 'checked' : ''}> Zwanger</label></div>` : ''}
        </div>`).join('')}
        <button class="primary" type="submit" style="margin-top:8px">Opslaan</button></form></div>
    <div class="card"><h2>🏠 Op je beginscherm</h2>
      <ul class="steps small"><li><b>iPhone (Safari):</b> deelknop <span aria-hidden="true">⬆️</span> → <i>Zet op beginscherm</i>. Open de app daarna vanaf het beginscherm (nodig voor meldingen).</li>
      <li><b>Android (Chrome):</b> menu ⋮ → <i>App installeren</i> of <i>Toevoegen aan startscherm</i>.</li></ul></div>
    <div class="card"><h2>✓ Vandaag gedaan</h2>
      ${Object.keys(S.fam.done).length ? `<div class="list">${Object.entries(S.fam.done).map(([id, n]) => `<div class="ride" style="grid-template-columns:auto 1fr auto"><span aria-hidden="true">${byId[id]?.icon}</span><span><b>${esc(byId[id]?.name)}</b> <span class="muted">${n}×</span></span><button data-undo="${id}">Ongedaan</button></div>`).join('')}</div>` : '<p class="muted small">Nog niets. Tik op “Gedaan” na een attractie.</p>'}</div>
    <p class="muted small">Wachttijden: ThemeParks.wiki (live). Kaart: © OpenStreetMap-bijdragers. Gegevens van jullie gezin worden na 7 dagen gewist.</p>`;
  renderPush();
}

// ---------- push notifications
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushPrefs = () => store.get('pushPrefs', { fav: true, best: true, food: true, down: true });
async function renderPush() {
  const body = $('#pushBody'); if (!body) return;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (isIOS && !standalone) {
    body.innerHTML = `<p class="small">Op een iPhone werken meldingen alleen vanaf het beginscherm:</p>
      <ol class="steps small"><li>Tik op de deelknop ⬆️ onderaan in Safari.</li><li>Kies <b>Zet op beginscherm</b>.</li><li>Open <b>Pretpark</b> vanaf je beginscherm en kom hier terug.</li></ol>`;
    return;
  }
  if (!supported) { body.innerHTML = '<p class="small muted">Deze browser ondersteunt geen meldingen. Probeer Chrome (Android) of Safari vanaf het beginscherm (iPhone).</p>'; return; }
  if (Notification.permission === 'denied') { body.innerHTML = '<p class="small">Meldingen zijn geblokkeerd. Zet ze aan in de instellingen van je browser of gsm voor deze site.</p>'; return; }
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  const p = pushPrefs();
  const tog = (k, t) => `<label class="tog"><input type="checkbox" data-pref="${k}" ${p[k] ? 'checked' : ''}> ${t}</label>`;
  body.innerHTML = sub
    ? `<p class="small">✅ Meldingen staan aan op deze gsm.</p>
      <div style="display:grid">${tog('fav', '⭐ Wachttijd zakt bij een favoriet')}${tog('best', '👉 Nieuwe beste suggestie')}${tog('food', '🍽️ Tijd om te eten / pauze')}${tog('down', '⚠️ Attractie in storing')}</div>
      <div class="row2"><button data-go="pushtest">Testmelding</button><button data-go="pushoff">Uitzetten</button></div>`
    : `<p class="small muted">Krijg een seintje als een favoriet kort wordt, als er iets beters is, als het etenstijd is of als jullie attractie stilvalt. Ook als de app dicht is.</p>
      <button class="primary big" data-go="pushon">🔔 Meldingen aanzetten</button>`;
}
const b64ToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function pushOn() {
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if ((await Notification.requestPermission()) !== 'granted') { toast('Meldingen niet toegestaan'); renderPush(); return; }
    const { key } = await api('/api/vapid');
    if (!key) { toast('Meldingen zijn nog niet ingesteld op de server'); return; }
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
    await api('/api/push', { method: 'POST', body: { device, family: S.famId, sub: sub.toJSON(), prefs: pushPrefs(), test: true } });
    toast('Meldingen staan aan 🔔');
  } catch (e) { console.error(e); toast('Meldingen aanzetten lukte niet'); }
  renderPush();
}
async function pushOff() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  await sub?.unsubscribe();
  await api('/api/push', { method: 'DELETE', body: { device } }).catch(() => {});
  renderPush();
}

// ---------- map (SVG, metres; y grows southwards)
let baseLayer = '';
function buildBase() {
  const d = S.park.data;
  const poly = (f) => { let s = ''; for (let i = 0; i < f.length; i += 2) s += (i ? ' ' : '') + f[i] + ',' + f[i + 1]; return s; };
  const pts = d.pts;
  const lines = d.lines.map((l) => l.map((i) => pts[2 * i] + ',' + pts[2 * i + 1]).join(' '));
  baseLayer = `<polygon points="${poly(d.outline)}" fill="var(--map-ground)"/>`
    + d.green.map((g) => `<polygon points="${poly(g)}" fill="var(--map-green)"/>`).join('')
    + d.water.map((g) => `<polygon points="${poly(g)}" fill="var(--map-water)"/>`).join('')
    + d.build.map((g) => `<polygon points="${poly(g)}" fill="var(--map-build)"/>`).join('')
    + `<g fill="none" stroke-linecap="round" stroke-linejoin="round">${lines.map((l) => `<polyline points="${l}" stroke="var(--map-edge)" stroke-width="7"/>`).join('')}${lines.map((l) => `<polyline points="${l}" stroke="var(--map-path)" stroke-width="4.5"/>`).join('')}</g>`;
}
function mapMarkers(all) {
  const out = [];
  for (const a of ATTRACTIONS) {
    const st = status(S.live, a.id), xy = S.park.toXY(a);
    const col = !st.open ? 'var(--surface-2)' : st.wait == null ? 'var(--ok)' : st.wait <= 10 ? 'var(--ok)' : st.wait <= 25 ? '#e08a00' : 'var(--bad)';
    const txt = !st.open ? '–' : st.wait ?? '•';
    out.push({ ...xy, id: a.id, kind: 'ride', col, txt, label: a.name, fg: '#fff', closed: !st.open });
  }
  if (all) {
    for (const f of FOOD) out.push({ ...S.park.toXY(f), id: f.id, kind: 'food', emoji: '🍽️', label: f.name });
    S.park.toilets.forEach((t, i) => out.push({ ...S.park.toXY(t), id: 'wc' + i, kind: 'wc', emoji: '🚻' }));
  }
  return out;
}
function mapSvg({ center, R, rotate = 0, markers = [], me, route, target, labels }) {
  if (!baseLayer) buildBase();
  const k = R / 180; // marker scale so pins stay the same size on screen
  const unrot = (x, y) => (rotate ? ` rotate(${rotate} ${x} ${y})` : '');
  const pins = markers.map((m) => {
    if (m.kind === 'ride') {
      return `<g class="pin" data-ride="${m.id}" role="button" tabindex="0" aria-label="${esc(m.label)}" transform="translate(${m.x} ${m.y}) scale(${k})${rotate ? ` rotate(${rotate})` : ''}">
        ${m.closed ? `<circle r="5" fill="var(--surface)" stroke="var(--muted)" stroke-width="2"/>` : `<circle r="11" fill="${m.col}" stroke="var(--surface)" stroke-width="2.5"/><text y="4" text-anchor="middle" font-size="11" fill="${m.fg}">${m.txt}</text>`}
        ${labels && (!m.closed || R < 300) ? `<text class="lbl" y="${m.closed ? 15 : 23}" text-anchor="middle" font-size="${m.closed ? 7.5 : 9}">${esc(m.label)}</text>` : ''}</g>`;
    }
    return `<g class="pin" data-${m.kind === 'food' ? 'food' : 'wc'}="${m.id}" transform="translate(${m.x} ${m.y}) scale(${k})${rotate ? ` rotate(${rotate})` : ''}"><text y="5" text-anchor="middle" font-size="13">${m.emoji}</text></g>`;
  }).join('');
  const routeSvg = route ? `<polyline points="${route.map((p) => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ')}" fill="none" stroke="var(--route)" stroke-width="${7 * k}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${0.1 * k} ${12 * k}" />
    <polyline points="${route.map((p) => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ')}" fill="none" stroke="var(--route)" stroke-width="${3 * k}" stroke-linecap="round" stroke-linejoin="round" opacity=".5"/>` : '';
  const tgt = target ? `<g transform="translate(${target.x} ${target.y}) scale(${k})${unrot(0, 0)}"><circle r="22" fill="var(--accent)" opacity=".2"/><circle r="14" fill="var(--accent)" stroke="#fff" stroke-width="3"/><text y="5" text-anchor="middle" font-size="14">${target.icon || '🎯'}</text></g>` : '';
  const meSvg = me ? `<g transform="translate(${me.x} ${me.y}) scale(${k})"><circle r="16" fill="var(--me)" opacity=".18"/><circle r="8" fill="var(--me)" stroke="#fff" stroke-width="3"/>${S.heading != null && rotate === 0 ? `<path d="M0 -22 L6 -12 L-6 -12 Z" fill="var(--me)" transform="rotate(${S.heading})"/>` : ''}</g>` : '';
  return `<svg viewBox="${center.x - R} ${center.y - R} ${2 * R} ${2 * R}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Kaart van het park">
    <rect x="${center.x - 3 * R}" y="${center.y - 3 * R}" width="${6 * R}" height="${6 * R}" fill="var(--map-green)"/>
    <g transform="rotate(${-rotate} ${center.x} ${center.y})">${baseLayer}${routeSvg}${pins}${tgt}${meSvg}</g></svg>`;
}

// ---------- the walking guide
function openGuide(target) {
  S.guide = target; buzz();
  $('#guide').hidden = false;
  if (store.get('compass') || typeof window.DeviceOrientationEvent?.requestPermission !== 'function') enableCompass(false);
  wake(true);
  updateGuide(true);
}
function closeGuide() { S.guide = null; $('#guide').hidden = true; wake(false); render(); }
let wakeLock = null;
async function wake(on) {
  try { if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; } } catch { /* not supported */ }
}
let lastGuideHtml = 0, arrowAngle = 0;
function updateGuide(full) {
  const g = S.guide; if (!g || !S.here) return;
  const path = S.here.path(g);
  const dist = pathLength(path);
  const here = path[0];
  const ahead = S.park.lookahead(path, 25);
  const brg = bearingXY(here, ahead);
  const hasHeading = S.heading != null;
  const rel = hasHeading ? ((brg - S.heading + 540) % 360) - 180 : brg > 180 ? brg - 360 : brg;
  const arrived = dist < 25;
  const el = $('#guide');
  const scaffold = !el.querySelector('.head') || full || el.dataset.arrived !== String(arrived) || el.dataset.id !== g.id || Date.now() - lastGuideHtml > 4000;
  if (scaffold) {
    lastGuideHtml = Date.now();
    el.dataset.arrived = String(arrived); el.dataset.id = g.id;
    const doneBtn = g.kind === 'ride' ? '<button class="primary big" data-go="done">✓ Gedaan</button>'
      : g.kind === 'ride-solo' ? `<button class="primary big" data-doneone="${g.id}">✓ Gedaan</button>`
      : g.kind === 'food' ? '<button class="primary big" data-go="ate">🍽️ We hebben gegeten</button>'
      : '<button class="primary big" data-go="guideclose">👍 Ik ben er</button>';
    const st = g.kind === 'ride' ? status(S.live, g.id) : null;
    el.innerHTML = `<div class="head"><span class="ic" aria-hidden="true">${g.icon}</span><h2 id="guideTitle">${esc(g.name)}</h2>
        ${st ? waitBadge(g.id) : ''}<button data-go="guideclose" aria-label="Sluiten">✕</button></div>
      ${arrived ? `<div class="arrived"><b>Je bent er! 🎉</b><span class="muted">${g.kind === 'ride' ? 'Veel plezier. Tik op “Gedaan” als jullie klaar zijn.' : g.kind === 'ride-solo' ? 'Veel plezier!' : g.kind === 'meet' ? 'Wacht hier op de anderen.' : ''}</span></div>`
      : `<div class="arrowbox"><div class="arrow ${hasHeading ? '' : 'unknown'}"><svg viewBox="-50 -50 100 100" aria-hidden="true" id="arrowSvg"><path d="M0 -44 L30 18 L0 6 L-30 18 Z" fill="${hasHeading ? '#fff' : 'var(--accent)'}" stroke="${hasHeading ? '#fff' : 'var(--accent)'}" stroke-width="6" stroke-linejoin="round"/></svg></div>
          <div class="dist"><b id="distTxt">${Math.round(dist)} m</b><span id="minTxt">± ${walkMin(dist)} min stappen</span></div></div>
        <p class="say" id="sayTxt"></p>
        ${hasHeading ? '' : `<button data-go="compass" style="margin-bottom:10px">🧭 Kompas aan: de pijl draait mee</button>`}`}
      ${S.sim ? `<p class="small muted">📍 ${S.sim === 'far' ? 'Je bent niet in het park: ik doe alsof je aan de ingang staat.' : S.sim === 'wait' ? 'GPS zoeken…' : 'Geen GPS: ik reken vanaf de ingang.'}</p>` : ''}
      ${g.kind === 'ride' && people().some((p) => p.kind === 'child' && p.height < 110) && isDark() ? '<p class="small">🎃 Donker: blijf met de peuter op de brede hoofdpaden.</p>' : ''}
      <div class="mapwrap" id="guideMap"></div>
      <div class="foot"><button data-go="guideclose">Stop</button>${doneBtn}</div>`;
  }
  if (!arrived) {
    let d = rel - (((arrowAngle % 360) + 540) % 360 - 180); d = ((d + 540) % 360) - 180; arrowAngle += d; // shortest turn, no spin at 359→0
    const a = $('#arrowSvg'); if (a) a.style.transform = `rotate(${arrowAngle}deg)`;
    const dt = $('#distTxt'); if (dt) dt.textContent = `${Math.round(dist)} m`;
    const mt = $('#minTxt'); if (mt) mt.textContent = `± ${walkMin(dist)} min stappen`;
    const say = $('#sayTxt');
    if (say) {
      const r = Math.abs(rel);
      say.textContent = !hasHeading ? 'De pijl wijst zoals op een kaart (noorden boven).'
        : r < 25 ? '⬆️ Rechtdoor' : r < 70 ? (rel > 0 ? '↗️ Schuin rechts' : '↖️ Schuin links') : r < 135 ? (rel > 0 ? '➡️ Rechts afslaan' : '⬅️ Links afslaan') : '↩️ Draai je om';
    }
  }
  const map = $('#guideMap');
  const span = Math.max(60, Math.min(220, dist * 0.7));
  map.innerHTML = mapSvg({ center: here, R: span, rotate: hasHeading ? S.heading : 0, markers: [], me: here, route: path, target: { ...S.park.toXY(g), icon: g.icon } });
}

// ---------- sheets
function openSheet(html) { $('#sheet').innerHTML = html; $('#sheet').hidden = false; $('#sheetBack').hidden = false; $('#sheet').querySelector('button')?.focus(); }
function closeSheet() { $('#sheet').hidden = true; $('#sheetBack').hidden = true; }
function foodSheet() {
  const meal = isMealTime(new Date());
  const opts = foodOptions(walkOf, { mealTime: meal }).slice(0, 6);
  openSheet(`<h2>🍽️ Eten in de buurt</h2><p class="muted small">Dichtstbij eerst, plaatsen met zitplaatsen krijgen voorrang${meal ? ', en nu vooral echte maaltijden' : ''}.</p>
    <div class="alts">${opts.map(({ f, walkM }) => `<button class="alt" data-food="${f.id}"><span class="ic" aria-hidden="true">${f.kind === 'meal' ? '🍔' : '🍩'}</span>
      <span><span class="t">${esc(f.name)}</span><span class="s">${esc(f.what)}${f.seat ? ' · 🪑 zitplaatsen' : ' · afhalen'}${f.approx ? ' · ≈ locatie' : ''}</span></span><span class="wait w-off">${mins(walkM)}</span></button>`).join('')}</div>
    <p class="muted small" style="margin-top:10px">Openingsuren van eetplekken zijn niet live bekend; ’s avonds kan een kraam dicht zijn.</p>
    <div class="row2"><button data-go="ate">✓ We hebben gegeten</button><button data-go="sheetclose">Sluiten</button></div>`);
}
function toiletGo() {
  const t = S.park.toilets.map((p) => ({ p, m: walkOf(p) })).sort((a, b) => a.m - b.m)[0];
  if (!t) return toast('Geen toilet gevonden');
  openGuide({ kind: 'wc', id: 'wc', name: 'Toilet', icon: '🚻', ...t.p });
}
function rideSheet(id) {
  const a = byId[id]; if (!a) return;
  const st = status(S.live, id);
  const rule = (p) => {
    const c = canRide(p, a);
    if (c === 'alone') return '✅ mag';
    if (c === 'adult') return `🤝 met volwassene (min. ${a.withAdult} cm)`;
    if (p.pregnant && !a.preg) return '🚫 niet voor zwangeren';
    if (a.max && p.height > a.max) return `🚫 max. ${a.max} cm`;
    return `🚫 te klein (min. ${a.withAdult ?? a.alone} cm${a.withAdult ? ' met volwassene' : ''})`;
  };
  openSheet(`<div style="display:flex;gap:12px;align-items:center"><span style="font-size:2.4rem" aria-hidden="true">${a.icon}</span><div style="flex:1"><h2>${esc(a.name)}</h2>
      <span class="muted small">${{ kids: 'Kinderattractie', family: 'Gezinsattractie', thrill: 'Spanning' }[a.cat]} · ${mins(walkOf(a))} stappen</span></div>${waitBadge(id)}</div>
    <ul class="notes" style="margin-top:12px">${people().map((p) => `<li><span aria-hidden="true">${emoji(p)}</span><span><b>${esc(p.name)}</b> (${p.height} cm): ${rule(p)}</span></li>`).join('')}</ul>
    ${a.wet ? '<p class="small">💧 Je kan nat worden.</p>' : ''}
    <p class="muted small">Min. ${a.alone ?? '–'} cm alleen${a.withAdult ? `, ${a.withAdult} cm met volwassene` : ''}${a.max ? `, max. ${a.max} cm` : ''}. Check het bordje aan de ingang.</p>
    <button class="primary big" data-goride="${a.id}" ${st.known && !st.open ? 'disabled' : ''}>🧭 Breng me erheen</button>
    <div class="row2"><button data-fav="${a.id}" aria-pressed="${S.fam.favs.includes(a.id)}">${S.fam.favs.includes(a.id) ? '★ Favoriet' : '☆ Favoriet'}</button>
      <button data-doneone="${a.id}">✓ Gedaan${S.fam.done[a.id] ? ` (${S.fam.done[a.id]}×)` : ''}</button></div>`);
}

// ---------- banners
const isDark = () => { const d = new Date(); const h = d.getHours() + d.getMinutes() / 60; const m = d.getMonth(); return (m >= 9 || m <= 1) ? h >= 17.2 || h < 7.5 : h >= 21; };
function renderBanners() {
  const b = [];
  if (S.offline) b.push(['offline', '📶', '<b>Geen verbinding.</b> Ik toon de laatste gegevens.']);
  if (!S.manual && S.sim === 'far') b.push(['far', '📍', '<b>Je bent niet in Walibi.</b> Ik reken vanaf de ingang.']);
  if (!S.manual && S.sim === 'off') b.push(['off', '📍', '<b>Locatie staat uit.</b> Ik reken vanaf de ingang. Zet locatie aan voor de wandelgids.']);
  if (S.manual) b.push(['manual', '📍', 'Je hebt je positie zelf gekozen op de kaart.']);
  const L = S.live;
  if (L && L.open && Date.now() < L.open) b.push(['before', '🕙', `Walibi opent om <b>${new Date(L.open).toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' })}</b>.`]);
  else if (L && (!L.open || Date.now() > L.close)) b.push(['closed', '🌙', 'Walibi is nu gesloten. Wachttijden zijn van de laatste meting.']);
  if (isDark() && new Date().getMonth() >= 9 && people().some((p) => p.kind === 'child' && p.height < 110) && !S.dismissed['night' + new Date().toDateString()]) {
    b.push(['night' + new Date().toDateString(), '🎃', '<b>Het is donker:</b> griezelacteurs en scare zones. Met de peuter: blijf op de brede hoofdpaden en volg de bordjes. Steek je hand op of zeg “stop” als het te eng wordt.', 'night']);
  }
  $('#banners').innerHTML = b.map(([k, i, t, cls]) => `<div class="banner ${cls || ''}"><span aria-hidden="true">${i}</span><span>${t}</span>${k.startsWith('night') ? `<button class="x" data-dismiss="${k}" aria-label="Verbergen">✕</button>` : ''}</div>`).join('');
  const pill = $('#livePill');
  if (L) {
    const age = Math.round((Date.now() - L.t) / 60e3);
    pill.textContent = `Live · ${new Date(L.t).toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' })}${L.close && Date.now() < L.close ? ` · open tot ${new Date(L.close).toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' })}` : ''}`;
    pill.classList.toggle('stale', age > 5);
  } else pill.textContent = 'Geen live data';
}

function render() {
  renderBanners();
  for (const t of ['now', 'map', 'list', 'fam']) $('#view-' + t).hidden = S.tab !== t;
  document.querySelectorAll('.tabs button').forEach((b) => (b.dataset.tab === S.tab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  if (!S.fam) return;
  if (S.tab === 'now') renderNow();
  if (S.tab === 'map') renderMapView();
  if (S.tab === 'list') renderList();
  if (S.tab === 'fam' && !document.activeElement?.closest('#peopleForm')) renderFam();
  if (S.guide) updateGuide();
}

let toastTimer;
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('on'), 2600); }

// ---------- events
document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, [data-ride], [data-food], [data-wc]');
  if (!t) return;
  const d = t.dataset;
  if (S.placing && t.closest('#bigmap')) return; // handled by map placement below
  if (d.tab) { S.tab = d.tab; buzz(); render(); scrollTo(0, 0); return; }
  if (d.tabGo) { S.tab = d.tabGo; render(); return; }
  if (d.me) { await act({ type: 'me', device, person: d.me }); toast('Top! 👋'); return; }
  if (d.filter) { S.filter = d.filter; renderList(); return; }
  if (d.fav) { buzz(); await act({ type: 'fav', id: d.fav }); if (!$('#sheet').hidden) rideSheet(d.fav); return; }
  if (d.undo) { await act({ type: 'undo', id: d.undo }); return; }
  if (d.doneone) { closeSheet(); if (S.guide) closeGuide(); await act({ type: 'done', ids: [d.doneone] }); toast('✓ Gedaan!'); return; }
  if (d.dismiss) { S.dismissed[d.dismiss] = 1; store.set('dismissed', S.dismissed); renderBanners(); return; }
  if (d.goride) { const a = byId[d.goride]; closeSheet(); openGuide({ kind: 'ride-solo', id: a.id, name: a.name, icon: a.icon, lat: a.lat, lon: a.lon }); return; }
  if (d.food && t.closest('#sheet')) { const f = byId[d.food]; closeSheet(); openGuide({ kind: 'food', id: f.id, name: f.name, icon: '🍽️', lat: f.lat, lon: f.lon }); return; }
  if (d.food) { const f = byId[d.food]; openGuide({ kind: 'food', id: f.id, name: f.name, icon: '🍽️', lat: f.lat, lon: f.lon }); return; }
  if (d.wc) { const i = +d.wc.slice(2); const p = S.park.toilets[i]; openGuide({ kind: 'wc', id: 'wc', name: 'Toilet', icon: '🚻', ...p }); return; }
  if (d.ride && !t.matches('button.star')) { rideSheet(d.ride); return; }
  const go = d.go; if (!go) return;
  if (go.startsWith('choose:')) {
    const plan = S.plans[+go.slice(7)]; if (!plan) return;
    openGuide(guideTargetFor(plan));
    act({ type: 'target', plan, device });
    return;
  }
  switch (go) {
    case 'guide': openGuide(guideTargetFor(S.fam.target.plan)); break;
    case 'guideclose': closeGuide(); break;
    case 'done': {
      const ids = S.fam.target ? S.fam.target.plan.parts.filter((p) => !p.rest).map((p) => p.id) : S.guide ? [S.guide.id] : [];
      if (S.guide) closeGuide();
      await act({ type: 'done', ids }); buzz(); toast('✓ Gedaan! Hier is het volgende.'); scrollTo(0, 0); break;
    }
    case 'untarget': await act({ type: 'untarget' }); break;
    case 'food': foodSheet(); break;
    case 'toilet': toiletGo(); break;
    case 'pause': await act({ type: 'pause' }); { const f = foodOptions(walkOf).find((o) => o.f.seat); toast(`🪑 Rust goed!${f ? ` Zitplaatsen: ${f.f.name} (${mins(f.walkM)})` : ''}`); } break;
    case 'ate': await act({ type: 'ate' }); closeSheet(); if (S.guide) closeGuide(); toast('Smakelijk! 😋'); break;
    case 'sheetclose': closeSheet(); break;
    case 'compass': if (await enableCompass(true)) { toast('🧭 Kompas aan'); setTimeout(() => updateGuide(true), 600); } else toast('Kompas niet beschikbaar op dit toestel'); break;
    case 'zoom': S.mapZoom = !S.mapZoom; renderMapView(); break;
    case 'place': S.placing = !S.placing; renderMapView(); break;
    case 'gps': S.manual = null; store.set('manual', null); recompute(); render(); break;
    case 'share': {
      const url = `${location.origin}/?g=${S.famId}`;
      if (navigator.share) navigator.share({ title: 'Pretpark', text: 'Ons plan voor Walibi', url }).catch(() => {});
      else { await navigator.clipboard?.writeText(url).catch(() => {}); toast('Link gekopieerd'); }
      break;
    }
    case 'copy': await navigator.clipboard?.writeText(`${location.origin}/?g=${S.famId}`).then(() => toast('Link gekopieerd'), () => toast('Kopiëren lukte niet')); break;
    case 'pushon': await pushOn(); break;
    case 'pushoff': await pushOff(); break;
    case 'pushtest': try { const r = await api('/api/push', { method: 'POST', body: { device, family: S.famId, prefs: pushPrefs(), test: true } }); toast(r.ok ? 'Testmelding verstuurd' : 'Versturen lukte niet'); } catch { toast('Versturen lukte niet'); } break;
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (!$('#sheet').hidden) closeSheet(); else if (S.guide) closeGuide(); }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('g.pin[data-ride]')) { e.preventDefault(); rideSheet(e.target.dataset.ride); }
});
$('#sheetBack').addEventListener('click', closeSheet);
document.addEventListener('change', async (e) => {
  if (e.target.dataset.pref) {
    const p = pushPrefs(); p[e.target.dataset.pref] = e.target.checked; store.set('pushPrefs', p);
    api('/api/push', { method: 'POST', body: { device, family: S.famId, prefs: p } }).catch(() => toast('Opslaan lukte niet'));
  }
});
document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'peopleForm') return;
  e.preventDefault();
  const ps = [...e.target.querySelectorAll('.person')].map((row) => ({
    id: row.dataset.id, kind: row.dataset.kind, name: row.querySelector('[name=name]').value,
    height: +row.querySelector('[name=height]').value, pregnant: !!row.querySelector('[name=pregnant]')?.checked,
  }));
  document.activeElement?.blur();
  if (await act({ type: 'people', people: ps })) toast('Opgeslagen ✓');
});
// placing your position by tapping the big map
document.addEventListener('pointerup', (e) => {
  if (!S.placing) return;
  const svg = e.target.closest('#bigmap svg'); if (!svg) return;
  const g = svg.querySelector('g'); const m = g.getScreenCTM()?.inverse(); if (!m) return;
  const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
  const ll = S.park.toLL({ x: pt.x, y: pt.y });
  S.manual = { ...ll, t: Date.now() }; store.set('manual', S.manual); S.placing = false;
  recompute(); render(); toast('📍 Positie gezet');
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadLive(); pollFamily(); if (S.guide) wake(true); } });

// ---------- start
(async function start() {
  render();
  try {
    const [parkData, url] = await Promise.all([fetch('park.json').then((r) => r.json()), loadFamily()]);
    S.park = makePark(parkData);
    startGps();
    if (typeof window.DeviceOrientationEvent?.requestPermission !== 'function') enableCompass(false);
    await loadLive();
    const go = url.searchParams.get('go');
    if (go && byId[go]) { S.tab = 'now'; render(); rideSheet(go); }
    if (url.searchParams.get('food')) foodSheet();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  } catch (err) {
    console.error(err);
    $('#view-now').innerHTML = '<div class="card"><h2>Oei, dat lukte niet</h2><p class="muted">Geen verbinding met de server. Herlaad de pagina.</p><button class="primary" onclick="location.reload()">Opnieuw</button></div>';
  }
  setInterval(loadLive, 60e3);
  setInterval(pollFamily, 15e3);
  setInterval(() => { if (S.tab === 'now' && !S.guide) renderNow(); }, 30e3);
})();

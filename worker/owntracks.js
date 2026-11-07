// OwnTracks (free iOS/Android app) posts the phone's location in the background to /api/ot/<token>, also with
// Pretpark closed and the screen off. Here: parse its JSON, run the same cleaning + detection as the phone
// (public/activity.js) on the server, and turn events into the same family actions the app would send.
// Pure functions; worker/index.js does the storage, the family writes and the push notifications.
import { addFix, detect, freshTracker } from '../public/activity.js';
import { FOOD, ENTRANCE } from '../public/data.js';
import { byId, isMealTime, status } from '../public/logic.js';
import park from '../public/park.json' with { type: 'json' };

export const okToken = (t) => typeof t === 'string' && /^[a-z0-9]{24}$/.test(t);
export const newToken = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');

// OwnTracks location payloads → fixes { lat, lon, acc, t (ms), speed (m/s) | null }, oldest first. One object or an
// array (its offline queue); other message types (transition, status, waypoints, lwt…) and junk are ignored.
// The message types in a post (location, status, transition…): to show "connected, but no location yet"
export function otTypes(text) {
  let data; try { data = JSON.parse(text); } catch { return []; }
  return [...new Set((Array.isArray(data) ? data : [data]).map((m) => (m && typeof m._type === 'string' ? m._type.slice(0, 20) : '?')))].slice(0, 5);
}
export function otFixes(text, now) {
  let data; try { data = JSON.parse(text); } catch { return []; }
  const list = Array.isArray(data) ? data : [data];
  const out = [];
  for (const m of list) {
    if (!m || m._type !== 'location') continue;
    const lat = Number(m.lat), lon = Number(m.lon), tst = Number(m.tst);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !Number.isFinite(tst)) continue;
    const t = tst * 1000;
    if (t < now - 12 * 3600e3 || t > now + 2 * 60e3) continue; // only today's fixes; never in the future
    const acc = Number.isFinite(Number(m.acc)) && m.acc >= 0 ? Number(m.acc) : 999;
    const vel = Number(m.vel);
    out.push({ lat, lon, acc, t: Math.min(t, now), speed: Number.isFinite(vel) && vel >= 0 ? vel / 3.6 : null, batt: Number.isFinite(Number(m.batt)) ? Number(m.batt) : null });
  }
  // the newest 300 at most (OwnTracks' offline queue can be long; older fixes matter least)
  return out.sort((a, b) => a.t - b.t).slice(-300);
}

// point in the park outline (park.json: metres east/south of origin, like route.js)
const [lat0, lon0] = park.origin;
export function inPark(p) {
  const x = (p.lon - lon0) * park.kx, y = (lat0 - p.lat) * park.ky;
  const o = park.outline; let inside = false;
  for (let i = 0, j = o.length - 2; i < o.length; j = i, i += 2) {
    const xi = o[i], yi = o[i + 1], xj = o[j], yj = o[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Which part of the current plan is this phone's (the person chosen on that phone); null when unknown in a split
export function targetFor(fam, device, live) {
  const t = fam?.target, plan = t?.plan;
  if (!plan) return null;
  const person = fam.me?.[device];
  if (plan.type === 'split' && !person) return null;
  let i = plan.parts.findIndex((p) => p.group?.includes(person));
  if (i < 0) { if (plan.type === 'split') return null; i = 0; } // never act for the other half
  const pt = plan.parts[i];
  if (!pt) return null;
  const q = t.q?.[i] || (!t.q && t.queued ? { t: t.queued } : null);
  const a = pt.rest ? null : byId[pt.id];
  return { i, plan, a, rest: !!pt.rest, setAt: t.setAt, queuedAt: q?.t || null, boardedAt: q?.b || null, queuedAuto: !!q?.auto,
    wait: q?.w ?? (pt.id ? status(live, pt.id).wait ?? pt.wait : null) };
}

// Brussels wall-clock Date (getHours() works in the Worker, which runs in UTC)
const brussels = (t) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Brussels', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(t).map((x) => [x.type, x.value]));
  return new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);
};

// One fix through the tracker "as of" the fix's own time (OwnTracks sends its offline queue later)
export function step(tr, fix, fam, device, live) {
  const r = addFix(tr, fix, fix.t);
  if (!r.ok) return { events: [], T: null, r };
  const tq = fam?.target;
  const queueing = !!tq && (Object.values(tq.q || {}).some((q) => !q.b) || (!tq.q && !!tq.queued));
  const T = targetFor(fam, device, live);
  const events = detect(tr, { now: fix.t, target: T, queueing, foods: FOOD, mealTime: isMealTime(brussels(fix.t)), ate: fam?.ate || 0,
    pause: fam?.pause || 0, entrance: ENTRANCE, inPark, carT: fam?.car?.t || 0, gap: r.gap });
  return { events, T, r };
}

const aidOf = (s) => { let h = 2166136261, g = 5381; for (const c of s) { h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; g = (Math.imul(g, 33) + c.charCodeAt(0)) >>> 0; } return ('ot' + h.toString(36) + g.toString(36)).slice(0, 24); };

// An event → the family action(s) the phone would have sent, plus a short push for that phone (null = quiet)
export function actionsFor(e, T, fam, device) {
  const name = T?.a?.name || '';
  const aid = aidOf(`${device}:${e.key}`);
  const note = (title, body = 'Klopt het niet? Open Pretpark en tik op “Klopt niet”.') => ({ tag: 'auto', title, body, url: '/' });
  switch (e.type) {
    case 'queue': return [{ act: { type: 'queue', part: T.i, wait: T.wait, at: e.at, auto: true, aid }, note: note(`⏳ In de rij bij ${name}`, 'Automatisch herkend. Speel intussen de quiz of raad de wachttijd in Pretpark.') }];
    case 'board': return [{ act: { type: 'board', part: T.i, at: e.at, aid }, note: null }];
    case 'unqueue': return [{ act: { type: 'unqueue', part: T.i, aid }, note: note(`↩️ Rij bij ${name} verlaten?`) }];
    case 'done': {
      const plan = T.plan, t = fam.target;
      const other = plan.type === 'split' ? plan.parts[1 - T.i] : null;
      if (other && !other.rest && !t?.ready?.[1 - T.i]) { // never end the other half's plan
        if (t?.ready?.[T.i]) return [];
        return [{ act: { type: 'ready', part: T.i, device, at: e.at, aid }, note: note(`✅ ${name} gedaan`, 'De anderen krijgen een seintje. Hoe was het? Open Pretpark.') }];
      }
      const ids = plan.parts.filter((p) => !p.rest).map((p) => p.id);
      return [{ act: { type: 'done', ids, target: T.setAt, part: T.i, at: e.at, aid }, note: note(`🎉 ${name} gedaan`, 'Automatisch herkend. Hoe was het? Open Pretpark voor de volgende tip.') }];
    }
    case 'ask-done': return [{ act: null, note: { tag: 'auto', title: `🤔 Hebben jullie ${name} gedaan?`, body: 'Open Pretpark om het te bevestigen.', url: '/' } }];
    case 'ate': return [{ act: { type: 'ate', at: e.at, aid }, note: null }];
    case 'pause': return [{ act: { type: 'pause', at: e.at, aid }, note: null }];
    case 'car': return [{ act: { type: 'car', lat: e.lat, lon: e.lon, note: 'automatisch bewaard', at: e.at, aid }, note: note('🚗 Parkeerplek bewaard', 'Automatisch, waar je stopte met rijden. Vanavond brengt Pretpark je terug.') }];
    default: return [];
  }
}

export { freshTracker };

// Pure checks and message texts used by worker/index.js (kept apart so tests can import them without the Worker).
import { byId } from '../public/logic.js';

// ---------- live data: only known statuses and sane wait times reach the phones and the planner
export const STATUSES = ['OPERATING', 'CLOSED', 'DOWN', 'REFURBISHMENT'];
export function liveRides(liveData) {
  const rides = {};
  for (const x of Array.isArray(liveData) ? liveData : []) {
    if (x?.entityType !== 'ATTRACTION' || typeof x.id !== 'string') continue;
    const w = x.queue?.STANDBY?.waitTime;
    // a wait over 3 hours is not a real queue (Walibi's feed says 222 for every ride before opening): unknown
    rides[x.id] = { s: STATUSES.includes(x.status) ? x.status : 'CLOSED', w: Number.isFinite(w) && w >= 0 && w <= 180 ? Math.round(w) : null };
  }
  // the same long wait on most rides at once is a placeholder, not a crowd: unknown too
  const ws = Object.values(rides).map((r) => r.w).filter((w) => w != null);
  const count = {}; for (const w of ws) count[w] = (count[w] || 0) + 1;
  const [top, n] = Object.entries(count).sort((a, b) => b[1] - a[1])[0] || [];
  if (ws.length >= 5 && +top >= 60 && n / ws.length >= 0.7) for (const r of Object.values(rides)) if (r.w === +top) r.w = null;
  return rides;
}

// ---------- push subscriptions: only the browsers' real push services (the cron POSTs to these URLs)
const PUSH_HOSTS = ['fcm.googleapis.com', 'push.services.mozilla.com', 'web.push.apple.com', 'notify.windows.com', 'push.apple.com'];
export function okEndpoint(e) {
  if (typeof e !== 'string' || e.length > 1000) return false;
  let u; try { u = new URL(e); } catch { return false; }
  if (u.protocol !== 'https:' || u.port || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  return PUSH_HOSTS.some((d) => h === d || h.endsWith('.' + d));
}

// ---------- tickets: images as strict base64 data URLs (null/undefined = no image)
const DATA_URL = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
export const okDataUrl = (s, max) => s == null || (typeof s === 'string' && s.length <= max && DATA_URL.test(s));

// ---------- "Wij zijn klaar": this part of the target plan waits at the meeting point
export function readyMessage(fam, part) {
  const plan = fam.target?.plan;
  const people = fam.people || [];
  const names = (plan?.parts?.[part]?.group || []).map((pid) => people.find((p) => p.id === pid)?.name).filter(Boolean);
  const who = names.length > 1 ? names.slice(0, -1).join(', ') + ' en ' + names.at(-1) : names[0] || 'Wij';
  const place = byId[plan?.meet || plan?.parts?.[0]?.id]?.name;
  return { tag: 'ready', title: '✅ Wij zijn klaar', body: place ? `${who} staan aan de uitgang van ${place}` : `${who} zijn klaar`, url: '/' };
}

// ---------- family chat
const okId = (x) => typeof x === 'string' && /^[a-z0-9]{8,24}$/.test(x);
const finite = (x, lo, hi) => (typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? x : null);
// A validated message, or null. The server sets the time and the sender's e-mail (from Cloudflare Access).
export function chatMessage(b, email, now) {
  if (!b || !okId(b.id)) return null;
  const kind = b.kind === 'loc' ? 'loc' : 'text';
  const text = String(b.text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 500);
  const msg = { id: b.id, t: now, kind, text, by: String(email || '').slice(0, 120) };
  if (/^p\d{1,2}$/.test(b.person)) msg.person = b.person;
  if (typeof b.device === 'string' && /^[a-z0-9]{8,32}$/i.test(b.device)) msg.device = b.device;
  if (kind === 'loc') {
    const lat = finite(b.lat, -90, 90), lon = finite(b.lon, -180, 180);
    if (lat == null || lon == null) return null;
    Object.assign(msg, { lat, lon, near: String(b.near ?? '').slice(0, 60) });
  } else if (!text) return null;
  return msg;
}
export function chatNote(fam, msg) {
  const p = (fam?.people || []).find((x) => x.id === msg.person);
  const fromMail = String(msg.by || '').split('@')[0].split(/[._-]/)[0];
  const name = p?.name || (fromMail ? fromMail[0].toUpperCase() + fromMail.slice(1) : 'Gezin');
  const body = msg.kind === 'loc' ? `📍 Hier ben ik${msg.near ? ` (bij ${msg.near})` : ''}${msg.text ? ` · ${msg.text}` : ''}` : msg.text;
  return { tag: 'chat', title: `💬 ${name}`, body: body.slice(0, 200), url: '/?chat=1' };
}

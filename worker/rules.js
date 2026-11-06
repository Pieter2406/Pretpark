// Pure checks and message texts used by worker/index.js (kept apart so tests can import them without the Worker).
import { byId } from '../public/logic.js';

// ---------- live data: only known statuses and sane wait times reach the phones and the planner
export const STATUSES = ['OPERATING', 'CLOSED', 'DOWN', 'REFURBISHMENT'];
export function liveRides(liveData) {
  const rides = {};
  for (const x of Array.isArray(liveData) ? liveData : []) {
    if (x?.entityType !== 'ATTRACTION' || typeof x.id !== 'string') continue;
    const w = x.queue?.STANDBY?.waitTime;
    rides[x.id] = { s: STATUSES.includes(x.status) ? x.status : 'CLOSED', w: Number.isFinite(w) ? Math.min(600, Math.max(0, Math.round(w))) : null };
  }
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

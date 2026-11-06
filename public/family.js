// The shared family state and the actions that change it. The Worker applies actions (so two phones can't
// overwrite each other's changes); the browser applies the same actions locally (offline outbox) and sends them.
// Pure functions, validated input.
//
// Every action may carry
//   aid: a client-made id (/^[a-z0-9]{6,24}$/): an action already applied (in fam.aids, last 80) is a no-op,
//        so the outbox can safely send an action again after a lost response;
//   at:  the client's time of the action (ms). Used for every timestamp the action writes when it lies within
//        [now − 12 h, now + 2 min], else the server time is used. A late replay (from the outbox) doesn't
//        overwrite newer state: an older position/car/target/done/ready doesn't replace a newer one.
import { DEFAULT_PEOPLE, byId } from './logic.js';
import { ATTRACTIONS } from './data.js';

export function newFamily(now) {
  return { v: 1, created: now, people: DEFAULT_PEOPLE, me: {}, favs: [], done: {}, log: [], target: null, ate: 0, pause: 0, positions: {}, aids: [] };
}

const str = (s, n = 40) => String(s ?? '').trim().slice(0, n);
const num = (x, lo, hi, d) => { const v = Number(x); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const okId = (id) => typeof id === 'string' && !!byId[id]; // attraction or food (favourites, done list)
const RIDES = new Set(ATTRACTIONS.map((a) => a.id));
const okRide = (id) => typeof id === 'string' && RIDES.has(id); // attractions only (plans)
export const okDevice = (d) => typeof d === 'string' && /^[a-z0-9]{8,32}$/i.test(d);
export const okAid = (a) => typeof a === 'string' && /^[a-z0-9]{6,24}$/.test(a);
export const MAX_AIDS = 80;
const PAST = 12 * 3600e3, FUTURE = 2 * 60e3;
// a replayed action only counts as older than state written at t0 beyond the clock difference two phones may have
const SKEW = 2 * 60e3;
const older = (t, t0) => typeof t0 === 'number' && t < t0 - SKEW;

// The time an action happened: the client's `at` when plausible, else the server's now.
export function actionTime(act, now) {
  const at = act?.at;
  return typeof at === 'number' && Number.isFinite(at) && at >= now - PAST && at <= now + FUTURE ? at : now;
}

// Rebuild a "Doe nu dit" plan (as made by logic.js plans()) out of validated fields only; throws when invalid.
export function sanitizePlan(plan, people) {
  const bad = () => { throw new Error('bad plan'); };
  if (!plan || typeof plan !== 'object') bad();
  const ids = new Set((people?.length ? people : DEFAULT_PEOPLE).map((p) => p.id));
  const type = plan.type;
  if (type !== 'together' && type !== 'split') bad();
  if (!Array.isArray(plan.parts) || plan.parts.length < 1 || plan.parts.length > 2) bad();
  const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(10000, Math.max(0, x)) : bad());
  const parts = plan.parts.map((p) => {
    if (!p || typeof p !== 'object' || !Array.isArray(p.group)) bad();
    const group = [...new Set(p.group)];
    if (!group.length || !group.every((id) => typeof id === 'string' && ids.has(id))) bad();
    const inGroup = (list) => (Array.isArray(list) ? [...new Set(list.filter((id) => group.includes(id)))] : []);
    const wait = p.wait == null ? null : n(p.wait);
    if (p.rest === true) {
      if (p.id != null) bad();
      return { group, rest: true, id: null, walkM: n(p.walkM), wait, minutes: n(p.minutes) };
    }
    if (!okRide(p.id)) bad();
    return {
      group, id: p.id, ride: inGroup(p.ride), watch: inGroup(p.watch), escorted: inGroup(p.escorted),
      walkM: n(p.walkM), wait, waitKnown: p.waitKnown === true, minutes: n(p.minutes),
    };
  });
  if (typeof plan.key !== 'string' || plan.key.length > 80) bad();
  if (typeof plan.score !== 'number' || !Number.isFinite(plan.score)) bad();
  const out = { type, key: plan.key, parts, score: Math.min(1e6, Math.max(-1e6, plan.score)), minutes: n(plan.minutes) };
  if (type === 'split') {
    if (parts[0].rest || plan.meet !== parts[0].id) bad();
    out.meet = parts[0].id;
  }
  return out;
}

export function apply(fam, act, now) {
  const aid = okAid(act?.aid) ? act.aid : null;
  const seen = Array.isArray(fam?.aids) ? fam.aids : [];
  if (aid && seen.includes(aid)) return fam; // already applied: no-op (the same object, nothing changed)
  const t = actionTime(act, now);
  const f = structuredClone(fam);
  const target = f.target;
  const beforeTarget = () => !!target && older(t, target.setAt); // a late replay from before the current target
  switch (act?.type) {
    case 'people': {
      if (!Array.isArray(act.people) || !act.people.length || act.people.length > 8) throw new Error('bad people');
      f.people = act.people.map((p, i) => ({
        id: /^p\d{1,2}$/.test(p?.id) ? p.id : 'p' + (i + 1),
        name: str(p?.name, 24) || 'Persoon ' + (i + 1),
        kind: p?.kind === 'child' ? 'child' : 'adult',
        height: num(p?.height, 50, 220, 120),
        pregnant: p?.kind !== 'child' && !!p?.pregnant,
      }));
      break;
    }
    case 'me':
      if (!okDevice(act.device)) throw new Error('bad device');
      f.me[act.device] = str(act.person, 4);
      break;
    case 'fav': {
      if (!okId(act.id)) throw new Error('bad id');
      const has = f.favs.includes(act.id);
      const on = typeof act.on === 'boolean' ? act.on : !has;
      if (on && !has) f.favs = [...f.favs, act.id];
      if (!on && has) f.favs = f.favs.filter((x) => x !== act.id);
      break;
    }
    case 'done': {
      const ids = (Array.isArray(act.ids) ? act.ids : []).filter(okId).slice(0, 3);
      for (const id of ids) f.done[id] = (f.done[id] || 0) + 1;
      f.log = [...f.log, { t, ids }].sort((a, b) => a.t - b.t).slice(-80);
      if (!beforeTarget()) f.target = null;
      break;
    }
    case 'undo':
      if (!okId(act.id)) throw new Error('bad id');
      if (f.done[act.id] > 1) f.done[act.id]--; else delete f.done[act.id];
      break;
    case 'target': {
      const plan = sanitizePlan(act.plan, f.people);
      if (!beforeTarget()) f.target = { plan, setAt: t, by: okDevice(act.device) ? act.device : '' };
      break;
    }
    case 'untarget': if (!beforeTarget()) f.target = null; break;
    case 'queue': if (target && !beforeTarget()) target.queued = t; break;
    case 'ready':
      if (act.part !== 0 && act.part !== 1) throw new Error('bad part');
      if (act.device != null && !okDevice(act.device)) throw new Error('bad device');
      if (target && !beforeTarget()) target.ready = { ...(target.ready || {}), [act.part]: t };
      break;
    case 'car':
      if (older(t, f.car?.t)) break; // a late replay doesn't replace a newer parking spot
      f.car = act.lat == null ? null : { lat: num(act.lat, -90, 90, 0), lon: num(act.lon, -180, 180, 0), t, note: str(act.note, 60) };
      break;
    case 'walk': f.walk = act.pref === 'low' ? 'low' : 'normal'; break;
    case 'ate': f.ate = Math.max(f.ate || 0, t); break;
    case 'pause': f.pause = Math.max(f.pause || 0, t); break;
    case 'pos':
      if (!okDevice(act.device)) throw new Error('bad device');
      if ((f.positions[act.device]?.t || 0) > t) break; // a stale fix doesn't replace a newer one
      f.positions[act.device] = { lat: num(act.lat, -90, 90, 0), lon: num(act.lon, -180, 180, 0), t };
      break;
    default: throw new Error('unknown action');
  }
  if (aid) f.aids = [...seen, aid].slice(-MAX_AIDS);
  return f;
}

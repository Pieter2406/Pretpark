// The shared family state and the actions that change it. The Worker applies actions (so two phones can't
// overwrite each other's changes); the browser only sends them. Pure functions, validated input.
import { DEFAULT_PEOPLE, byId } from './logic.js';

export function newFamily(now) {
  return { v: 1, created: now, people: DEFAULT_PEOPLE, me: {}, favs: [], done: {}, log: [], target: null, ate: 0, pause: 0, positions: {} };
}

const str = (s, n = 40) => String(s ?? '').trim().slice(0, n);
const num = (x, lo, hi, d) => { const v = Number(x); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const okId = (id) => typeof id === 'string' && !!byId[id];
const okDevice = (d) => typeof d === 'string' && /^[a-z0-9]{8,32}$/i.test(d);

export function apply(fam, act, now) {
  const f = structuredClone(fam);
  switch (act?.type) {
    case 'people': {
      if (!Array.isArray(act.people) || !act.people.length || act.people.length > 8) throw new Error('bad people');
      f.people = act.people.map((p, i) => ({
        id: /^p\d{1,2}$/.test(p.id) ? p.id : 'p' + (i + 1),
        name: str(p.name, 24) || 'Persoon ' + (i + 1),
        kind: p.kind === 'child' ? 'child' : 'adult',
        height: num(p.height, 50, 220, 120),
        pregnant: p.kind !== 'child' && !!p.pregnant,
      }));
      break;
    }
    case 'me':
      if (!okDevice(act.device)) throw new Error('bad device');
      f.me[act.device] = str(act.person, 4);
      break;
    case 'fav':
      if (!okId(act.id)) throw new Error('bad id');
      f.favs = f.favs.includes(act.id) ? f.favs.filter((x) => x !== act.id) : [...f.favs, act.id];
      break;
    case 'done': {
      const ids = (act.ids || []).filter(okId).slice(0, 3);
      for (const id of ids) f.done[id] = (f.done[id] || 0) + 1;
      f.log = [...f.log, { t: now, ids }].slice(-80);
      f.target = null;
      break;
    }
    case 'undo':
      if (!okId(act.id)) throw new Error('bad id');
      if (f.done[act.id] > 1) f.done[act.id]--; else delete f.done[act.id];
      break;
    case 'target': {
      const plan = act.plan;
      if (!plan || !Array.isArray(plan.parts) || plan.parts.length > 2) throw new Error('bad plan');
      if (!plan.parts.every((p) => p.rest || okId(p.id))) throw new Error('bad plan');
      const text = JSON.stringify(plan);
      if (text.length > 4000) throw new Error('bad plan');
      f.target = { plan: JSON.parse(text), setAt: now, by: str(act.device, 32) };
      break;
    }
    case 'untarget': f.target = null; break;
    case 'car':
      f.car = act.lat == null ? null : { lat: num(act.lat, -90, 90, 0), lon: num(act.lon, -180, 180, 0), t: now, note: str(act.note, 60) };
      break;
    case 'ate': f.ate = now; break;
    case 'pause': f.pause = now; break;
    case 'pos':
      if (!okDevice(act.device)) throw new Error('bad device');
      f.positions[act.device] = { lat: num(act.lat, -90, 90, 0), lon: num(act.lon, -180, 180, 0), t: now };
      break;
    default: throw new Error('unknown action');
  }
  return f;
}

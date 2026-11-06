// Defence in depth behind Cloudflare Access: every /api request must carry a valid Access JWT for this app,
// issued to one of the family's e-mail addresses. (Access itself already blocks everyone else at the edge.)
import { ub64 as dec } from './b64.js';

const TEAM = 'https://pieterverlinden.cloudflareaccess.com';
const AUD = '5e7b4ac86c3997ba2b9a848c1182db03096f9a4447356a444bd6fb4a17408720'; // Access app "Pretpark"
export const ALLOWED = ['pieter.verlinden@outlook.com', 'marjan.vandenabeele@gmail.com'];

let keys = null, keysAt = 0;
async function getKeys() {
  if (keys && Date.now() - keysAt < 3600e3) return keys;
  const res = await fetch(`${TEAM}/cdn-cgi/access/certs`);
  const { keys: jwks } = await res.json();
  keys = Object.fromEntries(await Promise.all(jwks.map(async (k) => [k.kid,
    await crypto.subtle.importKey('jwk', k, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])])));
  keysAt = Date.now();
  return keys;
}

// Returns the e-mail address, or null when the request isn't authorised.
// Local development (`npm run dev`) has no Access in front. It is recognised by all three: plain http, a loopback
// client address and no cf-ray header. On Cloudflare's edge cf-ray is always set and the client IP is real.
export async function accessEmail(request) {
  const local = new URL(request.url).protocol === 'http:' && !request.headers.get('cf-ray')
    && ['127.0.0.1', '::1'].includes(request.headers.get('cf-connecting-ip') || '127.0.0.1');
  if (local) return 'local@dev';
  const jwt = request.headers.get('cf-access-jwt-assertion');
  if (!jwt) return null;
  const [h, p, s] = jwt.split('.');
  try {
    const head = JSON.parse(new TextDecoder().decode(dec(h)));
    const body = JSON.parse(new TextDecoder().decode(dec(p)));
    let key = (await getKeys())[head.kid];
    if (!key) { keys = null; key = (await getKeys())[head.kid]; }
    if (!key) return null;
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, dec(s), new TextEncoder().encode(h + '.' + p));
    const aud = Array.isArray(body.aud) ? body.aud : [body.aud];
    if (!ok || !aud.includes(AUD) || body.iss !== TEAM || body.exp * 1000 < Date.now()) return null;
    const email = String(body.email || '').toLowerCase();
    return ALLOWED.includes(email) ? email : null;
  } catch {
    return null;
  }
}

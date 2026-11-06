// Web Push without libraries: VAPID (RFC 8292) signing and aes128gcm payload encryption (RFC 8291),
// all with WebCrypto, which Workers provide.

import { b64u, ub64 } from './b64.js';

export { b64u, ub64 };
const te = new TextEncoder();
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

export async function encrypt(sub, payload) {
  const uaPub = ub64(sub.keys.p256dh), auth = ub64(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const localPub = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(te.encode('WebPush: info\0'), uaPub, localPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(te.encode(payload), new Uint8Array([2]))));
  const header = new Uint8Array(86);
  header.set(salt, 0); new DataView(header.buffer).setUint32(16, 4096); header[20] = 65; header.set(localPub, 21);
  return concat(header, ct);
}

let signKey = null;
async function vapidJwt(env, aud) {
  signKey ??= crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:noreply@pieterverlinden.be' })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signKey, te.encode(head + '.' + body));
  return head + '.' + body + '.' + b64u(sig);
}

export function publicKey(env) {
  const j = JSON.parse(env.VAPID_PRIVATE_JWK);
  return b64u(concat(new Uint8Array([4]), ub64(j.x), ub64(j.y)));
}

// Returns the push service's status code (404/410 = subscription is gone).
export async function sendPush(env, sub, data) {
  const body = await encrypt(sub, JSON.stringify(data));
  const aud = new URL(sub.endpoint).origin;
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: `vapid t=${await vapidJwt(env, aud)}, k=${publicKey(env)}`,
      'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream',
      ttl: '600', urgency: 'high', topic: String(data.tag || 'pretpark').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32),
    },
    body,
  });
  return res.status;
}

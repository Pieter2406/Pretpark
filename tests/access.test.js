import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessEmail } from '../worker/access.js';

const b64u = (b) => Buffer.from(b).toString('base64url');
async function setup() {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1', alg: 'RS256' };
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }));
  const sign = async (claims, kid = 'k1') => {
    const h = b64u(JSON.stringify({ alg: 'RS256', kid })), p = b64u(JSON.stringify(claims));
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(h + '.' + p));
    return `${h}.${p}.${b64u(sig)}`;
  };
  return sign;
}
const req = (jwt) => new Request('https://pretpark.pieterverlinden.be/api/live', { headers: { 'cf-ray': 'x', 'cf-connecting-ip': '1.2.3.4', ...(jwt ? { 'cf-access-jwt-assertion': jwt } : {}) } });
const good = { aud: ['5e7b4ac86c3997ba2b9a848c1182db03096f9a4447356a444bd6fb4a17408720'], iss: 'https://pieterverlinden.cloudflareaccess.com', exp: Math.floor(Date.now() / 1000) + 600, email: 'Marjan.Vandenabeele@gmail.com' };

test('Access JWT: valid family member passes, everything else fails', async () => {
  const sign = await setup();
  assert.equal(await accessEmail(req(await sign(good))), 'marjan.vandenabeele@gmail.com');
  assert.equal(await accessEmail(req()), null);
  assert.equal(await accessEmail(req(await sign({ ...good, email: 'someone@else.com' }))), null);
  assert.equal(await accessEmail(req(await sign({ ...good, aud: ['other'] }))), null);
  assert.equal(await accessEmail(req(await sign({ ...good, exp: 1 }))), null);
  const t = await sign(good); const [h, p] = t.split('.');
  const forged = `${h}.${b64u(JSON.stringify({ ...good, email: 'pieter.verlinden@outlook.com', x: 1 }))}.${t.split('.')[2]}`;
  assert.equal(await accessEmail(req(forged)), null);
  void p;
});
test('local dev bypass only for plain http loopback without cf-ray', async () => {
  assert.equal(await accessEmail(new Request('http://pretpark.pieterverlinden.be/api/live')), 'local@dev');
  assert.equal(await accessEmail(new Request('http://pretpark.pieterverlinden.be/api/live', { headers: { 'cf-ray': 'x' } })), null);
  assert.equal(await accessEmail(new Request('https://pretpark.pieterverlinden.be/api/live')), null);
});

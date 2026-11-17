// Checks the phone-notification code: the message must be encrypted exactly as the Web Push standard says,
// verified here with a separate, independent decryption written with Node's own crypto.
import crypto from 'node:crypto';
import http from 'node:http';
import assert from 'node:assert/strict';
import { encryptPayload, vapidJwt, sendPush, deliver, authHeaders, b64uEncode, b64uDecode } from '../supabase/functions/notify/index.ts';

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FAIL', name, '\n      ', String(e.message).split('\n')[0]); } };
const newKeys = () => { const e = crypto.createECDH('prime256v1'); e.generateKeys(); return { ecdh: e, d: e.getPrivateKey().toString('base64url'), pub: e.getPublicKey(), pubB64: e.getPublicKey().toString('base64url') }; };

function decrypt(body, ua, authSecret) {            // the phone's side, written independently
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  assert.equal(rs, 4096); assert.equal(idlen, 65);
  const secret = ua.ecdh.computeSecret(asPub);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), ua.pub, asPub]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let i = pt.length - 1; while (pt[i] === 0) i--; assert.equal(pt[i], 2, 'padding delimiter');
  return pt.subarray(0, i).toString('utf8');
}

console.log('Phone notifications');
await t('base64url helpers round-trip', () => { const x = crypto.randomBytes(65); assert.deepEqual(Buffer.from(b64uDecode(b64uEncode(x))), x); });
await t('encrypted message can be opened by the phone, including Hindi text', async () => {
  const ua = newKeys(), auth = crypto.randomBytes(16);
  const msg = JSON.stringify({ title: 'Rent due in 3 days', body: 'नवंबर: ₹4,500 to pay by 05 Nov.', link: '#/home' });
  const out = await encryptPayload(ua.pubB64, auth.toString('base64url'), new TextEncoder().encode(msg));
  assert.equal(decrypt(Buffer.from(out), ua, auth), msg);
});
await t('two messages to the same phone never share a key or salt', async () => {
  const ua = newKeys(), auth = crypto.randomBytes(16).toString('base64url');
  const a = Buffer.from(await encryptPayload(ua.pubB64, auth, new Uint8Array([1]))), b = Buffer.from(await encryptPayload(ua.pubB64, auth, new Uint8Array([1])));
  assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16)); assert.notDeepEqual(a.subarray(21, 86), b.subarray(21, 86));
});
await t('VAPID token is a valid signed ES256 JWT with the right audience', async () => {
  const v = newKeys(); const jwt = await vapidJwt('https://fcm.googleapis.com', 'mailto:o@example.com', v.d, v.pubB64);
  const [h, c, s] = jwt.split('.'); const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: v.pub.subarray(1, 33).toString('base64url'), y: v.pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(h + '.' + c), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  const claims = JSON.parse(Buffer.from(c, 'base64url')); assert.equal(claims.aud, 'https://fcm.googleapis.com'); assert.equal(claims.sub, 'mailto:o@example.com');
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 86400);
});

// A pretend push service + a pretend Supabase, to run the whole delivery path
const ua1 = newKeys(), auth1 = crypto.randomBytes(16); const got = [];
const push = http.createServer((req, res) => {
  const chunks = []; req.on('data', (d) => chunks.push(d)); req.on('end', () => {
    if (req.url === '/gone') { res.statusCode = 410; return res.end(); }
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(req.headers.authorization || '');
    if (!m || req.headers['content-encoding'] !== 'aes128gcm' || !req.headers.ttl) { res.statusCode = 400; return res.end('bad headers'); }
    got.push({ k: m[2], text: decrypt(Buffer.concat(chunks), ua1, auth1) }); res.statusCode = 201; res.end();
  });
}).listen(0);
const vap = newKeys(); const pushUrl = `http://127.0.0.1:${push.address().port}`;
const sub = { endpoint: pushUrl + '/ok', p256dh: ua1.pubB64, auth: auth1.toString('base64url') };
await t('a push request carries the headers the push services require', async () => {
  const st = await sendPush(sub, '{"title":"hi"}', { privateKey: vap.d, publicKey: vap.pubB64, subject: 'mailto:o@example.com' });
  assert.equal(st, 201); assert.equal(got.at(-1).text, '{"title":"hi"}'); assert.equal(got.at(-1).k, vap.pubB64);
  assert.equal(await sendPush({ ...sub, endpoint: pushUrl + '/gone' }, 'x', { privateKey: vap.d, publicKey: vap.pubB64, subject: 'mailto:o@example.com' }), 410);
});
let SERVICE_KEY = 'eyJ.legacy.service-key';
await t('keys: old-style keys go in both headers, new-style keys only in the apikey header', async () => {
  assert.deepEqual(authHeaders('eyJabc.def.ghi'), { apikey: 'eyJabc.def.ghi', Authorization: 'Bearer eyJabc.def.ghi' });
  assert.deepEqual(authHeaders('sb_secret_abc123'), { apikey: 'sb_secret_abc123' });
});
for (const key of ['eyJ.legacy.service-key', 'sb_secret_new_style_key']) await t(`deliver() with a ${key.startsWith('eyJ') ? 'legacy' : 'new-style'} key: sends each waiting notification, removes phones that unsubscribed, reports counts`, async () => {
  SERVICE_KEY = key;
  const dropped = [];
  const supa = http.createServer((req, res) => {
    const chunks = []; req.on('data', (d) => chunks.push(d)); req.on('end', () => {
      assert.equal(req.headers.apikey, SERVICE_KEY);
      if (SERVICE_KEY.startsWith('eyJ')) assert.equal(req.headers.authorization, 'Bearer ' + SERVICE_KEY); else assert.equal(req.headers.authorization, undefined);
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); res.setHeader('Content-Type', 'application/json');
      if (req.url.endsWith('/claim_notifications')) return res.end(JSON.stringify([
        { id: '1', title: 'Payment to confirm: Room 101', body: 'Asha says they paid ₹2,000 by UPI.', link: '#/inbox', email: null, subs: [sub, { ...sub, endpoint: pushUrl + '/gone' }] },
        { id: '2', title: 'No phone', body: 'x', link: null, email: null, subs: [] }]));
      if (req.url.endsWith('/drop_push_subscriptions')) { dropped.push(...body.p_endpoints); res.statusCode = 204; return res.end(); }
      res.statusCode = 404; res.end();
    });
  }).listen(0);
  const before = got.length;
  const r = await deliver({ VAPID_PRIVATE_KEY: vap.d, VAPID_PUBLIC_KEY: vap.pubB64 }, `http://127.0.0.1:${supa.address().port}`, SERVICE_KEY);
  assert.deepEqual([r.notifications, r.pushed, r.emailed, r.removed_phones], [2, 1, 0, 1]);
  assert.deepEqual(dropped, [pushUrl + '/gone']);
  assert.deepEqual(JSON.parse(got[before].text), { title: 'Payment to confirm: Room 101', body: 'Asha says they paid ₹2,000 by UPI.', link: '#/inbox' });
  supa.close();
});
push.close();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

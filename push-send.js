#!/usr/bin/env node
// Web Push sender for the Learnmax -- zero dependencies.
//
//   node push-send.js --test                 run the RFC 8291 known-answer test
//   node push-send.js sub.json "title" "body" [url]
//
// Implements RFC 8291 (aes128gcm message encryption) and RFC 8292 (VAPID)
// with node's built-in crypto only. The Mac holds the VAPID private key
// (.vapid.json beside this file; generate with gen-vapid.js); the phone's
// push subscription arrives through the sync repo. The browser vendor's push
// service does the actual delivery, so these arrive as fully native
// lock-screen notifications.
//
// The VAPID `sub` claim (a mailto: contact for the push service) comes from
// config.json beside this file.

'use strict';
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const b64u = b => Buffer.from(b).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function hkdfExtract(salt, ikm) {
  return crypto.createHmac('sha256', salt).update(ikm).digest();
}
function hkdfExpand(prk, info, len) {
  // single-block expand is enough for <=32-byte outputs
  const t = crypto.createHmac('sha256', prk)
      .update(Buffer.concat([info, Buffer.from([1])])).digest();
  return t.slice(0, len);
}
function ecKeyFromRaw(rawPub, dScalar) {
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: b64u(rawPub.slice(1, 33)), y: b64u(rawPub.slice(33, 65)),
  };
  if (dScalar) jwk.d = b64u(dScalar);
  return dScalar
      ? crypto.createPrivateKey({ key: jwk, format: 'jwk' })
      : crypto.createPublicKey({ key: jwk, format: 'jwk' });
}
function rawPubOf(keyObj) {
  const jwk = keyObj.export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]);
}

// ---- RFC 8291: encrypt `plaintext` for a subscription -----------------------
function encrypt(plaintext, uaPubRaw, authSecret, asKeyPair, salt) {
  const asPubRaw = rawPubOf(asKeyPair.publicKey);
  const ecdh = crypto.diffieHellman({
    privateKey: asKeyPair.privateKey,
    publicKey: ecKeyFromRaw(uaPubRaw),
  });
  const prkKey = hkdfExtract(authSecret, ecdh);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'), uaPubRaw, asPubRaw]);
  const ikm = hkdfExpand(prkKey, keyInfo, 32);
  const prk = hkdfExtract(salt, ikm);
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0'), 12);

  const record = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]);
  const gcm = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([gcm.update(record), gcm.final(), gcm.getAuthTag()]);

  const header = Buffer.concat([
    salt,
    Buffer.from([0, 0, 16, 0]),            // rs = 4096
    Buffer.from([asPubRaw.length]),
    asPubRaw,
  ]);
  return Buffer.concat([header, ct]);
}

// ---- RFC 8292: VAPID Authorization header -----------------------------------
function contact() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json')));
  } catch (e) { /* fall through to the error below */ }
  if (!cfg.contact) {
    throw new Error('no "contact" in config.json -- push needs a mailto: ' +
                    'address for the VAPID sub claim');
  }
  return cfg.contact;
}

function vapidHeader(endpoint, vapid) {
  const aud = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const seg = o => b64u(Buffer.from(JSON.stringify(o)));
  const unsigned = seg({ typ: 'JWT', alg: 'ES256' }) + '.' +
                   seg({ aud, exp: now + 12 * 3600, sub: contact() });
  const key = crypto.createPrivateKey(vapid.privatePem);
  const sig = crypto.sign('sha256', Buffer.from(unsigned),
                          { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${vapid.publicKeyB64u}`;
}

// ---- send -------------------------------------------------------------------
function send(sub, payloadObj) {
  const vapid = JSON.parse(fs.readFileSync(
      path.join(__dirname, '.vapid.json')));
  const asKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const body = encrypt(JSON.stringify(payloadObj),
                       fromB64u(sub.keys.p256dh), fromB64u(sub.keys.auth),
                       asKeys, crypto.randomBytes(16));
  const u = new URL(sub.endpoint);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: {
        'Authorization': vapidHeader(sub.endpoint, vapid),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Content-Length': body.length,
        'TTL': '3600',
        'Urgency': 'normal',
        'Topic': 'rl-due',            // newer pushes replace older ones
      },
    }, res => {
      let out = '';
      res.on('data', d => out += d);
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ---- RFC 8291 Appendix A known-answer test ----------------------------------
function selfTest() {
  const plaintext = 'When I grow up, I want to be a watermelon';
  const uaPub = fromB64u('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4');
  const uaPriv = fromB64u('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94');
  const asPub = fromB64u('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
  const asPriv = fromB64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw');
  const auth = fromB64u('BTBZMqHH6r4Tts7J_aSIgg');
  const salt = fromB64u('DGv6ra1nlYgDCS1FRnbzlw');
  const expected = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';

  const asKeys = {
    privateKey: ecKeyFromRaw(asPub, asPriv),
    publicKey: ecKeyFromRaw(asPub),
  };
  const out = encrypt(plaintext, uaPub, auth, asKeys, salt);
  const match = b64u(out) === expected;

  // independent check: decrypt with the subscriber's key and compare
  const header = out.slice(0, 16 + 4 + 1 + 65);
  const ct = out.slice(header.length);
  const ecdh = crypto.diffieHellman({
    privateKey: ecKeyFromRaw(uaPub, uaPriv),
    publicKey: ecKeyFromRaw(asPub),
  });
  const prkKey = hkdfExtract(auth, ecdh);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]);
  const ikm = hkdfExpand(prkKey, keyInfo, 32);
  const prk = hkdfExtract(salt, ikm);
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0'), 12);
  const gcm = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  gcm.setAuthTag(ct.slice(-16));
  const rec = Buffer.concat([gcm.update(ct.slice(0, -16)), gcm.final()]);
  const roundtrip = rec.slice(0, -1).toString() === plaintext && rec[rec.length - 1] === 2;

  console.log('rfc8291 vector match:', match);
  console.log('roundtrip decrypt ok:', roundtrip);
  process.exit(match && roundtrip ? 0 : 1);
}

// ---- main -------------------------------------------------------------------
const argv = process.argv.slice(2);
if (argv[0] === '--test') {
  selfTest();
} else {
  const sub = JSON.parse(fs.readFileSync(argv[0]));
  const payload = { title: argv[1] || 'Learnmax', body: argv[2] || '',
                    url: argv[3] || '' };
  send(sub, payload).then(r => {
    console.log(r.status, r.body);
    process.exit(r.status >= 200 && r.status < 300 ? 0 : 1);
  }).catch(e => { console.error(String(e)); process.exit(1); });
}

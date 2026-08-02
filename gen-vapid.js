#!/usr/bin/env node
// One-time VAPID keypair generation for Web Push. Run from the drill
// directory:
//
//   node gen-vapid.js
//
// Writes .vapid.json (mode 0600 -- this holds the PRIVATE key, never commit
// or share it) and prints the public key to paste into webapp/config.json
// as "vapidPublicKey". deploy-webapp.sh reads it from .vapid.json directly,
// so if you deploy with that script there is nothing to paste.

'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '.vapid.json');
if (fs.existsSync(OUT)) {
  console.error(OUT + ' already exists.');
  console.error('Re-keying invalidates every existing push subscription;');
  console.error('delete the file first if that is really what you want.');
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'P-256',
});

// The Push API wants the public key as the raw uncompressed EC point
// (65 bytes, base64url) -- the same form the RFCs use.
const b64u = b => Buffer.from(b).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const jwk = publicKey.export({ format: 'jwk' });
const raw = Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]);

const out = {
  privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
  publicKeyB64u: b64u(raw),
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 1), { mode: 0o600 });
console.log('wrote ' + OUT + '  (private key -- keep it out of git)');
console.log('');
console.log('public key (vapidPublicKey for webapp/config.json):');
console.log(out.publicKeyB64u);

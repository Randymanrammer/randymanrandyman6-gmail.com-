// Item 61: Google sign-in through Firebase Auth. The browser signs in with
// Google and sends us the Firebase ID token; we verify its RS256 signature
// against Google's published certs, audience and issuer before trusting it.
const crypto = require('crypto');

const CERTS_URL = () => process.env.FIREBASE_CERTS_URL || 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let cache = { at: 0, certs: null, maxAge: 0 };

const configured = () => !!(process.env.FIREBASE_API_KEY && process.env.FIREBASE_PROJECT_ID);
const webConfig = () => ({ apiKey: process.env.FIREBASE_API_KEY, authDomain: process.env.FIREBASE_AUTH_DOMAIN || `${process.env.FIREBASE_PROJECT_ID}.firebaseapp.com`, projectId: process.env.FIREBASE_PROJECT_ID });

async function certs() {
  if (cache.certs && Date.now() - cache.at < cache.maxAge) return cache.certs;
  const r = await fetch(CERTS_URL(), { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('could not load Google certs');
  const m = String(r.headers.get('cache-control') || '').match(/max-age=(\d+)/);
  cache = { at: Date.now(), certs: await r.json(), maxAge: (m ? +m[1] : 3600) * 1000 };
  return cache.certs;
}

async function verifyIdToken(token) {
  const project = process.env.FIREBASE_PROJECT_ID;
  const [h, p, sig] = String(token || '').split('.');
  if (!h || !p || !sig) throw new Error('bad token');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  if (header.alg !== 'RS256') throw new Error('bad alg');
  const pem = (await certs())[header.kid];
  if (!pem) throw new Error('unknown key');
  const ok = crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(crypto.createPublicKey(pem), Buffer.from(sig, 'base64url'));
  if (!ok) throw new Error('bad signature');
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== project || payload.iss !== `https://securetoken.google.com/${project}`) throw new Error('wrong project');
  if (!(payload.exp > now) || !(payload.iat <= now + 60) || !payload.sub) throw new Error('expired');
  if (!payload.email || payload.email_verified !== true) throw new Error('email not verified');
  return { email: String(payload.email).toLowerCase(), uid: payload.sub };
}

module.exports = { configured, webConfig, verifyIdToken };

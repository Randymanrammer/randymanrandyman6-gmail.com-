// Sessions: signed, httpOnly cookies. Sign-in by emailed one-time link,
// or automatically right after a Stripe Checkout the server has verified.
const crypto = require('crypto');
const config = require('./config');
const { store } = require('./store');

function key(purpose) {
  const base = config.secret('TOKEN_ENCRYPTION_KEY');
  if (!base) return null;
  return crypto.createHmac('sha256', base).update('ios:' + purpose).digest();
}

function sign(payload, purpose) {
  const k = key(purpose);
  if (!k) throw new Error('TOKEN_ENCRYPTION_KEY not connected');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', k).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token, purpose) {
  const k = key(purpose);
  if (!k || !token || typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', k).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch { return null; }
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}

const SESSION_DAYS = 30;
function startSession(res, email) {
  const token = sign({ email: email.toLowerCase(), exp: Date.now() + SESSION_DAYS * 864e5 }, 'session');
  const secure = config.baseUrl.startsWith('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `ios_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}
function endSession(res) {
  res.setHeader('Set-Cookie', 'ios_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

async function loadUser(req, _res, next) {
  req.user = null;
  const p = verify(parseCookies(req).ios_session, 'session');
  if (p && p.email) {
    req.user = { email: p.email, isOwner: p.email === config.ownerEmail };
    const m = await store.where('members', 'email', p.email);
    req.member = m[0] || null;
    req.user.skin = req.member?.settings?.skin || 'classic';
  }
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  next();
}
function requireOwner(req, res, next) {
  if (!req.user || !req.user.isOwner) return res.status(404).send('Not found');
  next();
}

// Same-origin check for every form POST (blocks cross-site form attacks).
function sameOrigin(req, res, next) {
  if (req.method !== 'POST') return next();
  const origin = req.headers.origin || req.headers.referer || '';
  if (!origin) return next(); // non-browser clients (tests, curl) carry no cookie by default
  try {
    const o = new URL(origin);
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (o.host === host) return next();
  } catch {}
  return res.status(403).send('Blocked: cross-site request');
}

function loginLinkToken(email) {
  return sign({ email: email.toLowerCase(), exp: Date.now() + 20 * 60 * 1000, n: crypto.randomBytes(6).toString('hex') }, 'login');
}

module.exports = { sign, verify, startSession, endSession, loadUser, requireLogin, requireOwner, sameOrigin, loginLinkToken };

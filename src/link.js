// Signed service-to-service link (ios-link-v1) for the Master Bot Console.
// GET /link/v1/bots  -> which bots are live and which stopped.
//
// Rules:
// - HTTPS only (Cloud Run sets x-forwarded-proto).
// - Every request is signed with HMAC-SHA256 using BOT_SHARED_KEY from
//   Google Cloud Secret Manager. Caller, timestamp (max 5 min old) and a
//   one-time nonce are inside the signature, so a copied request can't be replayed.
// - Every answer is signed the same way, so the console knows it really came from here.
// - Rotation: BOT_SHARED_KEY may hold "new,old". We sign with the first and
//   accept any of them. Add the new version in Secret Manager, wait for every
//   service to pick it up, then remove the old one.
//
// String that gets signed (lines joined with \n):
//   request:  ios-link-v1, METHOD, PATH, CALLER, TIMESTAMP, NONCE, sha256hex(body)
//   response: ios-link-v1, "response", PATH, TIMESTAMP, NONCE(from request), sha256hex(body)
const crypto = require('crypto');
const config = require('./config');
const { store } = require('./store');
const { oracle } = require('./oracle');

const MAX_SKEW_S = 300;
const ALLOWED_CALLERS = ['master-bot-console', 'overseer-a', 'overseer-b'];
const seen = new Map(); // nonce -> expiry (one instance; nonces also expire with the timestamp window)

const keys = () => config.secret('BOT_SHARED_KEY').split(',').map((k) => k.trim()).filter((k) => k.length >= 32);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const mac = (key, parts) => crypto.createHmac('sha256', key).update(['ios-link-v1', ...parts].join('\n')).digest('base64url');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function verifyRequest(req, body = '') {
  const ks = keys();
  if (!ks.length) return { ok: false, code: 503, why: 'BOT_SHARED_KEY not connected' };
  const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(config.baseUrl);
  if (!local && req.headers['x-forwarded-proto'] !== 'https' && !req.secure) return { ok: false, code: 403, why: 'https only' };
  const caller = String(req.headers['x-ios-caller'] || '');
  const ts = String(req.headers['x-ios-timestamp'] || '');
  const nonce = String(req.headers['x-ios-nonce'] || '');
  const sig = String(req.headers['x-ios-signature'] || '');
  if (!ALLOWED_CALLERS.includes(caller) || !/^\d{10}$/.test(ts) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !sig) return { ok: false, code: 401, why: 'missing or bad headers' };
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > MAX_SKEW_S) return { ok: false, code: 401, why: 'stale' };
  const parts = [req.method, req.path, caller, ts, nonce, sha(body)];
  if (!ks.some((k) => same(sig, mac(k, parts)))) return { ok: false, code: 401, why: 'bad signature' };
  for (const [n, exp] of seen) if (exp < now) seen.delete(n);
  if (seen.has(nonce)) return { ok: false, code: 401, why: 'replay' };
  seen.set(nonce, now + MAX_SKEW_S * 2);
  return { ok: true, caller, nonce };
}

function sendSigned(res, path, nonce, obj) {
  const body = JSON.stringify(obj);
  const ts = String(Math.floor(Date.now() / 1000));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-IOS-Timestamp', ts);
  res.setHeader('X-IOS-Signature', mac(keys()[0], ['response', path, ts, nonce, sha(body)]));
  res.type('application/json').send(body);
}

// Live = last run finished OK and on time. Anything else = stopped.
async function botStatus(now = Date.now()) {
  const { SCHEDULE } = require('./bots');
  const runs = await store.all('botruns');
  return Object.entries(SCHEDULE).map(([name, everyMins]) => {
    const last = runs.filter((r) => r.bot === name && r.finishedAt).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
    if (!last) return { name, status: 'stopped', reason: 'never ran', everyMins, lastRun: null };
    const late = now - new Date(last.startedAt).getTime() > everyMins * 1.5 * 60e3 + 5 * 60e3;
    const status = last.ok && !late ? 'live' : 'stopped';
    return { name, status, reason: !last.ok ? 'last run failed' : late ? 'late' : '', everyMins, lastRun: last.finishedAt };
  });
}

function mount(app, { wrap }) {
  app.get('/link/v1/bots', wrap(async (req, res) => {
    const v = verifyRequest(req);
    if (!v.ok) {
      await oracle('link', 'link.refused', { why: v.why, caller: String(req.headers['x-ios-caller'] || '').slice(0, 40) });
      return res.status(v.code).json({ error: 'refused' });
    }
    const bots = await botStatus();
    sendSigned(res, req.path, v.nonce, {
      service: 'website-builder', at: new Date().toISOString(),
      live: bots.filter((b) => b.status === 'live').length, stopped: bots.filter((b) => b.status === 'stopped').length, bots,
    });
  }));
}

module.exports = { mount, verifyRequest, botStatus, mac, sha };

// Security bot (item 73): spam protection on forms, login rate limits,
// blocks attack traffic. Limits are per server instance (in memory); Cloud
// Armor at the load balancer adds a second layer when that is set up.
const { oracle } = require('./oracle');

const buckets = new Map();
// Allow `max` hits per `windowMs` for key. Returns true if allowed.
function allow(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  if (buckets.size > 50000) for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
  return b.n <= max;
}
const ip = (req) => String(req.ip || req.headers['x-forwarded-for'] || '').split(',')[0].trim();

function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    if (allow(`${name}:${ip(req)}`, max, windowMs)) return next();
    res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
    res.status(429).send('Too many tries. Please wait a minute and try again.');
  };
}

// Paths and payloads only attack tools send.
const ATTACK_PATH = /(\/\.env|\/\.git\/|wp-admin|wp-login|xmlrpc\.php|phpmyadmin|\/cgi-bin\/|\/etc\/passwd|\.\.\/|\.php$|\/vendor\/phpunit|\/actuator|\/boaform|\/HNAP1)/i;
const ATTACK_QS = /(union\s+select|<script|%3Cscript|sleep\(\d|benchmark\(|\$\{jndi:|\/bin\/sh|;\s*cat\s)/i;
const banned = new Map(); // ip -> until
const stats = { blocked: 0, since: new Date().toISOString() };

function blockAttacks(req, res, next) {
  const who = ip(req);
  const until = banned.get(who);
  if (until && Date.now() < until) { stats.blocked++; return res.status(403).send('Blocked'); }
  let raw = req.originalUrl || '';
  try { raw += ' ' + decodeURIComponent(raw); } catch {}
  if (ATTACK_PATH.test(req.path) || ATTACK_QS.test(raw)) {
    stats.blocked++;
    if (!allow('attack:' + who, 5, 10 * 60e3)) {
      banned.set(who, Date.now() + 60 * 60e3);
      oracle('bot:security', 'security.ip_blocked', { ip: who.replace(/\.\d+$/, '.x'), path: req.path.slice(0, 80) }).catch(() => {});
    }
    return res.status(404).send('Not found');
  }
  next();
}

// Form spam check: honeypot, too-fast, too many links, rate per IP.
function spamCheck(req, body) {
  if (String(body.website || '').trim()) return 'honeypot';
  const ts = Number(body.ts || 0);
  const age = Date.now() - ts;
  if (!ts || age < 2500 || age > 2 * 864e5) return 'timing';
  const text = `${body.message || ''} ${body.name || ''}`;
  if ((text.match(/https?:\/\//gi) || []).length >= 3) return 'links';
  if (/\b(viagra|casino|crypto signals|seo services|backlinks)\b/i.test(text)) return 'keywords';
  if (!allow('form:' + ip(req), 5, 60e3)) return 'rate';
  return null;
}

module.exports = { allow, rateLimit, blockAttacks, spamCheck, ip, stats };

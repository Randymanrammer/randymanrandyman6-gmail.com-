// AES-256-GCM for tokens members give us (e.g. their GitHub token), keyed
// from TOKEN_ENCRYPTION_KEY. Stored values are never shown back or logged.
const crypto = require('crypto');
const config = require('./config');

function key() {
  const k = config.secret('TOKEN_ENCRYPTION_KEY');
  if (!k) throw Object.assign(new Error('TOKEN_ENCRYPTION_KEY not connected'), { status: 503 });
  return crypto.createHash('sha256').update('ios-box:' + k).digest();
}
function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}
function open(box) {
  const [iv, tag, enc] = String(box).split('.').map((x) => Buffer.from(x, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
module.exports = { seal, open };

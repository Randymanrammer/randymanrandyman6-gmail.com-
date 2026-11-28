// Tests the signed Master Bot Console link (src/link.js). Run: npm run test:link
const crypto = require('crypto');
const KEY = crypto.randomBytes(32).toString('hex');
const OLD = crypto.randomBytes(32).toString('hex');
Object.assign(process.env, { STORE: 'memory', BOT_SHARED_KEY: `${KEY},${OLD}`, CRON_SECRET: 'c'.repeat(40), TOKEN_ENCRYPTION_KEY: 't'.repeat(40) });

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  - ' + extra : ''}`); };

(async () => {
  const config = require('../src/config');
  const app = require('../src/server');
  const { store } = require('../src/store');
  const link = require('../src/link');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.baseUrl = base;

  const P = '/link/v1/bots';
  const signed = (key = KEY, over = {}) => {
    const h = { caller: 'master-bot-console', ts: String(Math.floor(Date.now() / 1000)), nonce: crypto.randomBytes(16).toString('hex'), ...over };
    return { h, headers: { 'x-ios-caller': h.caller, 'x-ios-timestamp': h.ts, 'x-ios-nonce': h.nonce, 'x-ios-signature': link.mac(key, ['GET', P, h.caller, h.ts, h.nonce, link.sha('')]) } };
  };

  // one bot ran fine just now, one failed, the rest never ran
  const now = new Date().toISOString();
  await store.add('botruns', { bot: 'uptime', startedAt: now, finishedAt: now, ok: true });
  await store.add('botruns', { bot: 'security', startedAt: now, finishedAt: now, ok: false });

  const a = signed();
  let r = await fetch(base + P, { headers: a.headers });
  const body = await r.text();
  const j = JSON.parse(body);
  const wantSig = link.mac(KEY, ['response', P, r.headers.get('x-ios-timestamp'), a.h.nonce, link.sha(body)]);
  check('Signed request gets bot status', r.status === 200 && j.service === 'website-builder');
  check('Shows live vs stopped', j.bots.find((b) => b.name === 'uptime').status === 'live' && j.bots.find((b) => b.name === 'security').status === 'stopped' && j.bots.find((b) => b.name === 'backup').reason === 'never ran', `live ${j.live}, stopped ${j.stopped}`);
  check('Answer is signed (console can verify it came from the builder)', r.headers.get('x-ios-signature') === wantSig);
  check('No caching of the answer', r.headers.get('cache-control') === 'no-store');

  r = await fetch(base + P, { headers: a.headers });
  check('Same request replayed = refused', r.status === 401);
  r = await fetch(base + P);
  check('No signature = refused', r.status === 401);
  r = await fetch(base + P, { headers: signed(crypto.randomBytes(32).toString('hex')).headers });
  check('Wrong key = refused', r.status === 401);
  r = await fetch(base + P, { headers: signed(KEY, { ts: String(Math.floor(Date.now() / 1000) - 900) }).headers });
  check('15-minute-old request = refused', r.status === 401);
  r = await fetch(base + P, { headers: signed(KEY, { caller: 'stranger' }).headers });
  check('Unknown caller = refused', r.status === 401);
  const t = signed(); t.headers['x-ios-caller'] = 'overseer-a';
  r = await fetch(base + P, { headers: t.headers });
  check('Changing a signed field = refused', r.status === 401);
  r = await fetch(base + P, { headers: signed(OLD).headers });
  check('Key rotation: previous key still accepted while both are listed', r.status === 200);
  r = await fetch(base + P, { headers: signed(KEY, { caller: 'overseer-b' }).headers });
  check('Overseer B can read too', r.status === 200);

  config.baseUrl = 'https://success-domain.com';
  r = await fetch(base + P, { headers: signed().headers });
  check('Plain http refused in production (HTTPS only)', r.status === 403);
  r = await fetch(base + P, { headers: { ...signed().headers, 'x-forwarded-proto': 'https' } });
  check('HTTPS request accepted in production', r.status === 200);
  config.baseUrl = base;

  const refused = (await store.all('oracle')).filter((o) => o.what === 'link.refused').length;
  check('Refusals logged to the Oracle', refused >= 6, `${refused} logged`);

  server.close();
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

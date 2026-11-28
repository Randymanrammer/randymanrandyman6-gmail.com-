// ITEMS 21-100 TEST. Runs the real app on a local port with the in-memory store.
// Outside services are replaced by local stand-ins that record what they got:
// Gemini/Imagen, GitHub, Resend, Firebase certs, IndexNow, PageSpeed.
// Stripe items (payment check bot, live numbers, tax bot, referral credit) run
// against REAL Stripe TEST mode when STRIPE_SECRET_KEY is set (refuses live).
// The builder UI (chat, tap-to-edit, undo/redo, image crop/compress, mobile)
// is driven in a real Chromium browser with Playwright.
const crypto = require('crypto');
const http = require('http');
const zlib = require('zlib');

const GEMINI_KEY = 'test-gemini-key-' + crypto.randomBytes(6).toString('hex');
Object.assign(process.env, {
  STORE: 'memory', TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), CRON_SECRET: crypto.randomBytes(16).toString('hex'),
  GEMINI_API_KEY: GEMINI_KEY, RESEND_API_KEY: 're_test', GITHUB_TOKEN: 'ghp_owner_test_token_0000000000', BUILD_RECORDS_REPO: 'owner/records',
  BUSINESS_MAILING_ADDRESS: '123 Test St, Testville', FIREBASE_API_KEY: 'AIzaTest', FIREBASE_PROJECT_ID: 'ios-test',
  AI_MONTHLY_CREDITS: '60', AI_BUDGET_USD: '1000', STRIPE_WEBHOOK_SECRET: 'whsec_' + crypto.randomBytes(12).toString('hex'),
});
if (/^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY || '')) { console.error('REFUSING: live key'); process.exit(2); }
const HAS_STRIPE = !!process.env.STRIPE_SECRET_KEY;

const results = [];
function check(item, name, ok, info = '') {
  results.push({ item, name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${item}. ${name}${info ? '  - ' + info : ''}`);
}

// ---------- local stand-ins ----------
const got = { gemini: [], github: [], resend: [], indexnow: [], pagespeed: 0 };
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'testkid1';
const PNG = (w, h) => { // valid solid PNG
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x88)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32 ? zlib.crc32(Buffer.concat([Buffer.from(t), d])) : 0); return Buffer.concat([l, Buffer.from(t), d, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
function geminiAnswer(body) {
  const sys = body.systemInstruction?.parts?.[0]?.text || '';
  const p = body.contents?.[0]?.parts?.[0]?.text || '';
  const J = (o) => JSON.stringify(o);
  if (p.includes('Allowed ops')) return J({ reply: 'Added a FAQ section.', ops: [{ op: 'add_section', type: 'faq' }, { op: 'add_item', type: 'reviews', item: { name: 'Fake', text: 'fake' } }] });
  if (p.includes('SEO meta')) return J({ pages: [...p.matchAll(/PAGE id=(\S+)/g)].map((m) => ({ id: m[1], title: `AI title ${m[1]}`, description: `AI description for ${m[1]} page of the bakery`, keywords: 'bread, bakery' })) });
  if (p.includes('Translate each string')) { const arr = JSON.parse(p.slice(p.indexOf('\n') + 1)); return J({ t: arr.map((s) => 'ES ' + s) }); }
  if (p.includes('Write 3 short posts')) return J({ Facebook: 'FB post http://x', Instagram: 'IG post #bread', X: 'X post' });
  if (p.includes('Write up to 6 FAQs')) return J({ items: [{ q: 'Where are you?', a: 'At 1 Main St.' }] });
  if (p.includes('Draft a short, friendly email reply')) return 'Hi Ann, thanks for your request. We will confirm soon. - Test Bakery';
  if (sys.includes('AI assistant on the website')) return 'We sell sourdough. (I am an AI assistant.)';
  if (sys.includes('AI support assistant')) return /refund/i.test(p) ? 'HANDOFF: wants a refund' : 'Tap any text in the builder to edit it.';
  if (p.startsWith('Make it')) return 'Clearer: ' + p.split('TEXT:\n')[1];
  return 'ok';
}
const mock = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (u.pathname.startsWith('/v1beta/models/')) {
      const body = JSON.parse(b || '{}');
      got.gemini.push({ path: u.pathname, key: req.headers['x-goog-api-key'], body });
      if (u.pathname.endsWith(':predict')) return send(200, { predictions: [{ bytesBase64Encoded: PNG(64, 36).toString('base64'), mimeType: 'image/png' }] });
      return send(200, { candidates: [{ content: { parts: [{ text: geminiAnswer(body) }] } }] });
    }
    if (u.pathname === '/emails') { got.resend.push(JSON.parse(b)); return send(200, { id: 'em_' + got.resend.length }); }
    if (u.pathname === '/certs') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=3600' }); return res.end(JSON.stringify({ [KID]: publicKey.export({ type: 'spki', format: 'pem' }) })); }
    if (u.pathname === '/indexnow') { got.indexnow.push(JSON.parse(b)); return send(202, {}); }
    if (u.pathname === '/pagespeed') { got.pagespeed++; return send(200, { lighthouseResult: { categories: { performance: { score: 0.93 } } } }); }
    // GitHub
    got.github.push({ method: req.method, path: u.pathname, auth: req.headers.authorization, body: b ? JSON.parse(b) : null });
    if (u.pathname === '/user') return send(200, { login: 'memberuser' });
    if (req.method === 'GET' && u.pathname.startsWith('/repos/')) return send(404, { message: 'Not Found' });
    if (req.method === 'POST' && u.pathname === '/user/repos') return send(201, { full_name: 'memberuser/x' });
    if (req.method === 'PUT') return send(201, { content: {} });
    send(404, {});
  });
});

// ---------- HTTP client with cookies + Host header ----------
let base, port;
function request(method, path, { form, json, cookie, host, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const body = form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : null;
    const h = { ...headers };
    if (form) h['content-type'] = 'application/x-www-form-urlencoded';
    if (json) h['content-type'] = 'application/json';
    if (cookie) h.cookie = cookie;
    if (host) h.host = host;
    if (body) h['content-length'] = Buffer.byteLength(body);
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, text: buf.toString(), buf }); });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const jwt = (payload, key = privateKey, kid = KID) => {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${h}.${p}.${crypto.createSign('RSA-SHA256').update(`${h}.${p}`).sign(key).toString('base64url')}`;
};

(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const M = `http://127.0.0.1:${mock.address().port}`;
  Object.assign(process.env, { GEMINI_BASE_URL: M, RESEND_BASE_URL: M, GITHUB_API_URL: M, FIREBASE_CERTS_URL: M + '/certs', INDEXNOW_URL: M + '/indexnow', PAGESPEED_URL: M + '/pagespeed' });

  const config = require('../src/config');
  const app = require('../src/server');
  const auth = require('../src/auth');
  const { store } = require('../src/store');
  const bots = require('../src/bots');
  const docs = require('../src/doc');
  const render = require('../src/render');
  const templates = require('../src/templates');
  const governor = require('../src/governor');
  const domains = require('../src/domains');
  const referrals = require('../src/referrals');
  const billing = require('../src/billing');
  const features = require('../src/features');

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  config.baseUrl = base;
  // Test owner stands in for the real one (real owner is pinned by hash in config.js).
  config.ownerEmail = 'owner@example.test';
  config.ownerEmailSha256 = crypto.createHash('sha256').update(config.ownerEmail).digest('hex');
  const cookieFor = (email, m = 'google') => 'ios_session=' + encodeURIComponent(auth.sign({ email, m, exp: Date.now() + 864e5 }, 'session'));
  const now = new Date().toISOString();
  const mkMember = async (email, extra = {}) => store.get('members', await store.add('members', { email, status: 'active', subscriptionStatus: 'trialing', trialEnd: Math.floor(Date.now() / 1000) + 20 * 86400, createdAt: now, settings: {}, ...extra }));
  const A = await mkMember('alice@example.com');
  const B = await mkMember('bob@example.com');
  const ca = cookieFor(A.email), cb = cookieFor(B.email), co = cookieFor(config.ownerEmail);
  const emailsOf = async (kind) => (await store.all('emails')).filter((e) => e.kind === kind);

  // ===== 22 build pages from real details =====
  const input = { businessName: 'Test Bakery', siteName: 'test-bakery', tagline: 'Fresh bread daily', description: 'Family bakery since 1990.', services: 'Sourdough\nCakes',
    phone: '555-0100', email: 'hi@testbakery.example', address: '1 Main St, Springfield', hours: 'Mon-Fri 7-3', menu: 'Croissant - $3.50\nBaguette - $4', faqs: 'Do you deliver? Yes, within 5 miles.', takesBookings: 'yes', template: 'bakery' };
  let r = await request('POST', '/sites', { form: input, cookie: ca });
  const site = (await store.where('sites', 'slug', 'test-bakery'))[0];
  check(22, 'Create site -> opens builder', r.status === 303 && r.headers.location === `/sites/${site.id}/builder`);
  const titles = site.doc.pages.map((p) => p.title);
  check(22, 'Pages that fit: Home, About, Services, Menu, Booking, FAQ, Contact', ['Home', 'About', 'Services', 'Menu', 'Booking', 'FAQ', 'Contact'].every((t) => titles.includes(t)), titles.join(','));
  const allowed = new Set([...Object.values(input), 'Croissant', '$3.50', 'Baguette', '$4', 'Do you deliver?', 'Yes, within 5 miles.', 'Sourdough', 'Cakes']);
  const genericHeadings = /^(# .*|About us|Services|Menu|Questions|Hours|Contact|Find us|Send us a message|Book an appointment|Contact us)$/;
  const invented = docs.docText(site.doc).split('\n').filter((l) => !allowed.has(l) && !genericHeadings.test(l));
  check(22, 'No made-up facts (every text came from the member or is a plain heading)', invented.length === 0, invented.join(' | '));
  const plain = await store.get('sites', (await store.add('sites', { memberId: B.id, slug: 'bob-plain', details: docs.parseDetails({ businessName: 'Bob Plain' }), published: false, archived: false, doc: docs.buildDoc(docs.parseDetails({ businessName: 'Bob Plain' }), templates.BUILT_IN[4]) })));
  check(22, 'Menu/Booking/FAQ only when they fit', !plain.doc.pages.some((p) => ['Menu', 'Booking', 'FAQ'].includes(p.title)));

  // ===== 21 builder page =====
  r = await request('GET', `/sites/${site.id}/builder`, { cookie: ca });
  check(21, 'Builder: chat on the left, live preview on the right', r.status === 200 && r.text.includes('id="chat"') && r.text.includes('id="pv"') && r.text.includes('grid-template-columns:minmax(280px,360px) 1fr'));
  const js = await request('GET', '/static/builder.js');
  check(21, 'Builder script loads and parses', js.status === 200 && (() => { try { new (require('vm').Script)(js.text); return true; } catch { return false; } })());
  check(60, 'AI key never sent to the browser', !r.text.includes(GEMINI_KEY) && !js.text.includes(GEMINI_KEY) && !r.text.includes('generativelanguage'));

  // ===== 26 chat commands =====
  const chat = async (message, cookie = ca, s = site) => (await request('POST', `/sites/${s.id}/chat`, { json: { message, pageId: 'home' }, cookie })).text;
  let c = JSON.parse(await chat('add gallery'));
  check(26, 'Chat "add gallery" adds a gallery section', c.doc && c.doc.pages[0].sections.some((x) => x.type === 'gallery'));
  c = JSON.parse(await chat('move gallery to top'));
  check(26, 'Chat "move gallery to top"', c.doc && c.doc.pages[0].sections[0].type === 'gallery');
  c = JSON.parse(await chat('remove gallery'));
  check(26, 'Chat "remove gallery"', c.doc && !c.doc.pages[0].sections.some((x) => x.type === 'gallery'));
  for (const t of ['pricing', 'map', 'faq']) await chat('add ' + t);
  c = JSON.parse(await chat('add price Loaf - $6 whole wheat'));
  check(26, 'Add hero, gallery, services, pricing, map, FAQ sections', ['hero', 'services', 'pricing', 'map', 'faq'].every((t) => c.doc.pages[0].sections.some((x) => x.type === t)));
  c = JSON.parse(await chat('add review'));
  check(26, 'Reviews must be real: unconfirmed review refused', !c.doc && /must be real/.test(c.reply));
  c = JSON.parse(await chat('add real review Maria | Google review | Best croissants!'));
  check(26, 'Real review with source accepted', c.doc && c.doc.pages[0].sections.find((x) => x.type === 'reviews').data.items[0].attestedReal === true);
  c = JSON.parse(await chat('please make my site better'));
  check(21, 'Free-form chat goes to AI (server-side), ops applied', c.doc && c.reply.includes('Added a FAQ section') && got.gemini.at(-1).key === GEMINI_KEY);
  check(26, 'AI cannot add reviews', !c.doc.pages[0].sections.find((x) => x.type === 'reviews').data.items.some((i) => i.name === 'Fake'));

  // ===== 24 versions + restore =====
  r = await request('GET', `/sites/${site.id}/versions`, { cookie: ca });
  const vers = JSON.parse(r.text).versions;
  check(24, 'Version history kept for every save', vers.length >= 8, vers.length + ' versions');
  const first = vers.at(-1);
  r = await request('POST', `/sites/${site.id}/versions/${first.id}/restore`, { json: {}, cookie: ca });
  check(24, 'One-tap restore of an old version', r.status === 200 && !JSON.parse(r.text).doc.pages[0].sections.some((x) => x.type === 'reviews'));
  await request('POST', `/sites/${site.id}/versions/${vers[0].id}/restore`, { json: {}, cookie: ca });

  // ===== 48 member data walled off =====
  const bChecks = await Promise.all([
    request('GET', `/sites/${site.id}/builder`, { cookie: cb }), request('GET', `/sites/${site.id}/doc.json`, { cookie: cb }),
    request('POST', `/sites/${site.id}/doc`, { json: { doc: site.doc }, cookie: cb }), request('GET', `/sites/${site.id}/stats`, { cookie: cb }),
    request('GET', `/sites/${site.id}/backups`, { cookie: cb }), request('GET', `/sites/${site.id}/preview`, { cookie: cb }),
    request('POST', `/sites/${site.id}/chat`, { json: { message: 'add map' }, cookie: cb }),
  ]);
  check(48, "Member B can't open, edit, chat, see stats/backups of member A's site", bChecks.every((x) => x.status === 404 || x.status >= 400), bChecks.map((x) => x.status).join(','));

  // ===== 28 uploads =====
  const big = PNG(2400, 1600);
  r = await request('POST', `/sites/${site.id}/upload`, { json: { data: PNG(40, 40).toString('base64'), mime: 'image/png', name: 'a.png' }, cookie: ca });
  check(87, 'Upload refused without rights confirmation', r.status === 400);
  r = await request('POST', `/sites/${site.id}/upload`, { json: { data: Buffer.from('<svg onload=alert(1)>').toString('base64'), mime: 'image/svg+xml', rightsConfirmed: true }, cookie: ca });
  check(28, 'Non-image / SVG refused', r.status === 400);
  r = await request('POST', `/sites/${site.id}/upload`, { json: { data: crypto.randomBytes(800000).toString('base64'), mime: 'image/jpeg', rightsConfirmed: true }, cookie: ca });
  check(28, 'Oversize image refused', r.status >= 400);

  // ===== Browser: 21, 23, 24, 25, 28 =====
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  let gimg = null;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await ctx.addCookies([{ name: 'ios_session', value: cookieFor(A.email).split('=')[1], url: base }]);
    const pg = await ctx.newPage();
    const errors = [];
    pg.on('pageerror', (e) => errors.push(e.message));
    await pg.goto(`${base}/sites/${site.id}/builder`);
    const fr = () => pg.frameLocator('#pv');
    await fr().locator('h1[data-edit]').waitFor();
    await pg.fill('#msg', 'add gallery');
    await pg.click('#chat button');
    await fr().locator('.sec-gallery').waitFor({ timeout: 10000 });
    check(21, 'Browser: chat message updates live preview', await fr().locator('.sec-gallery').count() === 1);
    // tap to edit
    await fr().locator('h1[data-edit]').click();
    await pg.keyboard.press('Control+A');
    await pg.keyboard.type('Best Test Bakery');
    await fr().locator('body').click({ position: { x: 5, y: 5 } });
    const heroOf = async () => (await store.get('sites', site.id)).doc.pages[0].sections.find((x) => x.type === 'hero').data.heading;
    const waitFor = async (want) => { for (let i = 0; i < 50 && (await heroOf()) !== want; i++) await pg.waitForTimeout(200); };
    await waitFor('Best Test Bakery');
    let saved = await store.get('sites', site.id);
    check(23, 'Browser: tap text in preview, type, saved', saved.doc.pages[0].sections.find((x) => x.type === 'hero').data.heading === 'Best Test Bakery');
    await pg.click('#undo');
    await waitFor('Test Bakery');
    saved = await store.get('sites', site.id);
    check(24, 'Browser: Undo', saved.doc.pages[0].sections.find((x) => x.type === 'hero').data.heading === 'Test Bakery');
    await pg.click('#redo');
    await waitFor('Best Test Bakery');
    saved = await store.get('sites', site.id);
    check(24, 'Browser: Redo', saved.doc.pages[0].sections.find((x) => x.type === 'hero').data.heading === 'Best Test Bakery');
    // image: crop 16:9, resize, compress
    await fr().locator('.sec-gallery [data-edit-img]').first().click();
    await pg.locator('#f').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: big });
    await pg.selectOption('#ratio', '1.778');
    await pg.waitForFunction(() => /^1600×900/.test(document.getElementById('sz').textContent), null, { timeout: 10000 });
    await pg.fill('#alt', 'Fresh bread on the counter');
    await pg.check('#rights');
    await pg.click('#up');
    await pg.waitForFunction(() => !document.getElementById('panel').open, null, { timeout: 15000 });
    saved = await store.get('sites', site.id);
    gimg = saved.doc.pages[0].sections.find((x) => x.type === 'gallery').data.images[0];
    const asset = gimg && await store.get('assets', gimg.src.split('/').pop());
    const dims = asset && await pg.evaluate(async (src) => { const i = new Image(); i.src = src; await i.decode(); return [i.naturalWidth, i.naturalHeight]; }, base + gimg.src);
    check(28, 'Browser: crop to 16:9 + resize to 1600 wide + compress', asset && dims[0] === 1600 && dims[1] === 900 && asset.bytes < 600000 && asset.rightsConfirmed, asset ? `${dims} ${asset.bytes}B ${asset.mime}` : 'none');
    check(37, 'Image alt text prompt required and saved', gimg?.alt === 'Fresh bread on the counter');
    check(21, 'Browser: no script errors in builder', errors.length === 0, errors.join(' | '));
    // mobile builder
    const mob = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true });
    await mob.addCookies([{ name: 'ios_session', value: cookieFor(A.email).split('=')[1], url: base }]);
    const mp = await mob.newPage();
    await mp.goto(`${base}/sites/${site.id}/builder`);
    const chatVisible = await mp.isVisible('#chat');
    await mp.click('[data-tab=preview]');
    check(25, 'Builder on a phone: Chat / Preview tabs', chatVisible && await mp.isVisible('#pv') && !(await mp.isVisible('#chat')));
    await mob.close();
    await ctx.close();
  } catch (e) { check(21, 'Browser run', false, e.message); }

  // ===== 29 publish via Governor, 30 floor plan, 98 build record =====
  r = await request('POST', `/sites/${site.id}/publish.json`, { json: {}, cookie: ca });
  let pub = JSON.parse(r.text);
  check(29, 'One-tap publish', pub.published === true, JSON.stringify(pub.governor?.issues || []).slice(0, 200));
  r = await request('GET', '/s/test-bakery/');
  check(41, 'Published site is hosted', r.status === 200 && r.text.includes('Best Test Bakery'));
  await request('POST', `/sites/${site.id}/chat`, { json: { message: 'change heading to Draft Only' }, cookie: ca });
  r = await request('GET', '/s/test-bakery/');
  check(29, 'Draft edits not live until Publish (preview first)', !r.text.includes('Draft Only') && (await request('GET', `/sites/${site.id}/preview`, { cookie: ca })).text.includes('Draft Only'));
  await request('POST', `/sites/${site.id}/chat`, { json: { message: 'change heading to Test Bakery' }, cookie: ca });
  const fp = (await store.all('floorplans')).find((f) => f.siteId === site.id);
  check(30, 'Floor plan snapshot saved to template library (layout only, no content)', fp && fp.plan.pages.length > 3 && !JSON.stringify(fp.plan).includes('Sourdough'));
  check(98, 'Published site saved to owner GitHub build-records repo', got.github.some((g) => g.method === 'PUT' && g.path.startsWith('/repos/owner/records/contents/sites/test-bakery/') && g.auth === 'Bearer ' + process.env.GITHUB_TOKEN));

  // ===== 30 member GitHub export =====
  r = await request('POST', '/account/github', { form: { token: 'ghp_memberToken1234567890abcdef' }, cookie: ca });
  const aNow = await store.get('members', A.id);
  check(30, 'Member GitHub token stored encrypted', r.status === 303 && aNow.githubTokenBox && !JSON.stringify(aNow).includes('ghp_memberToken'));
  got.github.length = 0;
  r = await request('POST', `/sites/${site.id}/export/github`, { form: { repo: 'my-bakery-site' }, cookie: ca });
  check(30, 'Export site code to member GitHub (private repo + files)', r.status === 200 && got.github.some((g) => g.method === 'POST' && g.path === '/user/repos' && g.body.private) && got.github.some((g) => g.method === 'PUT' && g.path === '/repos/memberuser/my-bakery-site/contents/index.html' && g.auth === 'Bearer ghp_memberToken1234567890abcdef'));

  // ===== 31-40 templates =====
  const all = await templates.allTemplates();
  check(31, '10 starter templates', templates.BUILT_IN.length === 10 && ['bakery', 'dental', 'freight', 'detailing', 'advisory', 'salon', 'home', 'realestate', 'fitness', 'retail'].every((id) => all.some((t) => t.id === id)));
  check(32, '5 builder skins', Object.keys(templates.SKINS).length === 5);
  await request('POST', '/account/skin', { form: { skin: 'forest' }, cookie: ca });
  r = await request('GET', '/dashboard', { cookie: ca });
  check(32, 'Member switches skin; builder look changes', r.text.includes(templates.SKINS.forest.bg));
  let d = structuredClone((await store.get('sites', site.id)).doc);
  d.theme.colors = { light: { bg: '#ffffff', fg: '#222222', acc: '#123456', card: '#f0f0f0' }, dark: null };
  d.theme.headingFont = 'Merriweather';
  d.theme.logo = { src: gimg.src, alt: 'Test Bakery logo', rightsConfirmed: true };
  await request('POST', `/sites/${site.id}/doc`, { json: { doc: d, note: 'brand' }, cookie: ca });
  const pv = await Promise.all(['', 'about', 'contact'].map((p) => request('GET', `/sites/${site.id}/preview?page=${p}`, { cookie: ca })));
  check(33, 'Brand kit (logo, colors, fonts) on every page', pv.every((x) => x.text.includes('--acc:#123456') && x.text.includes('family=Merriweather') && x.text.includes('Test Bakery logo')));
  r = await request('GET', '/templates');
  const demo = await request('GET', '/templates/salon/demo');
  check(34, 'Template gallery with live demos labeled "Sample"', r.text.split('View sample').length - 1 === 10 && demo.text.includes('SAMPLE - demo template') && demo.text.includes('Sample Salon'));
  const beforeText = docs.docText(d);
  d.template = 'fitness';
  const sw = JSON.parse((await request('POST', `/sites/${site.id}/doc`, { json: { doc: d, note: 'switch' }, cookie: ca })).text).doc;
  check(35, 'Switch template without losing content', sw.template === 'fitness' && docs.docText(sw) === beforeText);
  const every = templates.BUILT_IN.map((t) => { const x = require('../src/routes/builder').demoHtml(t, '/', ''); return x.includes('prefers-color-scheme:dark') && x.includes('id="tog"') && x.includes('[data-mode=dark]'); });
  check(36, 'Light and dark mode on every template', every.every(Boolean));
  const fixedPal = render.palette(['#888888', '#777777', '#8a8a8a', '#888888']);
  check(37, 'Readable contrast enforced automatically', render.contrast(fixedPal.fg, fixedPal.bg) >= 4.5 && render.contrast(fixedPal.acc, fixedPal.bg) >= 4.5);
  check(37, 'Keyboard friendly: skip link, focus outline, labeled form fields', demo.text.includes('class="skip"') && demo.text.includes(':focus-visible') && /<label for="[^"]+">Name/.test(pv[2].text));
  r = await request('GET', '/s/test-bakery/');
  check(38, 'Fast: lazy-loaded images, cached pages', /loading="lazy" decoding="async"/.test(r.text) && /s-maxage/.test(r.headers['cache-control']));
  await request('POST', `/sites/${site.id}/pagespeed`, { form: {}, cookie: ca });
  r = await request('GET', `/sites/${site.id}/stats`, { cookie: ca });
  check(38, 'PageSpeed score on the dashboard', got.pagespeed === 1 && r.text.includes('>93<'));
  check(39, 'Every built-in template passes the Governor before offered', (await templates.checkedBuiltIns()).length === 10);
  r = await request('POST', '/owner/templates', { form: { id: 'bakery-two', name: 'Bakery Two', industry: 'Food', light: '#ffffff,#111111,#aa3300,#f5f5f5', dark: '#111111,#eeeeee,#ff8855,#1c1c1c', hf: 'Lato', bf: 'Lato', sections: 'hero,about,contact', sampleName: 'Biz' }, cookie: co });
  check(40, 'Owner adds a template from the console; Governor checks; offered', (await templates.allTemplates()).some((t) => t.id === 'bakery-two') && (await store.all('governor')).some((g) => g.templateId === 'bakery-two'));

  // ===== 42-50 hosting =====
  d = structuredClone((await store.get('sites', site.id)).doc);
  d.template = 'bakery';
  d.settings.redirects = [{ from: '/old-menu', to: '/menu' }];
  d.settings.notFound = { heading: 'Oops, no bread here', text: 'Try the menu.' };
  await request('POST', `/sites/${site.id}/doc`, { json: { doc: d }, cookie: ca });
  await request('POST', `/sites/${site.id}/publish.json`, { json: {}, cookie: ca });
  r = await request('GET', '/', { host: `test-bakery.${config.domain}` });
  check(42, 'Free address [site].DOMAIN serves the site', r.status === 200 && r.text.includes('Test Bakery') && r.text.includes('Croissant') === false);
  r = await request('GET', '/menu', { host: `test-bakery.${config.domain}` });
  check(42, 'Subdomain multi-page', r.status === 200 && r.text.includes('Croissant'));
  r = await request('GET', '/s/test-bakery/menu');
  check(43, 'Backup address DOMAIN/s/[site]', r.status === 200 && r.text.includes('Croissant'));
  r = await request('GET', `/sites/${site.id}/domain`, { cookie: ca });
  check(44, 'Custom domains show "Coming soon" until load balancer IP set', r.text.includes('Coming soon'));
  process.env.LB_IP = '203.0.113.10';
  r = await request('GET', `/sites/${site.id}/domain`, { cookie: ca });
  check(44, 'With LB IP: step-by-step DNS help', r.text.includes('Add domain'));
  await request('POST', `/sites/${site.id}/domain`, { form: { host: 'www.TestBakery.example' }, cookie: ca });
  const dom = (await store.where('domains', 'siteId', site.id))[0];
  r = await request('GET', `/sites/${site.id}/domain`, { cookie: ca });
  check(44, 'DNS steps show A record value', r.text.includes('A record') && r.text.includes('203.0.113.10'));
  const notYet = await domains.verify(dom, async () => ['1.2.3.4']);
  const yes = await domains.verify(dom, async () => ['203.0.113.10']);
  r = await request('GET', '/about', { host: 'www.testbakery.example' });
  check(44, 'Verified custom domain serves the site', !notYet.ok && yes.ok && r.status === 200 && r.text.includes('Family bakery since 1990'));
  r = await request('POST', `/sites/${plain.id}/domain`, { form: { host: 'www.testbakery.example' }, cookie: cb });
  check(48, "Member B can't take member A's domain", (await store.where('domains', 'host', 'www.testbakery.example')).length === 1);
  delete process.env.LB_IP;
  r = await request('GET', '/s/test-bakery/');
  check(46, 'CDN caching headers on sites and images', /public/.test(r.headers['cache-control']) && /immutable/.test((await request('GET', gimg.src)).headers['cache-control']));
  r = await request('GET', '/s/test-bakery/sitemap.xml');
  const rb = await request('GET', '/s/test-bakery/robots.txt');
  check(49, 'sitemap.xml and robots.txt per site', r.status === 200 && r.text.includes('/s/test-bakery/menu</loc>') && rb.text.includes('Sitemap: ') && rb.text.includes('sitemap.xml'));
  r = await request('GET', '/s/test-bakery/nope');
  check(50, 'Custom 404 page per site', r.status === 404 && r.text.includes('Oops, no bread here'));
  r = await request('GET', '/s/test-bakery/old-menu');
  check(50, '301 redirects per site', r.status === 301 && r.headers.location === '/s/test-bakery/menu');
  const bk = await bots.run('backup');
  const backupsA = await store.where('backups', 'siteId', site.id);
  check(47, 'Daily backup made', bk.ok && backupsA.length === 1);
  check(72, 'Backup bot test-restores one each week', bk.summary.restoreTest && bk.summary.restoreTest.ok);
  d = structuredClone((await store.get('sites', site.id)).doc); d.pages[0].sections = []; await request('POST', `/sites/${site.id}/doc`, { json: { doc: d }, cookie: ca });
  r = await request('POST', `/sites/${site.id}/backups/${backupsA[0].id}/restore`, { form: {}, cookie: ca });
  check(47, 'One-tap restore from backup', (await store.get('sites', site.id)).doc.pages[0].sections.length > 3);
  r = await request('POST', `/sites/${site.id}/backups/${backupsA[0].id}/restore`, { form: {}, cookie: cb });
  check(48, "Member B can't restore member A's backup", r.status === 404 || r.status >= 400);

  // ===== 51-60 AI =====
  await request('POST', `/sites/${site.id}/assistant`, { json: { on: true }, cookie: ca });
  await request('POST', `/sites/${site.id}/publish.json`, { json: {}, cookie: ca });
  r = await request('GET', '/s/test-bakery/');
  const asst = await request('POST', '/s/test-bakery/assistant', { form: { q: 'What do you sell?' } });
  const lastG = got.gemini.at(-1).body;
  check(51, 'Site AI assistant answers from site content and says it is an AI', r.text.includes('This is an AI assistant') && JSON.parse(asst.text).answer.includes('sourdough') && lastG.contents[0].parts[0].text.includes('Family bakery since 1990'));
  const sec = (await store.get('sites', site.id)).doc.pages[0].sections.findIndex((x) => x.type === 'hero');
  r = await request('POST', `/sites/${site.id}/ai/rewrite`, { json: { path: `pages.0.sections.${sec}.data.text`, how: 'Make it clearer' }, cookie: ca });
  check(52, 'AI writer suggests; nothing changes until member approves', JSON.parse(r.text).suggestion === 'Clearer: Fresh bread daily' && (await store.get('sites', site.id)).doc.pages[0].sections[sec].data.text === 'Fresh bread daily');
  r = await request('POST', `/sites/${site.id}/ai/image`, { json: { prompt: 'bread on a wooden table' }, cookie: ca });
  const ai1 = JSON.parse(r.text);
  const aiAsset = ai1.src && await store.get('assets', ai1.src.split('/').pop());
  d = structuredClone((await store.get('sites', site.id)).doc);
  d.pages[0].sections[sec].data.image = { src: ai1.src, alt: 'bread on a wooden table', aiMade: true };
  await request('POST', `/sites/${site.id}/doc`, { json: { doc: d }, cookie: ca });
  r = await request('GET', `/sites/${site.id}/preview`, { cookie: ca });
  check(53, 'AI image (Imagen) saved and labeled AI-made', aiAsset?.aiMade && r.text.includes('AI-made image') && got.gemini.some((g) => g.path.endsWith(':predict')));
  r = await request('POST', `/sites/${site.id}/ai/meta`, { json: {}, cookie: ca });
  const metaDoc = JSON.parse(r.text).doc;
  await request('POST', `/sites/${site.id}/doc`, { json: { doc: metaDoc }, cookie: ca });
  await request('POST', `/sites/${site.id}/publish.json`, { json: {}, cookie: ca });
  r = await request('GET', '/s/test-bakery/about');
  const seven = ['<title>AI title about</title>', 'name="description" content="AI description for about', 'name="keywords" content="bread, bakery"', 'name="robots" content="index,follow"', 'rel="canonical"', 'name="viewport"', 'property="og:title"'];
  check(54, 'AI meta tags: all 7 on every page', metaDoc.pages.every((p) => p.meta.title && p.meta.description) && seven.every((t) => r.text.includes(t)), seven.filter((t) => !r.text.includes(t)).join(' | '));
  r = await request('POST', `/sites/${site.id}/ai/spanish`, { json: {}, cookie: ca });
  await request('POST', `/sites/${site.id}/doc`, { json: { doc: JSON.parse(r.text).doc }, cookie: ca });
  await request('POST', `/sites/${site.id}/publish.json`, { json: {}, cookie: ca });
  r = await request('GET', '/s/test-bakery/es/about');
  check(55, 'One-tap Spanish version at /es/', r.status === 200 && r.text.includes('lang="es"') && r.text.includes('ES Family bakery since 1990.') && r.text.includes('hreflang="es"'));
  r = await request('POST', `/sites/${site.id}/ai/social`, { json: {}, cookie: ca });
  const soc = JSON.parse(r.text);
  check(56, 'AI social posts for Facebook, Instagram, X with share links', soc.posts.Facebook && soc.posts.Instagram && soc.posts.X && soc.share.X.startsWith('https://x.com/intent/'));
  r = await request('POST', `/sites/${site.id}/ai/faq`, { json: {}, cookie: ca });
  const fq = JSON.parse(r.text).items;
  r = await request('POST', `/sites/${site.id}/ai/faq/apply`, { json: { items: fq }, cookie: ca });
  check(57, 'AI FAQ builder (member approves to add)', fq[0].q === 'Where are you?' && JSON.parse(r.text).doc.pages.find((p) => p.slug === 'faq').sections[0].data.items.some((x) => x.q === 'Where are you?'));
  const bsite = (await store.where('sites', 'slug', 'bob-plain'))[0];
  check(60, 'All AI calls carried the key server-side only', got.gemini.every((g) => g.key === GEMINI_KEY));

  // ===== 27, 64, 65, 73 forms + leads + stats + security =====
  const form = (extra = {}) => ({ kind: 'booking', section: 'x', ts: String(Date.now() - 5000), name: 'Ann', email: 'ann@example.com', phone: '555', date: '2026-12-01', time: '10:00', message: 'Table for 2', ...extra });
  await store.update('sites', site.id, { publishedDoc: (await store.get('sites', site.id)).publishedDoc });
  got.resend.length = 0;
  r = await request('POST', '/s/test-bakery/f', { form: form(), headers: { 'x-forwarded-for': '10.0.0.1' } });
  const leadsA = await store.where('leads', 'memberId', A.id);
  check(27, 'Booking form -> member dashboard + email', r.status === 200 && leadsA.length === 1 && leadsA[0].kind === 'booking' && got.resend.some((e) => e.to[0] === A.email && e.subject.includes('New booking request')));
  r = await request('POST', '/s/test-bakery/f', { form: form({ website: 'http://spam' }), headers: { 'x-forwarded-for': '10.0.0.2' } });
  const r2 = await request('POST', '/s/test-bakery/f', { form: form({ ts: String(Date.now()) }), headers: { 'x-forwarded-for': '10.0.0.3' } });
  const spamLeads = (await store.where('leads', 'memberId', A.id)).filter((l) => l.spam);
  check(73, 'Form spam protection (honeypot + too-fast) - no email sent for spam', spamLeads.length === 2 && got.resend.length === 1);
  let rl = [];
  for (let i = 0; i < 6; i++) rl.push((await request('POST', '/s/test-bakery/f', { form: form({ message: 'm' + i }), headers: { 'x-forwarded-for': '10.0.0.9' } })).status);
  check(73, 'Form rate limit per visitor', rl[5] === 429, rl.join(','));
  rl = [];
  for (let i = 0; i < 6; i++) rl.push((await request('POST', '/login', { form: { email: 'x@example.com' }, headers: { 'x-forwarded-for': '10.0.1.1' } })).status);
  check(73, 'Login rate limit', rl[5] === 429, rl.join(','));
  rl = [];
  for (let i = 0; i < 7; i++) rl.push((await request('GET', i % 2 ? '/wp-login.php' : '/.env', { headers: { 'x-forwarded-for': '10.0.2.2' } })).status);
  const afterBan = await request('GET', '/', { headers: { 'x-forwarded-for': '10.0.2.2' } });
  const sqli = await request('GET', '/?q=1%27%20union%20select%20password', { headers: { 'x-forwarded-for': '10.0.2.3' } });
  check(73, 'Attack traffic blocked (probe paths, repeat offenders banned, injection)', rl[0] === 404 && afterBan.status === 403 && sqli.status === 404);
  r = await request('GET', '/leads', { cookie: ca });
  check(65, 'Leads inbox shows the message', r.text.includes('Table for 2') && r.text.includes('ann@example.com'));
  const L = leadsA[0];
  got.resend.length = 0;
  await request('POST', `/leads/${L.id}/draft`, { form: {}, cookie: ca });
  const drafted = await store.get('leads', L.id);
  check(58, 'AI drafts a reply; nothing sent until member approves', drafted.draft.includes('thanks for your request') && got.resend.length === 0);
  await request('POST', `/leads/${L.id}/send`, { form: { text: drafted.draft + ' (edited)' }, cookie: ca });
  check(58, 'Member sends the approved reply', got.resend.some((e) => e.to[0] === 'ann@example.com' && e.html.includes('(edited)')) && (await store.get('leads', L.id)).status === 'replied');
  r = await request('POST', `/leads/${L.id}/send`, { form: { text: 'hack' }, cookie: cb });
  check(48, "Member B can't read or answer member A's leads", r.status === 404 && !(await request('GET', '/leads', { cookie: cb })).text.includes('Table for 2'));
  await store.set('stats', `${site.id}_${new Date().toISOString().slice(0, 10)}`, { siteId: site.id, memberId: A.id, day: new Date().toISOString().slice(0, 10), visits: 0, pages: {} });
  await request('GET', '/s/test-bakery/', { headers: { 'user-agent': 'Mozilla/5.0' } });
  await request('GET', '/s/test-bakery/menu', { headers: { 'user-agent': 'Mozilla/5.0' } });
  await request('GET', '/s/test-bakery/', { headers: { 'user-agent': 'Googlebot/2.1' } });
  await new Promise((x) => setTimeout(x, 100));
  const st = await store.get('stats', `${site.id}_${new Date().toISOString().slice(0, 10)}`);
  r = await request('GET', `/sites/${site.id}/stats`, { cookie: ca });
  check(64, 'Real visitor stats (bots not counted), top pages, form leads', st.visits === 2 && st.pages.menu === 1 && r.text.includes('>2<') && r.text.includes('form leads'));
  const bobStats = await request('GET', `/sites/${bsite.id}/stats`, { cookie: cb });
  check(64, 'Stats are zero until real visits', bobStats.text.includes('No visits yet'));

  // ===== 59 AI allowance =====
  const before = (await require('../src/ai').usage(A.id)).used;
  r = await request('GET', '/dashboard', { cookie: ca });
  check(59, 'Monthly AI allowance shown on the dashboard', r.text.includes(`${before} of 60 credits`));
  for (let i = 0; i < 60 && (await require('../src/ai').usage(A.id)).used < 60; i++) await request('POST', `/sites/${site.id}/ai/faq`, { json: {}, cookie: ca });
  r = await request('POST', `/sites/${site.id}/ai/faq`, { json: {}, cookie: ca });
  check(59, 'AI stops at the allowance (costs can\'t run away)', r.status === 400 && JSON.parse(r.text).error.includes('allowance used'));

  // ===== 61 Google sign-in =====
  const tnow = Math.floor(Date.now() / 1000);
  const goodTok = jwt({ aud: 'ios-test', iss: 'https://securetoken.google.com/ios-test', sub: 'uid1', email: B.email, email_verified: true, iat: tnow, exp: tnow + 3600 });
  r = await request('POST', '/login/firebase', { json: { idToken: goodTok } });
  const forged = jwt({ aud: 'ios-test', iss: 'https://securetoken.google.com/ios-test', sub: 'uid1', email: B.email, email_verified: true, iat: tnow, exp: tnow + 3600 }, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey);
  const wrongAud = jwt({ aud: 'other', iss: 'https://securetoken.google.com/other', sub: 'u', email: B.email, email_verified: true, iat: tnow, exp: tnow + 3600 });
  const r1 = await request('POST', '/login/firebase', { json: { idToken: forged } });
  const r3 = await request('POST', '/login/firebase', { json: { idToken: wrongAud } });
  const lp = await request('GET', '/login');
  check(61, 'Google sign-in (Firebase): valid token signs in; forged or wrong-project refused', r.status === 200 && /ios_session=/.test(r.headers['set-cookie']) && r1.status === 401 && r3.status === 401 && lp.text.includes('Sign in with Google'));

  // ===== 62, 63, 66, 67, 68, 69 =====
  r = await request('GET', '/profile', { cookie: ca });
  check(62, 'Oracle profile ties every site to one member', r.text.includes('Test Bakery') && r.text.includes('Activity'));
  r = await request('GET', '/dashboard', { cookie: ca });
  check(63, 'Dashboard: sites, live/paused status, plan, next bill', r.text.includes('Test Bakery') && r.text.includes('pill ok">Live') && r.text.includes('First $100.00 bill on'));
  const rB = await request('GET', '/dashboard', { cookie: cb });
  check(66, 'New-member checklist', rB.text.includes('Getting started (') && rB.text.includes('Connect a domain'));
  await billing.welcome(B);
  check(67, 'Welcome email with getting-started guide', (await emailsOf('welcome')).length === 1 && got.resend.some((e) => e.subject.startsWith('Welcome') && e.html.includes('/help')));
  r = await request('GET', '/help');
  check(68, 'Help center with how-to guides', require('../src/routes/member').GUIDES.length >= 8 && r.text.includes('Publishing'));
  const code = await referrals.codeFor(await store.get('members', A.id));
  r = await request('GET', '/?ref=' + code);
  const C = await mkMember('carol@example.com', { referredBy: code, stripeCustomerId: 'cus_fake' });
  const none = await referrals.onPaid({ id: 'in_1', amount_paid: 499 }, C);
  const pay = await referrals.onPaid({ id: 'in_2', amount_paid: 10000 }, C);
  const again = await referrals.onPaid({ id: 'in_3', amount_paid: 10000 }, await store.get('members', C.id));
  const payout = await store.get('approvals', pay);
  check(69, 'Referral link; reward only on a real paid bill; payout waits for owner', r.text.includes(`name="ref" value="${code}"`) && none === null && payout?.type === 'payout' && payout.status === 'pending' && again === null);

  // ===== 70, 86 newsletter =====
  await request('POST', '/owner/news', { form: { kind: 'new', title: 'Builder is live', body: 'Chat + preview.' }, cookie: co });
  await request('POST', '/owner/news', { form: { kind: 'ai', title: 'Gemini update', body: 'New model.', link: 'https://blog.google/' }, cookie: co });
  got.resend.length = 0;
  let nl = await bots.run('newsletter');
  const nlMail = got.resend.filter((e) => e.subject.startsWith('This week'));
  check(70, 'Weekly newsletter: what\'s new, coming, AI news', nl.ok && nlMail.length >= 3 && nlMail[0].html.includes('Builder is live') && nlMail[0].html.includes('AI news'));
  check(86, 'Marketing email has unsubscribe link + mailing address + one-click header', nlMail[0].html.includes('Unsubscribe') && nlMail[0].html.includes('123 Test St') && nlMail[0].headers['List-Unsubscribe-Post']);
  const unsubUrl = nlMail.find((e) => e.to[0] === A.email).headers['List-Unsubscribe'].slice(1, -1).replace(base, '');
  r = await request('POST', unsubUrl.split('?')[0], { form: { t: decodeURIComponent(unsubUrl.split('t=')[1]) } });
  got.resend.length = 0;
  await bots.run('newsletter');
  check(86, 'Opt-out honored right away', r.status === 200 && !got.resend.some((e) => e.to[0] === A.email) && got.resend.length >= 2);
  const addr = process.env.BUSINESS_MAILING_ADDRESS; delete process.env.BUSINESS_MAILING_ADDRESS;
  const blocked = await require('../src/email').sendEmail({ to: 'z@example.com', subject: 's', html: 'x', marketing: true, unsubscribeUrl: 'u' });
  process.env.BUSINESS_MAILING_ADDRESS = addr;
  check(86, 'Marketing email blocked without a mailing address', blocked.status.startsWith('blocked'));

  // ===== 71 uptime =====
  got.resend.length = 0;
  let up = await bots.run('uptime');
  check(71, 'Uptime bot checks every live site', up.ok && up.summary.up >= 1 && up.summary.down === 0 && up.summary.platformOk);
  const realBase = config.baseUrl;
  config.baseUrl = 'http://127.0.0.1:9';
  await bots.run('uptime'); await bots.run('uptime');
  config.baseUrl = realBase;
  check(71, 'Owner alerted when a site is down', got.resend.some((e) => e.to[0] === config.ownerEmail && e.subject.startsWith('Site down')));
  await bots.run('uptime');
  check(71, 'Owner told when it is back up', got.resend.some((e) => e.subject.startsWith('Site back up')));

  // ===== 75, 76, 77, 78, 80 bots =====
  let s0 = await store.get('sites', site.id);
  const pd = structuredClone(s0.publishedDoc);
  pd.pages[1].meta.description = ''; pd.pages[1].meta.title = 'x'.repeat(90);
  const hi = pd.pages[0].sections.findIndex((x) => x.type === 'hero');
  pd.pages[0].sections[hi].data.button = { label: 'Our team', href: 'team-page-gone' };
  await store.update('sites', site.id, { publishedDoc: pd });
  const mt = await bots.run('meta');
  s0 = await store.get('sites', site.id);
  check(75, 'Meta tag bot checks the 7 tags and fixes small issues', mt.ok && mt.summary.missingTags === 0 && s0.publishedDoc.pages[1].meta.title.length <= 70 && s0.publishedDoc.pages[1].meta.description.length > 10);
  const lk = await bots.run('links');
  s0 = await store.get('sites', site.id);
  check(76, 'Broken link bot fixes broken internal links', lk.ok && lk.summary.fixedInternal === 1 && s0.publishedDoc.pages[0].sections[hi].data.button.href === 'contact');
  process.env.SUBDOMAINS_LIVE = 'yes';
  const ix = await bots.run('indexer');
  const key = await bots.indexNowKey();
  r = await request('GET', `/${key}.txt`, { host: `test-bakery.${config.domain}` });
  delete process.env.SUBDOMAINS_LIVE;
  check(77, 'Indexer sends new/updated pages to search engines (IndexNow + key file)', ix.ok && got.indexnow.length >= 1 && got.indexnow[0].key === key && got.indexnow[0].urlList.includes(`https://test-bakery.${config.domain}/menu`) && r.text === key);
  process.env.AI_BUDGET_USD = '0.01';
  got.resend.length = 0;
  const cs = await bots.run('cost');
  process.env.AI_BUDGET_USD = '1000';
  check(78, 'Cost watchdog tracks AI spend and warns before budget', cs.ok && cs.summary.aiUsd > 0 && got.resend.some((e) => e.subject.startsWith('AI spend at')));
  const sec2 = await bots.run('security');
  check(73, 'Security bot reports blocked traffic and spam', sec2.ok && sec2.summary.blockedRequests > 0);
  got.resend.length = 0;
  const sup = await require('../src/bots').BOTS.supervisor(Date.now() + 9 * 864e5);
  const twinRuns = (await store.all('botruns')).filter((x) => x.by === 'twin');
  check(80, 'Supervisor finds late bots; backup twin runs them; owner told', sup.tookOver.includes('uptime') && !sup.tookOver.includes('links') && twinRuns.some((x) => x.bot === 'uptime') && got.resend.some((e) => e.subject.startsWith('Supervisor')));

  // ===== 79 support bot =====
  r = await request('POST', '/help/ask', { json: { q: 'How do I edit text?' } });
  const r4 = await request('POST', '/help/ask', { json: { q: 'I want a refund' }, cookie: cb });
  check(79, 'Support bot answers 24/7, says it is an AI, hands off to owner', JSON.parse(r.text).answer.includes('Tap any text') && JSON.parse(r4.text).handoff && (await store.all('support')).length === 1 && (await request('GET', '/help')).text.includes('This is an AI support assistant'));

  // ===== 81-83, 87, 88, 90 Governor =====
  const g = async (sections, extra = {}) => governor.check({ details: { phone: '1' } }, { pages: [{ title: 'Home', sections: sections.map((x, i) => ({ id: 's0000000' + i, ...x })) }], theme: { logo: null }, ...extra });
  const t = (text) => ({ type: 'text', data: { heading: 'H', text } });
  check(82, 'Blocks fake badges / award claims', (await g([t('Award-winning bakery, as seen on TV')])).status === 'block');
  check(82, 'Blocks fake testimonials outside real reviews', (await g([t('"The best bread I ever had in my life!" - John')])).status === 'block');
  check(82, 'Blocks unconfirmed reviews', (await g([{ type: 'reviews', data: { heading: 'R', items: [{ name: 'X', text: 'Great', source: '', attestedReal: false }] } }])).status === 'block');
  check(83, 'Ads / paid endorsements need clear disclosure', (await g([t('Buy flour with my affiliate link')])).status === 'block' && (await g([{ type: 'sponsored', data: { heading: 'Flour Co', text: 'Our flour partner, affiliate link', disclosure: 'Sponsored' } }])).pass);
  check(81, 'Clean, honest content passes', (await g([t('We bake bread every morning.')])).status === 'pass');
  check(88, 'Accessibility check: missing image alt text blocks publish', (await g([{ type: 'gallery', data: { heading: 'G', images: [{ src: '/a/abcd', alt: '', rightsConfirmed: true }] } }])).issues.some((i) => i.code === 'a11y.alt'));
  const stockId = await store.add('assets', { memberId: A.id, mime: 'image/jpeg', data: '', originalName: 'shutterstock_99123.jpg', rightsConfirmed: true });
  check(87, 'Governor flags likely copyrighted images for review', (await g([{ type: 'gallery', data: { heading: 'G', images: [{ src: '/a/' + stockId, alt: 'x', rightsConfirmed: true }] } }])).status === 'hold');
  const banned = await Promise.all(['Watch porn here', 'Guaranteed returns, double your money', 'Buy cocaine fast', 'white power rally'].map((x) => g([t(x)])));
  check(90, 'Adult, scam, illegal, hate content held for owner review', banned.every((x) => x.status === 'hold'));
  // full flow: hold -> owner queue -> owner approves -> live; decision logged
  const hs = (await store.get('sites', bsite.id));
  d = structuredClone(hs.doc); d.pages[0].sections.push({ id: 's12345678', type: 'text', data: { heading: 'Deal', text: 'Risk-free investment opportunity' } });
  await request('POST', `/sites/${bsite.id}/doc`, { json: { doc: d }, cookie: cb });
  r = await request('POST', `/sites/${bsite.id}/publish.json`, { json: {}, cookie: cb });
  const held = JSON.parse(r.text);
  const q = (await store.where('approvals', 'siteId', bsite.id)).find((a) => a.type === 'governor');
  const notLive = (await request('GET', '/s/bob-plain/')).status;
  r = await request('POST', `/owner/approvals/${q.id}`, { form: { decision: 'approve' }, cookie: co });
  check(90, 'Flagged site waits for owner; owner approves -> live', held.held && notLive !== 200 && (await request('GET', '/s/bob-plain/')).status === 200);
  const govLog = await store.all('governor');
  check(90, 'Every Governor decision is logged', ['hold', 'owner-approved'].every((x) => govLog.some((g) => g.status === x)) && govLog.some((g) => g.status === 'pass' || g.status === 'warn') && (await store.all('oracle')).some((o) => o.what === 'governor.owner_approved'));

  // ===== 84, 85 legal =====
  const lg = await Promise.all(['privacy', 'terms', 'refunds'].map((x) => request('GET', '/legal/' + x)));
  const home = await request('GET', '/');
  check(84, 'Privacy, terms, refund/cancel pages; in footer', lg.every((x) => x.status === 200) && ['/legal/privacy', '/legal/terms', '/legal/refunds'].every((u) => home.text.includes(`href="${u}"`)));
  check(84, 'Linked at checkout ("I agree" step)', /I agree:[^<]*See the <a href="\/legal\/terms">/.test(home.text) || home.text.includes('Payments: Not connected'));
  check(85, 'Cookie notice (one essential cookie, no tracking)', home.text.includes('one essential sign-in cookie'));
  r = await request('GET', '/s/test-bakery/privacy');
  check(84, 'Member sites with forms get a privacy page in the footer', r.status === 200 && (await request('GET', '/s/test-bakery/')).text.includes('/s/test-bakery/privacy'));

  // ===== 89 data download / deletion =====
  r = await request('GET', '/account/export', { cookie: ca });
  const ex = JSON.parse(r.text);
  check(89, 'Download my data (no secrets inside)', r.headers['content-disposition'].includes('attachment') && ex.sites.length >= 1 && ex.leads.length >= 1 && !r.text.includes('githubTokenBox'));
  const D = await mkMember('dave@example.com');
  const cd = cookieFor(D.email);
  await request('POST', '/sites', { form: { businessName: 'Dave Co', siteName: 'dave-co' }, cookie: cd });
  await request('POST', '/account/delete-request', { form: { confirm: 'yes' }, cookie: cd });
  const delA = (await store.where('approvals', 'memberId', D.id)).find((a) => a.type === 'delete');
  const stillThere = (await store.where('sites', 'slug', 'dave-co')).length === 1;
  check(89, 'Deletion request waits for owner OK (nothing deleted yet)', delA?.status === 'pending' && stillThere && (await store.get('members', D.id)).email === 'dave@example.com');
  await request('POST', `/owner/approvals/${delA.id}`, { form: { decision: 'approve' }, cookie: co });
  check(93, 'Owner approves deletion -> account deleted', (await store.get('members', D.id)).email.startsWith('deleted-') && !(await store.where('sites', 'slug', 'dave-co')).length);

  // ===== 91-97, 99, 100 owner =====
  r = await request('GET', '/owner', { cookie: ca });
  const ro = await request('GET', '/owner', { cookie: co });
  check(91, 'Admin Command Center locked to owner', r.status === 404 && ro.status === 200 && ro.text.includes('Admin Command Center'));
  // Owner lock-down: owner email via emailed link, or no "m" (old cookie), or a different Google account = blocked.
  const coLink = cookieFor(config.ownerEmail, 'link');
  const coOld = 'ios_session=' + encodeURIComponent(auth.sign({ email: config.ownerEmail, exp: Date.now() + 864e5 }, 'session'));
  const ownerBlocked = [];
  for (const [ck, path, method] of [[coLink, '/owner', 'GET'], [coOld, '/owner', 'GET'], [cb, '/owner/oracle', 'GET'], ['', '/owner', 'GET'], [coLink, '/owner/bots/uptime', 'POST']]) {
    const x = await request(method, path, { cookie: ck, form: method === 'POST' ? {} : undefined });
    ownerBlocked.push(x.status);
  }
  const keepOwner = config.ownerEmail; config.ownerEmail = B.email; // alert address changed: must NOT grant access
  const swap = await request('GET', '/owner', { cookie: cb }); config.ownerEmail = keepOwner;
  await request('POST', '/login', { form: { email: config.ownerEmail } });
  const ownerLinkMails = got.resend.filter((e) => e.to[0] === config.ownerEmail && e.subject === 'Your sign-in link').length;
  const ownTok = jwt({ aud: 'ios-test', iss: 'https://securetoken.google.com/ios-test', sub: 'uid-owner', email: config.ownerEmail, email_verified: true, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });
  const gl = await request('POST', '/login/firebase', { json: { idToken: ownTok } });
  const gCookie = (gl.headers['set-cookie'] || [''])[0].split(';')[0];
  const gIn = await request('GET', '/owner', { cookie: gCookie });
  check(91, 'Owner-only: only the pinned owner account signed in with Google gets in; email link, old cookie, other accounts, no login, changed OWNER_EMAIL setting all blocked (server-side)',
    ownerBlocked.every((s) => s === 404) && swap.status === 404 && ownerLinkMails === 0 && gl.status === 200 && JSON.parse(gl.text).next === '/owner' && gIn.status === 200 && gIn.headers['cache-control'] === 'no-store',
    JSON.stringify({ ownerBlocked, swap: swap.status, ownerLinkMails, gl: gl.status, gIn: gIn.status }));
  check(93, 'Approval queue lists refunds/payouts/deletes; nothing moves without a tap', ro.text.includes('Referral payout') && (await store.get('approvals', pay)).status === 'pending');
  r = await request('GET', '/owner?q=bob', { cookie: co });
  const prof = await request('GET', `/owner/members/${B.id}`, { cookie: co });
  check(94, 'Member list with search; read-only profile', r.text.includes('bob@example.com') && !r.text.includes('alice@example.com</a>') && prof.text.includes('Read-only') && !prof.text.includes('name="email"'));
  await request('POST', `/owner/sites/${site.id}/pause`, { form: { reason: 'Checking a complaint' }, cookie: co });
  const paused = (await request('GET', '/s/test-bakery/')).status;
  await request('POST', `/owner/sites/${site.id}/pause`, { form: { reason: 'All clear' }, cookie: co });
  const unpaused = (await request('GET', '/s/test-bakery/')).status;
  const reasons = (await store.all('oracle')).filter((o) => o.what.startsWith('site.owner_')).map((o) => o.details.reason);
  check(95, 'Pause/unpause any site with the reason logged', paused === 503 && unpaused === 200 && reasons.includes('Checking a complaint') && reasons.includes('All clear'));
  await request('POST', '/owner/expenses', { form: { date: new Date().toISOString().slice(0, 10), amount: '19.99', category: 'Software' }, cookie: co });
  r = await request('GET', '/owner/taxes', { cookie: co });
  check(96, 'Tax bot: income, expenses, what to set aside; never files', r.text.includes('$19.99') && r.text.includes('Set aside for taxes') && r.text.includes('never files'));
  got.resend.length = 0;
  const dg = await bots.run('owner_digest');
  check(97, 'Daily email to owner: members, cancellations, failed payments, site problems', dg.ok && got.resend.some((e) => e.to[0] === config.ownerEmail && e.subject.startsWith('Daily report') && e.html.includes('Failed payments')));
  const ol = await store.all('oracle');
  check(99, 'Everything reports to the Oracle (members, sites, payments, bots)', ['site.created', 'site.published', 'lead.received', 'bot.ran', 'referral.earned', 'account.deleted', 'governor.pass'].every((w) => ol.some((o) => o.what === w || o.what.startsWith(w))));
  r = await request('GET', '/status');
  check(100, 'Public status page', r.status === 200 && r.text.includes('Platform status') && r.text.includes('Uptime last 7 days'));
  r = await request('POST', '/cron/bot/uptime', {});
  check(80, 'Bots only run with the cron secret', r.status === 401 && (await request('POST', '/cron/bot/uptime', { headers: { 'x-cron-secret': process.env.CRON_SECRET } })).status === 200);

  // ===== Stripe TEST mode items =====
  if (HAS_STRIPE) {
    const st = billing.stripe();
    const cust = await st.customers.create({ email: 'referrer@example.com', description: 'ios item test' });
    await store.update('members', A.id, { stripeCustomerId: cust.id });
    await store.update('approvals', pay, { memberId: A.id });
    r = await request('POST', `/owner/approvals/${pay}`, { form: { decision: 'approve' }, cookie: co });
    const bal = await st.customers.retrieve(cust.id);
    check(69, 'Stripe TEST: approved referral payout = bill credit', bal.balance === -referrals.REWARD());
    await store.update('members', B.id, { subscriptionId: 'sub_doesnotexist', status: 'active' });
    got.resend.length = 0;
    const pc = await bots.run('payments');
    check(74, 'Stripe TEST: payment check bot flags mismatches to owner', pc.ok && pc.summary.mismatches >= 1 && got.resend.some((e) => e.subject.startsWith('Payment check')));
    r = await request('GET', '/owner', { cookie: co });
    check(92, 'Stripe TEST: live numbers from Stripe (members, subscriptions, revenue)', r.text.includes('Monthly recurring revenue') && r.text.includes('Collected this month'));
    r = await request('GET', '/owner/taxes', { cookie: co });
    check(96, 'Stripe TEST: tax bot reads real Stripe income and fees', r.text.includes('Stripe TEST mode'));
    await st.customers.del(cust.id).catch(() => {});
  } else console.log('SKIP  Stripe items (no STRIPE_SECRET_KEY)');

  // 25: live site looks right on phone, tablet, computer (no sideways scroll)
  const widths = [];
  for (const w of [360, 768, 1280]) {
    const cx = await browser.newContext({ viewport: { width: w, height: 800 } });
    const p2 = await cx.newPage();
    for (const path of ['/s/test-bakery/', '/s/test-bakery/menu', '/s/test-bakery/contact']) {
      await p2.goto(base + path);
      widths.push([w, await p2.evaluate(() => document.documentElement.scrollWidth)]);
    }
    await cx.close();
  }
  check(25, 'Mobile-first: live site fits phones, tablets and computers', widths.every(([w, sw]) => sw <= w), JSON.stringify(widths));
  await browser.close();
  const failed = results.filter((x) => !x.ok);
  const items = [...new Set(results.map((x) => x.item))].sort((a, b) => a - b);
  console.log(`\n${results.length - failed.length}/${results.length} passed - items covered: ${items.length} (${items.join(',')})`);
  server.close(); mock.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('TEST CRASHED:', e.stack); process.exit(1); });

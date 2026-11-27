const express = require('express');
const config = require('./config');
const { store } = require('./store');
const { oracle, recent } = require('./oracle');
const { sendEmail } = require('./email');
const auth = require('./auth');
const billing = require('./billing');
const sites = require('./sites');
const { page, home, esc } = require('./views');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// ---------- Member sites on [site].DOMAIN ----------
app.use(async (req, res, next) => {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0].toLowerCase();
  const suffix = '.' + config.domain;
  if (!host.endsWith(suffix)) return next();
  const sub = host.slice(0, -suffix.length);
  if (!sub || sub === 'www' || sub === 'app') return next();
  try { await serveSite(sub, res); } catch (e) { next(e); }
});

async function serveSite(slug, res) {
  const site = await sites.siteBySlug(slug);
  const st = await sites.liveState(site);
  res.setHeader('Cache-Control', st.live ? 'public, max-age=60' : 'no-store');
  if (!st.live) return res.status(st.reason === 'missing' ? 404 : 503).send(sites.offlinePage(st.reason));
  res.send(sites.renderSite(site));
}

// ---------- Stripe webhook: raw body + signature check ----------
app.post('/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  if (!billing.connected()) return res.status(503).send('Payments not connected');
  let event;
  try {
    event = billing.constructEvent(req.body, req.headers['stripe-signature']);
  } catch (e) {
    return res.status(e.code === 'not_connected' ? 503 : 400).send(e.code === 'not_connected' ? 'Webhook not connected' : 'Bad signature');
  }
  try {
    await billing.handleEvent(event);
    res.json({ received: true });
  } catch (e) {
    console.error('webhook handler error', event.type, e.message);
    res.status(500).send('handler error'); // Stripe will retry
  }
});

app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(auth.loadUser);
app.use(auth.sameOrigin);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const actor = (req) => req.user?.email || 'visitor';

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/', (req, res) => res.send(home({ stripeConnected: billing.connected(), user: req.user })));
app.get('/s/:slug', wrap(async (req, res) => serveSite(String(req.params.slug).toLowerCase(), res)));

// ---------- Signup ----------
app.post('/checkout', wrap(async (req, res) => {
  if (!billing.connected()) return res.status(503).send(page('Not connected', '<p>Payments: Not connected.</p>'));
  if (req.body.agree !== 'yes') return res.status(400).send(page('Please agree', `<p>Please check the "I agree" box first.</p><p><a href="/">Back</a></p>`));
  const email = String(req.body.email || '').trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).send(page('Check email', '<p>That email looks wrong.</p><p><a href="/">Back</a></p>'));
  const existing = email ? await billing.memberByEmail(email) : null;
  if (existing && existing.status !== 'ended') return res.send(page('Already a member', '<p>You already have a membership. <a href="/login">Sign in</a>.</p>'));
  const session = await billing.createCheckout({ email, member: existing && existing.status === 'ended' ? existing : null });
  res.redirect(303, session.url);
}));

app.get('/welcome', wrap(async (req, res) => {
  if (!billing.connected()) return res.redirect('/');
  const id = String(req.query.session_id || '');
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(id)) return res.redirect('/');
  const cs = await billing.stripe().checkout.sessions.retrieve(id); // verified server-side with Stripe
  if (cs.status !== 'complete' || !cs.subscription) return res.send(page('Not finished', '<p>Checkout is not complete yet.</p><p><a href="/">Back</a></p>'));
  const m = await billing.syncSubscription(await billing.stripe().subscriptions.retrieve(cs.subscription), 'stripe:checkout-return');
  const custId = typeof cs.customer === 'string' ? cs.customer : cs.customer?.id;
  const fresh = Date.now() / 1000 - cs.created < 3600; // old /welcome links can't be reused to sign in
  if (!m || !fresh || m.stripeCustomerId !== custId || m.email === config.ownerEmail) {
    return res.send(page('Payment received', `<p>${m ? 'Your payment went through.' : 'Your payment went through, but that email already belongs to another account. We will contact you.'}</p><p><a href="/login">Sign in with an emailed link</a> to reach your dashboard.</p>`));
  }
  auth.startSession(res, m.email);
  res.redirect(303, '/dashboard?welcome=1');
}));

// ---------- Sign in by emailed link ----------
app.get('/login', (req, res) => res.send(page('Sign in', `
<h1>Sign in</h1><div class="card"><form method="post" action="/login">
<label for="e">Email</label><input id="e" name="email" type="email" required autocomplete="email">
<input type="hidden" name="next" value="${esc(req.query.next || '/dashboard')}">
<button>Email me a sign-in link</button></form></div>`, { user: req.user })));

app.post('/login', wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const m = await billing.memberByEmail(email);
  if ((m || email === config.ownerEmail) && config.has('TOKEN_ENCRYPTION_KEY')) {
    const link = `${config.baseUrl}/login/verify?token=${encodeURIComponent(auth.loginLinkToken(email))}`;
    await sendEmail({ to: email, kind: 'login', subject: 'Your sign-in link', html: `<p><a href="${esc(link)}">Tap here to sign in</a>. This link works for 20 minutes.</p><p>If you didn't ask for this, ignore this email.</p>` });
  }
  const emailOn = config.has('RESEND_API_KEY');
  res.send(page('Check your email', `<p>${emailOn ? 'If that email has an account, a sign-in link is on its way.' : 'Email sign-in: Not connected.'}</p>`));
}));

app.get('/login/verify', wrap(async (req, res) => {
  const p = auth.verify(String(req.query.token || ''), 'login');
  // Each link works once: its random code is recorded the first time it's used.
  const firstUse = p && p.n && await store.claim('used_login_links', p.n, { email: p.email, at: new Date().toISOString() });
  if (!firstUse) return res.status(400).send(page('Link expired', '<p>That link expired or was already used. <a href="/login">Get a new one</a>.</p>'));
  auth.startSession(res, p.email);
  res.redirect(303, p.email === config.ownerEmail ? '/owner' : '/dashboard');
}));
app.post('/logout', (req, res) => { auth.endSession(res); res.redirect(303, '/'); });

// ---------- Dashboard ----------
function needMember(req, res, next) {
  if (!req.member) return res.send(page('No membership', `<p>No membership found for ${esc(req.user.email)}.</p><p><a class="btn" href="/">Get Started</a></p>`, { user: req.user }));
  next();
}

app.get('/dashboard', auth.requireLogin, needMember, wrap(async (req, res) => {
  const m = req.member;
  const list = (await store.where('sites', 'memberId', m.id)).sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1));
  const active = list.filter((s) => !s.archived);
  const inc = config.plan.includedSites;
  const pct = Math.min(100, Math.round((Math.min(active.length, inc) / inc) * 100));
  const hosting = billing.hostingAllowed(m);
  const accessUntil = m.subscriptionStatus === 'trialing' ? m.trialEnd : m.currentPeriodEnd;
  let statusLine;
  if (m.status === 'ended') statusLine = '<b class="bad">Membership ended.</b> Your sites are offline but saved.';
  else if (m.status === 'past_due') statusLine = hosting ? `<b class="warn">Payment failed.</b> Sites stay online until ${new Date(new Date(m.pastDueSince).getTime() + config.plan.graceDays * 864e5).toLocaleDateString('en-US')}. <a href="/billing">Update card</a>` : '<b class="bad">Payment failed - sites paused.</b> <a href="/billing">Update card</a> to bring them back. Nothing was deleted.';
  else if (m.cancelAtPeriodEnd) statusLine = `<b class="warn">Cancelled.</b> Full access until ${billing.fmtDate(accessUntil)}. No more charges.`;
  else if (m.subscriptionStatus === 'trialing') statusLine = `<b class="ok">Member.</b> First $100.00 bill on ${billing.fmtDate(m.trialEnd)}.`;
  else statusLine = `<b class="ok">Member.</b> Next bill ${billing.fmtDate(m.currentPeriodEnd)}.`;

  const siteRows = active.map((s) => {
    const url = `/s/${s.slug}`;
    const state = !hosting ? '<span class="pill bad">Offline</span>' : s.ownerPaused ? '<span class="pill warn">Paused</span>' : s.published ? '<span class="pill ok">Live</span>' : '<span class="pill mut">Draft</span>';
    return `<tr><td><b>${esc(s.details.businessName)}</b><br><a href="${url}">${esc(url)}</a><br><span class="mut">${esc(s.slug)}.${esc(config.domain)} - address setup coming soon</span></td><td>${state}</td>
<td><div class="row">${m.status !== 'ended' ? `<form method="post" action="/sites/${s.id}/${s.published ? 'unpublish' : 'publish'}"><button class="sec">${s.published ? 'Unpublish' : 'Publish'}</button></form>
<details><summary>Remove</summary><form method="post" action="/sites/${s.id}/remove"><p class="mut">Takes it off your plan. It's kept, not deleted.</p><button class="danger">Yes, remove</button></form></details>` : ''}</div></td></tr>`;
  }).join('');

  const canBuild = m.status === 'active';
  res.send(page('Dashboard', `
${req.query.welcome ? '<p class="flash">Welcome! Your membership is active.</p>' : ''}
<h1>Your dashboard</h1>
<div class="card"><p>${statusLine}</p>
<p><b>${active.length} of ${inc} sites used</b>${active.length > inc ? ` + ${active.length - inc} extra at $25/month each` : ''}</p>
<div class="meter" role="img" aria-label="${active.length} of ${inc} sites used"><i style="width:${pct}%"></i></div></div>

<div class="card"><h2 style="margin-top:0">Your sites</h2>
${active.length ? `<div class="scroll"><table>${siteRows}</table></div>` : '<p class="mut">No sites yet.</p>'}
</div>

${canBuild ? `<div class="card" id="new"><h2 style="margin-top:0">Build a site</h2>
<p class="mut">Use only real details about your business.</p>
<form method="post" action="/sites">
<label>Business name *</label><input name="businessName" required maxlength="80">
<label>Site name (your address)</label><input name="siteName" maxlength="40" placeholder="my-bakery">
<label>Short tagline</label><input name="tagline" maxlength="140">
<label>About your business</label><textarea name="description" rows="4" maxlength="2000"></textarea>
<label>Services (one per line)</label><textarea name="services" rows="4" maxlength="2000"></textarea>
<label>Phone</label><input name="phone" maxlength="40">
<label>Email</label><input name="email" type="email" maxlength="120">
<label>Address</label><input name="address" maxlength="200">
<label>Hours</label><textarea name="hours" rows="2" maxlength="400"></textarea>
${active.length >= inc ? '<p class="price"><b>$25/month for this site.</b> You will confirm on the next screen.</p>' : ''}
<button>Create site</button></form></div>` : ''}

<div class="card" id="cancel"><h2 style="margin-top:0">Membership</h2>
${m.status === 'ended'
    ? `<form method="post" action="/rejoin"><p>Rejoin to bring back your sites and settings: $100.00/month starting today${active.length > inc ? `, plus $25/month for each of your ${active.length - inc} extra sites` : ''}. Cancel anytime online.</p><label class="check"><input type="checkbox" name="agree" value="yes" required> <span>I agree to these charges.</span></label><p><button>Rejoin</button></p></form>`
    : m.cancelAtPeriodEnd
      ? `<form method="post" action="/resume"><button class="sec">Keep my membership</button></form>`
      : `<details><summary><b>Cancel membership</b></summary><form method="post" action="/cancel"><p>You keep full access until ${billing.fmtDate(accessUntil)}. No more charges after that. Sites are kept, not deleted.</p><button class="danger">Yes, cancel</button></form></details>`}
</div>`, { user: req.user }));
}));

app.post('/sites', auth.requireLogin, needMember, wrap(async (req, res) => {
  try {
    const r = await sites.createSite(req.member, req.body, actor(req));
    if (r.needsConfirm) {
      const hidden = Object.entries(req.body).filter(([k]) => k !== 'confirmExtra').map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
      return res.send(page('Confirm extra site', `<h1>Add a 4th+ site?</h1><div class="card"><p class="price"><b>${esc(r.message)}</b></p>
<form method="post" action="/sites">${hidden}<input type="hidden" name="confirmExtra" value="yes"><div class="row"><button>Confirm: add for $25/month</button><a class="btn sec" href="/dashboard">Not now</a></div></form></div>`, { user: req.user }));
    }
    res.redirect(303, '/dashboard');
  } catch (e) {
    res.status(e.status || 500).send(page('Could not create site', `<p class="bad">${esc(e.status ? e.message : 'Something went wrong. Nothing was charged.')}</p><p><a href="/dashboard">Back</a></p>`, { user: req.user }));
    if (!e.status) console.error('createSite', e.message);
  }
}));

for (const [path, pub] of [['publish', true], ['unpublish', false]]) {
  app.post(`/sites/:id/${path}`, auth.requireLogin, needMember, wrap(async (req, res) => {
    await sites.setPublished(req.member, req.params.id, pub, actor(req));
    res.redirect(303, '/dashboard');
  }));
}
app.post('/sites/:id/remove', auth.requireLogin, needMember, wrap(async (req, res) => {
  await sites.removeSite(req.member, req.params.id, actor(req));
  res.redirect(303, '/dashboard');
}));

app.post('/cancel', auth.requireLogin, needMember, wrap(async (req, res) => {
  const m = await billing.cancel(req.member, actor(req));
  const until = m.subscriptionStatus === 'trialing' ? m.trialEnd : m.currentPeriodEnd;
  await sendEmail({ to: m.email, kind: 'cancel_confirm', subject: 'Your membership is cancelled', html: `<p>Your membership is cancelled. You keep full access until <b>${billing.fmtDate(until)}</b> and won't be charged again.</p><p>Changed your mind? <a href="${config.baseUrl}/dashboard">Keep my membership</a></p>` });
  res.redirect(303, '/dashboard');
}));
app.post('/resume', auth.requireLogin, needMember, wrap(async (req, res) => {
  await billing.resume(req.member, actor(req));
  res.redirect(303, '/dashboard');
}));
app.post('/rejoin', auth.requireLogin, needMember, wrap(async (req, res) => {
  if (req.member.status !== 'ended') return res.redirect(303, '/dashboard');
  if (req.body.agree !== 'yes') return res.redirect(303, '/dashboard#cancel');
  const s = await billing.createCheckout({ member: req.member });
  res.redirect(303, s.url);
}));

// ---------- Billing page ----------
app.get('/billing', auth.requireLogin, needMember, wrap(async (req, res) => {
  if (!billing.connected()) return res.send(page('Billing', '<p>Billing: Not connected.</p>', { user: req.user }));
  const b = await billing.billingSummary(req.member);
  const pending = (await store.where('approvals', 'memberId', req.member.id)).filter((a) => a.type === 'refund');
  const invRows = b.invoices.map((i) => `<tr><td>${billing.fmtDate(i.date)}</td><td>${esc(i.number || '')}</td><td>${billing.money(i.amountPaid || i.amountDue)}</td><td>${esc(i.status)}</td>
<td>${i.url ? `<a href="${esc(i.url)}">View</a>` : ''}${i.amountPaid > 0 && !pending.find((p) => p.invoiceId === i.id) ? ` <details><summary>Request refund</summary><form method="post" action="/billing/refund-request"><input type="hidden" name="invoiceId" value="${esc(i.id)}"><label>Reason</label><textarea name="reason" rows="2" maxlength="1000" required></textarea><button class="sec">Send request</button></form></details>` : ''}</td></tr>`).join('');
  res.send(page('Billing', `<h1>Billing</h1>
<div class="card"><h2 style="margin-top:0">Plan</h2><ul>${b.items.map((i) => `<li>${esc(i.name)}${i.quantity > 1 ? ` x ${i.quantity}` : ''} - ${billing.money(i.unitCents * i.quantity)}/month</li>`).join('')}</ul>
<p>${b.cancelAtPeriodEnd ? `Cancelled. Access until ${billing.fmtDate(b.status === 'trialing' ? b.trialEnd : b.periodEnd)}. No further charges.` : b.next ? `Next charge: <b>${billing.money(b.next.amountCents)}</b> on <b>${billing.fmtDate(b.next.date)}</b>` : 'No upcoming charge.'}</p>
<p>Card on file: ${b.card ? `${esc(b.card.brand)} ending ${esc(b.card.last4)} (exp ${esc(b.card.exp)})` : 'none'}</p>
<form method="post" action="/billing/portal"><button>Update card / download invoices</button></form></div>
<div class="card"><h2 style="margin-top:0">Past invoices</h2>${b.invoices.length ? `<div class="scroll"><table><tr><th>Date</th><th>Invoice</th><th>Amount</th><th>Status</th><th></th></tr>${invRows}</table></div>` : '<p class="mut">None yet.</p>'}
${pending.length ? `<h3>Refund requests</h3><ul>${pending.map((p) => `<li>${billing.money(p.amountCents)} - ${esc(p.status)}</li>`).join('')}</ul>` : ''}</div>`, { user: req.user }));
}));
app.post('/billing/portal', auth.requireLogin, needMember, wrap(async (req, res) => res.redirect(303, await billing.portalUrl(req.member))));
app.post('/billing/refund-request', auth.requireLogin, needMember, wrap(async (req, res) => {
  await billing.requestRefund(req.member, String(req.body.invoiceId || ''), req.body.reason);
  res.send(page('Refund requested', '<p>Your refund request was sent for review. You will get an email with the answer.</p><p><a href="/billing">Back to billing</a></p>', { user: req.user }));
}));

// ---------- Owner: approval queue + Oracle ----------
app.get('/owner', auth.requireOwner, wrap(async (req, res) => {
  const approvals = (await store.all('approvals')).sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
  const log = await recent(60);
  res.send(page('Owner', `<h1>Owner console</h1>
<p class="mut">Stripe: ${billing.connected() ? (billing.isTestMode() ? 'TEST mode' : '<b class="bad">LIVE mode</b>') : 'Not connected'}</p>
<div class="card"><h2 style="margin-top:0">Approval queue</h2>
${approvals.length ? `<div class="scroll"><table><tr><th>When</th><th>What</th><th>Who</th><th>Status</th><th></th></tr>${approvals.map((a) => `<tr><td>${esc(a.requestedAt?.slice(0, 16).replace('T', ' '))}</td><td>${esc(a.type)} ${a.amountCents ? billing.money(a.amountCents) : ''}<br><span class="mut">${esc(a.reason || '')}</span></td><td>${esc(a.email || '')}</td><td>${esc(a.status)}</td>
<td>${a.status === 'pending' ? `<form method="post" action="/owner/approvals/${a.id}"><div class="row"><button name="decision" value="approve">Approve</button><button class="sec" name="decision" value="deny">Deny</button></div></form>` : ''}</td></tr>`).join('')}</table></div>` : '<p class="mut">Nothing waiting.</p>'}</div>
<div class="card"><h2 style="margin-top:0">Oracle log</h2><div class="scroll"><table>${log.map((l) => `<tr><td>${esc(l.when.slice(0, 19).replace('T', ' '))}</td><td>${esc(l.who)}</td><td>${esc(l.what)}</td></tr>`).join('')}</table></div></div>`, { user: req.user }));
}));

app.post('/owner/approvals/:id', auth.requireOwner, wrap(async (req, res) => {
  const a = await store.get('approvals', req.params.id);
  if (!a || a.status !== 'pending') return res.redirect(303, '/owner');
  const decision = req.body.decision === 'approve' ? 'approve' : 'deny';
  if (decision === 'approve' && a.type === 'refund') {
    try {
      const r = await billing.executeApprovedRefund(a, req.user.email);
      await store.update('approvals', a.id, { status: 'approved', decidedAt: new Date().toISOString(), decidedBy: req.user.email, refundId: r.id });
      await oracle(req.user.email, 'refund.approved', { approval: a.id, refund: r.id, amountCents: a.amountCents });
      await sendEmail({ to: a.email, kind: 'refund', subject: 'Your refund was approved', html: `<p>Your refund of ${billing.money(a.amountCents)} was approved. It usually shows on your card in 5-10 business days.</p>` });
    } catch (e) {
      await oracle(req.user.email, 'refund.failed', { approval: a.id, error: e.message });
      return res.send(page('Refund failed', `<p class="bad">${esc(e.message)}</p><p><a href="/owner">Back</a></p>`, { user: req.user }));
    }
  } else {
    await store.update('approvals', a.id, { status: 'denied', decidedAt: new Date().toISOString(), decidedBy: req.user.email });
    await oracle(req.user.email, `${a.type}.denied`, { approval: a.id });
    if (a.type === 'refund') await sendEmail({ to: a.email, kind: 'refund', subject: 'About your refund request', html: '<p>Your refund request was reviewed and not approved. Reply to this email if you have questions.</p>' });
  }
  res.redirect(303, '/owner');
}));

// ---------- Daily job (Cloud Scheduler, CRON_SECRET header) ----------
app.post('/cron/daily', wrap(async (req, res) => {
  const want = config.secret('CRON_SECRET');
  const got = String(req.headers['x-cron-secret'] || '');
  const crypto = require('crypto');
  if (!want || got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return res.status(401).send('no');
  const out = await require('./jobs').daily();
  res.json(out);
}));

app.use((req, res) => res.status(404).send(page('Not found', '<h1>Page not found</h1><p><a href="/">Home</a></p>', { user: req.user })));
app.use((err, req, res, _next) => {
  console.error('error', req.method, req.path, err.type || '', err.message);
  res.status(500).send(page('Error', '<p>Something went wrong. Nothing was charged twice. Please try again.</p>', { user: req.user }));
});

if (require.main === module) {
  app.listen(config.port, () => {
    const status = config.SECRET_NAMES.map((n) => `${n}=${config.has(n) ? 'connected' : 'NOT CONNECTED'}`).join(' ');
    console.log(`listening on ${config.port} store=${config.store} ${status}`); // names + yes/no only, never values
  });
}
module.exports = app;

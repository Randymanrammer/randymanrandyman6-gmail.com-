// Owner-only Admin Command Center (items 40, 91-96, 99) + public status page (100).
const config = require('../config');
const { store } = require('../store');
const { oracle, recent } = require('../oracle');
const { sendEmail } = require('../email');
const auth = require('../auth');
const billing = require('../billing');
const sites = require('../sites');
const bots = require('../bots');
const templates = require('../templates');
const governor = require('../governor');
const { page, esc } = require('../views');

const money = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const yearStart = () => Math.floor(Date.UTC(new Date().getUTCFullYear(), 0, 1) / 1000);
const monthStart = () => Math.floor(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) / 1000);

// Item 92: live numbers from Stripe only (cached 5 min).
let numCache = { at: 0, v: null };
async function liveNumbers() {
  if (!billing.connected()) return null;
  if (numCache.v && Date.now() - numCache.at < 300e3) return numCache.v;
  const st = billing.stripe();
  const p = await billing.prices();
  let active = 0, trialing = 0, pastDue = 0, mrr = 0;
  for await (const sub of st.subscriptions.list({ status: 'all', limit: 100, price: p.plan.id })) {
    if (sub.status === 'active') { active++; mrr += sub.items.data.reduce((a, i) => a + (i.price.recurring ? i.price.unit_amount * i.quantity : 0), 0); }
    else if (sub.status === 'trialing') trialing++;
    else if (sub.status === 'past_due') pastDue++;
  }
  let month = 0;
  for await (const c of st.charges.list({ created: { gte: monthStart() }, limit: 100 })) if (c.paid && c.status === 'succeeded') month += c.amount - (c.amount_refunded || 0);
  numCache = { at: Date.now(), v: { active, trialing, pastDue, mrr, month, test: billing.isTestMode() } };
  return numCache.v;
}

// Item 96: tax bot - tracks income and expenses, shows what to set aside. Never files anything.
async function taxes() {
  const pct = Number(process.env.TAX_SET_ASIDE_PCT || 25);
  let gross = 0, refunds = 0, fees = 0, source = 'Not connected';
  if (billing.connected()) {
    source = billing.isTestMode() ? 'Stripe TEST mode (not real money)' : 'Stripe';
    for await (const t of billing.stripe().balanceTransactions.list({ created: { gte: yearStart() }, limit: 100 })) {
      if (t.type === 'charge' || t.type === 'payment') gross += t.amount;
      if (t.type === 'refund' || t.type === 'payment_refund') refunds += -t.amount;
      fees += t.fee || 0;
    }
  }
  const year = String(new Date().getUTCFullYear());
  const exp = (await store.all('expenses')).filter((e) => String(e.date).startsWith(year));
  const expenses = exp.reduce((a, e) => a + e.amountCents, 0);
  const profit = gross - refunds - fees - expenses;
  return { pct, gross, refunds, fees, expenses, profit, setAside: Math.max(0, Math.round(profit * pct / 100)), source, exp };
}

async function deleteMember(approval, ownerEmail) {
  const m = await store.get('members', approval.memberId);
  if (!m) return;
  if (billing.connected() && m.subscriptionId && m.status !== 'ended') {
    try { await billing.stripe().subscriptions.cancel(m.subscriptionId); } catch {}
  }
  for (const s of await store.where('sites', 'memberId', m.id)) await store.update('sites', s.id, { archived: true, published: false, doc: null, publishedDoc: null, details: { businessName: '(deleted)' }, slug: `deleted-${s.id}`, deletedAt: new Date().toISOString() });
  for (const l of await store.where('leads', 'memberId', m.id)) await store.update('leads', l.id, { name: '', email: '', phone: '', message: '(deleted)', deleted: true });
  for (const a of await store.where('assets', 'memberId', m.id)) await store.update('assets', a.id, { data: '', deleted: true });
  await sendEmail({ to: m.email, kind: 'account_deleted', subject: 'Your account was deleted', html: '<p>Your account, sites and messages were deleted as you asked.</p>' });
  await store.update('members', m.id, { email: `deleted-${m.id}@deleted.invalid`, status: 'ended', deletedAt: new Date().toISOString(), githubTokenBox: null, refCode: null });
  await oracle(ownerEmail, 'account.deleted', { member: m.id, approval: approval.id });
}

function mount(app, { wrap }) {
  const O = auth.requireOwner;

  app.get('/owner', O, wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const [members, approvals, log, runs, flags, tickets, nums] = await Promise.all([
      store.all('members'), store.all('approvals'), recent(40), store.all('botruns'), store.all('flags'), store.all('support'), liveNumbers().catch(() => null),
    ]);
    const pend = approvals.filter((a) => a.status === 'pending').sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
    const found = q ? members.filter((m) => m.email.includes(q) || m.id.toLowerCase().includes(q)) : members.slice(-20).reverse();
    const lastRun = (b) => runs.filter((r) => r.bot === b && r.finishedAt).sort((x, y) => (x.startedAt < y.startedAt ? 1 : -1))[0];
    const label = { refund: 'Refund', payout: 'Referral payout (bill credit)', delete: 'Account deletion', governor: 'Governor review' };
    res.send(page('Admin Command Center', `<h1>Admin Command Center</h1>
<p class="mut">Stripe: ${billing.connected() ? (billing.isTestMode() ? 'TEST mode' : '<b class="bad">LIVE mode</b>') : 'Not connected'}</p>
<div class="row">${nums ? [['Members (Stripe active)', nums.active], ['In free 30 days', nums.trialing], ['Past due', nums.pastDue], ['Monthly recurring revenue', money(nums.mrr)], ['Collected this month', money(nums.month)]].map(([k, v]) => `<div class="card"><b style="font-size:24px">${v}</b><br><span class="mut small">${k}</span></div>`).join('') : '<div class="card">Live numbers: Stripe not connected</div>'}
<div class="card"><b style="font-size:24px">${members.filter((m) => !m.deletedAt).length}</b><br><span class="mut small">Member records</span></div></div>
${nums?.test ? '<p class="mut small">Numbers are from Stripe TEST mode.</p>' : ''}

<div class="card" id="queue"><h2 style="margin-top:0">Approval queue (${pend.length})</h2><p class="mut small">Nothing refunds, pays out or deletes until you tap Approve.</p>
${pend.length ? pend.map((a) => `<div class="card"><b>${esc(label[a.type] || a.type)}</b>${a.amountCents ? ` - ${money(a.amountCents)}` : ''}<br><span class="mut">${esc(a.email || '')} · ${esc((a.requestedAt || '').slice(0, 16).replace('T', ' '))}</span><p>${esc(a.reason || '')}</p>${a.siteId ? `<p><a href="/owner/sites/${esc(a.siteId)}/preview" target="_blank">Open site preview</a></p>` : ''}
<form method="post" action="/owner/approvals/${esc(a.id)}"><div class="row"><button name="decision" value="approve">Approve</button><button class="sec" name="decision" value="deny">Deny</button></div></form></div>`).join('') : '<p class="mut">Nothing waiting.</p>'}</div>

<div class="card"><h2 style="margin-top:0">Members</h2><form class="row" method="get"><input name="q" value="${esc(q)}" placeholder="Search email" aria-label="Search members" style="max-width:300px"><button class="sec">Search</button></form>
<div class="scroll"><table>${found.map((m) => `<tr><td><a href="/owner/members/${esc(m.id)}">${esc(m.email)}</a></td><td>${esc(m.status)}${m.cancelAtPeriodEnd ? ' (cancelling)' : ''}</td><td>${esc((m.createdAt || '').slice(0, 10))}</td></tr>`).join('')}</table></div></div>

<div class="card"><h2 style="margin-top:0">Bots</h2><div class="scroll"><table><tr><th>Bot</th><th>Last run</th><th>Result</th><th></th></tr>${Object.keys(bots.SCHEDULE).map((b) => { const r = lastRun(b); return `<tr><td>${esc(b)}</td><td>${r ? esc(r.startedAt.slice(0, 16).replace('T', ' ')) + (r.by === 'twin' ? ' (twin)' : '') : 'never'}</td><td class="${r ? (r.ok ? 'ok' : 'bad') : ''}">${r ? (r.ok ? 'ok' : 'failed') : ''} <span class="mut small">${esc(r ? JSON.stringify(r.summary).slice(0, 120) : '')}</span></td><td><form method="post" action="/owner/bots/${esc(b)}"><button class="sm sec" style="min-height:32px;padding:4px 10px">Run</button></form></td></tr>`; }).join('')}</table></div></div>

${flags.filter((f) => f.status === 'open').length ? `<div class="card"><h2 style="margin-top:0">Flags</h2>${flags.filter((f) => f.status === 'open').map((f) => `<div><b>${esc(f.kind)}</b> ${esc(f.at.slice(0, 10))}<ul>${f.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul><form method="post" action="/owner/flags/${esc(f.id)}"><button class="sec sm">Mark reviewed</button></form></div>`).join('')}</div>` : ''}
${tickets.filter((t) => t.status === 'open').length ? `<div class="card"><h2 style="margin-top:0">Support hand-offs</h2>${tickets.filter((t) => t.status === 'open').map((t) => `<p><b>${esc(t.email)}</b> ${esc(t.at.slice(0, 16))}<br>${esc(t.q)}</p><form method="post" action="/owner/support/${esc(t.id)}"><button class="sec sm">Mark answered</button></form>`).join('')}</div>` : ''}

<div class="card"><h2 style="margin-top:0">More</h2><div class="row"><a class="btn sec" href="/owner/taxes">Tax bot</a><a class="btn sec" href="/owner/templates">Templates</a><a class="btn sec" href="/owner/news">Newsletter news</a><a class="btn sec" href="/owner/oracle">Full Oracle log</a><a class="btn sec" href="/status">Status page</a></div></div>
<div class="card"><h2 style="margin-top:0">Oracle (latest)</h2><div class="scroll"><table>${log.map((l) => `<tr><td>${esc(l.when.slice(0, 19).replace('T', ' '))}</td><td>${esc(l.who)}</td><td>${esc(l.what)}</td></tr>`).join('')}</table></div></div>`, { user: req.user }));
  }));

  // Item 93: approvals. Money out / deletes only here, only on Approve.
  app.post('/owner/approvals/:id', O, wrap(async (req, res) => {
    const a = await store.get('approvals', req.params.id);
    if (!a || a.status !== 'pending') return res.redirect(303, '/owner#queue');
    const decision = req.body.decision === 'approve' ? 'approve' : 'deny';
    const done = (extra = {}) => store.update('approvals', a.id, { status: decision === 'approve' ? 'approved' : 'denied', decidedAt: new Date().toISOString(), decidedBy: req.user.email, ...extra });
    try {
      if (decision === 'approve') {
        if (a.type === 'refund') {
          const r = await billing.executeApprovedRefund(a, req.user.email);
          await done({ refundId: r.id });
          await sendEmail({ to: a.email, kind: 'refund', subject: 'Your refund was approved', html: `<p>Your refund of ${money(a.amountCents)} was approved. It usually shows on your card in 5-10 business days.</p>` });
        } else if (a.type === 'payout') {
          const tx = await require('../referrals').executePayout(a, req.user.email);
          await done({ balanceTx: tx.id });
          await sendEmail({ to: a.email, kind: 'referral', subject: 'You earned a referral credit', html: `<p>Thanks for the referral! A ${money(a.amountCents)} credit was added to your next bill.</p>` });
        } else if (a.type === 'delete') {
          await deleteMember(a, req.user.email);
          await done();
        } else if (a.type === 'governor') {
          await sites.forcePublish(a.siteId, req.user.email);
          await done();
          await sendEmail({ to: a.email, kind: 'governor', subject: 'Your site was approved and is live', html: '<p>Your site was reviewed and published.</p>' });
        }
      } else {
        await done();
        if (a.type === 'refund') await sendEmail({ to: a.email, kind: 'refund', subject: 'About your refund request', html: '<p>Your refund request was reviewed and not approved. Reply to this email if you have questions.</p>' });
        if (a.type === 'governor') { await store.update('sites', a.siteId, { governorHold: { ...(await store.get('sites', a.siteId)).governorHold, denied: true } }); await sendEmail({ to: a.email, kind: 'governor', subject: 'Your site needs changes', html: '<p>Your site was reviewed and can\'t be published as it is. Please remove the flagged content and publish again.</p>' }); }
      }
      await oracle(req.user.email, `${a.type}.${decision === 'approve' ? 'approved' : 'denied'}`, { approval: a.id, amountCents: a.amountCents || 0 });
    } catch (e) {
      await oracle(req.user.email, `${a.type}.failed`, { approval: a.id, error: e.message });
      return res.send(page('Failed', `<p class="bad">${esc(e.message)}</p><p><a href="/owner">Back</a></p>`, { user: req.user }));
    }
    res.redirect(303, '/owner#queue');
  }));

  app.get('/owner/sites/:id/preview', O, wrap(async (req, res) => {
    const s = await store.get('sites', req.params.id);
    if (!s?.doc) return res.status(404).send('Not found');
    res.send(sites.renderSite(s, { pageSlug: String(req.query.page || ''), base: `/owner/sites/${s.id}/preview?page=`, preview: true, template: await templates.getTemplate(s.doc.template) }) || 'No page');
  }));

  // Item 94: read-only profile + 95 pause/unpause with reason
  app.get('/owner/members/:id', O, wrap(async (req, res) => {
    const m = await store.get('members', req.params.id);
    if (!m) return res.status(404).send(page('Not found', '<p>Not found</p>', { user: req.user }));
    const ss = await store.where('sites', 'memberId', m.id);
    const log = (await store.all('oracle')).filter((l) => l.who === m.email || l.details?.member === m.id).sort((a, b) => (a.when < b.when ? 1 : -1)).slice(0, 40);
    res.send(page('Member', `<h1>${esc(m.email)}</h1><p class="mut">Read-only view</p><div class="card"><table>${['status', 'subscriptionStatus', 'cancelAtPeriodEnd', 'extraSitesBilled', 'createdAt', 'stripeCustomerId', 'referredBy'].map((k) => `<tr><th>${k}</th><td>${esc(String(m[k] ?? ''))}</td></tr>`).join('')}</table></div>
<div class="card"><h2 style="margin-top:0">Sites</h2>${ss.map((s) => `<div class="card"><b>${esc(s.details?.businessName)}</b> (${esc(s.slug)}) - ${s.archived ? 'removed' : s.ownerPaused ? '<span class="warn">paused by owner</span>' : s.published ? 'published' : 'draft'} · <a href="/owner/sites/${esc(s.id)}/preview" target="_blank">Preview</a>
${s.archived ? '' : `<form method="post" action="/owner/sites/${esc(s.id)}/pause" class="row"><input name="reason" required maxlength="300" placeholder="Reason (logged)" aria-label="Reason" style="max-width:320px"><button class="sec sm">${s.ownerPaused ? 'Unpause' : 'Pause'}</button></form>`}${s.ownerPauseReason ? `<p class="mut small">Last: ${esc(s.ownerPauseReason)}</p>` : ''}</div>`).join('') || '<p class="mut">No sites.</p>'}</div>
<div class="card"><h2 style="margin-top:0">Oracle</h2><table>${log.map((l) => `<tr><td>${esc(l.when.slice(0, 16).replace('T', ' '))}</td><td>${esc(l.what)}</td></tr>`).join('')}</table></div><p><a href="/owner">Back</a></p>`, { user: req.user }));
  }));
  app.post('/owner/sites/:id/pause', O, wrap(async (req, res) => {
    const s = await store.get('sites', req.params.id);
    const reason = String(req.body.reason || '').trim().slice(0, 300);
    if (!s || !reason) return res.redirect(303, '/owner');
    await store.update('sites', s.id, { ownerPaused: !s.ownerPaused, ownerPauseReason: reason, ownerPausedAt: new Date().toISOString() });
    await oracle(req.user.email, s.ownerPaused ? 'site.owner_unpaused' : 'site.owner_paused', { site: s.id, reason });
    res.redirect(303, `/owner/members/${s.memberId}`);
  }));
  app.post('/owner/bots/:name', O, wrap(async (req, res) => { await bots.run(String(req.params.name), req.user.email); res.redirect(303, '/owner'); }));
  app.post('/owner/flags/:id', O, wrap(async (req, res) => { await store.update('flags', req.params.id, { status: 'reviewed', reviewedAt: new Date().toISOString() }); res.redirect(303, '/owner'); }));
  app.post('/owner/support/:id', O, wrap(async (req, res) => { await store.update('support', req.params.id, { status: 'answered' }); res.redirect(303, '/owner'); }));
  app.get('/owner/oracle', O, wrap(async (req, res) => {
    const log = await recent(500);
    res.send(page('Oracle', `<h1>Oracle log</h1><div class="scroll"><table>${log.map((l) => `<tr><td>${esc(l.when.slice(0, 19).replace('T', ' '))}</td><td>${esc(l.who)}</td><td>${esc(l.what)}</td><td class="mut small">${esc(JSON.stringify(l.details).slice(0, 200))}</td></tr>`).join('')}</table></div>`, { user: req.user }));
  }));

  // Item 96: tax bot
  app.get('/owner/taxes', O, wrap(async (req, res) => {
    const t = await taxes();
    res.send(page('Tax bot', `<h1>Tax bot - ${new Date().getUTCFullYear()}</h1><p class="mut">Tracks income and expenses and shows what to set aside. It never files anything. Check with a tax professional.</p>
<div class="card"><table><tr><td>Money in (${esc(t.source)})</td><td>${money(t.gross)}</td></tr><tr><td>Refunds</td><td>-${money(t.refunds)}</td></tr><tr><td>Stripe fees</td><td>-${money(t.fees)}</td></tr><tr><td>Your expenses</td><td>-${money(t.expenses)}</td></tr><tr><th>Profit so far</th><th>${money(t.profit)}</th></tr>
<tr><th>Set aside for taxes (${t.pct}%)</th><th class="warn">${money(t.setAside)}</th></tr></table><p class="mut small">The ${t.pct}% rate is a planning estimate (change it with TAX_SET_ASIDE_PCT).</p></div>
<div class="card"><h2 style="margin-top:0">Add an expense</h2><form method="post" action="/owner/expenses"><label>Date<input type="date" name="date" required></label><label>Amount ($)<input name="amount" inputmode="decimal" required pattern="\\d+(\\.\\d{1,2})?"></label><label>Category<input name="category" maxlength="60" placeholder="Hosting, software, ads..."></label><label>Note<input name="note" maxlength="200"></label><button>Add</button></form>
${t.exp.length ? `<table>${t.exp.sort((a, b) => (a.date < b.date ? 1 : -1)).map((e) => `<tr><td>${esc(e.date)}</td><td>${esc(e.category)}</td><td>${money(e.amountCents)}</td><td class="mut">${esc(e.note)}</td></tr>`).join('')}</table>` : ''}</div><p><a href="/owner">Back</a></p>`, { user: req.user }));
  }));
  app.post('/owner/expenses', O, wrap(async (req, res) => {
    const amt = Math.round(parseFloat(String(req.body.amount || '0')) * 100);
    if (!(amt > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(req.body.date)) return res.redirect(303, '/owner/taxes');
    await store.add('expenses', { date: req.body.date, amountCents: amt, category: String(req.body.category || '').slice(0, 60), note: String(req.body.note || '').slice(0, 200), at: new Date().toISOString() });
    await oracle(req.user.email, 'expense.added', { amountCents: amt });
    res.redirect(303, '/owner/taxes');
  }));

  // Item 40: owner adds templates; item 39: Governor checks before offering.
  app.get('/owner/templates', O, wrap(async (req, res) => {
    const custom = await store.all('templates');
    res.send(page('Templates', `<h1>Templates</h1><p>${templates.BUILT_IN.length} built-in + ${custom.length} added by you. A template is offered to members only after it passes the Governor check.</p>
${custom.map((t) => `<div class="card"><b>${esc(t.name)}</b> (${esc(t.id)}) - ${t.governor?.pass ? '<span class="ok">offered</span>' : `<span class="bad">not offered: ${esc((t.governor?.issues || []).map((i) => i.msg).join(' | '))}</span>`} · <a href="/templates/${esc(t.id)}/demo" target="_blank">Sample</a></div>`).join('')}
<div class="card"><h2 style="margin-top:0">Add a template</h2><form method="post" action="/owner/templates">
<label>ID (letters/dashes)<input name="id" required pattern="[a-z0-9-]{3,30}"></label><label>Name<input name="name" required maxlength="60"></label><label>Industry<input name="industry" maxlength="40"></label>
<label>Light colors: background, text, accent, card<input name="light" required placeholder="#ffffff,#111111,#0055aa,#f2f4f7"></label><label>Dark colors<input name="dark" required placeholder="#0f1115,#eeeeee,#66aaff,#1a1d23"></label>
<label>Heading font<select name="hf">${templates.FONTS.map((f) => `<option>${esc(f)}</option>`).join('')}</select></label><label>Text font<select name="bf">${templates.FONTS.map((f) => `<option>${esc(f)}</option>`).join('')}</select></label>
<label>Home sections (comma list)<input name="sections" value="hero,about,services,contact"></label><label>Sample business name<input name="sampleName" value="Sample Business"></label>
<button>Check with Governor and save</button></form></div><p><a href="/owner">Back</a></p>`, { user: req.user, flash: req.query.f || '' }));
  }));
  app.post('/owner/templates', O, wrap(async (req, res) => {
    const b = req.body;
    const cols = (v) => String(v || '').split(',').map((x) => x.trim()).filter((x) => /^#[0-9a-fA-F]{6}$/.test(x));
    const light = cols(b.light), dark = cols(b.dark);
    const secs = String(b.sections || '').split(',').map((x) => x.trim()).filter((x) => require('../doc').SECTION_TYPES[x]);
    if (!/^[a-z0-9-]{3,30}$/.test(b.id) || templates.BUILT_IN.some((t) => t.id === b.id) || light.length !== 4 || dark.length !== 4 || !secs.length) return res.redirect(303, '/owner/templates?f=' + encodeURIComponent('Check the ID (unique), 4 light + 4 dark colors, and sections.'));
    const t = { id: b.id, name: String(b.name).slice(0, 60), industry: String(b.industry || '').slice(0, 40), builtIn: false, theme: { light, dark, headingFont: templates.FONTS.includes(b.hf) ? b.hf : 'Inter', bodyFont: templates.FONTS.includes(b.bf) ? b.bf : 'Inter', radius: 12 }, sections: secs, extraPages: [], sample: { businessName: 'Sample: ' + String(b.sampleName || 'Business').slice(0, 60), tagline: 'Sample text', services: ['Sample service'] } };
    const { doc, d } = require('./builder').demoDoc(t);
    const g = await governor.decide({ details: d }, doc, req.user.email, { template: t, templateId: t.id });
    await store.set('templates', t.id, { ...t, governor: { pass: g.pass, status: g.status, issues: g.issues }, at: new Date().toISOString() });
    await oracle(req.user.email, 'template.added', { template: t.id, governor: g.status });
    res.redirect(303, '/owner/templates?f=' + encodeURIComponent(g.pass ? 'Saved and offered to members.' : 'Saved, but NOT offered: it failed the Governor check.'));
  }));

  // News for the weekly newsletter (item 70).
  app.get('/owner/news', O, wrap(async (req, res) => {
    const n = (await store.all('news')).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 30);
    res.send(page('Newsletter news', `<h1>Newsletter news</h1><p class="mut">The weekly newsletter sends these (from the last 7 days), plus the "Coming soon" list. It skips a week with nothing new.</p>
<form method="post" action="/owner/news" class="card"><label>Type<select name="kind"><option value="new">What's new</option><option value="ai">AI news</option></select></label><label>Title<input name="title" required maxlength="120"></label><label>Text<textarea name="body" rows="3" maxlength="1000"></textarea></label><label>Source link (for AI news)<input name="link" type="url" maxlength="300"></label><button>Add</button></form>
${n.map((x) => `<div class="card"><b>${esc(x.title)}</b> <span class="mut small">${esc(x.kind)} · ${esc(x.at.slice(0, 10))}</span><p>${esc(x.body)}</p></div>`).join('')}<p><a href="/owner">Back</a></p>`, { user: req.user }));
  }));
  app.post('/owner/news', O, wrap(async (req, res) => {
    const link = /^https:\/\//.test(req.body.link || '') ? String(req.body.link).slice(0, 300) : '';
    await store.add('news', { kind: req.body.kind === 'ai' ? 'ai' : 'new', title: String(req.body.title || '').slice(0, 120), body: String(req.body.body || '').slice(0, 1000), link, at: new Date().toISOString() });
    res.redirect(303, '/owner/news');
  }));

  // Item 100: public status page.
  app.get('/status', wrap(async (req, res) => {
    const runs = await store.all('botruns');
    const days = (await store.all('uptime_days')).sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 7);
    const checks = days.reduce((a, d) => a + (d.platformChecks || 0), 0);
    const ok = days.reduce((a, d) => a + (d.platformOk || 0), 0);
    const up = (b) => { const r = runs.filter((x) => x.bot === b && x.finishedAt).sort((x, y) => (x.startedAt < y.startedAt ? 1 : -1))[0]; return r ? { ok: r.ok, at: r.startedAt } : null; };
    const sitesUp = (await store.all('uptime'));
    const rows = [['Website builder & dashboard', { ok: true, at: new Date().toISOString() }], ['Member sites', sitesUp.length ? { ok: sitesUp.every((s) => s.up), at: sitesUp.map((s) => s.lastCheck).sort().pop() } : null], ['Uptime monitor', up('uptime')], ['Daily backups', up('backup')], ['Payments', billing.connected() ? { ok: true, at: new Date().toISOString() } : null]];
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.send(page('Status', `<h1>Platform status</h1><div class="card">${rows.some(([, v]) => v && !v.ok) ? '<p style="font-size:22px"><b class="bad">● Some systems have problems</b></p>' : '<p style="font-size:22px"><b class="ok">● All reporting systems operational</b></p>'}${checks ? `<p>Uptime last 7 days: <b>${((ok / checks) * 100).toFixed(2)}%</b> (${checks} checks)</p>` : '<p class="mut">Uptime history starts after the first checks.</p>'}</div>
<div class="card"><table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v ? (v.ok ? '<span class="ok">Operational</span>' : '<span class="bad">Problem</span>') : '<span class="mut">Not reporting yet</span>'}</td><td class="mut small">${v?.at ? esc(v.at.slice(0, 16).replace('T', ' ')) + ' UTC' : ''}</td></tr>`).join('')}</table></div>`, { user: req.user }));
  }));
}

module.exports = { mount, liveNumbers, taxes, deleteMember };

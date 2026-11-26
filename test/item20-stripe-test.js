// ITEM 20 TEST - runs against REAL Stripe TEST mode (refuses live mode).
// Flow: signup checkout -> $4.99 paid -> build a site -> 4th site at $25 ->
// refund request waits -> remove extra -> cancel -> membership ends (sites
// offline, kept) -> rejoin -> sites back. Webhooks: real Stripe events are
// pulled from the API and delivered to /webhooks/stripe with a valid
// signature (and one forged one that must be rejected).
//
// Card entry on Stripe's hosted Checkout page can't be driven from here, so
// the paid subscription is created with Stripe's test card through the API
// using the exact same prices, trial and one-time $4.99 as Checkout.
const crypto = require('crypto');
process.env.STORE = 'memory';
process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_' + crypto.randomBytes(24).toString('hex');
process.env.CRON_SECRET = crypto.randomBytes(16).toString('hex');
if (!process.env.STRIPE_SECRET_KEY) { console.error('Set STRIPE_SECRET_KEY (test mode)'); process.exit(2); }
if (/^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY)) { console.error('REFUSING: live key'); process.exit(2); }

const http = require('http');
const Stripe = require('stripe');
const app = require('../src/server');
const billing = require('../src/billing');
const auth = require('../src/auth');
const { store } = require('../src/store');
const jobs = require('../src/jobs');

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  - ' + info : ''}`);
}

let base, cookie = '';
async function req(method, path, form, extraHeaders = {}) {
  const body = form ? new URLSearchParams(form).toString() : undefined;
  const r = await fetch(base + path, {
    method, redirect: 'manual', body,
    headers: { ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(cookie ? { cookie } : {}), ...extraHeaders },
  });
  const sc = r.headers.get('set-cookie');
  if (sc && sc.startsWith('ios_session=')) cookie = sc.split(';')[0];
  return { status: r.status, location: r.headers.get('location'), text: await r.text() };
}

async function deliverEvents(stripe, since, customerId) {
  // Pull real events for this customer (oldest first) and post them signed.
  let all = [];
  for await (const ev of stripe.events.list({ created: { gte: since }, limit: 100 })) all.push(ev);
  all = all.filter((e) => { const o = e.data.object; return o.customer === customerId || o.id === customerId; }).reverse();
  let ok = 0;
  for (const ev of all) {
    const payload = JSON.stringify(ev);
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    const r = await fetch(base + '/webhooks/stripe', { method: 'POST', body: payload, headers: { 'content-type': 'application/json', 'stripe-signature': header } });
    if (r.status === 200) ok++; else console.log('  webhook', ev.type, r.status);
  }
  return { total: all.length, ok };
}
const waitEvents = () => new Promise((r) => setTimeout(r, 4000));

(async () => {
  const server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const stripe = billing.stripe();
  const start = Math.floor(Date.now() / 1000) - 5;
  const email = `ios-test-${Date.now()}@example.com`;

  // 1-3. Signup checkout with disclosure + agree box
  const homeHtml = (await req('GET', '/')).text;
  check('3. Exact price disclosure shown', homeHtml.includes('$4.99 today, then $100.00/month starting 30 days later, plus $25/month per site after 3. Cancel anytime online.'));
  check('3. "I agree" box starts unchecked', /<input type="checkbox" name="agree" value="yes" id="agree">/.test(homeHtml));
  check('3. Checkout refused without "I agree"', (await req('POST', '/checkout', { email })).status === 400);
  const co = await req('POST', '/checkout', { email, agree: 'yes' });
  check('1. Get Started opens Stripe Checkout', co.status === 303 && /^https:\/\/checkout\.stripe\.com\//.test(co.location || ''), co.location ? co.location.slice(0, 40) : String(co.status));
  const csId = (co.location || '').match(/(cs_test_[A-Za-z0-9]+)/)?.[1];
  const cs = await stripe.checkout.sessions.retrieve(csId, { expand: ['line_items'] });
  check('Stripe is in TEST mode', cs.livemode === false);
  const amounts = cs.line_items.data.map((l) => `${l.price.unit_amount}:${l.price.type}`).sort();
  check('1-2. Checkout = $4.99 one-time + $100/month', JSON.stringify(amounts) === JSON.stringify(['10000:recurring', '499:one_time']), amounts.join(','));
  check('2. Checkout has the 30-day start', cs.amount_total === 499, `due today ${cs.amount_total}`);
  check('3. Disclosure also on Stripe pay button', cs.custom_text?.submit?.message?.includes('$4.99 today'));
  check('4. /welcome does not trust an unpaid checkout', !(await req('GET', '/welcome?session_id=' + csId)).text.includes('dashboard'));

  // Pay with Stripe's test card (same prices/trial as Checkout).
  const p = await billing.prices();
  const pm = await stripe.paymentMethods.create({ type: 'card', card: { token: 'tok_visa' } });
  const cust = await stripe.customers.create({ email });
  await stripe.paymentMethods.attach(pm.id, { customer: cust.id });
  await stripe.customers.update(cust.id, { invoice_settings: { default_payment_method: pm.id } });
  const sub = await stripe.subscriptions.create({
    customer: cust.id, items: [{ price: p.plan.id }], trial_period_days: 30,
    add_invoice_items: [{ price: p.signup.id }], metadata: { flow: 'signup' },
  });
  check('2. Subscription starts as 30-day trial', sub.status === 'trialing' && Math.round((sub.trial_end - sub.created) / 86400) === 30);
  const firstInv = (await stripe.invoices.list({ customer: cust.id, limit: 1 })).data[0];
  check('1. $4.99 charged today', firstInv.amount_paid === 499 && firstInv.status === 'paid', `${firstInv.amount_paid} ${firstInv.status}`);

  // 4. Webhook: bad signature rejected; real events activate membership
  const forged = await fetch(base + '/webhooks/stripe', { method: 'POST', body: JSON.stringify({ id: 'evt_fake', type: 'customer.subscription.created', data: { object: sub } }), headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' } });
  check('4. Forged webhook rejected', forged.status === 400);
  check('4. No member from forged webhook', !(await billing.memberByEmail(email)));
  await waitEvents();
  const d1 = await deliverEvents(stripe, start, cust.id);
  let m = await billing.memberByEmail(email);
  check('4. Signed webhook turns membership on', m && m.status === 'active' && m.subscriptionStatus === 'trialing', `${d1.ok}/${d1.total} events`);
  const receipts = await store.where('emails', 'kind', 'receipt');
  check('5. Receipt email for the $4.99 charge', receipts.some((e) => e.to === email), receipts.map((r) => r.status).join(','));

  // sign in (same as tapping the emailed link)
  await req('GET', '/login/verify?token=' + encodeURIComponent(auth.loginLinkToken(email)));
  let dash = (await req('GET', '/dashboard')).text;
  check('16. Meter shows "0 of 3 sites used"', dash.includes('0 of 3 sites used'));

  // 11/22. Build a site from real details
  const r1 = await req('POST', '/sites', { businessName: 'Test Bakery One', siteName: `tb1-${Date.now()}`, tagline: 'Fresh bread daily', services: 'Bread\nCakes', phone: '555-0100' });
  const s1 = (await store.where('sites', 'memberId', m.id))[0];
  check('11. Build a site', r1.status === 303 && s1);
  await req('POST', `/sites/${s1.id}/publish`, {});
  const live1 = await req('GET', `/s/${s1.slug}`);
  check('11. Site is hosted and live', live1.status === 200 && live1.text.includes('Test Bakery One'));
  for (const n of [2, 3]) await req('POST', '/sites', { businessName: `Test Site ${n}`, siteName: `ts${n}-${Date.now()}` });
  dash = (await req('GET', '/dashboard')).text;
  check('16. Meter shows "3 of 3 sites used"', dash.includes('3 of 3 sites used'));
  check('12. Trial has the same 3-site limit', dash.includes('$25/month for this site'));

  // 13-14. 4th site needs confirm tap, bills $25 on same subscription
  const ask = await req('POST', '/sites', { businessName: 'Fourth Site', siteName: `t4-${Date.now()}` });
  check('13. 4th site shows "$25/month for this site" + confirm', ask.text.includes('$25/month for this site') && ask.text.includes('confirmExtra'));
  check('13. Nothing added before confirm', (await billing.activeSites(m)).length === 3);
  const f4 = Object.fromEntries([...ask.text.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((x) => [x[1], x[2]]));
  await req('POST', '/sites', f4);
  let s2 = await stripe.subscriptions.retrieve(sub.id);
  const extraItem = s2.items.data.find((i) => i.price.id === p.extra.id);
  check('14. $25 extra site on the same subscription', extraItem && extraItem.quantity === 1 && extraItem.price.unit_amount === 2500);
  await waitEvents();
  await deliverEvents(stripe, start, cust.id);
  m = await billing.memberByEmail(email);
  dash = (await req('GET', '/dashboard')).text;
  check('16. Meter shows 4 sites with 1 extra', dash.includes('4 of 3 sites used') && dash.includes('1 extra at $25/month'));

  // 9. Billing page
  const bill = (await req('GET', '/billing')).text;
  check('9. Billing page: next charge $125.00 on first bill date', bill.includes('$125.00') && bill.includes(billing.fmtDate(sub.trial_end)));
  check('9. Billing page: card on file', /visa ending 4242/i.test(bill));
  check('9. Billing page: past invoices', bill.includes('$4.99'));
  const portal = await req('POST', '/billing/portal', {});
  check('9. Stripe Customer Portal opens', portal.status === 303 && /billing\.stripe\.com/.test(portal.location || ''));

  // 10. Refund request waits for owner
  await req('POST', '/billing/refund-request', { invoiceId: firstInv.id, reason: 'test' });
  const ap = await store.where('approvals', 'invoiceId', firstInv.id);
  const pays = await stripe.invoicePayments.list({ invoice: firstInv.id });
  const pi = pays.data[0]?.payment?.payment_intent;
  const refunds = await stripe.refunds.list({ payment_intent: typeof pi === 'string' ? pi : pi?.id });
  check('10. Refund request in owner queue, nothing refunded', ap.length === 1 && ap[0].status === 'pending' && refunds.data.length === 0);
  const memberTriesOwner = await req('GET', '/owner');
  check('10. Members cannot open owner queue', memberTriesOwner.status === 404);

  // 15. Remove the extra site -> $25 stops (no refund, no proration credit)
  const four = (await billing.activeSites(m)).find((x) => x.details.businessName === 'Fourth Site');
  await req('POST', `/sites/${four.id}/remove`, {});
  s2 = await stripe.subscriptions.retrieve(sub.id);
  check('15. Removing extra site stops its $25', !s2.items.data.find((i) => i.price.id === p.extra.id));
  check('15/17. Removed site kept, not deleted', !!(await store.get('sites', four.id)));

  // 6. 7-day reminder (job run as if 6 days before first bill)
  await jobs.daily(sub.trial_end * 1000 - 6 * 864e5);
  check('6. Reminder email 7 days before first $100', (await store.where('emails', 'kind', 'trial_reminder')).some((e) => e.to === email));

  // 7. Cancel in 2 taps; access stays until period end
  dash = (await req('GET', '/dashboard')).text;
  check('7. Cancel is on the dashboard', dash.includes('Cancel membership') && dash.includes('Yes, cancel'));
  await req('POST', '/cancel', {});
  s2 = await stripe.subscriptions.retrieve(sub.id);
  m = await billing.memberByEmail(email);
  check('7. Cancel sets end-of-period (no early cut-off)', (s2.cancel_at_period_end || !!s2.cancel_at) && s2.status === 'trialing');
  check('7. Access stays on until period ends', billing.hostingAllowed(m) && (await req('GET', `/s/${s1.slug}`)).status === 200);
  check('7. Dashboard says when access ends', (await req('GET', '/dashboard')).text.includes('Full access until'));

  // 17. Period ends -> sites offline, kept (end the TEST subscription now to simulate)
  await stripe.subscriptions.cancel(sub.id);
  await waitEvents();
  await deliverEvents(stripe, start, cust.id);
  m = await billing.memberByEmail(email);
  const off = await req('GET', `/s/${s1.slug}`);
  check('17. Membership ended -> sites offline', m.status === 'ended' && off.status === 503);
  check('17. Sites kept after membership ends', (await billing.activeSites(m)).length === 3);

  // 18. Rejoin brings sites back
  const rj = await req('POST', '/rejoin', { agree: 'yes' });
  check('18. Rejoin opens Stripe Checkout', rj.status === 303 && /checkout\.stripe\.com/.test(rj.location || ''));
  const sub2 = await stripe.subscriptions.create({ customer: cust.id, items: [{ price: p.plan.id }], metadata: { flow: 'rejoin' } });
  await waitEvents();
  await deliverEvents(stripe, start, cust.id);
  m = await billing.memberByEmail(email);
  check('18. Rejoin -> membership active, sites back', m.status === 'active' && (await req('GET', `/s/${s1.slug}`)).status === 200);

  // 8. Failed payment -> grace -> pause, nothing deleted
  await store.update('members', m.id, { status: 'past_due', pastDueSince: new Date(Date.now() - 3 * 864e5).toISOString() });
  check('8. Failed payment: still online during 7-day grace', billing.hostingAllowed(await store.get('members', m.id)));
  await store.update('members', m.id, { pastDueSince: new Date(Date.now() - 8 * 864e5).toISOString() });
  check('8. After grace: sites pause', (await req('GET', `/s/${s1.slug}`)).status === 503);
  check('8. After grace: nothing deleted', (await billing.activeSites(m)).length === 3);
  await stripe.subscriptions.update(sub2.id, { cancel_at_period_end: true }); // leave test data tidy

  // 19. Oracle log
  const log = await store.all('oracle');
  const whats = new Set(log.map((l) => l.what));
  check('19. Every plan change logged (who/what/when)', ['member.joined', 'plan.extra_site.added', 'plan.extra_site.removed', 'member.cancel.requested', 'member.rejoined'].every((w) => whats.has(w)) && log.every((l) => l.who && l.what && l.when));

  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('TEST CRASHED:', e.type || '', e.message); process.exit(1); });

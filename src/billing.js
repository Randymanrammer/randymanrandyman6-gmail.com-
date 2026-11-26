// Billing: Stripe Checkout, signature-checked webhook, plan limits, extra
// sites, cancel/rejoin, billing page data, refund approval queue.
// Money IN flows automatically. Refunds only run after the owner approves.
const Stripe = require('stripe');
const config = require('./config');
const { store } = require('./store');
const { oracle } = require('./oracle');
const { sendEmail, esc } = require('./email');

let _stripe = null;
function stripe() {
  const k = config.secret('STRIPE_SECRET_KEY');
  if (!k) return null;
  if (!_stripe) {
    const opts = { maxNetworkRetries: 2, appInfo: { name: 'InstantOnlineSuccess' } };
    // Behind an outbound proxy (local testing), use fetch, which honors HTTPS_PROXY.
    if (process.env.HTTPS_PROXY && process.env.NODE_USE_ENV_PROXY) opts.httpClient = Stripe.createFetchHttpClient();
    _stripe = new Stripe(k, opts);
  }
  return _stripe;
}
const connected = () => !!stripe();
const isTestMode = () => (config.secret('STRIPE_SECRET_KEY') || '').startsWith('sk_test_') || (config.secret('STRIPE_SECRET_KEY') || '').startsWith('rk_test_');

const LOOKUP = {
  signup: 'ios_signup_499',
  plan: 'ios_plan_monthly_100',
  extra: 'ios_extra_site_monthly_25',
};

let _prices = null;
async function prices() {
  if (_prices) return _prices;
  const s = stripe();
  const found = await s.prices.list({ lookup_keys: Object.values(LOOKUP), active: true, limit: 10 });
  const by = Object.fromEntries(found.data.map((p) => [p.lookup_key, p]));
  async function ensure(lookup, productName, unit_amount, recurring) {
    if (by[lookup]) return by[lookup];
    const product = await s.products.create({ name: productName });
    return s.prices.create({
      product: product.id, currency: 'usd', unit_amount, lookup_key: lookup,
      ...(recurring ? { recurring: { interval: 'month' } } : {}),
    });
  }
  _prices = {
    signup: await ensure(LOOKUP.signup, 'Instant Online Success membership signup', config.plan.signupCents, false),
    plan: await ensure(LOOKUP.plan, 'Instant Online Success plan (up to 3 sites built and hosted)', config.plan.monthlyCents, true),
    extra: await ensure(LOOKUP.extra, 'Extra site (4th and up)', config.plan.extraSiteCents, true),
  };
  return _prices;
}

const money = (cents) => '$' + (cents / 100).toFixed(2);
const fmtDate = (unix) => (unix ? new Date(unix * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');

// ---------- Checkout ----------
async function createCheckout({ email, member }) {
  const s = stripe();
  const p = await prices();
  const rejoin = !!member;
  const params = {
    mode: 'subscription',
    line_items: [{ price: p.plan.id, quantity: 1 }],
    success_url: `${config.baseUrl}/welcome?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.baseUrl}/${rejoin ? 'dashboard' : ''}`,
    payment_method_collection: 'always',
    allow_promotion_codes: false,
    metadata: { flow: rejoin ? 'rejoin' : 'signup' },
    subscription_data: { metadata: { flow: rejoin ? 'rejoin' : 'signup' } },
  };
  if (rejoin) {
    // Rejoin: no new $4.99 and no new trial; plan starts today, extra sites included.
    const extra = await extraSitesNeeded(member);
    if (extra > 0) params.line_items.push({ price: p.extra.id, quantity: extra });
    params.custom_text = { submit: { message: `$100.00/month starting today${extra ? ` plus $25/month for ${extra} extra site${extra > 1 ? 's' : ''}` : ''}. Cancel anytime online.` } };
    if (member.stripeCustomerId) params.customer = member.stripeCustomerId; else params.customer_email = member.email;
  } else {
    params.line_items.push({ price: p.signup.id, quantity: 1 });
    params.subscription_data.trial_period_days = config.plan.trialDays;
    params.custom_text = { submit: { message: config.disclosure } };
    if (email) params.customer_email = email;
  }
  const session = await s.checkout.sessions.create(params);
  await oracle(email || member?.email || 'visitor', rejoin ? 'checkout.rejoin.started' : 'checkout.signup.started', { checkoutSession: session.id });
  return session;
}

// ---------- Members ----------
async function memberByCustomer(customerId) {
  const r = await store.where('members', 'stripeCustomerId', customerId);
  return r[0] || null;
}
async function memberByEmail(email) {
  const r = await store.where('members', 'email', String(email).toLowerCase());
  return r[0] || null;
}

function periodEnd(sub) {
  const ends = (sub.items?.data || []).map((i) => i.current_period_end).filter(Boolean);
  return ends.length ? Math.min(...ends) : sub.current_period_end || null;
}

function statusFrom(sub) {
  if (['trialing', 'active'].includes(sub.status)) return 'active';
  if (sub.status === 'past_due') return 'past_due';
  if (['canceled', 'unpaid', 'incomplete_expired'].includes(sub.status)) return 'ended';
  return 'incomplete';
}

// Only ever called with a subscription fetched from Stripe or carried by a
// signature-checked webhook - never with browser data.
async function syncSubscription(sub, actor = 'stripe') {
  const customer = typeof sub.customer === 'string' ? await stripe().customers.retrieve(sub.customer) : sub.customer;
  const customerId = customer.id;
  let m = await memberByCustomer(customerId);
  if (!m && customer.email) m = await memberByEmail(customer.email);
  const now = new Date().toISOString();
  const p = await prices();
  const extraItem = (sub.items?.data || []).find((i) => i.price?.id === p.extra.id);
  const patch = {
    email: (customer.email || m?.email || '').toLowerCase(),
    stripeCustomerId: customerId,
    subscriptionId: sub.id,
    subscriptionStatus: sub.status,
    status: statusFrom(sub),
    trialEnd: sub.trial_end || null,
    currentPeriodEnd: periodEnd(sub),
    cancelAtPeriodEnd: !!sub.cancel_at_period_end || !!sub.cancel_at,
    extraSitesBilled: extraItem ? extraItem.quantity : 0,
    updatedAt: now,
  };
  if (sub.status === 'past_due') patch.pastDueSince = m?.pastDueSince || now;
  else patch.pastDueSince = null;
  let changed;
  if (!m) {
    const id = await store.add('members', { ...patch, createdAt: now, settings: {} });
    m = await store.get('members', id);
    changed = 'member.joined';
  } else {
    if (m.subscriptionId && m.subscriptionId !== sub.id && m.status === 'active' && patch.status === 'ended') {
      return m; // an old subscription ending must not override a newer live one
    }
    changed = m.status !== patch.status || m.cancelAtPeriodEnd !== patch.cancelAtPeriodEnd || m.subscriptionId !== sub.id || m.extraSitesBilled !== patch.extraSitesBilled ? 'member.plan.changed' : null;
    if (m.status === 'ended' && patch.status === 'active') changed = 'member.rejoined';
    await store.update('members', m.id, patch);
    m = { ...m, ...patch };
  }
  if (changed) await oracle(actor, changed, { member: m.id, email: m.email, status: m.status, subscriptionStatus: sub.status, cancelAtPeriodEnd: m.cancelAtPeriodEnd, extraSitesBilled: m.extraSitesBilled });
  return m;
}

// Can this member's sites be online right now?
function hostingAllowed(m) {
  if (!m) return false;
  if (m.status === 'active') return true;
  if (m.status === 'past_due' && m.pastDueSince) {
    return Date.now() < new Date(m.pastDueSince).getTime() + config.plan.graceDays * 864e5;
  }
  return false;
}

// ---------- Webhook ----------
function constructEvent(rawBody, signature) {
  const secret = config.secret('STRIPE_WEBHOOK_SECRET');
  if (!secret) { const e = new Error('webhook secret not connected'); e.code = 'not_connected'; throw e; }
  return Stripe.webhooks.constructEvent(rawBody, signature, secret);
}

const invoiceSubId = (inv) => inv.parent?.subscription_details?.subscription || inv.subscription || null;

async function handleEvent(event) {
  if (await store.get('stripe_events', event.id)) return 'duplicate';
  const s = stripe();
  const o = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed': {
      if (o.subscription) await syncSubscription(await s.subscriptions.retrieve(o.subscription), 'stripe:checkout');
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      // Re-fetch so out-of-order events can't leave stale state.
      let sub;
      try { sub = await s.subscriptions.retrieve(o.id); } catch { sub = o; }
      await syncSubscription(sub, 'stripe:' + event.type);
      break;
    }
    case 'invoice.paid': {
      const subId = invoiceSubId(o);
      if (subId) await syncSubscription(await s.subscriptions.retrieve(subId), 'stripe:invoice.paid');
      await store.set('payments', o.id, {
        invoiceId: o.id, customer: o.customer, amountCents: o.amount_paid, currency: o.currency,
        paidAt: new Date((o.status_transitions?.paid_at || event.created) * 1000).toISOString(),
        description: (o.lines?.data || []).map((l) => l.description).join('; '),
        hostedInvoiceUrl: o.hosted_invoice_url || '',
      });
      await oracle('stripe', 'payment.received', { invoice: o.id, amountCents: o.amount_paid, customer: o.customer });
      if (o.amount_paid > 0 && o.customer_email) {
        const lines = (o.lines?.data || []).map((l) => `<li>${esc(l.description)} - ${money(l.amount)}</li>`).join('');
        await sendEmail({
          to: o.customer_email, kind: 'receipt',
          subject: `Receipt: ${money(o.amount_paid)} paid to ${config.brand}`,
          html: `<h2>Thanks - payment received</h2><p>Amount: <b>${money(o.amount_paid)}</b><br>Date: ${fmtDate(o.status_transitions?.paid_at || event.created)}<br>Invoice: ${esc(o.number || o.id)}</p><ul>${lines}</ul>${o.hosted_invoice_url ? `<p><a href="${esc(o.hosted_invoice_url)}">View or download this receipt</a></p>` : ''}<p>Manage billing: <a href="${config.baseUrl}/billing">${config.baseUrl}/billing</a></p>`,
        });
      }
      break;
    }
    case 'invoice.payment_failed': {
      const subId = invoiceSubId(o);
      const m = subId ? await syncSubscription(await s.subscriptions.retrieve(subId), 'stripe:invoice.payment_failed') : await memberByCustomer(o.customer);
      if (m && !m.pastDueSince) await store.update('members', m.id, { pastDueSince: new Date().toISOString() });
      await oracle('stripe', 'payment.failed', { invoice: o.id, amountCents: o.amount_due, customer: o.customer, attempt: o.attempt_count });
      const to = o.customer_email || m?.email;
      if (to) {
        await sendEmail({
          to, kind: 'payment_failed', subject: 'Action needed: update your card',
          html: `<h2>Your payment didn't go through</h2><p>We tried to charge <b>${money(o.amount_due)}</b> and it failed. Stripe will retry automatically.</p><p>Your sites stay online for ${config.plan.graceDays} days while you fix this. After that they pause (nothing is deleted).</p><p><a href="${config.baseUrl}/billing">Update your card</a></p>`,
        });
      }
      break;
    }
    default:
      break;
  }
  await store.set('stripe_events', event.id, { type: event.type, at: new Date().toISOString() });
  return 'ok';
}

// ---------- Plan limits & extra sites ----------
async function activeSites(member) {
  return (await store.where('sites', 'memberId', member.id)).filter((x) => !x.archived);
}
async function extraSitesNeeded(member) {
  return Math.max(0, (await activeSites(member)).length - config.plan.includedSites);
}

// Point the subscription's extra-site item at `qty`. Adding during the free
// 30 days bills from the first $100 bill; adding later charges the prorated
// amount now. Removing never refunds; the $25 stops at the next bill.
async function setExtraSites(member, qty, actor) {
  const s = stripe();
  const p = await prices();
  const sub = await s.subscriptions.retrieve(member.subscriptionId);
  const item = sub.items.data.find((i) => i.price.id === p.extra.id);
  const current = item ? item.quantity : 0;
  if (current === qty) return sub;
  const increasing = qty > current;
  const proration = increasing && sub.status !== 'trialing' ? 'always_invoice' : 'none';
  if (!item) await s.subscriptionItems.create({ subscription: sub.id, price: p.extra.id, quantity: qty, proration_behavior: proration });
  else if (qty === 0) await s.subscriptionItems.del(item.id, { proration_behavior: 'none' });
  else await s.subscriptionItems.update(item.id, { quantity: qty, proration_behavior: proration });
  const fresh = await s.subscriptions.retrieve(sub.id);
  await syncSubscription(fresh, actor);
  await oracle(actor, increasing ? 'plan.extra_site.added' : 'plan.extra_site.removed', { member: member.id, from: current, to: qty, proration });
  return fresh;
}

// ---------- Cancel / resume ----------
async function cancel(member, actor) {
  const sub = await stripe().subscriptions.update(member.subscriptionId, { cancel_at_period_end: true });
  const m = await syncSubscription(sub, actor);
  await oracle(actor, 'member.cancel.requested', { member: member.id, accessUntil: m.trialEnd && sub.status === 'trialing' ? m.trialEnd : m.currentPeriodEnd });
  return m;
}
async function resume(member, actor) {
  const sub = await stripe().subscriptions.update(member.subscriptionId, { cancel_at_period_end: false });
  const m = await syncSubscription(sub, actor);
  await oracle(actor, 'member.cancel.undone', { member: member.id });
  return m;
}

// ---------- Billing page ----------
async function billingSummary(member) {
  const s = stripe();
  const sub = await s.subscriptions.retrieve(member.subscriptionId, { expand: ['default_payment_method'] });
  let next = null;
  if (!sub.cancel_at_period_end && !sub.cancel_at && sub.status !== 'canceled') {
    try {
      const prev = await s.invoices.createPreview({ customer: sub.customer, subscription: sub.id });
      next = { amountCents: prev.amount_due, date: sub.status === 'trialing' ? sub.trial_end : periodEnd(sub) };
    } catch { next = null; }
  }
  let pm = sub.default_payment_method;
  if (!pm) {
    const c = await s.customers.retrieve(sub.customer, { expand: ['invoice_settings.default_payment_method'] });
    pm = c.invoice_settings?.default_payment_method;
  }
  const card = pm && pm.card ? { brand: pm.card.brand, last4: pm.card.last4, exp: `${pm.card.exp_month}/${pm.card.exp_year}` } : null;
  const inv = await s.invoices.list({ customer: sub.customer, limit: 24 });
  return {
    status: sub.status,
    trialEnd: sub.trial_end,
    periodEnd: periodEnd(sub),
    cancelAtPeriodEnd: !!sub.cancel_at_period_end || !!sub.cancel_at,
    items: sub.items.data.map((i) => ({ name: i.price.nickname || (i.price.lookup_key === LOOKUP.extra ? 'Extra site' : 'Plan: up to 3 sites'), quantity: i.quantity, unitCents: i.price.unit_amount })),
    next, card,
    invoices: inv.data.map((i) => ({ id: i.id, number: i.number, date: i.created, amountPaid: i.amount_paid, amountDue: i.amount_due, status: i.status, url: i.hosted_invoice_url, pdf: i.invoice_pdf })),
  };
}

let _portalConfig = null;
async function portalUrl(member) {
  const s = stripe();
  if (!_portalConfig) {
    const existing = await s.billingPortal.configurations.list({ is_default: false, active: true, limit: 20 });
    const mine = existing.data.find((c) => c.metadata?.app === 'ios');
    _portalConfig = mine || await s.billingPortal.configurations.create({
      metadata: { app: 'ios' },
      business_profile: { headline: 'Instant Online Success - billing' },
      features: {
        payment_method_update: { enabled: true },
        invoice_history: { enabled: true },
        customer_update: { enabled: true, allowed_updates: ['email', 'address', 'name'] },
        subscription_cancel: { enabled: false }, // cancel lives in our dashboard so sites/limits stay in sync
      },
    });
  }
  const sess = await s.billingPortal.sessions.create({ customer: member.stripeCustomerId, return_url: `${config.baseUrl}/billing`, configuration: _portalConfig.id });
  return sess.url;
}

// ---------- Refund approval queue ----------
async function requestRefund(member, invoiceId, reason) {
  const inv = await stripe().invoices.retrieve(invoiceId);
  if (inv.customer !== member.stripeCustomerId) throw new Error('That invoice is not yours');
  if (!inv.amount_paid) throw new Error('Nothing was paid on that invoice');
  const dup = (await store.where('approvals', 'invoiceId', invoiceId)).find((a) => a.status === 'pending');
  if (dup) return dup.id;
  const id = await store.add('approvals', {
    type: 'refund', status: 'pending', memberId: member.id, email: member.email,
    invoiceId, amountCents: inv.amount_paid, reason: String(reason || '').slice(0, 1000),
    requestedAt: new Date().toISOString(),
  });
  await oracle(member.email, 'refund.requested', { approval: id, invoiceId, amountCents: inv.amount_paid });
  return id;
}

// Runs ONLY from the owner console after the owner taps Approve.
async function executeApprovedRefund(approval, ownerEmail) {
  const s = stripe();
  const pays = await s.invoicePayments.list({ invoice: approval.invoiceId, limit: 10 });
  const paid = pays.data.find((p) => p.status === 'paid' && p.payment?.payment_intent);
  if (!paid) throw new Error('No refundable payment found on that invoice');
  const pi = typeof paid.payment.payment_intent === 'string' ? paid.payment.payment_intent : paid.payment.payment_intent.id;
  const refund = await s.refunds.create({ payment_intent: pi, amount: approval.amountCents, metadata: { approval: approval.id, approvedBy: ownerEmail } }, { idempotencyKey: 'refund-' + approval.id });
  return refund;
}

module.exports = {
  stripe, connected, isTestMode, prices, money, fmtDate, createCheckout, syncSubscription, hostingAllowed,
  constructEvent, handleEvent, activeSites, extraSitesNeeded, setExtraSites, cancel, resume,
  billingSummary, portalUrl, requestRefund, executeApprovedRefund, memberByEmail, LOOKUP,
};

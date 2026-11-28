// Items 84-86: privacy, terms, refund/cancel policy (footer + checkout),
// cookie note (in the footer: one essential cookie, no tracking), and
// one-tap unsubscribe honored right away.
const config = require('../config');
const { store } = require('../store');
const { oracle } = require('../oracle');
const auth = require('../auth');
const { page, esc } = require('../views');

const P = config.plan;
const $ = (c) => '$' + (c / 100).toFixed(2);

function docs() {
  const addr = config.secret('BUSINESS_MAILING_ADDRESS');
  const contact = `${esc(config.ownerEmail)}${addr ? `, ${esc(addr)}` : ''}`;
  return {
    privacy: ['Privacy policy', `
<p>${esc(config.businessName)} ("we") runs ${esc(config.brand)}. This explains what we collect and why.</p>
<h2>What we collect</h2><ul><li>Your email, and the business details and photos you put in the builder.</li>
<li>Billing is handled by Stripe. We never see or store your full card number.</li>
<li>Messages visitors send through forms on your sites, so we can deliver them to you.</li>
<li>Visit counts per page on your sites (no visitor names, no tracking cookies).</li>
<li>A log of account and plan changes (who, what, when) for security and support.</li></ul>
<h2>How we use it</h2><p>To build and host your sites, bill you, send receipts, reminders and account emails, and keep the service safe. AI features send the text needed for that task to Google's Gemini service from our servers.</p>
<h2>Cookies</h2><p>One essential cookie keeps you signed in. No advertising or tracking cookies.</p>
<h2>Email</h2><p>Account emails (receipts, reminders, sign-in links) are part of the service. Newsletters have an unsubscribe link that works right away.</p>
<h2>Your choices</h2><p>Download your data or ask us to delete your account from your dashboard. Deletion is reviewed and done by a person, then confirmed by email.</p>
<h2>We don't sell your data.</h2><p>Contact: ${contact}</p>`],
    terms: ['Terms of service', `
<h2>Membership and price</h2><p class="price"><b>${esc(config.disclosure)}</b></p>
<ul><li>${$(P.signupCents)} is charged today and makes you a member.</li><li>${$(P.monthlyCents)}/month starts ${P.trialDays} days later and covers building and hosting up to ${P.includedSites} sites.</li>
<li>Each site after ${P.includedSites} is ${$(P.extraSiteCents)}/month on the same bill. You confirm before any extra site is added.</li>
<li>We email a reminder ${P.reminderDaysBefore} days before your first ${$(P.monthlyCents)} charge.</li></ul>
<h2>Your content</h2><p>You own your content. You confirm you have the rights to everything you upload. No fake reviews, fake testimonials, fake badges or claims you can't back up. Paid endorsements and ads must be clearly disclosed. Adult, hateful, scam or illegal content isn't allowed. Our automated Governor checks every site before it publishes and may hold a site for review.</p>
<h2>AI</h2><p>AI suggestions are drafts. You review and approve them. Images made with AI are labeled as AI-made.</p>
<h2>Failed payments</h2><p>Stripe retries the charge and we email you. Your sites stay online for ${P.graceDays} days, then pause until payment works. Nothing is deleted.</p>
<h2>Ending</h2><p>Cancel any time online (see the <a href="/legal/refunds">refund &amp; cancel policy</a>). When a membership ends, sites go offline but are kept, so you can rejoin and get them back.</p>
<p>Contact: ${contact}</p>`],
    refunds: ['Refund & cancel policy', `
<h2>Cancel anytime online</h2><p>Dashboard → Membership → Cancel membership → Yes, cancel. That's it. You keep full access until the end of the period you already paid for, and you are not charged again.</p>
<h2>Refunds</h2><p>Ask from your Billing page (next to any paid invoice). Each request is reviewed by a person and you get an email with the answer. Removing an extra site stops its ${$(P.extraSiteCents)}/month from your next bill.</p>
<h2>After you leave</h2><p>Your sites go offline but are kept. Rejoin from your dashboard to bring back your sites and settings. To delete your data, request deletion from your dashboard.</p>
<p>Contact: ${contact}</p>`],
  };
}

function mount(app) {
  app.get('/legal/:doc', (req, res) => {
    const d = docs()[req.params.doc];
    if (!d) return res.status(404).send(page('Not found', '<h1>Not found</h1>', { user: req.user }));
    res.send(page(d[0], `<h1>${esc(d[0])}</h1><div class="card">${d[1]}</div><p class="mut small">Last updated ${new Date().toISOString().slice(0, 10)}.</p>`, { user: req.user }));
  });
  // Item 86: opt-out honored right away (GET shows a one-tap button; POST is RFC 8058 one-click).
  const unsub = async (req, res) => {
    const p = auth.verify(String(req.query.t || req.body?.t || ''), 'unsub');
    if (!p) return res.status(400).send(page('Unsubscribe', '<p>That link is not valid.</p>'));
    if (req.method === 'GET') return res.send(page('Unsubscribe', `<h1>Unsubscribe</h1><form method="post" action="/unsubscribe"><input type="hidden" name="t" value="${esc(req.query.t)}"><p>Stop newsletters to ${esc(p.email)}?</p><button>Unsubscribe</button></form>`));
    for (const m of await store.where('members', 'email', p.email)) await store.update('members', m.id, { marketingOptOut: new Date().toISOString() });
    await store.set('optouts', Buffer.from(p.email).toString('base64url'), { email: p.email, at: new Date().toISOString() });
    await oracle(p.email, 'email.unsubscribed', {});
    res.send(page('Unsubscribed', '<h1>You are unsubscribed.</h1><p>You will still get receipts and account emails.</p>'));
  };
  app.get('/unsubscribe', unsub);
  app.post('/unsubscribe', unsub);
}

module.exports = { mount };

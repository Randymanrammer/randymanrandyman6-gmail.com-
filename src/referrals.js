// Item 69: referral links. A reward is earned ONLY when the referred member
// pays a real monthly bill (not the $4.99 signup, not a trial $0 invoice).
// Rewards go to the owner's approval queue as a "payout"; on approval the
// referrer gets a Stripe bill credit. Nothing moves without the owner's tap.
const crypto = require('crypto');
const config = require('./config');
const { store } = require('./store');
const { oracle } = require('./oracle');

const REWARD = () => Number(process.env.REFERRAL_CREDIT_CENTS || 2500);

async function codeFor(member) {
  if (member.refCode) return member.refCode;
  const code = crypto.randomBytes(5).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x');
  await store.update('members', member.id, { refCode: code });
  return code;
}
const linkFor = (code) => `${config.baseUrl}/?ref=${encodeURIComponent(code)}`;
const validCode = (c) => /^[a-z0-9_-]{4,20}$/i.test(String(c || ''));

// Called from the signature-checked invoice.paid webhook.
async function onPaid(invoice, member) {
  if (!member?.referredBy || member.referralRewarded) return null;
  if (!invoice.amount_paid || invoice.amount_paid < config.plan.monthlyCents) return null; // the $4.99 signup never counts
  const ref = (await store.where('members', 'refCode', member.referredBy))[0];
  if (!ref || ref.id === member.id) return null;
  await store.update('members', member.id, { referralRewarded: true });
  const id = await store.add('approvals', { type: 'payout', status: 'pending', memberId: ref.id, email: ref.email, amountCents: REWARD(), reason: `Referral: ${member.email} paid their first monthly bill`, referredMemberId: member.id, invoiceId: invoice.id, requestedAt: new Date().toISOString() });
  await oracle('stripe', 'referral.earned', { referrer: ref.id, referred: member.id, approval: id });
  return id;
}

// Runs ONLY after the owner approves.
async function executePayout(approval, ownerEmail) {
  const billing = require('./billing');
  const ref = await store.get('members', approval.memberId);
  if (!ref?.stripeCustomerId) throw new Error('Referrer has no Stripe customer');
  const tx = await billing.stripe().customers.createBalanceTransaction(ref.stripeCustomerId, { amount: -approval.amountCents, currency: 'usd', description: approval.reason, metadata: { approval: approval.id, approvedBy: ownerEmail } }, { idempotencyKey: 'payout-' + approval.id });
  return tx;
}

module.exports = { codeFor, linkFor, validCode, onPaid, executePayout, REWARD };

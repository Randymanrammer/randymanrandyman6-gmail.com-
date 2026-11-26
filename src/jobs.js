// Daily job: 7-day reminder before the first $100 bill, and grace-period pauses.
const config = require('./config');
const { store } = require('./store');
const { oracle } = require('./oracle');
const { sendEmail } = require('./email');
const billing = require('./billing');

async function daily(now = Date.now()) {
  const members = await store.all('members');
  let reminders = 0, paused = 0;
  for (const m of members) {
    if (m.subscriptionStatus === 'trialing' && m.trialEnd && !m.cancelAtPeriodEnd && m.reminderSentFor !== m.trialEnd) {
      const msLeft = m.trialEnd * 1000 - now;
      if (msLeft > 0 && msLeft <= config.plan.reminderDaysBefore * 864e5) {
        const amount = config.plan.monthlyCents + (m.extraSitesBilled || 0) * config.plan.extraSiteCents;
        const r = await sendEmail({
          to: m.email, kind: 'trial_reminder', subject: `Reminder: your first ${billing.money(amount)} bill is on ${billing.fmtDate(m.trialEnd)}`,
          html: `<p>Your first monthly charge of <b>${billing.money(amount)}</b> is on <b>${billing.fmtDate(m.trialEnd)}</b>.</p><p>Don't want it? <a href="${config.baseUrl}/dashboard#cancel">Cancel online here</a> before then and you won't be charged.</p>`,
        });
        if (r.status === 'sent') { await store.update('members', m.id, { reminderSentFor: m.trialEnd }); reminders++; }
      }
    }
    if (m.status === 'past_due' && m.pastDueSince && !billing.hostingAllowed(m) && !m.graceEndNotified) {
      await store.update('members', m.id, { graceEndNotified: new Date(now).toISOString() });
      await oracle('bot:daily', 'sites.paused.payment', { member: m.id });
      await sendEmail({ to: m.email, kind: 'sites_paused', subject: 'Your sites are paused', html: `<p>We couldn't collect your payment, so your sites are paused. Nothing was deleted.</p><p><a href="${config.baseUrl}/billing">Update your card</a> and they come right back.</p>` });
      paused++;
    }
    if (m.status !== 'past_due' && m.graceEndNotified) await store.update('members', m.id, { graceEndNotified: null });
  }
  await oracle('bot:daily', 'bot.ran', { reminders, paused });
  return { reminders, paused };
}

module.exports = { daily };

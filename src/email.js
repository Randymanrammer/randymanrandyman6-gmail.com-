// Email through Resend. If RESEND_API_KEY is missing, emails are recorded
// as "not sent - email not connected" and everything else keeps working.
const config = require('./config');
const { store } = require('./store');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function layout(bodyHtml, { marketing = false, unsubscribeUrl = '' } = {}) {
  const addr = config.secret('BUSINESS_MAILING_ADDRESS');
  const foot = [
    esc(config.businessName),
    addr ? esc(addr) : '',
    marketing && unsubscribeUrl ? `<a href="${esc(unsubscribeUrl)}">Unsubscribe</a>` : '',
  ].filter(Boolean).join('<br>');
  return `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:auto;line-height:1.5;color:#111">
${bodyHtml}
<hr style="border:none;border-top:1px solid #ddd;margin:24px 0">
<p style="font-size:12px;color:#666">${foot}</p></div>`;
}

async function sendEmail({ to, subject, html, kind, marketing = false, unsubscribeUrl = '' }) {
  const record = { to, subject, kind: kind || 'general', at: new Date().toISOString(), status: 'pending' };
  if (marketing && !config.secret('BUSINESS_MAILING_ADDRESS')) {
    record.status = 'blocked: mailing address not set';
    await store.add('emails', record);
    return record;
  }
  const key = config.secret('RESEND_API_KEY');
  if (!key) {
    record.status = 'not sent: email not connected';
    await store.add('emails', record);
    return record;
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.emailFrom, to: [to], subject, html: layout(html, { marketing, unsubscribeUrl }) }),
    });
    record.status = r.ok ? 'sent' : `failed: HTTP ${r.status}`;
  } catch (e) {
    record.status = 'failed: network';
  }
  await store.add('emails', record);
  return record;
}

module.exports = { sendEmail, esc };

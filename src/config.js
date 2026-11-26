// All secret values come from environment variables that Cloud Run fills
// from Google Cloud Secret Manager. Nothing secret lives in this file.
// Never log any value from SECRET_NAMES.
const SECRET_NAMES = [
  'STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET',
  'GEMINI_API_KEY', 'RESEND_API_KEY', 'GITHUB_TOKEN', 'CRON_SECRET',
  'TOKEN_ENCRYPTION_KEY', 'BUSINESS_MAILING_ADDRESS',
];

function val(name) {
  const v = process.env[name];
  if (!v || !String(v).trim() || /^(placeholder|changeme|not-set)$/i.test(String(v).trim())) return '';
  return String(v).trim();
}

const config = {
  businessName: 'Instant Online Success LLC',
  brand: 'Instant Online Success',
  ownerEmail: (process.env.OWNER_EMAIL || 'randymanrandyman6@gmail.com').toLowerCase(),
  domain: process.env.DOMAIN || 'success-domain.com',
  baseUrl: (process.env.BASE_URL || 'http://localhost:8080').replace(/\/$/, ''),
  emailFrom: process.env.EMAIL_FROM || 'Instant Online Success <hello@success-domain.com>',
  store: process.env.STORE || (process.env.K_SERVICE ? 'firestore' : 'memory'),
  port: Number(process.env.PORT || 8080),
  // Plan numbers (shown to members exactly as below)
  plan: {
    signupCents: 499,
    monthlyCents: 10000,
    extraSiteCents: 2500,
    includedSites: 3,
    trialDays: 30,
    graceDays: 7,
    reminderDaysBefore: 7,
  },
  secret: val,
  has: (name) => !!val(name),
  SECRET_NAMES,
};

config.disclosure =
  '$4.99 today, then $100.00/month starting 30 days later, plus $25/month per site after 3. Cancel anytime online.';

module.exports = config;

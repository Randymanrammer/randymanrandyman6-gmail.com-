// The pricing page lists a feature as included ONLY when:
//   tested: true  - the matching automated test passed (see test/README.md), AND
//   every key in `needs` is connected in Secret Manager / env.
// Otherwise it shows "Coming soon" (not built/tested) or "Not connected" (built,
// tested, waiting on a key or setup step).
const config = require('./config');

const F = (id, label, tested, needs = [], env = []) => ({ id, label, tested, needs, env });
const features = [
  F('signup', 'Sign up online: $4.99 today, first $100 bill 30 days later', true, ['STRIPE_SECRET_KEY']),
  F('sites3', 'Up to 3 sites built and hosted on the $100 plan', true, ['STRIPE_SECRET_KEY']),
  F('extra', 'Extra sites: $25/month each, add or remove anytime', true, ['STRIPE_SECRET_KEY']),
  F('cancel', 'Cancel online in 2 taps; access stays until your paid period ends', true, ['STRIPE_SECRET_KEY']),
  F('billing', 'Billing page: next bill, card on file, past invoices', true, ['STRIPE_SECRET_KEY']),
  F('rejoin', 'Rejoin anytime and get your sites back', true, ['STRIPE_SECRET_KEY']),
  F('builder', 'Site builder: chat + live preview, tap to edit, undo/redo, version history', true),
  F('pages', 'Home, About, Services, Contact pages (plus Menu, Booking, FAQ when they fit) from your real details', true),
  F('sections', 'Add, move or remove sections: hero, gallery, services, pricing, map, FAQ, real reviews', true),
  F('forms', 'Contact, quote and booking forms to your dashboard and email', true),
  F('images', 'Photo upload with crop, resize and auto-compress', true),
  F('templates', '10 starter templates, brand kit, light and dark mode', true),
  F('a11y', 'Accessible and fast by default, checked on every publish', true),
  F('hosting', 'Hosting included, with backup address success-domain.com/s/your-site', true),
  F('subdomain', 'Free address: your-site.success-domain.com', true, [], ['SUBDOMAINS_LIVE']),
  F('domains', 'Custom domains with step-by-step DNS help', true, [], ['LB_IP']),
  F('backups', 'Daily backups with one-tap restore', true),
  F('seo', 'sitemap.xml, robots.txt, meta tags, custom 404 and redirects', true),
  F('export', 'Export your site\'s code to your own GitHub', true, ['TOKEN_ENCRYPTION_KEY']),
  F('ai', 'AI writer, FAQ builder, Spanish version, social posts, AI images (you approve every change)', true, ['GEMINI_API_KEY']),
  F('assistant', 'AI assistant on your site (labeled as AI)', true, ['GEMINI_API_KEY']),
  F('stats', 'Real visitor stats and leads inbox with email alerts', true),
  F('google', 'Sign in with Google', true, [], ['FIREBASE_API_KEY', 'FIREBASE_PROJECT_ID']),
  F('referral', 'Referral link: bill credit when a friend becomes a paying member', true, ['STRIPE_SECRET_KEY']),
  F('bots', 'Uptime, backup and security bots watching every site', true),
  F('support', '24/7 AI support with hand-off to a person', true, ['GEMINI_API_KEY']),
];

function isLive(f) {
  return f.tested && f.needs.every((n) => config.has(n)) && f.env.every((n) => !!process.env[n]);
}
function state(f) { return isLive(f) ? 'live' : f.tested ? 'not_connected' : 'soon'; }

module.exports = features;
module.exports.isLive = isLive;
module.exports.state = state;

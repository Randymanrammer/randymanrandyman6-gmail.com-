// The pricing page lists a feature as included ONLY when tested:true.
// tested flips to true only after the matching automated test passes
// (see test/README.md for the run log). Everything else shows "Coming soon".
module.exports = [
  { id: 'signup', label: 'Sign up online: $4.99 today, first $100 bill 30 days later', tested: true },
  { id: 'sites3', label: 'Up to 3 sites built and hosted on the $100 plan', tested: true },
  { id: 'extra', label: 'Extra sites: $25/month each, add or remove anytime', tested: true },
  { id: 'cancel', label: 'Cancel online in 2 taps; access stays until your paid period ends', tested: true },
  { id: 'billing', label: 'Billing page: next bill, card on file, past invoices', tested: true },
  { id: 'rejoin', label: 'Rejoin anytime and get your sites back', tested: true },
  { id: 'builder', label: 'AI site builder with live preview', tested: false },
  { id: 'templates', label: 'Starter templates and brand kit', tested: false },
  { id: 'domains', label: 'Free [your-site].success-domain.com address and custom domains', tested: false },
  { id: 'ai', label: 'AI writer, AI images, Spanish version, social posts', tested: false },
  { id: 'stats', label: 'Visitor stats and leads inbox', tested: false },
  { id: 'bots', label: 'Uptime, backup and security bots', tested: false },
];

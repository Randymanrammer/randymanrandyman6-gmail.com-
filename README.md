# Instant Online Success - website builder

Node.js app for Google Cloud Run. Data in Firestore ("the Oracle" log lives in the `oracle` collection).
All keys come from Google Cloud Secret Manager. None are in this repo.

Built: all 100 items (signup & billing, plan limits, builder, templates, hosting & domains,
AI helpers, dashboard & Oracle, bots, Governor & compliance, owner controls). See `test/README.md`.

Deploy (paste into Cloud Shell, in order):
1. `deploy/1-of-3-setup.sh` - turns on Google Cloud services, saves your keys in Secret Manager
2. `deploy/2-of-3-deploy.sh` - deploys the app, connects the Stripe webhook, schedules the bots
3. `deploy/3-of-3-domain.sh` - success-domain.com + [site].success-domain.com with HTTPS, CDN,
   Firestore backups, budget alerts. Run it once, add the DNS records it prints, run it again.

Optional settings (Cloud Run environment variables, not secrets):
`FIREBASE_API_KEY`, `FIREBASE_PROJECT_ID` (Google sign-in), `BUILD_RECORDS_REPO`, `AI_MONTHLY_CREDITS` (300),
`AI_BUDGET_USD` (50), `REFERRAL_CREDIT_CENTS` (2500), `TAX_SET_ASIDE_PCT` (25), `PAGESPEED_API_KEY`.

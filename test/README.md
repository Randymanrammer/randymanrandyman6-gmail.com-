# Test log

## Item 20 test - 2026-11-26 - Stripe TEST mode - 45/45 passed
Re-run 2026-11-27 after items 21-100 were added: 45/45 passed.
`STRIPE_SECRET_KEY=<test key> npm run test:item20`

Covers: disclosure + unchecked "I agree", Checkout ($4.99 one-time + $100/month, 30-day start),
$4.99 charged, forged webhook rejected, signed webhooks turn membership on, receipt email generated,
build + publish a site, 3-site meter, 4th site "$25/month" confirm, $25 item on the same subscription,
billing page (next charge $125.00, card, invoices, Customer Portal), refund request waits in owner queue
(nothing refunded), removing the extra site stops its $25, 7-day reminder, 2-tap cancel with access kept,
membership end takes sites offline but keeps them, rejoin brings them back, 7-day failed-payment grace,
Oracle logs every plan change.

Limits of this run: Stripe's hosted card page can't be driven from the test machine, so the paid
subscription was created with Stripe's test card through the API using the same prices and trial.

## Items 21-100 test - 2026-11-27 - 138/138 passed
`STRIPE_SECRET_KEY=<test key> npm run test:items21-100`

Runs the real app on a local port. The builder UI is driven in a real Chromium browser (chat updates
the live preview, tap-to-edit, undo/redo, photo crop 16:9 + resize to 1600px + compress, phone tabs,
no sideways scroll at 360/768/1280px). Stripe items run against REAL Stripe TEST mode: referral payout
as a bill credit after owner approval, payment-check bot mismatch flag, live numbers, tax bot.

Covers items 21-44 and 46-100. Not covered by this test: item 45 (HTTPS certificates), which is
Google Cloud setup done by deploy/3-of-3-domain.sh. That script was syntax-checked but not run
against a real Google Cloud project from here.

Stand-ins used (outside services that need your keys): Gemini + Imagen, GitHub, Resend email,
Firebase (Google sign-in) certificates, IndexNow, PageSpeed. The stand-ins check what the app sends
(for example: the AI key is only sent from the server, the GitHub token is the member's own).
The first real call to each of those services happens after you add its key.

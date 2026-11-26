# Test log

## Item 20 test - 2026-11-26 - Stripe TEST mode - 45/45 passed
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
Emails were generated but not sent (Resend not connected yet).

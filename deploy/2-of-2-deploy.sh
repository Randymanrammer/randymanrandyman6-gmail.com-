# INSTANT ONLINE SUCCESS - Cloud Shell script 2 of 2 (deploy + webhook + daily job)
set -e
P=$(gcloud config get-value project 2>/dev/null); R=us-central1; S=instant-online-success; SA=ios-app@$P.iam.gserviceaccount.com
gcloud iam service-accounts describe $SA >/dev/null 2>&1 || gcloud iam service-accounts create ios-app --display-name="Instant Online Success app"
for ROLE in roles/secretmanager.secretAccessor roles/datastore.user; do gcloud projects add-iam-policy-binding $P --member=serviceAccount:$SA --role=$ROLE --condition=None >/dev/null; done
B=claude/site-review-gr7eri
if [ ! -d ~/ios-app ]; then git clone https://github.com/Randymanrammer/randymanrandyman6-gmail.com-.git ~/ios-app; fi
git -C ~/ios-app fetch origin $B && git -C ~/ios-app checkout -B $B FETCH_HEAD
cd ~/ios-app
SEC=""; for N in STRIPE_SECRET_KEY STRIPE_PUBLISHABLE_KEY STRIPE_WEBHOOK_SECRET GEMINI_API_KEY RESEND_API_KEY GITHUB_TOKEN CRON_SECRET TOKEN_ENCRYPTION_KEY BUSINESS_MAILING_ADDRESS; do SEC="$SEC,$N=$N:latest"; done
gcloud run deploy $S --source . --region $R --service-account $SA --allow-unauthenticated --set-secrets "${SEC#,}" --set-env-vars STORE=firestore,DOMAIN=success-domain.com --quiet
URL=$(gcloud run services describe $S --region $R --format='value(status.url)')
gcloud run services update $S --region $R --update-env-vars BASE_URL=$URL --quiet
SK=$(gcloud secrets versions access latest --secret=STRIPE_SECRET_KEY)
WH=$(gcloud secrets versions access latest --secret=STRIPE_WEBHOOK_SECRET)
if [[ $SK == sk_test_* || $SK == rk_test_* ]] && [ "$WH" = not-set ]; then
  W=$(curl -s https://api.stripe.com/v1/webhook_endpoints -u "$SK:" -d url="$URL/webhooks/stripe" -d description="Instant Online Success" \
    -d "enabled_events[]=checkout.session.completed" -d "enabled_events[]=customer.subscription.created" -d "enabled_events[]=customer.subscription.updated" \
    -d "enabled_events[]=customer.subscription.deleted" -d "enabled_events[]=invoice.paid" -d "enabled_events[]=invoice.payment_failed" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("secret",""))')
  if [ -n "$W" ]; then printf %s "$W" | gcloud secrets versions add STRIPE_WEBHOOK_SECRET --data-file=- >/dev/null; echo "Stripe webhook connected"; else echo "Stripe webhook NOT created"; fi
  gcloud run services update $S --region $R --update-labels=refreshed=$(date +%s) --quiet
fi
SK=""; W=""; WH=""
CS=$(gcloud secrets versions access latest --secret=CRON_SECRET)
if gcloud scheduler jobs describe ios-daily --location $R >/dev/null 2>&1; then
  gcloud scheduler jobs update http ios-daily --location $R --schedule="17 14 * * *" --uri="$URL/cron/daily" --http-method=POST --update-headers="X-Cron-Secret=$CS" --quiet >/dev/null
else
  gcloud scheduler jobs create http ios-daily --location $R --schedule="17 14 * * *" --uri="$URL/cron/daily" --http-method=POST --headers="X-Cron-Secret=$CS" --quiet >/dev/null
fi
CS=""
echo "DONE 2 of 2. Your site: $URL"

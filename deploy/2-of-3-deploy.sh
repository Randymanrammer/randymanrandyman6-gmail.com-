# INSTANT ONLINE SUCCESS - Cloud Shell script 2 of 3 (deploy + webhook + bots)
set -e
P=$(gcloud config get-value project 2>/dev/null); R=us-central1; S=instant-online-success; SA=ios-app@$P.iam.gserviceaccount.com; B=ccr-ec0307f1-4oxyza
gcloud iam service-accounts describe $SA >/dev/null 2>&1 || gcloud iam service-accounts create ios-app --display-name="Instant Online Success app"
for ROLE in roles/secretmanager.secretAccessor roles/datastore.user roles/certificatemanager.editor; do gcloud projects add-iam-policy-binding $P --member=serviceAccount:$SA --role=$ROLE --condition=None >/dev/null; done
if [ -d ~/ios-app/.git ]; then git -C ~/ios-app fetch -q origin $B && git -C ~/ios-app checkout -q -B $B FETCH_HEAD; else git clone -q -b $B https://github.com/Randymanrammer/randymanrandyman6-gmail.com-.git ~/ios-app; fi
cd ~/ios-app
SEC=""; for N in STRIPE_SECRET_KEY STRIPE_PUBLISHABLE_KEY STRIPE_WEBHOOK_SECRET GEMINI_API_KEY RESEND_API_KEY GITHUB_TOKEN CRON_SECRET TOKEN_ENCRYPTION_KEY BUSINESS_MAILING_ADDRESS; do SEC="$SEC,$N=$N:latest"; done
gcloud run deploy $S --source . --region $R --service-account $SA --allow-unauthenticated --set-secrets "${SEC#,}" \
  --update-env-vars STORE=firestore,DOMAIN=success-domain.com,GOOGLE_CLOUD_PROJECT=$P,BUILD_RECORDS_REPO=Randymanrammer/ios-build-records --quiet
URL=$(gcloud run services describe $S --region $R --format='value(status.url)')
CUR=$(gcloud run services describe $S --region $R --format=json | python3 -c 'import sys,json;e=json.load(sys.stdin)["spec"]["template"]["spec"]["containers"][0].get("env",[]);print(next((x.get("value","") for x in e if x["name"]=="BASE_URL"),""))')
[[ $CUR == https://success-domain.com ]] || gcloud run services update $S --region $R --update-env-vars BASE_URL=$URL --quiet
[[ $CUR == https://success-domain.com ]] && URL=$CUR
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
job(){ if gcloud scheduler jobs describe $1 --location $R >/dev/null 2>&1; then gcloud scheduler jobs update http $1 --location $R --schedule="$2" --uri="$3" --http-method=POST --update-headers="X-Cron-Secret=$CS" --quiet >/dev/null
  else gcloud scheduler jobs create http $1 --location $R --schedule="$2" --uri="$3" --http-method=POST --headers="X-Cron-Secret=$CS" --quiet >/dev/null; fi; echo "bot $1: $2"; }
job ios-daily "17 14 * * *" "$URL/cron/daily"
while read -r N C; do job ios-$N "$C" "$URL/cron/bot/$N"; done <<'J'
uptime */5 * * * *
backup 7 3 * * *
security 13 * * * *
payments 23 4 * * *
meta 37 5 * * *
links 41 6 * * 0
indexer 29 * * * *
cost 47 7 * * *
owner_digest 3 12 * * *
newsletter 11 15 * * 2
supervisor */15 * * * *
J
CS=""
echo "DONE 2 of 3. Your site: $URL  (script 3 = your own domain + HTTPS)"

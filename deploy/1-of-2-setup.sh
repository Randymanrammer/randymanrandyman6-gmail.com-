# INSTANT ONLINE SUCCESS - Cloud Shell script 1 of 2 (setup + secrets)
set -e
P=$(gcloud config get-value project 2>/dev/null)
if [ -z "$P" ]; then read -rp "Google Cloud project ID: " P; gcloud config set project "$P"; fi
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com firestore.googleapis.com cloudscheduler.googleapis.com
gcloud firestore databases describe --database="(default)" >/dev/null 2>&1 || gcloud firestore databases create --location=nam5 --type=firestore-native
put(){ if gcloud secrets describe "$1" >/dev/null 2>&1; then printf %s "$2" | gcloud secrets versions add "$1" --data-file=- >/dev/null; else printf %s "$2" | gcloud secrets create "$1" --data-file=- --replication-policy=automatic >/dev/null; fi; echo "saved $1"; }
for N in CRON_SECRET TOKEN_ENCRYPTION_KEY; do
  if gcloud secrets describe $N >/dev/null 2>&1; then echo "kept $N"; else put $N "$(openssl rand -hex 32)"; fi
done
for N in STRIPE_SECRET_KEY STRIPE_PUBLISHABLE_KEY RESEND_API_KEY GEMINI_API_KEY GITHUB_TOKEN BUSINESS_MAILING_ADDRESS; do
  read -rsp "Paste $N then Enter (or just Enter to skip): " V; echo
  if [ "$N" = STRIPE_SECRET_KEY ] && [ -n "$V" ] && [[ $V != sk_test_* && $V != rk_test_* ]]; then echo "NOT saved: use the TEST key (sk_test_...) until go-live"; V=""; fi
  if [ -n "$V" ]; then put $N "$V"; elif ! gcloud secrets describe $N >/dev/null 2>&1; then put $N not-set; fi
done
V=""
gcloud secrets describe STRIPE_WEBHOOK_SECRET >/dev/null 2>&1 || put STRIPE_WEBHOOK_SECRET not-set
echo "DONE 1 of 2. Now paste script 2 of 2."

# Rotate BOT_SHARED_KEY (paste into Cloud Shell). Deletes nothing.
# Step 1 (now): new key goes first, old key still accepted. Redeploys the builder so it picks it up.
# Step 2 (after every service has redeployed): run with "finish" to drop the old key.
set -e
P=$(gcloud config get-value project 2>/dev/null); R=us-central1; S=instant-online-success
CUR=$(gcloud secrets versions access latest --secret=BOT_SHARED_KEY)
if [ "$1" = "finish" ]; then
  printf '%s' "${CUR%%,*}" | gcloud secrets versions add BOT_SHARED_KEY --data-file=- --quiet >/dev/null
  echo "Old key dropped."
else
  printf '%s,%s' "$(openssl rand -hex 32)" "${CUR%%,*}" | gcloud secrets versions add BOT_SHARED_KEY --data-file=- --quiet >/dev/null
  echo "New key added (old one still accepted)."
fi
unset CUR
gcloud run services update $S --region $R --update-secrets BOT_SHARED_KEY=BOT_SHARED_KEY:latest --quiet >/dev/null
echo "Builder restarted with the new key. Redeploy the other services, then run: bash rotate-bot-key.sh finish"

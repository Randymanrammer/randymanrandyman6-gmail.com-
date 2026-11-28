# INSTANT ONLINE SUCCESS - owner lock for every bot panel (paste once into Cloud Shell)
# Redeploys: 1) website builder owner console  2) Cotexcontent bot.
# Deletes nothing. Touches no payments. Run it while signed in to Cloud Shell as the owner.
set -e
P=$(gcloud config get-value project 2>/dev/null); R=us-central1
[ -n "$P" ] || { echo "Pick your project first: gcloud config set project YOUR_PROJECT_ID"; exit 1; }
echo "Project: $P"

# ---- 1. Website builder ----
S=instant-online-success
if gcloud run services describe $S --region $R >/dev/null 2>&1; then
  FB=$(gcloud run services describe $S --region $R --format=json | jq -r '.spec.template.spec.containers[0].env[]? | select(.name=="FIREBASE_PROJECT_ID") | .value')
  if [ -z "$FB" ]; then
    echo "SKIPPED website builder: Google sign-in (FIREBASE_API_KEY, FIREBASE_PROJECT_ID) is not set,"
    echo "so the new lock would keep you out too. Nothing changed there."
  else
    rm -rf ~/ios-lock && git clone -q -b ccr-4055601e-b8yt00 https://github.com/Randymanrammer/randymanrandyman6-gmail.com-.git ~/ios-lock
    bash ~/ios-lock/deploy/2-of-3-deploy.sh
  fi
else
  echo "SKIPPED website builder: service '$S' not found in $P/$R."
fi

# ---- 2. Cotexcontent bot ----
if gcloud run services describe cotexcontent-bot --region $R >/dev/null 2>&1; then
  rm -rf ~/cotex-lock && git clone -q -b ccr-4055601e-b8yt00 https://github.com/Randymanrammer/Cotexcontent-bot.claud.git ~/cotex-lock
  (cd ~/cotex-lock && bash deploy.sh)
else
  echo "SKIPPED Cotexcontent bot: not found in $P/$R."
fi
echo "Finished. Open each console URL and sign in with Google."

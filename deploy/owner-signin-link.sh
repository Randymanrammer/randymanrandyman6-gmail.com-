# INSTANT ONLINE SUCCESS - Cloud Shell: get a one-time owner sign-in link
# Use this when email (Resend) isn't connected yet. Run it after script 2 of 2.
# The link works once, for 20 minutes. Don't share it.
set -e
R=us-central1; S=instant-online-success
cd ~/ios-app
URL=$(gcloud run services describe $S --region $R --format='value(status.url)')
OWNER=$(gcloud run services describe $S --region $R --format=json | python3 -c 'import sys,json;e=json.load(sys.stdin)["spec"]["template"]["spec"]["containers"][0].get("env",[]);print(next((x.get("value","") for x in e if x["name"]=="OWNER_EMAIL"),""))')
K=$(gcloud secrets versions access latest --secret=TOKEN_ENCRYPTION_KEY)
T=$(STORE=memory OWNER_EMAIL="$OWNER" TOKEN_ENCRYPTION_KEY="$K" node -e "const c=require('./src/config');process.stdout.write(encodeURIComponent(require('./src/auth').loginLinkToken(c.ownerEmail)))")
K=""
echo "Open this link on your phone within 20 minutes:"
echo "$URL/login/verify?token=$T"

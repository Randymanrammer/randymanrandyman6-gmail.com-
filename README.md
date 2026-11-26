# Instant Online Success - website builder

Node.js app for Google Cloud Run. Data in Firestore ("the Oracle" log lives in the `oracle` collection).
All keys come from Google Cloud Secret Manager. None are in this repo.

Built so far: items 1-20 (signup & billing, plan limits & extra sites). See `test/README.md`.

Deploy: paste `deploy/1-of-2-setup.sh`, then `deploy/2-of-2-deploy.sh`, into Cloud Shell.

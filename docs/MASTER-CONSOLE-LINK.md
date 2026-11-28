# Master Bot Console link (ios-link-v1)

The website builder serves `GET /link/v1/bots`. It shows which bots are live and which have stopped.
Only callers that sign with `BOT_SHARED_KEY` (from Google Cloud Secret Manager) get an answer.

## Paste this into the Master Bot Console app in AI Studio

```
FIX ONLY. Connect to the website builder bot status using this exact protocol. Do not change the design.

1. SERVER SIDE ONLY. Make the call from the server (Express/Cloud Run), never from the browser. The key never goes to the browser.
2. KEY: read BOT_SHARED_KEY from the environment (Cloud Run fills it from Google Cloud Secret Manager). It may hold "new,old" separated by a comma: sign with the FIRST one, accept answers signed with ANY of them. Never show, log, or print any part of any key. On the status card show only CONNECTED or NOT CONNECTED.
3. URL: PLATFORM2_URL + "/link/v1/bots". Refuse to call if PLATFORM2_URL does not start with https://.
4. SIGN THE REQUEST. Make these headers:
   x-ios-caller: master-bot-console
   x-ios-timestamp: current Unix time in seconds (10 digits)
   x-ios-nonce: 32 random hex characters (crypto.randomBytes(16)), new for every call
   x-ios-signature: base64url( HMAC-SHA256( key, lines joined with "\n" ) ) where the lines are:
     "ios-link-v1", "GET", "/link/v1/bots", caller, timestamp, nonce, sha256hex("")
5. CHECK THE ANSWER before trusting it. Compute
     base64url( HMAC-SHA256( key, ["ios-link-v1","response","/link/v1/bots", <x-ios-timestamp response header>, <your nonce>, sha256hex(<raw response body>)].join("\n") ) )
   It must equal the x-ios-signature response header (timing-safe compare), and the timestamp must be within 5 minutes. If not, show "NOT VERIFIED" in red and ignore the data.
6. SHOW: for each item in "bots": name, LIVE (green) or STOPPED (red) with its "reason", and "lastRun". Show the "live" and "stopped" totals. Refresh every 60 seconds. No made-up numbers: if the call fails, show "NOT CONNECTED".
7. OWNER ONLY: every page and API of this console checks the signed-in Google account ON THE SERVER. Only the owner account gets in; everyone else gets 404. Remove any passcode login.
8. Use the same protocol for OVERSEER_A_URL and OVERSEER_B_URL when they offer /link/v1/bots (caller names: overseer-a, overseer-b).
9. Remove ORACLE_URL. The Oracle is the Firestore "oracle" collection.
```

## Key rotation
`deploy/rotate-bot-key.sh` adds a new key in front of the old one ("new,old") and restarts the builder.
After every service has redeployed, run it with `finish` to drop the old key. Nothing is deleted.

## Data at rest
Firestore and Secret Manager encrypt everything at rest with AES-256 (Google-managed keys).
Tokens that members give us are also sealed in the app with AES-256-GCM (`src/secretbox.js`).

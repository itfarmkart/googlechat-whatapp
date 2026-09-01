# Deploying to Vercel

The relay runs as one Vercel function (`api/index.js` mounts the Express app;
`vercel.json` rewrites every path to it). Because Vercel is serverless:

- the route store is **MySQL** (auto-creates a `routes` table on first use),
- Workspace Events arrive as **Pub/Sub push** to `/pubsub` (not a pull listener),
- the two schedulers run from **GitHub Actions** (`.github/workflows/relay-cron.yml`).

## 1. Environment variables (Vercel → Project → Settings → Environment Variables)

| Var | Value |
|---|---|
| `GOOGLE_CREDENTIALS_JSON` | the whole `service-account.json`, one line (or base64 of it) |
| `GOOGLE_PROJECT_NUMBER` | `378537659768` |
| `GOOGLE_IMPERSONATE_USER` | `it@farmkart.com` |
| `PERISKOPE_API_KEY` / `PERISKOPE_PHONE` / `PERISKOPE_SIGNING_KEY` | from `.env` |
| `PROVISION_TOKEN` | from `.env` (GitHub Actions uses the same value) |
| `DATABASE_URL` | `mysql://user:pass@host:3306/dbname` — your MySQL, reachable from the public internet / Vercel |
| `MYSQL_SSL` | `1` if your MySQL requires TLS |
| `PUBSUB_PUSH_SA` | `whatapp@whatapp-506816.iam.gserviceaccount.com` |
| `SHEET_ID` | `18zOEIFjxu9pmR7tc_EPMOR-qovmVw3yVbSgUAK5H5QE` |
| `SHEET_DRY_RUN` | `1` at first — remove to go live |

(Don't set `GOOGLE_KEY_FILE`, `PORT`, `STORE_FILE` on Vercel.)

## 2. Point Pub/Sub at the deployment

Switch the existing `chat-events-sub` from pull to push:

```
gcloud pubsub subscriptions modify-push-config chat-events-sub \
  --push-endpoint=https://<app>.vercel.app/pubsub \
  --push-auth-service-account=whatapp@whatapp-506816.iam.gserviceaccount.com
```

Pub/Sub's own service agent needs permission to mint the push token — run once:

```
PROJECT_NUMBER=378537659768
gcloud iam service-accounts add-iam-policy-binding \
  whatapp@whatapp-506816.iam.gserviceaccount.com \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"
```

## 3. Repoint the webhooks (one time — the URL is now permanent)

- **Periskope** → Webhooks → `https://<app>.vercel.app/periskope`
- **Google Chat API → Configuration → HTTP endpoint URL** → `https://<app>.vercel.app/gchat`

## 4. GitHub Actions cron

Repo → Settings → Secrets and variables → Actions → add:

- `RELAY_URL` = `https://<app>.vercel.app` (no trailing slash)
- `PROVISION_TOKEN` = same as the Vercel env var

The workflow renews the Workspace Events subscription hourly and syncs the sheet
at 06:30 & 18:30 UTC (00:00 & 12:00 IST). Trigger it once manually
(Actions tab → relay-cron → Run workflow) to create the Events subscription.

## 5. Verify, then clean up

```
curl https://<app>.vercel.app/health           # {"ok":true,"routes":N}
curl -X POST https://<app>.vercel.app/renew -H "x-provision-token: <token>"
```

Send a Chat message in a live space → check WhatsApp. Then **delete the old
service-account JSON key** in the Cloud console (Service Accounts → Keys) — the
deployment authenticates from `GOOGLE_CREDENTIALS_JSON`, and that key was pasted
around during setup.

## Local dev is unchanged

`node --env-file=.env server.js` still runs everything with the JSON-file store
and the Pub/Sub *pull* listener (`npm test` = 48 tests).

# Customer relay — Google Chat ↔ WhatsApp

One Google Chat space per customer. Team leads talk in the space; the customer
sees it on WhatsApp. Customer replies land back in the space.

The customer is **not** a member of the Chat space. They don't need a Google
account, and internal notes stay internal.

```
team leads ──▶ Chat space ──▶ /gchat ──▶ Periskope ──▶ customer WhatsApp
team leads ◀── Chat space ◀── /periskope ◀── Periskope ◀── customer WhatsApp
```

## Files

| File | Purpose |
|---|---|
| `server.js` | The relay. Both directions plus a provisioning endpoint. |
| `provision.js` | Creates a space for one customer, adds leads, saves mapping. |
| `clients.js` | Google Chat and Periskope API wrappers. |
| `store.js` | Space ↔ WhatsApp mapping (JSON file). |

## Setup

### 1. Google Cloud

1. New project → enable **Google Chat API**.
2. Chat API → Configuration:
   - App name, avatar, description
   - **Interactive features** on
   - **Receive 1:1 messages** off, **Join spaces and group conversations** on
   - Connection: **HTTP endpoint URL** → `https://your-host/gchat`
   - Visibility: your Workspace domain
3. Create a service account, download the JSON key as `service-account.json`.
4. Note the **project number** — the relay uses it to verify inbound calls.

### 2. Domain-wide delegation

Space creation needs a real user identity. Admin console → Security → API
controls → Domain-wide delegation → add the service account client ID with:

```
https://www.googleapis.com/auth/chat.spaces.create
https://www.googleapis.com/auth/chat.memberships
https://www.googleapis.com/auth/chat.memberships.app
```

Then set `GOOGLE_IMPERSONATE_USER` to an ops account that will show as the
space creator.

### 3. Periskope

1. Connect the customer-facing number (QR scan). Use a dedicated number, not
   anyone's personal phone.
2. Settings → Integrations → API → generate key.
3. Settings → Integrations → Webhooks → add `https://your-host/periskope`,
   subscribe to **message.created**, generate a signing key.

### 4. Env

```bash
GOOGLE_KEY_FILE=./service-account.json
GOOGLE_PROJECT_NUMBER=123456789012
GOOGLE_IMPERSONATE_USER=ops@farmkart.com

PERISKOPE_API_KEY=pk_live_...
PERISKOPE_PHONE=919876543210
PERISKOPE_SIGNING_KEY=...

PROVISION_TOKEN=some-long-random-string
PORT=8080
```

### 5. Run

```bash
npm install
node server.js          # or: node --env-file=.env server.js  (Node 20+)
```

`PROVISION_TOKEN` is **required** — `/provision` returns 503 until it is set.
Copy `.env.example` to `.env` for the full list.

Deploy to Cloud Run — same GCP project, always-on, https by default.

### Tests

```bash
npm test                # all — pure logic + local relay, no network
npm run test:store      # store.js only
npm run test:local      # boots the server, stubs Google/Periskope
```

`SKIP_GCHAT_AUTH=1` bypasses Google Chat token verification for local runs.
Never set it in a deployed environment.

## Creating a customer channel

From the CLI:

```bash
node provision.js --name "Ramesh Patidar" --phone 919876543210 \
                  --dept solar --ref RS-2041
```

From your CRM, when an order is confirmed:

```bash
curl -X POST https://your-host/provision \
  -H 'x-provision-token: ...' -H 'Content-Type: application/json' \
  -d '{"name":"Ramesh Patidar","phone":"919876543210","dept":"solar","ref":"RS-2041"}'
```

Edit `TEAM_LEADS` in `provision.js` to set who joins which department's spaces.

## Behaviour

- Every message in the space goes to the customer, signed with the sender's
  first name.
- A line starting with `//` stays internal.
- Customer messages appear in the space prefixed with their name.
- Media from WhatsApp posts as a link, not an inline attachment.

## Before you go live

- **Space names must be unique** across the Workspace. The `--ref` argument
  keeps them so — use the order or lead ID, not just the customer name.
- **Number safety.** Periskope drives a real WhatsApp number, so mass
  provisioning on a fresh SIM gets it banned. Warm the number up first and
  keep first-contact volume low.
- **First contact.** WhatsApp treats unsolicited messages from an unknown
  number harshly. Have the customer message you first where possible, or send
  the opening message from a warmed number.
- **Space sprawl.** A space per customer means hundreds of spaces for the team
  leads. Archive on order completion, or scope this to active projects only.
- **Attribution.** The customer sees one number for everyone. Decide whether
  the first-name signature is what you want before rolling out.

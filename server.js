/**
 * Relay server.
 *
 *   POST /gchat              Google Chat app endpoint  (team lead -> customer)
 *   POST /periskope          Periskope webhook         (customer -> team lead)
 *   POST /provision          Create a space for a customer from your CRM
 *
 * Run behind https. Google Chat and Periskope both need a public URL.
 */

const express = require("express");
const { createHmac, timingSafeEqual } = require("crypto");
const { OAuth2Client } = require("google-auth-library");

const { postToSpace, sendWhatsApp, getMessage } = require("./clients");
const { provision, sendWelcomeMessage } = require("./provision");
const store = require("./store");
const events = require("./events");
const sheetSync = require("./sheet-sync");
const { resolveSender } = require("./directory");

const PORT = process.env.PORT || 8080;
const BRAND = process.env.BRAND_NAME || "Farmkart"; // shown on the WhatsApp signature
const GOOGLE_PROJECT_NUMBER = process.env.GOOGLE_PROJECT_NUMBER;
const PERISKOPE_SIGNING_KEY = process.env.PERISKOPE_SIGNING_KEY;
const PROVISION_TOKEN = process.env.PROVISION_TOKEN;

const app = express();
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

// ------------------------------------------------------------ verification

const googleAuth = new OAuth2Client();

// Google Chat signs request tokens with this service account, not with the
// OAuth2 federated keys that verifyIdToken() expects — so we fetch its x509
// certs and verify against them directly.
const CHAT_ISSUER = "chat@system.gserviceaccount.com";
const CHAT_CERT_URL =
  "https://www.googleapis.com/service_accounts/v1/metadata/x509/" + CHAT_ISSUER;

let certCache = { certs: null, expiresAt: 0 };

async function chatCerts() {
  if (certCache.certs && Date.now() < certCache.expiresAt) return certCache.certs;

  const res = await fetch(CHAT_CERT_URL);
  if (!res.ok) throw new Error(`cert fetch failed: ${res.status}`);
  const certs = await res.json();

  const m = /max-age=(\d+)/.exec(res.headers.get("cache-control") || "");
  const ttl = m ? Number(m[1]) * 1000 : 3_600_000;
  certCache = { certs, expiresAt: Date.now() + ttl };
  return certs;
}

async function verifyGoogleChat(req) {
  // Local testing only: skip token verification so the relay logic can be
  // exercised without a Google-signed request. Never set this in production.
  if (process.env.SKIP_GCHAT_AUTH === "1") return;

  if (!GOOGLE_PROJECT_NUMBER) throw new Error("GOOGLE_PROJECT_NUMBER is not set");

  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) throw new Error("missing bearer token");

  // Throws unless the token is validly signed by CHAT_ISSUER, unexpired, and
  // carries aud === our project number.
  await googleAuth.verifySignedJwtWithCertsAsync(
    header.slice(7),
    await chatCerts(),
    GOOGLE_PROJECT_NUMBER,
    [CHAT_ISSUER]
  );
}

function verifyPeriskope(rawBody, signature) {
  if (!signature || !PERISKOPE_SIGNING_KEY) return false;
  const digest = createHmac("sha256", PERISKOPE_SIGNING_KEY)
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(digest);
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}

// Periskope retries on non-2xx and can redeliver. Drop repeats.
const seen = new Map();
function isDuplicate(id) {
  if (!id) return false;
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 600_000) seen.delete(k);
  if (seen.has(id)) return true;
  seen.set(id, now);
  return false;
}

// ------------------------------------ direction A: Google Chat -> WhatsApp

/**
 * Relay one space message to the customer. Fed by two paths that can both see
 * the same message — the /gchat webhook (when the app is @mentioned) and the
 * Workspace Events -> Pub/Sub stream (every message) — so it dedupes by
 * message name and drops anything a bot sent (our own posts would loop).
 */
async function relayChatMessage({
  spaceName,
  text,
  senderId,
  senderName,
  senderType,
  messageName,
}) {
  if (messageName && isDuplicate(`msg:${messageName}`)) return;
  if (senderType && senderType !== "HUMAN") return; // our own / other apps

  const clean = (text || "").trim();
  if (!clean) return;

  const route = await store.bySpace(spaceName);
  if (!route) {
    console.log(`chat msg in unmapped space ${spaceName}`);
    return;
  }

  const { name, email } = await resolveSender(senderId, senderName);

  // Internal-only line — record it, but don't send to the customer.
  if (clean.startsWith("//")) {
    await store
      .logMessage({
        direction: "note",
        spaceName: route.spaceName,
        chatId: route.chatId,
        customerName: route.customerName,
        senderName: name,
        senderEmail: email,
        body: clean,
        refId: messageName || null,
      })
      .catch((e) => console.error("logMessage(note) failed:", e.message));
    return;
  }
  const signature = name ? `${name}, ${BRAND}` : `${BRAND} team`;
  try {
    const result = await sendWhatsApp({
      chat_id: route.chatId,
      message: `${clean}\n\n_${signature}_`,
    });
    console.log(`-> wa ${route.chatId} queue=${result.queue_id}`);
    await store
      .logMessage({
        direction: "out",
        spaceName: route.spaceName,
        chatId: route.chatId,
        customerName: route.customerName,
        senderName: name,
        senderEmail: email,
        body: clean,
        refId: result.queue_id,
      })
      .catch((e) => console.error("logMessage(out) failed:", e.message));
  } catch (err) {
    console.error("send failed:", err.message);
    await postToSpace(
      route.spaceName,
      `⚠️ Not delivered to WhatsApp: ${err.message}`
    ).catch((e) => console.error("failure notice post failed:", e.message));
  }
}

/**
 * Turn a Workspace Events `chat.message.v1.created` payload into a relay call.
 * Shared by the Pub/Sub push route (/pubsub) and the local pull listener.
 */
async function handleChatEvent({ message, messageName }) {
  let msg = message;
  if (!msg?.text && messageName) {
    try {
      msg = await getMessage(messageName);
    } catch (err) {
      console.error("getMessage failed:", err.message);
      return;
    }
  }
  if (!msg) return;

  await relayChatMessage({
    spaceName:
      msg.space?.name || (messageName || "").split("/messages/")[0] || undefined,
    text: events.cleanText(msg),
    senderId: msg.sender?.name,
    senderName: msg.sender?.displayName,
    senderType: msg.sender?.type,
    messageName: msg.name || messageName,
  });
}

app.post("/gchat", async (req, res) => {
  try {
    await verifyGoogleChat(req);
  } catch (err) {
    console.error("gchat auth failed:", err.message);
    return res.status(401).json({ text: "Unauthorized" });
  }

  const event = req.body;

  if (event.type === "ADDED_TO_SPACE") {
    // Self-register: a human created the space (named "<Name> - <phone>",
    // "allow external" on) and added the bot. Pull the phone from the name,
    // save the route, drop the orientation message.
    const spaceName = event.space?.name;
    const display = event.space?.displayName || "";
    const m = display.match(/^(.*?)[\s]*[-—][\s]*(\+?\d[\d\s-]{7,}\d)\s*$/);
    if (!spaceName || !m) {
      return res.json({
        text:
          "Bridge connected. Rename this space to `Customer Name - 9876543210` " +
          "and re-add me, or use /provision, so I can link it to a WhatsApp number.",
      });
    }
    const custName = m[1].trim();
    const digits = m[2].replace(/\D/g, "");
    const phone = digits.length === 10 ? `91${digits}` : digits;

    try {
      const existing = await store.byPhone(phone);
      if (existing && existing.spaceName !== spaceName) {
        return res.json({
          text: `⚠️ ${phone} is already linked to another space (\`${existing.spaceName}\`).`,
        });
      }
      const isNew = !existing;
      const route = await store.addRoute({
        customerName: custName,
        customerPhone: phone,
        spaceName,
      });
      if (isNew) await sendWelcomeMessage(route);
      await postToSpace(
        spaceName,
        [
          `*${custName}* — ${phone}`,
          "",
          "Anything posted here goes to the customer on WhatsApp, signed with your name.",
          "Their replies come back into this space.",
          "",
          "Start a line with `//` to keep it internal.",
        ].join("\n")
      ).catch(() => {});
      console.log(`linked ${spaceName} <-> ${phone}@c.us (via ADDED_TO_SPACE)`);
      return res.json({});
    } catch (err) {
      console.error("auto-link failed:", err.message);
      return res.json({ text: `⚠️ Couldn't link this space: ${err.message}` });
    }
  }

  if (event.type !== "MESSAGE") return res.json({});

  // Do the work before responding — on serverless the function is frozen once
  // the response is sent. This branch only fires on an @mention (the bulk of
  // traffic comes through /pubsub).
  try {
    await relayChatMessage({
      spaceName: event.space?.name,
      text: event.message?.argumentText ?? event.message?.text,
      senderId: event.message?.sender?.name,
      senderName: event.message?.sender?.displayName,
      senderType: event.message?.sender?.type,
      messageName: event.message?.name,
    });
  } catch (err) {
    console.error("gchat relay error:", err.message);
  }
  res.json({});
});

// ------------------------------------ direction B: WhatsApp -> Google Chat

async function periskopeInbound(data) {
  if (data?.from_me) return; // our own outbound, would loop
  if (isDuplicate(data?.message_id || data?.unique_id)) return;

  const route = await store.byChatId(data.chat_id);
  if (!route) {
    console.log(`unmapped inbound from ${data.chat_id}`);
    return;
  }

  const body = data.body?.trim();
  const kind = data.message_type || "chat";
  const isMedia = data.has_media || (kind !== "chat" && kind !== undefined);
  const mediaUrl = data.media?.path;

  let text;
  if (isMedia) {
    const noun =
      kind === "ptt" ? "a voice message" : kind === "chat" ? "a file" : `a ${kind}`;
    const lines = [`*${route.customerName}*`];
    lines.push(body ? body : `_sent ${noun}_`);
    if (data.media?.filename && !body) lines.push(`\`${data.media.filename}\``);
    lines.push(
      mediaUrl ? mediaUrl : `_(${noun} — couldn't get a link; open in WhatsApp)_`
    );
    if (!mediaUrl) {
      console.warn(
        `inbound media without url: type=${kind} media=${JSON.stringify(
          data.media
        )}`
      );
    }
    text = lines.join("\n");
  } else if (body) {
    text = `*${route.customerName}*\n${body}`;
  } else {
    return;
  }

  const posted = await postToSpace(route.spaceName, text);
  console.log(`-> chat ${route.spaceName}`);

  await store
    .logMessage({
      direction: "in",
      spaceName: route.spaceName,
      chatId: route.chatId,
      customerName: route.customerName,
      senderName: route.customerName,
      body: body || null,
      mediaUrl: mediaUrl || null,
      refId: posted?.name || data.message_id || data.unique_id || null,
    })
    .catch((e) => console.error("logMessage(in) failed:", e.message));
}

app.post("/periskope", async (req, res) => {
  if (!verifyPeriskope(req.rawBody, req.headers["x-periskope-signature"])) {
    return res.status(401).send("Invalid signature");
  }

  // Serverless: finish the work before responding, or the function is frozen.
  try {
    const { event_type, data } = req.body;
    if (event_type === "message.created") await periskopeInbound(data);
  } catch (err) {
    console.error("periskope inbound error:", err.message);
  }
  res.status(200).send("ok");
});

// ------------------------------------------------- provisioning from a CRM

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

app.post("/provision", async (req, res) => {
  if (!PROVISION_TOKEN) {
    console.error("/provision hit but PROVISION_TOKEN is not set — refusing");
    return res
      .status(503)
      .json({ error: "provisioning disabled: PROVISION_TOKEN not set" });
  }
  if (!safeEqual(req.headers["x-provision-token"], PROVISION_TOKEN)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const { route, manualAdds } = await provision(req.body);
    res.json({ ok: true, route, manualAdds });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ------------------------------- Pub/Sub push (Workspace Events -> relay)

const PUBSUB_PUSH_AUDIENCE = process.env.PUBSUB_PUSH_AUDIENCE; // optional
const PUBSUB_PUSH_SA = process.env.PUBSUB_PUSH_SA; // SA Pub/Sub signs the push as

async function verifyPubsubPush(req) {
  const hdr = req.headers.authorization || "";
  if (hdr.startsWith("Bearer ")) {
    const ticket = await googleAuth.verifyIdToken({
      idToken: hdr.slice(7),
      audience: PUBSUB_PUSH_AUDIENCE || undefined,
    });
    const p = ticket.getPayload();
    if (!p || p.email_verified === false) throw new Error("email not verified");
    if (PUBSUB_PUSH_SA && p.email !== PUBSUB_PUSH_SA) {
      throw new Error(`unexpected pusher ${p.email}`);
    }
    return;
  }
  // fallback: shared token in the query string (?token=…)
  if (PROVISION_TOKEN && safeEqual(req.query.token, PROVISION_TOKEN)) return;
  throw new Error("no valid auth");
}

app.post("/pubsub", async (req, res) => {
  try {
    await verifyPubsubPush(req);
  } catch (err) {
    console.error("pubsub push auth failed:", err.message);
    return res.status(401).send("unauthorized");
  }

  const m = req.body && req.body.message;

  // Serverless: process before responding — the function is frozen once the
  // response is sent. A 204 tells Pub/Sub to ack; a 500 makes it retry.
  try {
    if (m && !isDuplicate(`ps:${m.messageId || m.message_id}`)) {
      const decoded = m.data
        ? Buffer.from(m.data, "base64").toString("utf8")
        : "";
      const parsed = events.parseChatEvent({
        data: decoded,
        attributes: m.attributes,
      });
      if (parsed && parsed.eventType === events.EVENT_TYPE) {
        await handleChatEvent(parsed);
      }
    }
    res.status(204).end();
  } catch (err) {
    console.error("pubsub push handler error:", err.message);
    res.status(500).end(); // Pub/Sub will redeliver
  }
});

// ------------------------------- cron: renew the Events subscription

app.post("/renew", async (req, res) => {
  if (!PROVISION_TOKEN) return res.status(503).json({ error: "PROVISION_TOKEN not set" });
  const tok = req.headers["x-provision-token"] || req.query.token;
  if (!safeEqual(tok, PROVISION_TOKEN)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const r = await events.renewSubscription();
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Trigger a sheet sync now (same guard as /provision; token via header or ?token=).
app.post("/sync", async (req, res) => {
  if (!PROVISION_TOKEN) return res.status(503).json({ error: "PROVISION_TOKEN not set" });
  const tok = req.headers["x-provision-token"] || req.query.token;
  if (!safeEqual(tok, PROVISION_TOKEN)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const result = await sheetSync.poll();
  res.json({ ok: true, ...result });
});

// Message log (audit). GET /messages?space=spaces/AAA | ?phone=9198... | ?limit=200
app.get("/messages", async (req, res) => {
  if (!PROVISION_TOKEN) return res.status(503).json({ error: "PROVISION_TOKEN not set" });
  const tok = req.headers["x-provision-token"] || req.query.token;
  if (!safeEqual(tok, PROVISION_TOKEN)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const rows = await store.messages({
      spaceName: req.query.space || undefined,
      chatId: req.query.phone ? store.toChatId(req.query.phone) : undefined,
      limit: req.query.limit,
    });
    res.json({ ok: true, count: rows.length, messages: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/health", async (_req, res) => {
  try {
    const routes = await store.all();
    res.json({ ok: true, routes: routes.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`relay on :${PORT}`));

  // Local dev: hold a Pub/Sub *pull* listener. On Vercel this block never runs;
  // events arrive as *push* requests to /pubsub instead.
  if (process.env.DISABLE_EVENTS !== "1") {
    // Retry with backoff — e.g. while the chat.messages.readonly delegation
    // scope is still propagating after setup.
    const startEvents = (attempt = 0) =>
      events.start({ onMessage: handleChatEvent }).catch((err) => {
        const wait = Math.min(60_000, 5_000 * 2 ** attempt);
        console.error(
          `events startup failed (${err.message}); retrying in ${wait / 1000}s`
        );
        setTimeout(() => startEvents(attempt + 1), wait);
      });
    startEvents();
  }

  // Auto-provision spaces from the Leegality sheet (no-op unless SHEET_ID set).
  if (process.env.DISABLE_SHEET_SYNC !== "1") sheetSync.start();
}

module.exports = app;

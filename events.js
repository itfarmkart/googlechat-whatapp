/**
 * Google Workspace Events -> Pub/Sub -> relay.
 *
 * A plain HTTP Chat app only receives messages that @mention it. To relay every
 * message in every customer space, we hold ONE Workspace Events subscription
 * targeting `//chat.googleapis.com/spaces/-` (all spaces the impersonated user
 * belongs to — provisioning adds that user to each space) and read the events
 * off a Pub/Sub pull subscription.
 *
 * Subscriptions with message content included live ~4h max, so we renew hourly
 * and recreate on startup if missing.
 */

const path = require("path");
const { userToken } = require("./clients");

const KEY_FILE = process.env.GOOGLE_KEY_FILE || "./service-account.json";
const EVENTS_BASE = "https://workspaceevents.googleapis.com/v1";

const TARGET = "//chat.googleapis.com/spaces/-";
const EVENT_TYPE = "google.workspace.chat.message.v1.created";
const SCOPE = "https://www.googleapis.com/auth/chat.messages.readonly";

const SUBSCRIPTION_ID = process.env.PUBSUB_SUBSCRIPTION || "chat-events-sub";

function projectId() {
  if (process.env.GOOGLE_CLOUD_PROJECT) return process.env.GOOGLE_CLOUD_PROJECT;
  return require(path.resolve(KEY_FILE)).project_id;
}

function pubsubTopic() {
  return (
    process.env.PUBSUB_TOPIC || `projects/${projectId()}/topics/chat-events`
  );
}

// ------------------------------------------------------------ events REST API

async function eventsApi(url, { method = "GET", body } = {}) {
  const token = await userToken([SCOPE]);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(
      `Events API ${res.status}: ${parsed.error?.message || text}`
    );
  }
  return parsed;
}

/** Poll a long-running operation to completion and return its response. */
async function awaitOperation(op) {
  let current = op;
  for (let i = 0; i < 30 && !current.done; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    current = await eventsApi(`${EVENTS_BASE}/${current.name}`);
  }
  if (current.error) {
    throw new Error(`operation failed: ${current.error.message}`);
  }
  return current.response;
}

async function findExisting() {
  const filter = encodeURIComponent(`event_types:"${EVENT_TYPE}"`);
  const { subscriptions = [] } = await eventsApi(
    `${EVENTS_BASE}/subscriptions?filter=${filter}`
  );
  return subscriptions.find(
    (s) =>
      s.targetResource === TARGET &&
      s.notificationEndpoint?.pubsubTopic === pubsubTopic() &&
      s.state !== "DELETED"
  );
}

/** Return an active subscription, creating one if none exists. */
async function ensureSubscription() {
  const existing = await findExisting();
  if (existing && existing.state === "ACTIVE") {
    console.log(`events subscription ok: ${existing.name}`);
    return existing;
  }
  if (existing) {
    // exists but SUSPENDED / not ACTIVE — try a renew to reactivate
    try {
      await renew(existing.name);
      console.log(`events subscription reactivated: ${existing.name}`);
      return existing;
    } catch (err) {
      console.warn(`reactivate failed (${err.message}), recreating`);
    }
  }

  console.log("creating Workspace Events subscription…");
  const op = await eventsApi(`${EVENTS_BASE}/subscriptions`, {
    method: "POST",
    body: {
      targetResource: TARGET,
      eventTypes: [EVENT_TYPE],
      payloadOptions: { includeResource: true },
      notificationEndpoint: { pubsubTopic: pubsubTopic() },
      ttl: "0s", // 0 = maximum allowed
    },
  });
  const created = await awaitOperation(op);
  console.log(`events subscription created: ${created?.name}`);
  return created;
}

/** Renew to the maximum TTL again. */
async function renew(name) {
  return eventsApi(
    `${EVENTS_BASE}/${name}?updateMask=ttl`,
    { method: "PATCH", body: { ttl: "0s" } }
  );
}

// --------------------------------------------------------- pub/sub payload

/**
 * Pull a Chat message out of a Pub/Sub message. Pure — unit tested.
 * Returns { eventType, message, messageName } or null.
 */
function parseChatEvent(pubsubMessage) {
  const attrs = pubsubMessage.attributes || {};
  const eventType = attrs["ce-type"] || attrs.ceType;

  let payload = {};
  try {
    const raw = Buffer.isBuffer(pubsubMessage.data)
      ? pubsubMessage.data.toString("utf8")
      : String(pubsubMessage.data || "");
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return null;
  }

  const message = payload.message || null;
  // ce-subject looks like "//chat.googleapis.com/spaces/AAA/messages/BBB"
  const subject = attrs["ce-subject"] || attrs.ceSubject || "";
  const messageName =
    message?.name ||
    subject.replace(/^\/\/chat\.googleapis\.com\//, "") ||
    null;

  return { eventType, message, messageName };
}

/**
 * Message text with any @mentions of a bot removed — so a message that still
 * @mentions this app (no longer required, but possible) doesn't reach the
 * customer with "@Farmkart Customer Relay" stuck on the front. Pure.
 */
function cleanText(message) {
  let text = message?.text || "";
  const botMentions = (message?.annotations || [])
    .filter(
      (a) =>
        a.type === "USER_MENTION" && a.userMention?.user?.type === "BOT"
    )
    .sort((a, b) => Number(b.startIndex || 0) - Number(a.startIndex || 0));

  for (const m of botMentions) {
    const start = Number(m.startIndex || 0);
    const len = Number(m.length || 0);
    text = text.slice(0, start) + text.slice(start + len);
  }
  return text.trim();
}

// ------------------------------------------------------------------ runtime

let renewTimer;

/**
 * Ensure the subscription exists, start the pull listener, and keep the
 * subscription renewed. `onMessage({ message, messageName })` is called for
 * every chat.message.v1.created event; `message` may be null if the payload
 * lacked the resource (caller should fall back to clients.getMessage).
 */
async function start({ onMessage, renewMs = 60 * 60 * 1000 }) {
  await ensureSubscription();

  const { PubSub } = require("@google-cloud/pubsub");
  const pubsub = new PubSub({ projectId: projectId(), keyFilename: KEY_FILE });
  const sub = pubsub.subscription(SUBSCRIPTION_ID);

  sub.on("message", async (m) => {
    try {
      const parsed = parseChatEvent(m);
      if (parsed && parsed.eventType === EVENT_TYPE) {
        await onMessage(parsed);
      }
    } catch (err) {
      console.error("event handler error:", err.message);
    } finally {
      m.ack(); // dedupe downstream; never redeliver a poison message forever
    }
  });
  sub.on("error", (err) => console.error("pubsub listener error:", err.message));
  console.log(`listening on pub/sub subscription ${SUBSCRIPTION_ID}`);

  clearInterval(renewTimer);
  renewTimer = setInterval(async () => {
    try {
      const s = await findExisting();
      if (s) await renew(s.name);
      else await ensureSubscription();
    } catch (err) {
      console.error("subscription renew failed:", err.message);
      try {
        await ensureSubscription();
      } catch (e) {
        console.error("recreate after renew failure also failed:", e.message);
      }
    }
  }, renewMs);
  if (renewTimer.unref) renewTimer.unref();
}

function stop() {
  clearInterval(renewTimer);
}

module.exports = {
  start,
  stop,
  ensureSubscription,
  renew,
  parseChatEvent,
  cleanText,
  pubsubTopic,
  EVENT_TYPE,
  TARGET,
};

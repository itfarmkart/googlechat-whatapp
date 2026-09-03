/**
 * Local end-to-end-ish tests for server.js.
 *
 * No real Google / Periskope calls: ./clients is replaced with in-memory stubs
 * that record what the relay *would* have sent. Google Chat token verification
 * is bypassed with SKIP_GCHAT_AUTH=1. The Periskope webhook signature is real —
 * we own the signing key in the test, so we compute a valid HMAC.
 *
 *   npm run test:local
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// ---- env must be set before server.js / store.js are required -------------

const SIGNING_KEY = "test-signing-key";
const PROVISION_TOKEN = "test-provision-token";
const STORE_FILE = path.join(os.tmpdir(), `relay-local-${process.pid}.json`);

process.env.SKIP_GCHAT_AUTH = "1";
process.env.PERISKOPE_SIGNING_KEY = SIGNING_KEY;
process.env.PROVISION_TOKEN = PROVISION_TOKEN;
process.env.STORE_FILE = STORE_FILE;
process.env.GOOGLE_IMPERSONATE_USER = "it@farmkart.com";

// ---- stub ./clients before anything requires it -------------------------------

const calls = { wa: [], chat: [], spaces: [], contacts: [], members: [] };

// Per-test override for what checkContact() returns.
let contactResult = { contacts: [{ exists: true }] };

function resetCalls() {
  calls.wa.length = 0;
  calls.chat.length = 0;
  calls.spaces.length = 0;
  calls.contacts.length = 0;
  calls.members.length = 0;
  contactResult = { contacts: [{ exists: true }] };
}

const clientsPath = require.resolve("../clients");
require.cache[clientsPath] = {
  id: clientsPath,
  filename: clientsPath,
  loaded: true,
  exports: {
    sendWhatsApp: async (payload) => {
      calls.wa.push(payload);
      return { queue_id: "queue-1" };
    },
    postToSpace: async (spaceName, text) => {
      calls.chat.push({ spaceName, text });
      return { name: `${spaceName}/messages/1` };
    },
    createSpaceWithMembers: async (args) => {
      calls.spaces.push(args);
      return { name: "spaces/TEST123" };
    },
    addHumanToSpace: async (spaceName, email) => {
      calls.members.push({ spaceName, email });
      // Google rejects external members added via delegation — model that.
      if (!email.endsWith("@farmkart.com")) throw new Error("403 external");
      return {};
    },
    addAppToSpace: async () => ({}),
    getMessage: async () => {
      throw new Error("getMessage not stubbed");
    },
    userToken: async () => "stub-token",
    saToken: async () => "stub-sa-token",
    serviceAccountKey: () => ({
      project_id: "test-project",
      client_email: "sa@test.iam.gserviceaccount.com",
      private_key: "x",
    }),
    checkContact: async (phone) => {
      calls.contacts.push(phone);
      return contactResult;
    },
  },
};

const store = require("../store");
const app = require("../server");

// ---- helpers ---------------------------------------------------------------

let base;
let server;

test.before(async () => {
  try {
    fs.unlinkSync(STORE_FILE);
  } catch {}
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  for (const f of [STORE_FILE, `${STORE_FILE}.messages.jsonl`]) {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
});

test.beforeEach(resetCalls);

const sign = (body) =>
  createHmac("sha256", SIGNING_KEY).update(body).digest("hex");

async function waitFor(predicate, ms = 500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor: condition not met in time");
}

async function seedRoute(overrides = {}) {
  return store.addRoute({
    customerName: "Ramesh Patidar",
    customerPhone: "919876543210",
    spaceName: "spaces/AAA",
    department: "solar",
    ...overrides,
  });
}

// ---- /health ----------------------------------------------------------------

test("GET /health reports route count", async () => {
  await seedRoute();
  const res = await fetch(`${base}/health`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(typeof json.routes, "number");
});

// ---- direction A: /gchat (team lead -> customer) ---------------------------

test("ADDED_TO_SPACE with no usable name asks to be renamed", async () => {
  const res = await fetch(`${base}/gchat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "ADDED_TO_SPACE", space: { name: "spaces/AAA" } }),
  });
  const json = await res.json();
  assert.match(json.text, /Bridge connected/);
  assert.match(json.text, /Customer Name - 9876543210/);
  assert.equal(calls.wa.length, 0);
});

test("ADDED_TO_SPACE with a '<name> - <phone>' title links the space", async () => {
  const res = await fetch(`${base}/gchat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "ADDED_TO_SPACE",
      space: { name: "spaces/NEW1", displayName: "Ramesh Patidar - 9812300001" },
    }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {});

  const route = await store.byChatId("919812300001@c.us");
  assert.ok(route, "route saved");
  assert.equal(route.spaceName, "spaces/NEW1");
  assert.equal(route.customerName, "Ramesh Patidar");
  assert.ok(
    calls.chat.some((c) => c.spaceName === "spaces/NEW1" && /goes to the customer/.test(c.text)),
    "intro message posted"
  );
});

test("ADDED_TO_SPACE for a phone already linked elsewhere is refused", async () => {
  await store.addRoute({
    customerName: "Someone",
    customerPhone: "919812300002",
    spaceName: "spaces/OLD",
  });
  const res = await fetch(`${base}/gchat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "ADDED_TO_SPACE",
      space: { name: "spaces/OTHER", displayName: "Dup - 9812300002" },
    }),
  });
  const json = await res.json();
  assert.match(json.text, /already linked/);
});

test("a normal MESSAGE is relayed to WhatsApp with the sender's name", async () => {
  await seedRoute();
  const res = await fetch(`${base}/gchat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "MESSAGE",
      space: { name: "spaces/AAA" },
      message: { text: "Your panels ship tomorrow", sender: { displayName: "Priya Sharma" } },
    }),
  });

  assert.equal(res.status, 200);
  assert.equal(calls.wa.length, 1);
  assert.equal(calls.wa[0].chat_id, "919876543210@c.us");
  assert.match(calls.wa[0].message, /Your panels ship tomorrow/);
  assert.match(calls.wa[0].message, /_Priya Sharma, Farmkart_/);
});

test("a line starting with // stays internal", async () => {
  await seedRoute();
  await fetch(`${base}/gchat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "MESSAGE",
      space: { name: "spaces/AAA" },
      message: { text: "// remember to call the installer", sender: { displayName: "Priya Sharma" } },
    }),
  });
  assert.equal(calls.wa.length, 0);
});

test("MESSAGE in an unmapped space is acked and not relayed", async () => {
  const res = await fetch(`${base}/gchat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "MESSAGE",
      space: { name: "spaces/UNKNOWN" },
      message: { text: "hello?", sender: { displayName: "Priya Sharma" } },
    }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {});
  assert.equal(calls.wa.length, 0);
});

test("a bot-sent MESSAGE is not relayed (loop guard)", async () => {
  await seedRoute();
  await fetch(`${base}/gchat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "MESSAGE",
      space: { name: "spaces/AAA" },
      message: {
        text: "*Ramesh Patidar*\nhi there",
        sender: { displayName: "Farmkart Customer Relay", type: "BOT" },
      },
    }),
  });
  assert.equal(calls.wa.length, 0);
});

test("the same message via two paths only relays once (dedupe by name)", async () => {
  await seedRoute();
  const body = JSON.stringify({
    type: "MESSAGE",
    space: { name: "spaces/AAA" },
    message: {
      name: "spaces/AAA/messages/DUP1",
      text: "ship it",
      sender: { displayName: "Priya Sharma", type: "HUMAN" },
    },
  });
  const h = { "content-type": "application/json" };
  await fetch(`${base}/gchat`, { method: "POST", headers: h, body });
  await waitFor(() => calls.wa.length === 1);
  await fetch(`${base}/gchat`, { method: "POST", headers: h, body });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls.wa.length, 1);
});

test("with real verification on, a request with no bearer token is 401", async () => {
  delete process.env.SKIP_GCHAT_AUTH;
  try {
    const res = await fetch(`${base}/gchat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "MESSAGE", space: { name: "spaces/AAA" }, message: {} }),
    });
    assert.equal(res.status, 401);
    assert.equal(calls.wa.length, 0);
  } finally {
    process.env.SKIP_GCHAT_AUTH = "1";
  }
});

// ---- Pub/Sub push (/pubsub) --------------------------------------------

function pushEnvelope(chatMessage, messageId = "ps-1") {
  const payload = JSON.stringify({ message: chatMessage });
  return JSON.stringify({
    message: {
      data: Buffer.from(payload, "utf8").toString("base64"),
      attributes: { "ce-type": "google.workspace.chat.message.v1.created" },
      messageId,
    },
    subscription: "projects/x/subscriptions/chat-events-sub",
  });
}

test("/pubsub without auth is 401", async () => {
  const res = await fetch(`${base}/pubsub`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: pushEnvelope({ name: "spaces/AAA/messages/1", text: "hi" }),
  });
  assert.equal(res.status, 401);
  assert.equal(calls.wa.length, 0);
});

test("/pubsub with ?token relays a HUMAN chat message", async () => {
  await seedRoute();
  const res = await fetch(`${base}/pubsub?token=${PROVISION_TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: pushEnvelope(
      {
        name: "spaces/AAA/messages/PS1",
        text: "quote is ready",
        space: { name: "spaces/AAA" },
        sender: { name: "users/55", displayName: "Priya Sharma", type: "HUMAN" },
      },
      "ps-relay-1"
    ),
  });
  assert.equal(res.status, 204);
  await waitFor(() => calls.wa.length === 1);
  assert.match(calls.wa[0].message, /quote is ready/);
  assert.match(calls.wa[0].message, /_Priya Sharma, Farmkart_/);
});

test("/pubsub drops a bot-sent message (loop guard)", async () => {
  await seedRoute();
  await fetch(`${base}/pubsub?token=${PROVISION_TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: pushEnvelope(
      {
        name: "spaces/AAA/messages/PS2",
        text: "*Ramesh*\nhello",
        space: { name: "spaces/AAA" },
        sender: { name: "users/app", type: "BOT" },
      },
      "ps-bot-1"
    ),
  });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(calls.wa.length, 0);
});

// ---- /renew ------------------------------------------------------------

test("/renew without token is 401", async () => {
  const res = await fetch(`${base}/renew`, { method: "POST" });
  assert.equal(res.status, 401);
});

// ---- message log ------------------------------------------------------

test("/messages without token is 401", async () => {
  const res = await fetch(`${base}/messages`);
  assert.equal(res.status, 401);
});

test("relayed messages are recorded (both directions, with sender)", async () => {
  await seedRoute(); // Ramesh Patidar / 919876543210 / spaces/AAA

  // outbound via /gchat
  await fetch(`${base}/gchat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "MESSAGE",
      space: { name: "spaces/AAA" },
      message: {
        name: "spaces/AAA/messages/LOG1",
        text: "your panels ship Tuesday",
        sender: { name: "users/77", displayName: "Priya Sharma", type: "HUMAN" },
      },
    }),
  });

  // inbound via /periskope
  const body = JSON.stringify({
    event_type: "message.created",
    data: {
      message_id: "in-log-1",
      chat_id: "919876543210@c.us",
      body: "thanks, got it",
      message_type: "chat",
    },
  });
  await fetch(`${base}/periskope`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-periskope-signature": sign(body) },
    body,
  });

  await waitFor(async () => (await store.messages({ spaceName: "spaces/AAA" })).length >= 2);

  const res = await fetch(`${base}/messages?space=spaces/AAA`, {
    headers: { "x-provision-token": PROVISION_TOKEN },
  });
  const { messages } = await res.json();

  const out = messages.find((m) => m.direction === "out");
  const inb = messages.find((m) => m.direction === "in");

  assert.equal(out.body, "your panels ship Tuesday");
  assert.equal(out.senderName, "Priya Sharma");
  assert.equal(out.customerName, "Ramesh Patidar");
  assert.equal(out.chatId, "919876543210@c.us");

  assert.equal(inb.body, "thanks, got it");
  assert.equal(inb.senderName, "Ramesh Patidar");
  assert.equal(inb.direction, "in");
});

// ---- direction B: /periskope (customer -> team lead) ---------------------

test("a bad signature is rejected with 401", async () => {
  const body = JSON.stringify({ event_type: "message.created", data: {} });
  const res = await fetch(`${base}/periskope`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-periskope-signature": "deadbeef" },
    body,
  });
  assert.equal(res.status, 401);
});

test("an inbound text message is posted into the space with the customer name", async () => {
  await seedRoute();
  const body = JSON.stringify({
    event_type: "message.created",
    data: {
      message_id: "m-100",
      chat_id: "919876543210@c.us",
      body: "Is someone coming today?",
      message_type: "chat",
    },
  });
  const res = await fetch(`${base}/periskope`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-periskope-signature": sign(body) },
    body,
  });

  assert.equal(res.status, 200);
  await waitFor(() => calls.chat.length === 1);
  assert.equal(calls.chat[0].spaceName, "spaces/AAA");
  assert.match(calls.chat[0].text, /\*Ramesh Patidar\*/);
  assert.match(calls.chat[0].text, /Is someone coming today\?/);
});

test("our own outbound (from_me) is ignored", async () => {
  await seedRoute();
  const body = JSON.stringify({
    event_type: "message.created",
    data: { message_id: "m-200", chat_id: "919876543210@c.us", body: "hi", from_me: true },
  });
  await fetch(`${base}/periskope`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-periskope-signature": sign(body) },
    body,
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls.chat.length, 0);
});

test("a redelivered message (same id) is only posted once", async () => {
  await seedRoute();
  const body = JSON.stringify({
    event_type: "message.created",
    data: {
      message_id: "m-300",
      chat_id: "919876543210@c.us",
      body: "duplicate please",
      message_type: "chat",
    },
  });
  const headers = {
    "content-type": "application/json",
    "x-periskope-signature": sign(body),
  };

  await fetch(`${base}/periskope`, { method: "POST", headers, body });
  await waitFor(() => calls.chat.length === 1);
  await fetch(`${base}/periskope`, { method: "POST", headers, body });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls.chat.length, 1);
});

test("a media message with no caption posts the file link", async () => {
  await seedRoute();
  const body = JSON.stringify({
    event_type: "message.created",
    data: {
      message_id: "m-400",
      chat_id: "919876543210@c.us",
      message_type: "document",
      has_media: true,
      media: {
        path: "https://media.periskope.app/x/quote.pdf?token=abc",
        filename: "quote.pdf",
        mimetype: "application/pdf",
      },
    },
  });
  await fetch(`${base}/periskope`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-periskope-signature": sign(body) },
    body,
  });
  await waitFor(() => calls.chat.length === 1);
  assert.match(calls.chat[0].text, /\*Ramesh Patidar\*/);
  assert.match(calls.chat[0].text, /sent a document/);
  assert.match(calls.chat[0].text, /quote\.pdf/);
  assert.match(calls.chat[0].text, /media\.periskope\.app\/x\/quote\.pdf\?token=abc/);
});

test("a media message WITH a caption keeps both caption and link", async () => {
  await seedRoute();
  const body = JSON.stringify({
    event_type: "message.created",
    data: {
      message_id: "m-401",
      chat_id: "919876543210@c.us",
      message_type: "image",
      has_media: true,
      body: "here's the site photo",
      media: { path: "https://media.periskope.app/x/site.jpg?token=xyz" },
    },
  });
  await fetch(`${base}/periskope`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-periskope-signature": sign(body) },
    body,
  });
  await waitFor(() => calls.chat.length === 1);
  assert.match(calls.chat[0].text, /here's the site photo/);
  assert.match(calls.chat[0].text, /media\.periskope\.app\/x\/site\.jpg\?token=xyz/);
});

test("media with no url falls back to a note, still posts", async () => {
  await seedRoute();
  const body = JSON.stringify({
    event_type: "message.created",
    data: {
      message_id: "m-402",
      chat_id: "919876543210@c.us",
      message_type: "audio",
      has_media: true,
      media: {},
    },
  });
  await fetch(`${base}/periskope`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-periskope-signature": sign(body) },
    body,
  });
  await waitFor(() => calls.chat.length === 1);
  assert.match(calls.chat[0].text, /couldn't get a link|open in WhatsApp/);
});

// ---- /provision -----------------------------------------------------------

test("provision is rejected without the token", async () => {
  const res = await fetch(`${base}/provision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Test", phone: "919999999999" }),
  });
  assert.equal(res.status, 401);
});

test("provision refuses a number that is not on WhatsApp", async () => {
  contactResult = { contacts: [{ exists: false }] };
  const res = await fetch(`${base}/provision`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-provision-token": PROVISION_TOKEN,
    },
    body: JSON.stringify({ name: "Nope", phone: "919222222222", dept: "solar" }),
  });
  const json = await res.json();

  assert.equal(res.status, 400);
  assert.equal(json.ok, false);
  assert.match(json.error, /not registered on WhatsApp/);
  assert.equal(calls.spaces.length, 0, "no space created");
  assert.equal(await store.byChatId("919222222222@c.us"), null);
});

test("provision creates a space, adds the app and saves a route", async () => {
  const res = await fetch(`${base}/provision`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-provision-token": PROVISION_TOKEN,
    },
    body: JSON.stringify({
      name: "New Customer",
      phone: "919111111111",
      dept: "solar",
      ref: "RS-9001",
    }),
  });
  const json = await res.json();

  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.route.spaceName, "spaces/TEST123");
  assert.equal(json.route.chatId, "919111111111@c.us");
  assert.equal(calls.spaces.length, 1);
  assert.match(calls.spaces[0].displayName, /New Customer — RS-9001/);
  assert.deepEqual(await store.byChatId("919111111111@c.us"), json.route);

  // spaces:setup gets only same-domain members
  for (const e of calls.spaces[0].memberEmails) {
    assert.ok(e.endsWith("@farmkart.com"), `${e} should be a home-domain seed`);
  }
  assert.ok(
    calls.spaces[0].memberEmails.includes("it@farmkart.com"),
    "impersonation user is seeded into the space"
  );

  // myrsolar.com leads can't be added by delegation → reported for a manual add
  assert.ok(Array.isArray(json.manualAdds));
  assert.ok(json.manualAdds.includes("shailendrar@myrsolar.com"));
  assert.ok(json.manualAdds.every((e) => e.endsWith("@myrsolar.com")));
});

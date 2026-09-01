/**
 * API clients for Google Chat and Periskope.
 *
 * Two Google identities are used:
 *   appAuth()  - the Chat app itself (service account). Posts messages into
 *                spaces the app is a member of. No impersonation.
 *   userAuth() - the same service account impersonating an ops user via
 *                domain-wide delegation. Needed to CREATE spaces and add
 *                human members, which app auth can't do without admin
 *                approval of the chat.app.* scopes.
 */

const { GoogleAuth, JWT } = require("google-auth-library");

const KEY_FILE = process.env.GOOGLE_KEY_FILE || "./service-account.json";
const IMPERSONATE = process.env.GOOGLE_IMPERSONATE_USER; // ops@farmkart.com
const CHAT_BASE = "https://chat.googleapis.com/v1";

/**
 * Service-account key: from GOOGLE_CREDENTIALS_JSON (raw JSON or base64) on
 * hosts with no filesystem (Vercel), else the key file. Cached.
 */
let _key;
function serviceAccountKey() {
  if (_key) return _key;
  const raw = process.env.GOOGLE_CREDENTIALS_JSON;
  if (raw) {
    const json = raw.trim().startsWith("{")
      ? raw
      : Buffer.from(raw, "base64").toString("utf8");
    _key = JSON.parse(json);
  } else {
    _key = require(require("path").resolve(KEY_FILE));
  }
  return _key;
}

/** GoogleAuth options for the SA's own identity, file- or env-based. */
function googleAuthOpts(scopes) {
  return process.env.GOOGLE_CREDENTIALS_JSON
    ? { credentials: serviceAccountKey(), scopes }
    : { keyFile: KEY_FILE, scopes };
}

const PERISKOPE_BASE = "https://api.periskope.app/v1";
const PERISKOPE_API_KEY = process.env.PERISKOPE_API_KEY;
const PERISKOPE_PHONE = process.env.PERISKOPE_PHONE;

// ------------------------------------------------------------------ google

const saClients = new Map();

/** Token for the service account's own identity (no impersonation). */
async function saToken(scopes) {
  const cacheKey = scopes.join(" ");
  if (!saClients.has(cacheKey)) {
    saClients.set(cacheKey, new GoogleAuth(googleAuthOpts(scopes)));
  }
  const client = await saClients.get(cacheKey).getClient();
  const { token } = await client.getAccessToken();
  return token;
}

const appToken = () => saToken(["https://www.googleapis.com/auth/chat.bot"]);

async function userToken(scopes) {
  const key = serviceAccountKey();
  const jwt = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes,
    subject: IMPERSONATE,
  });
  const { access_token } = await jwt.authorize();
  return access_token;
}

async function chatRequest(url, { method = "GET", body, token }) {
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
    throw new Error(`Chat API ${res.status}: ${parsed.error?.message || text}`);
  }
  return parsed;
}

/** Create a space and add team leads in one call. Requires user auth (DWD). */
async function createSpaceWithMembers({ displayName, description, memberEmails }) {
  const token = await userToken([
    "https://www.googleapis.com/auth/chat.spaces.create",
    "https://www.googleapis.com/auth/chat.memberships",
  ]);

  return chatRequest(`${CHAT_BASE}/spaces:setup`, {
    method: "POST",
    token,
    body: {
      space: {
        spaceType: "SPACE",
        displayName,
        spaceDetails: { description },
        // Can't be true here: DWD/impersonation may not create external
        // spaces. The space auto-converts when a human adds the first
        // myrsolar.com member.
        externalUserAllowed: false,
      },
      memberships: memberEmails.map((email) => ({
        member: { name: `users/${email}`, type: "HUMAN" },
      })),
    },
  });
}

/** Add one human member to an existing space (used for cross-org members that
 *  spaces:setup won't accept inline). Requires user auth (DWD). */
async function addHumanToSpace(spaceName, email) {
  const token = await userToken([
    "https://www.googleapis.com/auth/chat.memberships",
  ]);
  return chatRequest(`${CHAT_BASE}/${spaceName}/members`, {
    method: "POST",
    token,
    body: { member: { name: `users/${email}`, type: "HUMAN" } },
  });
}

/** Add this Chat app to a space so it can post and receive events. */
async function addAppToSpace(spaceName) {
  const token = await userToken([
    "https://www.googleapis.com/auth/chat.memberships.app",
  ]);

  return chatRequest(`${CHAT_BASE}/${spaceName}/members`, {
    method: "POST",
    token,
    body: { member: { name: "users/app", type: "BOT" } },
  });
}

/** Post a message into a space as the app. */
async function postToSpace(spaceName, text) {
  const token = await appToken();
  return chatRequest(`${CHAT_BASE}/${spaceName}/messages`, {
    method: "POST",
    token,
    body: { text },
  });
}

/**
 * Fetch a single message resource. Used when a Workspace Events notification
 * arrives without the inline resource. Reads as the impersonated user, who is
 * a member of every customer space.
 */
async function getMessage(messageName) {
  const token = await userToken([
    "https://www.googleapis.com/auth/chat.messages.readonly",
  ]);
  return chatRequest(`${CHAT_BASE}/${messageName}`, { token });
}

// --------------------------------------------------------------- periskope

async function periskope(path, { method = "POST", body }) {
  const res = await fetch(`${PERISKOPE_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${PERISKOPE_API_KEY}`,
      "Content-Type": "application/json",
      "x-phone": PERISKOPE_PHONE,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`Periskope ${res.status}: ${text}`);
  }
  return parsed;
}

const sendWhatsApp = ({ chat_id, message, media }) =>
  periskope("/message/send", { body: { chat_id, message, media } });

/** Confirm a number is actually on WhatsApp before provisioning. */
const checkContact = (phone) =>
  periskope("/contacts/check", { body: { contact_ids: [String(phone)] } });

module.exports = {
  createSpaceWithMembers,
  addHumanToSpace,
  addAppToSpace,
  postToSpace,
  getMessage,
  sendWhatsApp,
  checkContact,
  userToken,
  saToken,
  serviceAccountKey,
};

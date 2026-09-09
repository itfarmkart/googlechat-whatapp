/**
 * Resolve a Google Chat `users/{id}` to a display name for the WhatsApp
 * signature.
 *
 * Order of preference:
 *   1. a name handed in by the /gchat webhook (it carries displayName),
 *   2. a manual entry in sender-names.json (people not in our directory —
 *      e.g. myrsolar.com partners),
 *   3. the People API directory profile (farmkart.com users), cached,
 *   4. null — caller falls back to a generic sign-off.
 *
 * People API (not Admin SDK) so it works for any user, no admin role needed.
 * Needs DWD scope: https://www.googleapis.com/auth/directory.readonly
 */

const fs = require("fs");
const path = require("path");
const { userToken } = require("./clients");

const SCOPE = "https://www.googleapis.com/auth/directory.readonly";
const MAP_FILE =
  process.env.SENDER_NAMES_FILE || path.join(__dirname, "sender-names.json");

const cache = new Map(); // userId -> { name, email } | null

let manualMap = new Map();
let manualMtime = 0;

function loadManualMap() {
  try {
    const stat = fs.statSync(MAP_FILE);
    if (stat.mtimeMs === manualMtime) return;
    manualMtime = stat.mtimeMs;
    const obj = JSON.parse(fs.readFileSync(MAP_FILE, "utf8"));
    const next = new Map();
    for (const [k, v] of Object.entries(obj)) {
      const id = String(k).replace(/^users\//, "");
      if (/^\d+$/.test(id) && typeof v === "string" && v.trim()) {
        next.set(id, v.trim());
      }
    }
    manualMap = next;
  } catch {
    // no file / bad JSON — keep whatever we had
  }
}
loadManualMap();

const EMPTY = { name: null, email: null };

async function directoryProfile(id) {
  if (cache.has(id)) return cache.get(id);
  try {
    const token = await userToken([SCOPE]);
    const res = await fetch(
      `https://people.googleapis.com/v1/people/${id}?personFields=names,emailAddresses`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.ok) {
      const j = await res.json();
      const names = j.names || [];
      const emails = j.emailAddresses || [];
      const name =
        (names.find((n) => n.metadata?.primary) || names[0])?.displayName || null;
      const email =
        (emails.find((e) => e.metadata?.primary) || emails[0])?.value || null;
      const profile = { name, email };
      console.log(`directory: users/${id} -> "${name}" <${email}>`);
      cache.set(id, profile);
      return profile;
    }
    if (res.status === 404) {
      cache.set(id, EMPTY); // external / unknown — stop retrying
      console.log(
        `directory: no profile for users/${id} — add "${id}": "Their Name" to sender-names.json`
      );
      return EMPTY;
    }
    console.error(
      `directory lookup ${res.status} for users/${id}: ${(await res.text())
        .replace(/\s+/g, " ")
        .slice(0, 160)}`
    );
  } catch (err) {
    console.error("directory lookup failed:", err.message);
  }
  // Negative-cache any failure too: the People API is on the message relay's
  // critical path, so we retry at most once per cold start per user, not once
  // per message. A fixed config picks up on the next deploy / cold start.
  cache.set(id, EMPTY);
  return EMPTY;
}

/**
 * Resolve a chat sender to { name, email }. `name` may come from the supplied
 * displayName, the manual map, or the directory; `email` only from the
 * directory.
 * @param {string} [senderId]    "users/123..." or "123..."
 * @param {string} [displayName] name already supplied by the caller
 */
async function resolveSender(senderId, displayName) {
  const id = senderId ? String(senderId).replace(/^users\//, "") : null;
  if (!id) return { name: displayName || null, email: null };

  loadManualMap();
  if (manualMap.has(id)) {
    return { name: displayName || manualMap.get(id), email: null };
  }

  // Directory profile is the only source of the sender's email. Still consult
  // it when we already have a name, but never let it override the name we were
  // handed. Fully error-safe + cached, so a broken/disabled People API just
  // means email stays null.
  const prof = await directoryProfile(id);
  return {
    name: displayName || prof.name || null,
    email: prof.email || null,
  };
}

/** Back-compat: just the name. */
async function resolveName(senderId, displayName) {
  return (await resolveSender(senderId, displayName)).name;
}

module.exports = { resolveName, resolveSender };

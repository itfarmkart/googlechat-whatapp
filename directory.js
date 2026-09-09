/**
 * Resolve a Google Chat `users/{id}` to a display name + email for the
 * WhatsApp signature and the message audit log.
 *
 * Order of preference:
 *   1. a name handed in by the /gchat webhook (it carries displayName),
 *   2. a manual entry in sender-names.json (people not in our directory —
 *      e.g. external partners),
 *   3. the Workspace directory profile (people:listDirectoryPeople), cached,
 *   4. null — caller falls back to a generic sign-off.
 *
 * Uses people:listDirectoryPeople (NOT people.get — that only reads the
 * caller's own contacts and returns an empty profile for directory members).
 * The whole domain profile list is pulled once and cached. No admin role
 * needed; DWD scope: https://www.googleapis.com/auth/directory.readonly
 * (also requires "contact sharing" ON in Admin console → Directory settings).
 */

const fs = require("fs");
const path = require("path");
const { userToken } = require("./clients");

const SCOPE = "https://www.googleapis.com/auth/directory.readonly";
const MAP_FILE =
  process.env.SENDER_NAMES_FILE || path.join(__dirname, "sender-names.json");

const cache = new Map(); // userId -> { name, email } | null

// Whole-directory snapshot: userId -> { name, email }. Refreshed on a TTL.
const DIRECTORY_TTL_MS = 60 * 60 * 1000;
let dirMap = null;
let dirLoadedAt = 0;
let dirLoading = null;

async function loadDirectory() {
  const token = await userToken([SCOPE]);
  const map = new Map();
  let pageToken = "";
  for (let page = 0; page < 25; page++) {
    const url = new URL(
      "https://people.googleapis.com/v1/people:listDirectoryPeople"
    );
    url.searchParams.set("readMask", "names,emailAddresses");
    url.searchParams.set("sources", "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE");
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = (await res.text()).replace(/\s+/g, " ").slice(0, 200);
      throw new Error(`listDirectoryPeople ${res.status}: ${body}`);
    }
    const j = await res.json();
    for (const p of j.people || []) {
      const id = String(p.resourceName || "").replace(/^people\//, "");
      if (!id) continue;
      const names = p.names || [];
      const emails = p.emailAddresses || [];
      const name =
        (names.find((n) => n.metadata?.primary) || names[0])?.displayName ||
        null;
      const email =
        (emails.find((e) => e.metadata?.primary) || emails[0])?.value || null;
      map.set(id, { name, email });
    }
    pageToken = j.nextPageToken || "";
    if (!pageToken) break;
  }
  console.log(`directory: loaded ${map.size} domain profiles`);
  return map;
}

async function ensureDirectory() {
  if (dirMap && Date.now() - dirLoadedAt < DIRECTORY_TTL_MS) return dirMap;
  if (dirLoading) return dirLoading;
  dirLoading = loadDirectory()
    .then((m) => {
      dirMap = m;
      dirLoadedAt = Date.now();
      cache.clear(); // drop per-id negatives so new hires resolve
      return m;
    })
    .catch((err) => {
      console.error("directory load failed:", err.message);
      return dirMap || new Map(); // serve stale on failure
    })
    .finally(() => {
      dirLoading = null;
    });
  return dirLoading;
}

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
    const dir = await ensureDirectory();
    const hit = dir.get(id);
    if (hit && (hit.name || hit.email)) {
      console.log(`directory: users/${id} -> "${hit.name}" <${hit.email}>`);
      cache.set(id, hit);
      return hit;
    }
    console.log(
      `directory: no domain profile for users/${id} — add "${id}": "Their Name" to sender-names.json if external`
    );
  } catch (err) {
    console.error("directory lookup failed:", err.message);
  }
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

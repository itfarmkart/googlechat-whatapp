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

const cache = new Map(); // userId -> name | null

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

async function directoryName(id) {
  if (cache.has(id)) return cache.get(id);
  try {
    const token = await userToken([SCOPE]);
    const res = await fetch(
      `https://people.googleapis.com/v1/people/${id}?personFields=names`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.ok) {
      const j = await res.json();
      const names = j.names || [];
      const primary =
        names.find((n) => n.metadata?.primary) || names[0] || null;
      const name = primary?.displayName || null;
      cache.set(id, name);
      return name;
    }
    if (res.status === 404) {
      cache.set(id, null); // external / unknown — stop retrying
      console.log(
        `directory: no profile for users/${id} — add "${id}": "Their Name" to sender-names.json`
      );
      return null;
    }
    console.error(
      `directory lookup ${res.status} for users/${id}: ${(await res.text())
        .replace(/\s+/g, " ")
        .slice(0, 160)}`
    );
  } catch (err) {
    console.error("directory lookup failed:", err.message);
  }
  return null;
}

/**
 * @param {string} [senderId]    "users/123..." or "123..."
 * @param {string} [displayName] name already supplied by the caller
 * @returns {Promise<string|null>}
 */
async function resolveName(senderId, displayName) {
  if (displayName) return displayName;
  if (!senderId) return null;

  const id = String(senderId).replace(/^users\//, "");

  loadManualMap();
  if (manualMap.has(id)) return manualMap.get(id);

  return directoryName(id);
}

module.exports = { resolveName };

/**
 * Mapping store: customer <-> Google Chat space <-> WhatsApp chat.
 * JSON file with atomic writes. Swap for Postgres when you outgrow it.
 */

const fs = require("fs");
const path = require("path");

const FILE = process.env.STORE_FILE || path.join(__dirname, "routes.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { routes: [] };
  }
}

function save(data) {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

/** Normalise a phone to Periskope's 1-1 chat_id form: 919876543210@c.us */
function toChatId(phone) {
  const digits = String(phone).replace(/\D/g, "");
  if (!digits) throw new Error("empty phone");
  const withCc = digits.length === 10 ? `91${digits}` : digits;
  return `${withCc}@c.us`;
}

function addRoute({ customerName, customerPhone, spaceName, department }) {
  const db = load();
  const chatId = toChatId(customerPhone);

  const existing = db.routes.find((r) => r.chatId === chatId);
  if (existing) {
    Object.assign(existing, { customerName, spaceName, department });
  } else {
    db.routes.push({
      customerName,
      customerPhone: String(customerPhone),
      chatId,
      spaceName,
      department: department || null,
      createdAt: new Date().toISOString(),
    });
  }

  save(db);
  return db.routes.find((r) => r.chatId === chatId);
}

const bySpace = (spaceName) =>
  load().routes.find((r) => r.spaceName === spaceName) || null;

const byChatId = (chatId) =>
  load().routes.find((r) => r.chatId === chatId) || null;

const byPhone = (phone) => {
  try {
    return byChatId(toChatId(phone));
  } catch {
    return null;
  }
};

const all = () => load().routes;

module.exports = { addRoute, bySpace, byChatId, byPhone, all, toChatId };

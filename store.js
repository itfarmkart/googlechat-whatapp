/**
 * Mapping store: customer <-> Google Chat space <-> WhatsApp chat.
 *
 * Two backends, chosen by env:
 *   - MySQL   when DATABASE_URL or MYSQL_HOST is set (Vercel / production)
 *   - JSON file otherwise (local dev, tests) — STORE_FILE or ./routes.json
 *
 * The read/write API is async either way. toChatId() stays sync.
 */

const fs = require("fs");
const path = require("path");

const USE_MYSQL = !!(process.env.DATABASE_URL || process.env.MYSQL_HOST);

/** Normalise a phone to Periskope's 1-1 chat_id form: 919876543210@c.us */
function toChatId(phone) {
  const digits = String(phone).replace(/\D/g, "");
  if (!digits) throw new Error("empty phone");
  const withCc = digits.length === 10 ? `91${digits}` : digits;
  return `${withCc}@c.us`;
}

// --------------------------------------------------------------- JSON file

const FILE = process.env.STORE_FILE || path.join(__dirname, "routes.json");

function fileLoad() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { routes: [] };
  }
}
function fileSave(data) {
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

const fileBackend = {
  async addRoute({ customerName, customerPhone, spaceName, department }) {
    const db = fileLoad();
    const chatId = toChatId(customerPhone);
    const existing = db.routes.find((r) => r.chatId === chatId);
    if (existing) {
      Object.assign(existing, { customerName, spaceName, department: department || null });
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
    fileSave(db);
    return db.routes.find((r) => r.chatId === chatId);
  },
  async bySpace(spaceName) {
    return fileLoad().routes.find((r) => r.spaceName === spaceName) || null;
  },
  async byChatId(chatId) {
    return fileLoad().routes.find((r) => r.chatId === chatId) || null;
  },
  async all() {
    return fileLoad().routes;
  },
};

// ------------------------------------------------------------------ MySQL

let pool;
let tableReady;

function mysqlPool() {
  if (pool) return pool;
  const mysql = require("mysql2/promise");
  const common = {
    connectionLimit: 3,
    maxIdle: 1,
    idleTimeout: 30_000,
    enableKeepAlive: true,
    namedPlaceholders: false,
  };
  const ssl =
    process.env.MYSQL_SSL === "1" || /ssl-mode=REQUIRED/i.test(process.env.DATABASE_URL || "")
      ? { minVersion: "TLSv1.2", rejectUnauthorized: true }
      : undefined;

  pool = process.env.DATABASE_URL
    ? mysql.createPool(
        Object.assign({ uri: process.env.DATABASE_URL }, common, ssl ? { ssl } : {})
      )
    : mysql.createPool(
        Object.assign(
          {
            host: process.env.MYSQL_HOST,
            port: Number(process.env.MYSQL_PORT || 3306),
            user: process.env.MYSQL_USER,
            password: process.env.MYSQL_PASSWORD,
            database: process.env.MYSQL_DATABASE,
          },
          common,
          ssl ? { ssl } : {}
        )
      );
  return pool;
}

async function ensureTable() {
  if (tableReady) return tableReady;
  tableReady = mysqlPool()
    .query(
      `CREATE TABLE IF NOT EXISTS routes (
         chat_id        VARCHAR(64)  NOT NULL PRIMARY KEY,
         customer_name  VARCHAR(255) NOT NULL,
         customer_phone VARCHAR(32)  NOT NULL,
         space_name     VARCHAR(191) NOT NULL,
         department     VARCHAR(64)  NULL,
         created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
         UNIQUE KEY uniq_space_name (space_name)
       )`
    )
    .then(() => true);
  return tableReady;
}

const rowToRoute = (r) =>
  r
    ? {
        customerName: r.customer_name,
        customerPhone: String(r.customer_phone),
        chatId: r.chat_id,
        spaceName: r.space_name,
        department: r.department ?? null,
        createdAt:
          r.created_at instanceof Date
            ? r.created_at.toISOString()
            : r.created_at,
      }
    : null;

const mysqlBackend = {
  async addRoute({ customerName, customerPhone, spaceName, department }) {
    await ensureTable();
    const chatId = toChatId(customerPhone);
    await mysqlPool().query(
      `INSERT INTO routes (chat_id, customer_name, customer_phone, space_name, department)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         customer_name = VALUES(customer_name),
         space_name    = VALUES(space_name),
         department    = VALUES(department)`,
      [chatId, customerName, String(customerPhone), spaceName, department || null]
    );
    return this.byChatId(chatId);
  },
  async bySpace(spaceName) {
    await ensureTable();
    const [rows] = await mysqlPool().query(
      "SELECT * FROM routes WHERE space_name = ? LIMIT 1",
      [spaceName]
    );
    return rowToRoute(rows[0]);
  },
  async byChatId(chatId) {
    await ensureTable();
    const [rows] = await mysqlPool().query(
      "SELECT * FROM routes WHERE chat_id = ? LIMIT 1",
      [chatId]
    );
    return rowToRoute(rows[0]);
  },
  async all() {
    await ensureTable();
    const [rows] = await mysqlPool().query(
      "SELECT * FROM routes ORDER BY created_at"
    );
    return rows.map(rowToRoute);
  },
};

// ------------------------------------------------------------------ facade

const backend = USE_MYSQL ? mysqlBackend : fileBackend;

const addRoute = (r) => backend.addRoute(r);
const bySpace = (spaceName) => backend.bySpace(spaceName);
const byChatId = (chatId) => backend.byChatId(chatId);
const byPhone = async (phone) => {
  try {
    return await backend.byChatId(toChatId(phone));
  } catch {
    return null;
  }
};
const all = () => backend.all();

module.exports = { addRoute, bySpace, byChatId, byPhone, all, toChatId };

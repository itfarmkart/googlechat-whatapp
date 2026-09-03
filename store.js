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
  async logMessage(m) {
    fs.appendFileSync(
      `${FILE}.messages.jsonl`,
      JSON.stringify({ ...m, createdAt: new Date().toISOString() }) + "\n"
    );
  },
  async messages({ spaceName, chatId, limit = 100 } = {}) {
    let lines;
    try {
      lines = fs.readFileSync(`${FILE}.messages.jsonl`, "utf8").trim().split("\n");
    } catch {
      return [];
    }
    return lines
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((m) => (!spaceName || m.spaceName === spaceName) && (!chatId || m.chatId === chatId))
      .reverse()
      .slice(0, limit);
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
  // MYSQL_SSL=1 -> encrypted; verify the chain only if MYSQL_CA is supplied
  // (managed DBs like DigitalOcean use a private CA the host doesn't trust).
  const wantSsl =
    process.env.MYSQL_SSL === "1" ||
    /ssl-mode=REQUIRED/i.test(process.env.DATABASE_URL || "");
  const ssl = wantSsl
    ? {
        minVersion: "TLSv1.2",
        rejectUnauthorized: !!process.env.MYSQL_CA,
        ca: process.env.MYSQL_CA || undefined,
      }
    : undefined;

  // mysql2 doesn't grok query params like ?ssl-mode=REQUIRED — strip them.
  const uri = process.env.DATABASE_URL
    ? process.env.DATABASE_URL.split("?")[0]
    : null;

  pool = uri
    ? mysql.createPool(Object.assign({ uri }, common, ssl ? { ssl } : {}))
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
  const p = mysqlPool();
  tableReady = p
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
    .then(() =>
      p.query(
        `CREATE TABLE IF NOT EXISTS messages (
           id            BIGINT AUTO_INCREMENT PRIMARY KEY,
           direction     VARCHAR(8)   NOT NULL,          -- 'out' team->customer, 'in' customer->team, 'note' internal (//)
           space_name    VARCHAR(191) NOT NULL,
           chat_id       VARCHAR(64)  NOT NULL,
           customer_name VARCHAR(255) NULL,
           sender_name   VARCHAR(255) NULL,              -- employee (out) / customer (in)
           sender_email  VARCHAR(255) NULL,              -- employee email (out only)
           body          TEXT         NULL,
           media_url     VARCHAR(1024) NULL,
           ref_id        VARCHAR(191) NULL,              -- periskope queue id (out) / chat msg name (in)
           created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
           INDEX idx_msg_space   (space_name, created_at),
           INDEX idx_msg_chat    (chat_id, created_at),
           INDEX idx_msg_created (created_at)
         )`
      )
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
  async logMessage(m) {
    await ensureTable();
    await mysqlPool().query(
      `INSERT INTO messages
         (direction, space_name, chat_id, customer_name, sender_name, sender_email, body, media_url, ref_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        m.direction,
        m.spaceName || "",
        m.chatId || "",
        m.customerName || null,
        m.senderName || null,
        m.senderEmail || null,
        m.body || null,
        m.mediaUrl || null,
        m.refId || null,
      ]
    );
  },
  async messages({ spaceName, chatId, limit = 100 } = {}) {
    await ensureTable();
    const where = [];
    const args = [];
    if (spaceName) (where.push("space_name = ?"), args.push(spaceName));
    if (chatId) (where.push("chat_id = ?"), args.push(chatId));
    const sql =
      "SELECT * FROM messages" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY created_at DESC LIMIT ?";
    args.push(Math.min(Number(limit) || 100, 1000));
    const [rows] = await mysqlPool().query(sql, args);
    return rows.map((r) => ({
      id: r.id,
      direction: r.direction,
      spaceName: r.space_name,
      chatId: r.chat_id,
      customerName: r.customer_name,
      senderName: r.sender_name,
      senderEmail: r.sender_email,
      body: r.body,
      mediaUrl: r.media_url,
      refId: r.ref_id,
      createdAt:
        r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    }));
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
const logMessage = (m) => backend.logMessage(m);
const messages = (opts) => backend.messages(opts);

module.exports = {
  addRoute,
  bySpace,
  byChatId,
  byPhone,
  all,
  logMessage,
  messages,
  toChatId,
};

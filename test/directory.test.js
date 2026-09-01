/**
 * Unit tests for directory.resolveName — no network (a supplied name or the
 * manual map short-circuits before any Admin Directory call).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const MAP = path.join(os.tmpdir(), `sender-names-${process.pid}.json`);
fs.writeFileSync(
  MAP,
  JSON.stringify({
    __comment: "ignored",
    "108316318617767504386": "Akshay Rao",
    "users/222": "Prefixed Key",
    "333": "  Trimmed  ",
    bad: "not numeric",
  })
);
process.env.SENDER_NAMES_FILE = MAP;

// stub ./clients so requiring directory.js doesn't pull real google-auth
const clientsPath = require.resolve("../clients");
require.cache[clientsPath] = {
  id: clientsPath,
  filename: clientsPath,
  loaded: true,
  exports: {
    userToken: async () => {
      throw new Error("network not allowed in this test");
    },
  },
};

const { resolveName } = require("../directory");

test.after(() => {
  try {
    fs.unlinkSync(MAP);
  } catch {}
});

test("a supplied display name wins outright", async () => {
  assert.equal(await resolveName("users/999", "Priya Sharma"), "Priya Sharma");
});

test("falls back to the manual map by numeric id", async () => {
  assert.equal(await resolveName("users/108316318617767504386"), "Akshay Rao");
});

test("manual map accepts a bare id and a users/ prefixed key", async () => {
  assert.equal(await resolveName("108316318617767504386"), "Akshay Rao");
  assert.equal(await resolveName("users/222"), "Prefixed Key");
});

test("manual map values are trimmed", async () => {
  assert.equal(await resolveName("333"), "Trimmed");
});

test("unknown id with no name returns null (no network in test)", async () => {
  // "bad" key was non-numeric so it's not in the map; no id given here
  assert.equal(await resolveName(null), null);
  assert.equal(await resolveName(undefined, ""), null);
});

test("edits to the map file are picked up without a restart", async () => {
  fs.writeFileSync(MAP, JSON.stringify({ "444": "Later Added" }));
  // mtime-based reload — bump mtime to be safe on coarse filesystems
  const t = Date.now() / 1000 + 2;
  fs.utimesSync(MAP, t, t);
  assert.equal(await resolveName("users/444"), "Later Added");
});

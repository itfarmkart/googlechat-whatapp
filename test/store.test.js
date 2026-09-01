/**
 * Unit tests for store.js — pure logic, no network, no credentials.
 *   npm run test:store
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// Point the store at a throwaway file before requiring it.
const TMP = path.join(os.tmpdir(), `routes-test-${process.pid}.json`);
process.env.STORE_FILE = TMP;

const store = require("../store");

test.beforeEach(() => {
  try {
    fs.unlinkSync(TMP);
  } catch {}
});

test.after(() => {
  try {
    fs.unlinkSync(TMP);
  } catch {}
});

test("toChatId normalises a 10-digit number to India chat_id form", () => {
  assert.equal(store.toChatId("9876543210"), "919876543210@c.us");
});

test("toChatId strips spaces, plus signs and punctuation", () => {
  assert.equal(store.toChatId("+91 98765-43210"), "919876543210@c.us");
});

test("toChatId leaves an already country-coded number alone", () => {
  assert.equal(store.toChatId("919876543210"), "919876543210@c.us");
});

test("toChatId throws on an empty / non-numeric phone", () => {
  assert.throws(() => store.toChatId("abc"), /empty phone/);
});

test("addRoute inserts a new route and it is findable both ways", async () => {
  const route = await store.addRoute({
    customerName: "Ramesh Patidar",
    customerPhone: "919876543210",
    spaceName: "spaces/AAA",
    department: "solar",
  });

  assert.equal(route.chatId, "919876543210@c.us");
  assert.equal(route.customerName, "Ramesh Patidar");
  assert.ok(route.createdAt, "createdAt is stamped");

  assert.deepEqual(await store.bySpace("spaces/AAA"), route);
  assert.deepEqual(await store.byChatId("919876543210@c.us"), route);
  assert.equal((await store.all()).length, 1);
});

test("addRoute updates in place when the same number is provisioned again", async () => {
  await store.addRoute({
    customerName: "Old Name",
    customerPhone: "919876543210",
    spaceName: "spaces/OLD",
    department: "solar",
  });

  const updated = await store.addRoute({
    customerName: "New Name",
    customerPhone: "919876543210",
    spaceName: "spaces/NEW",
    department: "agri",
  });

  assert.equal((await store.all()).length, 1, "no duplicate row");
  assert.equal(updated.customerName, "New Name");
  assert.equal(updated.spaceName, "spaces/NEW");
  assert.equal(updated.department, "agri");
  assert.equal(await store.bySpace("spaces/OLD"), null, "old space no longer maps");
});

test("lookups return null when nothing matches", async () => {
  assert.equal(await store.bySpace("spaces/nope"), null);
  assert.equal(await store.byChatId("910000000000@c.us"), null);
});

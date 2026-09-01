/**
 * Unit tests for sheet-sync.poll — the row-scanning / provision-dispatch logic,
 * with the Sheets fetch and provision() stubbed.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

process.env.SHEET_ID = "TEST_SHEET";
process.env.SHEET_TAB = "Leegality";
process.env.SHEET_FIRST_ROW = "3"; // header row 1, one pre-existing row at 2
process.env.SHEET_HEADER_ROW = "1";
process.env.SHEET_COL_NAME = "Aadhaar Name English";
process.env.SHEET_COL_PHONE = "Mobile No";
process.env.SHEET_COL_SALES = "Sales Person Email";
process.env.SHEET_COL_STATUS = "Status";
process.env.SHEET_STATUS_DONE = "Completed";

const STORE_FILE = path.join(os.tmpdir(), `sheetsync-${process.pid}.json`);
process.env.STORE_FILE = STORE_FILE;

// stub ./clients (saToken) and ./provision before requiring sheet-sync
const provisionCalls = [];
const clientsPath = require.resolve("../clients");
require.cache[clientsPath] = {
  id: clientsPath,
  filename: clientsPath,
  loaded: true,
  exports: { saToken: async () => "tok" },
};
const provisionPath = require.resolve("../provision");
require.cache[provisionPath] = {
  id: provisionPath,
  filename: provisionPath,
  loaded: true,
  exports: {
    provision: async (args) => {
      provisionCalls.push(args);
      return { route: { spaceName: "spaces/NEW", chatId: `${args.phone}@c.us` }, manualAdds: [] };
    },
    TEAM_LEADS: [],
  },
};

const store = require("../store");
const sheetSync = require("../sheet-sync");

// stub the Sheets HTTP call
const HEADER = ["Aadhaar Name English", "Mobile No", "Sales Person Email", "Status"];
let sheetRows = [HEADER];
global.fetch = async () => ({
  ok: true,
  json: async () => ({ values: sheetRows }),
  text: async () => "",
});

test.beforeEach(() => {
  provisionCalls.length = 0;
  try {
    fs.unlinkSync(STORE_FILE);
  } catch {}
});
test.after(() => {
  try {
    fs.unlinkSync(STORE_FILE);
  } catch {}
});

test("provisions only Completed rows at/after SHEET_FIRST_ROW", async () => {
  sheetRows = [
    HEADER,
    ["Old Cust", "919000000002", "s@farmkart.com", "Completed"], // row 2 — below floor
    ["Ramesh Patidar", "919000001071", "sales1@farmkart.com", "Completed"], // row 3
    ["Pending Person", "919000001072", "sales2@farmkart.com", "Sent"], // row 4 — wrong status
    ["Sita Devi", "9190000010 73", "sales3@farmkart.com", "completed"], // row 5 — case + spaces
  ];

  await sheetSync.poll();

  const names = provisionCalls.map((c) => c.name);
  assert.deepEqual(names, ["Ramesh Patidar", "Sita Devi"]);
  assert.equal(provisionCalls[0].displayName, "Ramesh Patidar - 919000001071");
  assert.deepEqual(provisionCalls[0].extraMembers, ["sales1@farmkart.com"]);
  assert.equal(provisionCalls[1].phone, "919000001073"); // non-digits stripped
});

test("skips a phone that already has a route", async () => {
  await store.addRoute({
    customerName: "Ramesh Patidar",
    customerPhone: "919000001071",
    spaceName: "spaces/EXISTING",
  });
  sheetRows = [
    HEADER,
    [], // row 2 filler
    ["Ramesh Patidar", "919000001071", "sales1@farmkart.com", "Completed"],
    ["New Person", "919000001099", "sales2@farmkart.com", "Completed"],
  ];

  await sheetSync.poll();

  assert.deepEqual(
    provisionCalls.map((c) => c.name),
    ["New Person"]
  );
});

test("skips rows missing a name or with a short phone", async () => {
  sheetRows = [
    HEADER,
    [],
    ["", "919000001071", "s@farmkart.com", "Completed"],
    ["No Phone", "12345", "s@farmkart.com", "Completed"],
  ];
  await sheetSync.poll();
  assert.equal(provisionCalls.length, 0);
});

test("columnIndexes throws on a missing column", () => {
  assert.throws(
    () => sheetSync.columnIndexes(["Aadhaar Name English", "Mobile No"]),
    /Sales Person Email/
  );
});

test("msUntilNextRun targets the next midnight / noon", () => {
  const min = 60 * 1000;
  // 09:30 -> next run is noon, ~2h30m away
  let ms = sheetSync.msUntilNextRun(new Date(2026, 0, 1, 9, 30, 0));
  assert.ok(Math.abs(ms - (2 * 60 + 30) * min) < min, `${ms}`);
  // 15:00 -> next run is midnight, ~9h away
  ms = sheetSync.msUntilNextRun(new Date(2026, 0, 1, 15, 0, 0));
  assert.ok(Math.abs(ms - 9 * 60 * min) < min, `${ms}`);
  // exactly noon -> next is the following midnight, ~12h
  ms = sheetSync.msUntilNextRun(new Date(2026, 0, 1, 12, 0, 0));
  assert.ok(Math.abs(ms - 12 * 60 * min) < min, `${ms}`);
});

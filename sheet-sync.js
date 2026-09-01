/**
 * Auto-provision from a Google Sheet.
 *
 * Polls one tab. For each data row at/after SHEET_FIRST_ROW whose status column
 * equals the "done" value, and whose phone isn't already mapped, it provisions
 * a space named "<name> - <phone>" with TEAM_LEADS + that row's salesperson.
 *
 * Env:
 *   SHEET_ID              spreadsheet id (from the URL)
 *   SHEET_TAB             tab name                       (default "Leegality")
 *   SHEET_FIRST_ROW       first data row to consider     (default 1071)
 *   SHEET_HEADER_ROW      row holding column headers     (default 1)
 *   SHEET_COL_NAME        name column header             (default "Aadhaar Name English")
 *   SHEET_COL_PHONE       phone column header            (default "Mobile No")
 *   SHEET_COL_SALES       salesperson email column       (default "Sales Person Email")
 *   SHEET_COL_STATUS      status column header           (default "Status")
 *   SHEET_STATUS_DONE     status value that triggers     (default "Completed")
 *   SHEET_POLL_MS         poll interval                  (default 300000)
 */

const { saToken } = require("./clients");
const store = require("./store");
const { provision } = require("./provision");

const SHEET_ID = process.env.SHEET_ID;
const TAB = process.env.SHEET_TAB || "Leegality";
const FIRST_ROW = Number(process.env.SHEET_FIRST_ROW || 1071);
const HEADER_ROW = Number(process.env.SHEET_HEADER_ROW || 1);
const COL = {
  name: process.env.SHEET_COL_NAME || "Aadhaar Name English",
  phone: process.env.SHEET_COL_PHONE || "Mobile No",
  sales: process.env.SHEET_COL_SALES || "Assign to Site Visit",
  status: process.env.SHEET_COL_STATUS || "Agreement signed status (Leegality)",
};
const STATUS_DONE = (process.env.SHEET_STATUS_DONE || "COMPLETED")
  .trim()
  .toLowerCase();
// Hours of the day (local time) to run at. Default: midnight and noon.
const RUN_HOURS = (process.env.SHEET_RUN_HOURS || "0,12")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((h) => Number.isInteger(h) && h >= 0 && h < 24);
const DRY_RUN = process.env.SHEET_DRY_RUN === "1";
const MAX_PER_POLL = Number(process.env.SHEET_MAX_PER_POLL || 15);

async function readValues() {
  const token = await saToken([
    "https://www.googleapis.com/auth/spreadsheets.readonly",
  ]);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/` +
      encodeURIComponent(TAB),
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    throw new Error(`Sheets ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const { values = [] } = await res.json();
  return values; // values[0] === sheet row 1
}

function columnIndexes(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => {
    map[String(h).trim().toLowerCase()] = i;
  });
  const need = (label) => {
    const i = map[label.trim().toLowerCase()];
    if (i === undefined) throw new Error(`sheet column not found: "${label}"`);
    return i;
  };
  return {
    name: need(COL.name),
    phone: need(COL.phone),
    sales: need(COL.sales),
    status: need(COL.status),
  };
}

let running = false;

async function poll() {
  if (!SHEET_ID) return { skipped: "SHEET_ID not set" };
  if (running) return { skipped: "already running" };
  running = true;
  const result = { candidates: 0, made: 0, dryRun: DRY_RUN, errors: [] };
  try {
    const values = await readValues();
    if (values.length < HEADER_ROW) return result;

    const cols = columnIndexes(values[HEADER_ROW - 1]);
    let made = 0;
    let candidates = 0;

    for (let r = FIRST_ROW - 1; r < values.length; r++) {
      const row = values[r] || [];
      const status = String(row[cols.status] || "").trim().toLowerCase();
      if (status !== STATUS_DONE) continue;

      const name = String(row[cols.name] || "").trim();
      const phone = String(row[cols.phone] || "").replace(/\D/g, "");
      const sales = String(row[cols.sales] || "").trim();
      if (!name || phone.length < 10) continue;
      if (await store.byPhone(phone)) continue; // already has a space

      candidates++;
      if (DRY_RUN) {
        console.log(
          `sheet-sync[dry]: row ${r + 1}  "${name} - ${phone}"  sales=${sales || "-"}`
        );
        continue;
      }
      if (made >= MAX_PER_POLL) continue; // cap per cycle; picked up next poll

      try {
        const { route, manualAdds } = await provision({
          name,
          phone,
          displayName: `${name} - ${phone}`,
          extraMembers: sales ? [sales] : [],
        });
        made++;
        console.log(
          `sheet-sync: row ${r + 1} -> ${route.spaceName}` +
            (manualAdds?.length ? ` | add by hand: ${manualAdds.join(", ")}` : "")
        );
      } catch (err) {
        console.error(`sheet-sync: row ${r + 1} (${name}) failed: ${err.message}`);
        result.errors.push(`row ${r + 1}: ${err.message}`);
      }
    }

    result.candidates = candidates;
    result.made = made;

    if (DRY_RUN) {
      console.log(`sheet-sync[dry]: ${candidates} row(s) would be provisioned`);
    } else if (made) {
      console.log(
        `sheet-sync: provisioned ${made}/${candidates}` +
          (candidates > made ? ` (capped at ${MAX_PER_POLL}/run)` : "")
      );
    }
    return result;
  } catch (err) {
    console.error("sheet-sync poll failed:", err.message);
    result.errors.push(err.message);
    return result;
  } finally {
    running = false;
  }
}

function msUntilNextRun(now = new Date()) {
  let best = Infinity;
  for (const h of RUN_HOURS) {
    const t = new Date(now);
    t.setHours(h, 0, 0, 0);
    if (t <= now) t.setDate(t.getDate() + 1);
    best = Math.min(best, t - now);
  }
  return Number.isFinite(best) ? best : 12 * 60 * 60 * 1000;
}

let timer;
function scheduleNext() {
  const ms = msUntilNextRun();
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await poll();
    scheduleNext();
  }, ms);
  if (timer.unref) timer.unref();
  const at = new Date(Date.now() + ms);
  console.log(`sheet-sync: next run ${at.toLocaleString()}`);
}

function start() {
  if (!SHEET_ID) {
    console.log("sheet-sync: SHEET_ID not set — disabled");
    return;
  }
  console.log(
    `sheet-sync: watching "${TAB}" from row ${FIRST_ROW} at ${RUN_HOURS.map(
      (h) => `${String(h).padStart(2, "0")}:00`
    ).join(" & ")} local${
      DRY_RUN ? " [DRY RUN]" : ` (max ${MAX_PER_POLL}/run)`
    }`
  );
  poll(); // once on startup
  scheduleNext();
}

module.exports = { start, poll, columnIndexes, msUntilNextRun };

// `node --env-file=.env sheet-sync.js` — one run now, then exit.
if (require.main === module) {
  poll()
    .then((r) => {
      console.log("sheet-sync run:", JSON.stringify(r));
      process.exit(0);
    })
    .catch((err) => {
      console.error("sheet-sync failed:", err.message);
      process.exit(1);
    });
}

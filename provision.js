#!/usr/bin/env node
/**
 * Create a Google Chat space for one customer and wire it to their WhatsApp.
 *
 *   node provision.js --name "Ramesh Patidar" --phone 919876543210 \
 *                     --dept solar --ref RS-2041
 *
 * Steps: create space -> add team leads -> add the bridge app -> save mapping
 *        -> post a header card into the space.
 */

const {
  createSpaceWithMembers,
  addHumanToSpace,
  addAppToSpace,
  postToSpace,
  checkContact,
} = require("./clients");
const store = require("./store");

const HOME_DOMAIN = (process.env.GOOGLE_IMPERSONATE_USER || "").split("@")[1];

/**
 * Team leads added to every customer space. All myrsolar.com — the relay
 * runs on the myrsolar Workspace, so these are same-domain members (no
 * external-member limits). Edit this list, or point it at a Google Group.
 */
const TEAM_LEADS = [
  "akshay@myrsolar.com",
  "shailendrar@myrsolar.com",
  "abhishekn@myrsolar.com",
  "ravik@myrsolar.com",
  "anshulp@myrsolar.com",
  "yashp@myrsolar.com",
];

// The relay's single Workspace Events subscription targets every space this
// user belongs to, so they MUST be in each customer space or their messages
// never stream in. Keep this in sync with GOOGLE_IMPERSONATE_USER.
const ALWAYS_ADD = [process.env.GOOGLE_IMPERSONATE_USER].filter(Boolean);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "");
    out[key] = argv[i + 1];
  }
  return out;
}

async function provision({
  name,
  phone,
  dept = null,
  ref,
  displayName: displayNameOverride,
  extraMembers = [],
}) {
  if (!name || !phone) throw new Error("--name and --phone are required");

  // Periskope wants full international digits; sheet rows are often 10-digit.
  const digits = String(phone).replace(/\D/g, "");
  const intlPhone = digits.length === 10 ? `91${digits}` : digits;

  // 1. Don't create a space for a number that isn't on WhatsApp.
  //    A failed *check* is non-fatal (warn and continue); a check that comes
  //    back saying the number doesn't exist is fatal.
  let check;
  try {
    check = await checkContact(intlPhone);
  } catch (err) {
    console.warn(`  contact check skipped: ${err.message}`);
  }
  if (check) {
    const entry = Array.isArray(check) ? check[0] : check?.contacts?.[0];
    if (entry && entry.exists === false) {
      throw new Error(`${intlPhone} is not registered on WhatsApp`);
    }
  }

  // 2. Create the space with the home-domain (farmkart.com) leads. Google
  //    won't let this credential create an external space or add external
  //    members, so cross-org leads (myrsolar.com) are added by hand after.
  //    displayName must be unique across the Workspace — phone keeps it so.
  const displayName =
    displayNameOverride || (ref ? `${name} — ${ref}` : `${name} — ${phone}`);
  const all = [
    ...new Set(
      [...TEAM_LEADS, ...ALWAYS_ADD, ...extraMembers]
        .map((e) => String(e).trim().toLowerCase())
        .filter((e) => e.includes("@"))
    ),
  ];
  const homeMembers = all.filter((e) => e.split("@")[1] === HOME_DOMAIN);
  const externalMembers = all.filter((e) => e.split("@")[1] !== HOME_DOMAIN);

  console.log(`Creating space "${displayName}" (${homeMembers.length} members)`);
  const space = await createSpaceWithMembers({
    displayName,
    description: `Customer channel — WhatsApp relay to ${phone}`,
    memberEmails: homeMembers,
  });
  console.log(`  ${space.name}`);

  // 2b. Try the cross-org leads via API in case delegation ever gains the
  //     right; collect the ones that still need a manual add.
  const manualAdds = [];
  for (const email of externalMembers) {
    try {
      await addHumanToSpace(space.name, email);
      console.log(`  + ${email}`);
    } catch {
      manualAdds.push(email);
    }
  }

  // 3. Add the bridge app so it can post and receive MESSAGE events.
  await addAppToSpace(space.name);
  console.log("  bridge app added");

  // 4. Save the mapping the relay reads on every message.
  const route = await store.addRoute({
    customerName: name,
    customerPhone: intlPhone,
    spaceName: space.name,
    department: dept,
  });

  // 5. Orientation message so leads know how this space behaves.
  const lines = [
    `*${name}* — ${phone}`,
    "",
    "Anything posted here is relayed to the customer on WhatsApp.",
    "Their replies come back into this space.",
    "",
    "Start a line with `//` to keep it internal.",
  ];
  if (manualAdds.length) {
    lines.push(
      "",
      `_Still to add manually (external): ${manualAdds.join(", ")}_`
    );
  }
  await postToSpace(space.name, lines.join("\n"));

  if (manualAdds.length) {
    console.log(
      `\n  ⚠ add these people to the space by hand (external org):\n` +
      manualAdds.map((e) => `      ${e}`).join("\n")
    );
  }

  return { route, manualAdds };
}

if (require.main === module) {
  provision(parseArgs(process.argv.slice(2)))
    .then(({ route }) =>
      console.log("\nLinked:", route.spaceName, "<->", route.chatId)
    )
    .catch((err) => {
      console.error("Failed:", err.message);
      process.exit(1);
    });
}

module.exports = { provision, TEAM_LEADS };

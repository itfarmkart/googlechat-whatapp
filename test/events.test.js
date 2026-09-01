/**
 * Unit tests for the pure helpers in events.js (Pub/Sub payload parsing and
 * @mention stripping). No network.
 *   npm run test -- test/events.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.GOOGLE_KEY_FILE =
  process.env.GOOGLE_KEY_FILE || "./service-account.json";
process.env.GOOGLE_CLOUD_PROJECT = "test-project"; // avoid reading the key file

const { parseChatEvent, cleanText, pubsubTopic, EVENT_TYPE } = require("../events");

function pubsubMessage(payload, attributes) {
  return {
    data: Buffer.from(JSON.stringify(payload), "utf8"),
    attributes,
  };
}

test("parseChatEvent pulls the message resource and event type", () => {
  const msg = pubsubMessage(
    {
      message: {
        name: "spaces/AAA/messages/BBB.BBB",
        text: "hello team",
        sender: { displayName: "Priya Sharma", type: "HUMAN" },
        space: { name: "spaces/AAA" },
      },
    },
    {
      "ce-type": EVENT_TYPE,
      "ce-subject": "//chat.googleapis.com/spaces/AAA/messages/BBB.BBB",
    }
  );

  const out = parseChatEvent(msg);
  assert.equal(out.eventType, EVENT_TYPE);
  assert.equal(out.message.text, "hello team");
  assert.equal(out.messageName, "spaces/AAA/messages/BBB.BBB");
});

test("parseChatEvent falls back to ce-subject when resource is absent", () => {
  const msg = pubsubMessage(
    {},
    {
      "ce-type": EVENT_TYPE,
      "ce-subject": "//chat.googleapis.com/spaces/AAA/messages/CCC",
    }
  );
  const out = parseChatEvent(msg);
  assert.equal(out.message, null);
  assert.equal(out.messageName, "spaces/AAA/messages/CCC");
});

test("parseChatEvent returns null on non-JSON data", () => {
  assert.equal(
    parseChatEvent({ data: Buffer.from("not json"), attributes: {} }),
    null
  );
});

test("parseChatEvent accepts a string data field", () => {
  const out = parseChatEvent({
    data: JSON.stringify({ message: { name: "spaces/A/messages/D", text: "x" } }),
    attributes: { "ce-type": EVENT_TYPE },
  });
  assert.equal(out.message.text, "x");
  assert.equal(out.messageName, "spaces/A/messages/D");
});

test("cleanText strips a leading bot @mention", () => {
  const mention = "@Farmkart Customer Relay";
  const message = {
    text: `${mention} please send the quote`,
    annotations: [
      {
        type: "USER_MENTION",
        startIndex: 0,
        length: mention.length,
        userMention: { user: { type: "BOT", displayName: "Farmkart Customer Relay" } },
      },
    ],
  };
  assert.equal(cleanText(message), "please send the quote");
});

test("cleanText strips multiple bot mentions and keeps human mentions", () => {
  // "@Bot hi @Alice @Bot bye"  — remove both @Bot, keep @Alice
  const text = "@Bot hi @Alice @Bot bye";
  const message = {
    text,
    annotations: [
      { type: "USER_MENTION", startIndex: 0, length: 4, userMention: { user: { type: "BOT" } } },
      { type: "USER_MENTION", startIndex: 8, length: 6, userMention: { user: { type: "HUMAN" } } },
      { type: "USER_MENTION", startIndex: 15, length: 4, userMention: { user: { type: "BOT" } } },
    ],
  };
  assert.equal(cleanText(message), "hi @Alice  bye".trim());
});

test("cleanText is a no-op without annotations", () => {
  assert.equal(cleanText({ text: "  just text  " }), "just text");
  assert.equal(cleanText({}), "");
});

test("pubsubTopic honours PUBSUB_TOPIC override", () => {
  const prev = process.env.PUBSUB_TOPIC;
  process.env.PUBSUB_TOPIC = "projects/x/topics/y";
  try {
    assert.equal(pubsubTopic(), "projects/x/topics/y");
  } finally {
    if (prev === undefined) delete process.env.PUBSUB_TOPIC;
    else process.env.PUBSUB_TOPIC = prev;
  }
});

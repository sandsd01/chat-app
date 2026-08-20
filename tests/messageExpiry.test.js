const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { resetDb, createUser, makeFriends, prisma } = require("./helpers/db");
const { expireMessages } = require("../src/lib/messageExpiry");
const chatBus = require("../src/lib/chatBus");

async function conversationFor(alice, bob) {
  return prisma.conversation.create({
    data: { userAId: Math.min(alice.id, bob.id), userBId: Math.max(alice.id, bob.id) },
  });
}

function sendAt(conversationId, senderId, body, expiresAt) {
  return prisma.message.create({ data: { conversationId, senderId, body, expiresAt } });
}

describe("expireMessages", () => {
  let alice;
  let bob;
  let conversation;

  beforeEach(async () => {
    await resetDb();
    alice = await createUser({ email: "alice@example.com" });
    bob = await createUser({ email: "bob@example.com" });
    await makeFriends(alice, bob);
    conversation = await conversationFor(alice, bob);
  });

  test("deletes messages past their expiry", async () => {
    const past = new Date(Date.now() - 1000);
    const expired = await sendAt(conversation.id, alice.id, "gone", past);

    const result = await expireMessages();

    assert.equal(result.deleted, 1);
    assert.equal(await prisma.message.findUnique({ where: { id: expired.id } }), null);
  });

  test("leaves messages whose expiry is still in the future", async () => {
    const future = new Date(Date.now() + 60_000);
    const alive = await sendAt(conversation.id, alice.id, "still here", future);

    await expireMessages();

    assert.ok(await prisma.message.findUnique({ where: { id: alive.id } }));
  });

  test("never touches a message with no expiry at all", async () => {
    const permanent = await sendAt(conversation.id, alice.id, "forever", null);

    await expireMessages();

    assert.ok(await prisma.message.findUnique({ where: { id: permanent.id } }));
  });

  test("publishes message-expired to both participants", async () => {
    const expired = await sendAt(conversation.id, alice.id, "gone", new Date(Date.now() - 1000));

    const seen = [];
    const unsubA = chatBus.subscribe(alice.id, (event, payload) => event === "message-expired" && seen.push(["a", payload]));
    const unsubB = chatBus.subscribe(bob.id, (event, payload) => event === "message-expired" && seen.push(["b", payload]));

    await expireMessages();
    unsubA();
    unsubB();

    assert.equal(seen.length, 2);
    assert.deepEqual(seen.map(([side]) => side).sort(), ["a", "b"]);
    for (const [, payload] of seen) {
      assert.equal(payload.id, expired.id);
      assert.equal(payload.conversationId, conversation.id);
    }
  });

  test("a reply to an expired message survives with its reference nulled", async () => {
    const original = await sendAt(conversation.id, alice.id, "original", new Date(Date.now() - 1000));
    const reply = await prisma.message.create({
      data: { conversationId: conversation.id, senderId: bob.id, body: "replying", replyToId: original.id },
    });

    await expireMessages();

    const stillThere = await prisma.message.findUnique({ where: { id: reply.id } });
    assert.ok(stillThere);
    assert.equal(stillThere.replyToId, null);
  });
});

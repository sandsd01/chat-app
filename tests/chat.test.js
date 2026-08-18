const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const request = require("supertest");
const { resetDb, createUser, makeFriends, prisma } = require("./helpers/db");
const app = require("../src/app");
const chatBus = require("../src/lib/chatBus");

function waitForEvent(userId, eventName, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for "${eventName}" event`));
    }, timeoutMs);
    const unsubscribe = chatBus.subscribe(userId, (event, payload) => {
      if (event !== eventName) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(payload);
    });
  });
}

async function login(email, password) {
  const res = await request(app).post("/api/auth/login").send({ email, password });
  return res.body.token;
}

// GET /chat/stream never ends its response (it's a long-lived SSE
// connection, kept open by a heartbeat interval), so driving it through
// supertest's normal `.then()`/`await` — which waits for the response body
// to finish — would hang the test run forever. Instead bind a throwaway
// listener, grab just the status/headers via the raw `http` module, and
// destroy the socket immediately so nothing is left open.
function probeStream(query) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const req = http.get(`http://127.0.0.1:${port}/api/chat/stream${query}`, (res) => {
        const result = { status: res.statusCode, headers: res.headers };
        res.resume(); // drain/discard whatever body arrives so 'close' fires
        req.destroy();
        server.close();
        resolve(result);
      });
      req.on("error", (err) => {
        server.close();
        reject(err);
      });
    });
  });
}

describe("Chat API", () => {
  let adminToken;
  let adminUser;
  let staffToken;
  let staffUser;
  let otherToken;
  let otherUser;

  beforeEach(async () => {
    await resetDb();
    adminUser = await createUser({ email: "admin@test.com", password: "adminpass1" });
    staffUser = await createUser({ email: "staff@test.com", password: "staffpass1" });
    otherUser = await createUser({ email: "other@test.com", password: "otherpass1" });
    adminToken = await login("admin@test.com", "adminpass1");
    staffToken = await login("staff@test.com", "staffpass1");
    otherToken = await login("other@test.com", "otherpass1");
    // The chat routes below are about conversation/message mechanics, not the
    // friend gate itself (see friends.test.js and the "friend gating" block
    // further down) — pre-friend everyone so those tests don't have to.
    await makeFriends(adminUser, staffUser);
    await makeFriends(adminUser, otherUser);
    await makeFriends(staffUser, otherUser);
  });

  describe("friend gating on POST /chat/conversations and sending", () => {
    test("404s starting a conversation with a non-friend", async () => {
      const stranger = await createUser({ email: "stranger@test.com", password: "strangerpass1" });
      const res = await request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ userId: stranger.id });
      assert.equal(res.status, 404);
    });

    test("a pending (not yet accepted) request does not satisfy the gate", async () => {
      const stranger = await createUser({ email: "pending@test.com", password: "pendingpass1" });
      await prisma.friendship.create({
        data: {
          userAId: Math.min(adminUser.id, stranger.id),
          userBId: Math.max(adminUser.id, stranger.id),
          status: "pending",
          requestedById: adminUser.id,
        },
      });
      const res = await request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ userId: stranger.id });
      assert.equal(res.status, 404);
    });

    test("a nonexistent userId 404s identically to a real non-friend's id, so the status code can't be used to enumerate accounts", async () => {
      const stranger = await createUser({ email: "stranger2@test.com", password: "strangerpass1" });
      const nonFriend = await request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ userId: stranger.id });
      const nonexistent = await request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ userId: stranger.id + 999999 });
      assert.equal(nonFriend.status, 404);
      assert.equal(nonexistent.status, 404);
      assert.deepEqual(nonFriend.body, nonexistent.body);
    });

    test("unfriending after a conversation exists blocks new sends but not reading history", async () => {
      const conv = await request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ userId: staffUser.id });
      assert.equal(conv.status, 201); // first conversation between this already-friended pair

      const sent = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ body: "before unfriending" });
      assert.equal(sent.status, 201);

      await request(app)
        .delete(`/api/friends/${staffUser.id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      const blockedSend = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ body: "after unfriending" });
      assert.equal(blockedSend.status, 403);

      const history = await request(app)
        .get(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${adminToken}`);
      assert.equal(history.status, 200);
      assert.equal(history.body.data.length, 1);
      assert.equal(history.body.data[0].body, "before unfriending");
    });
  });

  describe("POST /chat/uploads", () => {
    test("503s when attachments aren't configured", async () => {
      const conv = await request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ userId: staffUser.id });

      const res = await request(app)
        .post("/api/chat/uploads")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ conversationId: conv.body.id, fileName: "photo.jpg", mimeType: "image/jpeg", size: 1000 });
      assert.equal(res.status, 503);
    });
  });

  describe("POST /chat/conversations", () => {
    test("requires authentication", async () => {
      const res = await request(app).post("/api/chat/conversations").send({ userId: staffUser.id });
      assert.equal(res.status, 401);
    });

    test("400 on missing userId", async () => {
      const res = await request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});
      assert.equal(res.status, 400);
    });

    test("400 on non-integer userId", async () => {
      const res = await request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ userId: "not-a-number" });
      assert.equal(res.status, 400);
    });

    test("400 when targeting self", async () => {
      const res = await request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ userId: adminUser.id });
      assert.equal(res.status, 400);
    });

    test("404 on a nonexistent target user", async () => {
      const res = await request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ userId: 999999 });
      assert.equal(res.status, 404);
    });

    test("creates a conversation (201) and is idempotent find-or-create regardless of initiator direction", async () => {
      const created = await request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ userId: staffUser.id });
      assert.equal(created.status, 201);
      assert.equal(created.body.otherUser.id, staffUser.id);

      // A -> B again: same conversation, 200 not 201.
      const again = await request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ userId: staffUser.id });
      assert.equal(again.status, 200);
      assert.equal(again.body.id, created.body.id);

      // B -> A: same conversation too.
      const reverse = await request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ userId: adminUser.id });
      assert.equal(reverse.status, 200);
      assert.equal(reverse.body.id, created.body.id);
      assert.equal(reverse.body.otherUser.id, adminUser.id);

      const count = await prisma.conversation.count();
      assert.equal(count, 1, "only a single conversation row should exist for the pair");
    });

    test("two concurrent requests for the same new pair (e.g. a double-click) don't 500 and leave only one row", async () => {
      const [first, second] = await Promise.all([
        request(app)
          .post("/api/chat/conversations")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({ userId: staffUser.id }),
        request(app)
          .post("/api/chat/conversations")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({ userId: staffUser.id }),
      ]);

      const statuses = [first.status, second.status].sort();
      assert.deepEqual(statuses, [200, 201]);
      assert.equal(first.body.id, second.body.id);

      const count = await prisma.conversation.count();
      assert.equal(count, 1, "only a single conversation row should exist for the pair");
    });
  });

  describe("GET /chat/conversations", () => {
    test("requires authentication", async () => {
      const res = await request(app).get("/api/chat/conversations");
      assert.equal(res.status, 401);
    });

    test("only returns the caller's own conversations, with otherUser/lastMessage/lastMessageAt/unreadCount, sorted by recency", async () => {
      // admin <-> staff
      const convAdminStaff = await request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ userId: staffUser.id });
      // staff <-> other (admin is not a participant)
      const convStaffOther = await request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ userId: otherUser.id });

      // Post a message in the staff<->other conversation so it becomes most recent.
      const msg = await request(app)
        .post(`/api/chat/conversations/${convStaffOther.body.id}/messages`)
        .set("Authorization", `Bearer ${otherToken}`)
        .send({ body: "hi staff" });
      assert.equal(msg.status, 201);

      const staffList = await request(app)
        .get("/api/chat/conversations")
        .set("Authorization", `Bearer ${staffToken}`);
      assert.equal(staffList.status, 200);
      assert.equal(staffList.body.length, 2);
      // Most recently active (has a message) first.
      assert.equal(staffList.body[0].id, convStaffOther.body.id);
      assert.equal(staffList.body[0].otherUser.id, otherUser.id);
      assert.equal(staffList.body[0].lastMessage.body, "hi staff");
      assert.ok(staffList.body[0].lastMessageAt);
      assert.equal(staffList.body[0].unreadCount, 1);

      assert.equal(staffList.body[1].id, convAdminStaff.body.id);
      assert.equal(staffList.body[1].lastMessage, null);
      assert.equal(staffList.body[1].unreadCount, 0);

      // admin only sees the admin<->staff conversation, not staff<->other.
      const adminList = await request(app)
        .get("/api/chat/conversations")
        .set("Authorization", `Bearer ${adminToken}`);
      assert.equal(adminList.status, 200);
      assert.equal(adminList.body.length, 1);
      assert.equal(adminList.body[0].id, convAdminStaff.body.id);
    });

    test("otherLastReadAt reflects the OTHER participant's own last-read timestamp, not the caller's", async () => {
      const conv = await request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ userId: staffUser.id });

      const beforeRead = await request(app)
        .get("/api/chat/conversations")
        .set("Authorization", `Bearer ${adminToken}`);
      assert.equal(beforeRead.body.find((c) => c.id === conv.body.id).otherLastReadAt, null);

      const readRes = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/read`)
        .set("Authorization", `Bearer ${staffToken}`)
        .send({});

      const afterRead = await request(app)
        .get("/api/chat/conversations")
        .set("Authorization", `Bearer ${adminToken}`);
      assert.equal(afterRead.body.find((c) => c.id === conv.body.id).otherLastReadAt, readRes.body.lastReadAt);
    });
  });

  describe("GET /chat/conversations/:id/messages", () => {
    async function createConversation(token, userId) {
      return request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${token}`)
        .send({ userId });
    }

    test("requires authentication", async () => {
      const res = await request(app).get("/api/chat/conversations/1/messages");
      assert.equal(res.status, 401);
    });

    test("404 (not 403) for a non-participant, and for a nonexistent conversation", async () => {
      const conv = await createConversation(adminToken, staffUser.id);

      const nonParticipant = await request(app)
        .get(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${otherToken}`);
      assert.equal(nonParticipant.status, 404);

      const missing = await request(app)
        .get("/api/chat/conversations/999999/messages")
        .set("Authorization", `Bearer ${adminToken}`);
      assert.equal(missing.status, 404);
    });

    test("limit is clamped between 1 and 100, defaulting to 50", async () => {
      const conv = await createConversation(adminToken, staffUser.id);

      const tooHigh = await request(app)
        .get(`/api/chat/conversations/${conv.body.id}/messages?limit=500`)
        .set("Authorization", `Bearer ${adminToken}`);
      assert.equal(tooHigh.status, 200);

      const tooLow = await request(app)
        .get(`/api/chat/conversations/${conv.body.id}/messages?limit=0`)
        .set("Authorization", `Bearer ${adminToken}`);
      assert.equal(tooLow.status, 200);
      assert.equal(tooLow.body.data.length, 0, "limit clamped to at least 1, but there are no messages yet");
    });

    test("cursor pagination via before walks every message exactly once, no duplicates or gaps", async () => {
      const conv = await createConversation(adminToken, staffUser.id);

      const total = 12;
      const pageSize = 5;
      const bodies = [];
      for (let i = 0; i < total; i++) {
        const body = `message ${i}`;
        bodies.push(body);
        const sender = i % 2 === 0 ? adminToken : staffToken;
        const res = await request(app)
          .post(`/api/chat/conversations/${conv.body.id}/messages`)
          .set("Authorization", `Bearer ${sender}`)
          .send({ body });
        assert.equal(res.status, 201);
      }

      const seenIds = new Set();
      const seenBodies = [];
      let before;
      let pages = 0;
      for (;;) {
        pages++;
        const query = `?limit=${pageSize}${before !== undefined ? `&before=${before}` : ""}`;
        const res = await request(app)
          .get(`/api/chat/conversations/${conv.body.id}/messages${query}`)
          .set("Authorization", `Bearer ${adminToken}`);
        assert.equal(res.status, 200);
        assert.ok(res.body.data.length <= pageSize);

        for (const m of res.body.data) {
          assert.ok(!seenIds.has(m.id), "must not see the same message twice across pages");
          seenIds.add(m.id);
          seenBodies.push(m.body);
        }

        if (!res.body.hasMore) {
          assert.equal(res.body.nextBefore, null);
          break;
        }
        assert.equal(res.body.nextBefore, res.body.data[res.body.data.length - 1].id);
        before = res.body.nextBefore;
        assert.ok(pages < 20, "safety valve against an infinite loop bug");
      }

      assert.equal(seenIds.size, total, "must have walked every message exactly once");
      // Pages come back newest-first; reverse to compare against insertion order.
      assert.deepEqual(seenBodies.slice().reverse(), bodies);
    });

    test("replyTo reflects the original's current state on every fetch, not what it was when the reply was sent", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const original = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ body: "before edit" });
      const reply = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ body: "a reply", replyToId: original.body.id });

      const beforeEdit = await request(app)
        .get(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${adminToken}`);
      const replyRowBefore = beforeEdit.body.data.find((m) => m.id === reply.body.id);
      assert.deepEqual(replyRowBefore.replyTo, {
        id: original.body.id,
        senderId: adminUser.id,
        body: "before edit",
        deletedAt: null,
      });

      await request(app)
        .patch(`/api/chat/conversations/${conv.body.id}/messages/${original.body.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ body: "after edit" });

      const afterEdit = await request(app)
        .get(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${adminToken}`);
      const replyRowAfter = afterEdit.body.data.find((m) => m.id === reply.body.id);
      assert.equal(replyRowAfter.replyTo.body, "after edit");

      // A message with no reply gets an explicit null, not an absent key.
      const originalRow = afterEdit.body.data.find((m) => m.id === original.body.id);
      assert.equal(originalRow.replyTo, null);
    });
  });

  describe("GET /chat/conversations/:id/messages/search", () => {
    async function createConversation(token, userId) {
      return request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${token}`)
        .send({ userId });
    }

    async function sendMessage(token, conversationId, body) {
      return request(app)
        .post(`/api/chat/conversations/${conversationId}/messages`)
        .set("Authorization", `Bearer ${token}`)
        .send({ body });
    }

    test("requires authentication", async () => {
      const res = await request(app).get("/api/chat/conversations/1/messages/search?q=hi");
      assert.equal(res.status, 401);
    });

    test("404 for a non-participant", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const res = await request(app)
        .get(`/api/chat/conversations/${conv.body.id}/messages/search?q=hi`)
        .set("Authorization", `Bearer ${otherToken}`);
      assert.equal(res.status, 404);
    });

    test("400 when q is missing or blank", async () => {
      const conv = await createConversation(adminToken, staffUser.id);

      const missing = await request(app)
        .get(`/api/chat/conversations/${conv.body.id}/messages/search`)
        .set("Authorization", `Bearer ${adminToken}`);
      assert.equal(missing.status, 400);

      const blank = await request(app)
        .get(`/api/chat/conversations/${conv.body.id}/messages/search?q=%20%20`)
        .set("Authorization", `Bearer ${adminToken}`);
      assert.equal(blank.status, 400);
    });

    test("400 when q is longer than 200 characters", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const res = await request(app)
        .get(`/api/chat/conversations/${conv.body.id}/messages/search?q=${"a".repeat(201)}`)
        .set("Authorization", `Bearer ${adminToken}`);
      assert.equal(res.status, 400);
    });

    test("matches case-insensitively, scoped to this conversation only, newest match first", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const otherConv = await createConversation(staffToken, otherUser.id);

      await sendMessage(adminToken, conv.body.id, "let's grab Pizza tonight");
      await sendMessage(staffToken, conv.body.id, "sure, what time?");
      await sendMessage(adminToken, conv.body.id, "pizza at 7 works");
      await sendMessage(staffToken, otherConv.body.id, "unrelated pizza message in a different thread");

      const res = await request(app)
        .get(`/api/chat/conversations/${conv.body.id}/messages/search?q=pizza`)
        .set("Authorization", `Bearer ${adminToken}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 2);
      assert.equal(res.body.data[0].body, "pizza at 7 works");
      assert.equal(res.body.data[1].body, "let's grab Pizza tonight");
    });

    test("excludes a soft-deleted message even if it used to match", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const msg = await sendMessage(adminToken, conv.body.id, "the secret word is banana");
      await request(app)
        .delete(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      const res = await request(app)
        .get(`/api/chat/conversations/${conv.body.id}/messages/search?q=banana`)
        .set("Authorization", `Bearer ${adminToken}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 0);
    });
  });

  describe("POST /chat/conversations/:id/messages", () => {
    async function createConversation(token, userId) {
      return request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${token}`)
        .send({ userId });
    }

    test("requires authentication", async () => {
      const res = await request(app).post("/api/chat/conversations/1/messages").send({ body: "hi" });
      assert.equal(res.status, 401);
    });

    test("404 for a non-participant", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const res = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${otherToken}`)
        .send({ body: "hi" });
      assert.equal(res.status, 404);
    });

    test("400 on empty or whitespace-only body", async () => {
      const conv = await createConversation(adminToken, staffUser.id);

      const empty = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ body: "" });
      assert.equal(empty.status, 400);

      const whitespace = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ body: "   \n\t  " });
      assert.equal(whitespace.status, 400);

      const missing = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});
      assert.equal(missing.status, 400);
    });

    test("400 on a body over 4000 characters", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const res = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ body: "x".repeat(4001) });
      assert.equal(res.status, 400);
    });

    test("accepts a body of exactly 4000 characters", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const res = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ body: "x".repeat(4000) });
      assert.equal(res.status, 201);
    });

    test("201 on success, returns the created message, and updates Conversation.lastMessageAt", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const before = await prisma.conversation.findUnique({ where: { id: conv.body.id } });
      assert.equal(before.lastMessageAt, null);

      const res = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ body: "hello there" });
      assert.equal(res.status, 201);
      assert.equal(res.body.body, "hello there");
      assert.equal(res.body.senderId, adminUser.id);
      assert.equal(res.body.conversationId, conv.body.id);
      assert.ok(res.body.id);
      assert.ok(res.body.createdAt);

      const after = await prisma.conversation.findUnique({ where: { id: conv.body.id } });
      assert.ok(after.lastMessageAt, "lastMessageAt must be set after a message is sent");
    });

    test("delivered is true when the recipient has a live SSE connection open at send time, false otherwise", async () => {
      const conv = await createConversation(adminToken, staffUser.id);

      const notDelivered = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ body: "staff isn't connected" });
      assert.equal(notDelivered.body.delivered, false);

      const unsubscribe = chatBus.subscribe(staffUser.id, () => {});
      try {
        const delivered = await request(app)
          .post(`/api/chat/conversations/${conv.body.id}/messages`)
          .set("Authorization", `Bearer ${adminToken}`)
          .send({ body: "staff is connected now" });
        assert.equal(delivered.body.delivered, true);
      } finally {
        unsubscribe();
      }
    });

    test("replyToId attaches a quoted snippet of the original, visible to both participants", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const original = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ body: "original message" });

      const reply = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ body: "a reply", replyToId: original.body.id });
      assert.equal(reply.status, 201);
      assert.deepEqual(reply.body.replyTo, {
        id: original.body.id,
        senderId: adminUser.id,
        body: "original message",
        deletedAt: null,
      });

      const dbMessage = await prisma.message.findUnique({ where: { id: reply.body.id } });
      assert.equal(dbMessage.replyToId, original.body.id);
    });

    test("400 when replyToId references a message in a different conversation", async () => {
      const convStaff = await createConversation(adminToken, staffUser.id);
      const convOther = await createConversation(adminToken, otherUser.id);
      const inOtherConv = await request(app)
        .post(`/api/chat/conversations/${convOther.body.id}/messages`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ body: "wrong conversation" });

      const res = await request(app)
        .post(`/api/chat/conversations/${convStaff.body.id}/messages`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ body: "a reply", replyToId: inOtherConv.body.id });
      assert.equal(res.status, 400);
    });

    test("400 when replyToId references an already-deleted message", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const original = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ body: "will be deleted" });
      await request(app)
        .delete(`/api/chat/conversations/${conv.body.id}/messages/${original.body.id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      const res = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ body: "a reply", replyToId: original.body.id });
      assert.equal(res.status, 400);
    });

    test("400 when replyToId is not an integer", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const res = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ body: "a reply", replyToId: "not-a-number" });
      assert.equal(res.status, 400);
    });
  });

  describe("PATCH /chat/conversations/:id/messages/:messageId", () => {
    async function createConversation(token, userId) {
      return request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${token}`)
        .send({ userId });
    }

    async function sendMessage(token, conversationId, body) {
      return request(app)
        .post(`/api/chat/conversations/${conversationId}/messages`)
        .set("Authorization", `Bearer ${token}`)
        .send({ body });
    }

    test("requires authentication", async () => {
      const res = await request(app).patch("/api/chat/conversations/1/messages/1").send({ body: "x" });
      assert.equal(res.status, 401);
    });

    test("404 for a non-participant", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const msg = await sendMessage(adminToken, conv.body.id, "original");
      const res = await request(app)
        .patch(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}`)
        .set("Authorization", `Bearer ${otherToken}`)
        .send({ body: "edited" });
      assert.equal(res.status, 404);
    });

    test("403 when the caller is a participant but not the sender", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const msg = await sendMessage(adminToken, conv.body.id, "original");
      const res = await request(app)
        .patch(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}`)
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ body: "edited by the wrong person" });
      assert.equal(res.status, 403);
    });

    test("400 on empty body", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const msg = await sendMessage(adminToken, conv.body.id, "original");
      const res = await request(app)
        .patch(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ body: "   " });
      assert.equal(res.status, 400);
    });

    test("edits the body, sets editedAt, and publishes a message-edited event to both participants", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const msg = await sendMessage(adminToken, conv.body.id, "original");

      const staffWaiter = waitForEvent(staffUser.id, "message-edited");
      const adminWaiter = waitForEvent(adminUser.id, "message-edited");

      const res = await request(app)
        .patch(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ body: "edited text" });
      assert.equal(res.status, 200);
      assert.equal(res.body.body, "edited text");
      assert.ok(res.body.editedAt);

      const staffPayload = await staffWaiter;
      const adminPayload = await adminWaiter;
      assert.equal(staffPayload.id, msg.body.id);
      assert.equal(staffPayload.body, "edited text");
      assert.equal(adminPayload.id, msg.body.id);

      const dbMsg = await prisma.message.findUnique({ where: { id: msg.body.id } });
      assert.equal(dbMsg.body, "edited text");
      assert.ok(dbMsg.editedAt);
    });

    test("404 for a nonexistent message", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const res = await request(app)
        .patch(`/api/chat/conversations/${conv.body.id}/messages/999999`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ body: "edited" });
      assert.equal(res.status, 404);
    });

    test("404 when editing an already-deleted message", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const msg = await sendMessage(adminToken, conv.body.id, "original");
      await request(app)
        .delete(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      const res = await request(app)
        .patch(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ body: "edited" });
      assert.equal(res.status, 404);
    });
  });

  describe("DELETE /chat/conversations/:id/messages/:messageId", () => {
    async function createConversation(token, userId) {
      return request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${token}`)
        .send({ userId });
    }

    async function sendMessage(token, conversationId, body) {
      return request(app)
        .post(`/api/chat/conversations/${conversationId}/messages`)
        .set("Authorization", `Bearer ${token}`)
        .send({ body });
    }

    test("requires authentication", async () => {
      const res = await request(app).delete("/api/chat/conversations/1/messages/1").send({});
      assert.equal(res.status, 401);
    });

    test("404 for a non-participant", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const msg = await sendMessage(adminToken, conv.body.id, "original");
      const res = await request(app)
        .delete(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}`)
        .set("Authorization", `Bearer ${otherToken}`)
        .send({});
      assert.equal(res.status, 404);
    });

    test("403 when the caller is a participant but not the sender", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const msg = await sendMessage(adminToken, conv.body.id, "original");
      const res = await request(app)
        .delete(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}`)
        .set("Authorization", `Bearer ${staffToken}`)
        .send({});
      assert.equal(res.status, 403);
    });

    test("soft-deletes: clears body, sets deletedAt, and publishes message-deleted to both participants", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const msg = await sendMessage(adminToken, conv.body.id, "secret content");

      const staffWaiter = waitForEvent(staffUser.id, "message-deleted");
      const adminWaiter = waitForEvent(adminUser.id, "message-deleted");

      const res = await request(app)
        .delete(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});
      assert.equal(res.status, 200);
      assert.equal(res.body.id, msg.body.id);
      assert.ok(res.body.deletedAt);

      const staffPayload = await staffWaiter;
      const adminPayload = await adminWaiter;
      assert.equal(staffPayload.id, msg.body.id);
      assert.equal(adminPayload.id, msg.body.id);

      const dbMsg = await prisma.message.findUnique({ where: { id: msg.body.id } });
      assert.equal(dbMsg.body, null, "content must be cleared, not just flagged");
      assert.ok(dbMsg.deletedAt);
    });

    test("404 when deleting an already-deleted message", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const msg = await sendMessage(adminToken, conv.body.id, "original");
      await request(app)
        .delete(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      const res = await request(app)
        .delete(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});
      assert.equal(res.status, 404);
    });
  });

  describe("POST/DELETE /chat/conversations/:id/messages/:messageId/reactions", () => {
    async function createConversation(token, userId) {
      return request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${token}`)
        .send({ userId });
    }

    async function sendMessage(token, conversationId, body) {
      return request(app)
        .post(`/api/chat/conversations/${conversationId}/messages`)
        .set("Authorization", `Bearer ${token}`)
        .send({ body });
    }

    test("POST requires authentication", async () => {
      const res = await request(app).post("/api/chat/conversations/1/messages/1/reactions").send({ emoji: "👍" });
      assert.equal(res.status, 401);
    });

    test("POST 404 for a non-participant", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const msg = await sendMessage(adminToken, conv.body.id, "hi");
      const res = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}/reactions`)
        .set("Authorization", `Bearer ${otherToken}`)
        .send({ emoji: "👍" });
      assert.equal(res.status, 404);
    });

    test("POST 400 on a missing or oversized emoji", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const msg = await sendMessage(adminToken, conv.body.id, "hi");

      const missing = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}/reactions`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});
      assert.equal(missing.status, 400);

      const oversized = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}/reactions`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ emoji: "x".repeat(9) });
      assert.equal(oversized.status, 400);
    });

    test("either participant can react to either side's message; 201 then 200 on a repeat react", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const msg = await sendMessage(adminToken, conv.body.id, "hi");

      const staffWaiter = waitForEvent(staffUser.id, "reaction-added");
      const adminWaiter = waitForEvent(adminUser.id, "reaction-added");

      const first = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}/reactions`)
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ emoji: "👍" });
      assert.equal(first.status, 201);

      const staffPayload = await staffWaiter;
      const adminPayload = await adminWaiter;
      assert.deepEqual(
        { conversationId: staffPayload.conversationId, messageId: staffPayload.messageId, emoji: staffPayload.emoji, userId: staffPayload.userId },
        { conversationId: conv.body.id, messageId: msg.body.id, emoji: "👍", userId: staffUser.id }
      );
      assert.deepEqual(adminPayload, staffPayload, "both participants get the same event, including the reactor");

      // Repeat: idempotent, no re-publish, 200 not 201.
      const noEventWaiter = waitForEvent(staffUser.id, "reaction-added", 200).catch((err) => err);
      const second = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}/reactions`)
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ emoji: "👍" });
      assert.equal(second.status, 200);
      assert.ok((await noEventWaiter) instanceof Error, "a repeat react must not re-publish");

      const rows = await prisma.messageReaction.findMany({ where: { messageId: msg.body.id } });
      assert.equal(rows.length, 1, "must not create a duplicate row");
    });

    test("two concurrent adds of the same reaction (e.g. a double-tap) don't 500 and leave only one row", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const msg = await sendMessage(adminToken, conv.body.id, "hi");

      const [first, second] = await Promise.all([
        request(app)
          .post(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}/reactions`)
          .set("Authorization", `Bearer ${staffToken}`)
          .send({ emoji: "👍" }),
        request(app)
          .post(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}/reactions`)
          .set("Authorization", `Bearer ${staffToken}`)
          .send({ emoji: "👍" }),
      ]);

      const statuses = [first.status, second.status].sort();
      assert.deepEqual(statuses, [200, 201]);

      const rows = await prisma.messageReaction.findMany({ where: { messageId: msg.body.id } });
      assert.equal(rows.length, 1, "must not create a duplicate row");
    });

    test("DELETE 404 when the caller never reacted with that emoji", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const msg = await sendMessage(adminToken, conv.body.id, "hi");
      const res = await request(app)
        .delete(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}/reactions/👍`)
        .set("Authorization", `Bearer ${adminToken}`);
      assert.equal(res.status, 404);
    });

    test("DELETE removes only the caller's own reaction and publishes reaction-removed to both", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const msg = await sendMessage(adminToken, conv.body.id, "hi");
      await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}/reactions`)
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ emoji: "👍" });
      await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}/reactions`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ emoji: "👍" });

      const staffWaiter = waitForEvent(staffUser.id, "reaction-removed");
      const adminWaiter = waitForEvent(adminUser.id, "reaction-removed");

      const res = await request(app)
        .delete(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}/reactions/👍`)
        .set("Authorization", `Bearer ${staffToken}`);
      assert.equal(res.status, 200);

      const staffPayload = await staffWaiter;
      const adminPayload = await adminWaiter;
      assert.equal(staffPayload.userId, staffUser.id);
      assert.deepEqual(adminPayload, staffPayload);

      const rows = await prisma.messageReaction.findMany({ where: { messageId: msg.body.id } });
      assert.equal(rows.length, 1, "only staff's reaction must be gone");
      assert.equal(rows[0].userId, adminUser.id);
    });

    test("GET messages includes a reactions summary with emoji/count/mine", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const msg = await sendMessage(adminToken, conv.body.id, "hi");
      await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}/reactions`)
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ emoji: "👍" });
      await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}/reactions`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ emoji: "👍" });
      await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages/${msg.body.id}/reactions`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ emoji: "🔥" });

      const asStaff = await request(app)
        .get(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${staffToken}`);
      const staffView = asStaff.body.data.find((m) => m.id === msg.body.id).reactions;
      const thumbsUpStaff = staffView.find((r) => r.emoji === "👍");
      assert.equal(thumbsUpStaff.count, 2);
      assert.equal(thumbsUpStaff.mine, true);
      const fireStaff = staffView.find((r) => r.emoji === "🔥");
      assert.equal(fireStaff.count, 1);
      assert.equal(fireStaff.mine, false);

      const asAdmin = await request(app)
        .get(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${adminToken}`);
      const adminView = asAdmin.body.data.find((m) => m.id === msg.body.id).reactions;
      assert.equal(adminView.find((r) => r.emoji === "🔥").mine, true);
    });
  });

  describe("POST /chat/conversations/:id/read", () => {
    async function createConversation(token, userId) {
      return request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${token}`)
        .send({ userId });
    }

    test("requires authentication", async () => {
      const res = await request(app).post("/api/chat/conversations/1/read").send({});
      assert.equal(res.status, 401);
    });

    test("404 for a non-participant", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const res = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/read`)
        .set("Authorization", `Bearer ${otherToken}`)
        .send({});
      assert.equal(res.status, 404);
    });

    test("updates only the caller's own last-read timestamp, and unreadCount reflects it on a subsequent list", async () => {
      const conv = await createConversation(adminToken, staffUser.id);

      // staff sends two messages to admin.
      await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ body: "msg 1" });
      await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ body: "msg 2" });

      // Before reading, admin sees 2 unread; staff (the sender) sees 0.
      const beforeAdminList = await request(app)
        .get("/api/chat/conversations")
        .set("Authorization", `Bearer ${adminToken}`);
      assert.equal(beforeAdminList.body.find((c) => c.id === conv.body.id).unreadCount, 2);

      const beforeStaffList = await request(app)
        .get("/api/chat/conversations")
        .set("Authorization", `Bearer ${staffToken}`);
      assert.equal(beforeStaffList.body.find((c) => c.id === conv.body.id).unreadCount, 0);

      const readRes = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/read`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});
      assert.equal(readRes.status, 200);
      assert.equal(readRes.body.conversationId, conv.body.id);
      assert.ok(readRes.body.lastReadAt);

      const dbConv = await prisma.conversation.findUnique({ where: { id: conv.body.id } });
      // admin is userA (lower id, since users are created admin, staff, other in that order).
      const isAdminUserA = dbConv.userAId === adminUser.id;
      if (isAdminUserA) {
        assert.ok(dbConv.userALastReadAt, "the reader's own last-read timestamp must be set");
        assert.equal(dbConv.userBLastReadAt, null, "the other participant's last-read must be untouched");
      } else {
        assert.ok(dbConv.userBLastReadAt, "the reader's own last-read timestamp must be set");
        assert.equal(dbConv.userALastReadAt, null, "the other participant's last-read must be untouched");
      }

      const afterAdminList = await request(app)
        .get("/api/chat/conversations")
        .set("Authorization", `Bearer ${adminToken}`);
      assert.equal(afterAdminList.body.find((c) => c.id === conv.body.id).unreadCount, 0);

      // staff's own unread count (of admin's messages, of which there are none) stays 0.
      const afterStaffList = await request(app)
        .get("/api/chat/conversations")
        .set("Authorization", `Bearer ${staffToken}`);
      assert.equal(afterStaffList.body.find((c) => c.id === conv.body.id).unreadCount, 0);
    });

    test("publishes a read event to the other participant (the sender), not to the reader", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ body: "msg 1" });

      const staffWaiter = waitForEvent(staffUser.id, "read");
      const adminWaiter = waitForEvent(adminUser.id, "read", 200).catch((err) => err);

      const res = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/read`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});
      assert.equal(res.status, 200);

      const staffPayload = await staffWaiter;
      assert.equal(staffPayload.conversationId, conv.body.id);
      assert.equal(staffPayload.readerId, adminUser.id);
      // chatBus carries the raw Date object (in-process, pre-serialization);
      // the HTTP response has already gone through JSON.stringify. Compare
      // as ISO strings, which is also what a real SSE client receives.
      assert.equal(staffPayload.lastReadAt.toISOString(), res.body.lastReadAt);

      assert.ok((await adminWaiter) instanceof Error, "the reader must not receive their own read event");
    });
  });

  describe("POST/DELETE /chat/conversations/:id/pin", () => {
    async function createConversation(token, userId) {
      return request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${token}`)
        .send({ userId });
    }

    test("requires authentication", async () => {
      const res = await request(app).post("/api/chat/conversations/1/pin").send({});
      assert.equal(res.status, 401);
    });

    test("404 for a non-participant", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const res = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/pin`)
        .set("Authorization", `Bearer ${otherToken}`)
        .send({});
      assert.equal(res.status, 404);
    });

    test("pins for the caller only, sorts pinned conversations first, and unpin restores normal ordering", async () => {
      const convStaff = await createConversation(adminToken, staffUser.id);
      const convOther = await createConversation(adminToken, otherUser.id);

      // Give convOther a more recent message so it would normally sort above
      // convStaff — pinning convStaff should override that.
      await request(app)
        .post(`/api/chat/conversations/${convOther.body.id}/messages`)
        .set("Authorization", `Bearer ${otherToken}`)
        .send({ body: "hi" });

      const pinRes = await request(app)
        .post(`/api/chat/conversations/${convStaff.body.id}/pin`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});
      assert.equal(pinRes.status, 204);

      const list = await request(app).get("/api/chat/conversations").set("Authorization", `Bearer ${adminToken}`);
      assert.equal(list.body[0].id, convStaff.body.id, "pinned conversation must sort first");
      assert.equal(list.body[0].pinned, true);
      assert.equal(list.body[1].pinned, false);

      // The other participant never sees it as pinned — this is per-side, not shared.
      const staffList = await request(app)
        .get("/api/chat/conversations")
        .set("Authorization", `Bearer ${staffToken}`);
      assert.equal(staffList.body.find((c) => c.id === convStaff.body.id).pinned, false);

      const unpinRes = await request(app)
        .delete(`/api/chat/conversations/${convStaff.body.id}/pin`)
        .set("Authorization", `Bearer ${adminToken}`);
      assert.equal(unpinRes.status, 204);

      const afterList = await request(app)
        .get("/api/chat/conversations")
        .set("Authorization", `Bearer ${adminToken}`);
      assert.equal(afterList.body[0].id, convOther.body.id, "unpinning restores recency ordering");
      assert.equal(afterList.body.find((c) => c.id === convStaff.body.id).pinned, false);
    });
  });

  describe("POST/DELETE /chat/conversations/:id/mute", () => {
    async function createConversation(token, userId) {
      return request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${token}`)
        .send({ userId });
    }

    test("requires authentication", async () => {
      const res = await request(app).post("/api/chat/conversations/1/mute").send({});
      assert.equal(res.status, 401);
    });

    test("404 for a non-participant", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const res = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/mute`)
        .set("Authorization", `Bearer ${otherToken}`)
        .send({});
      assert.equal(res.status, 404);
    });

    test("mutes for the caller only, reported back on the list, and unmute clears it", async () => {
      const conv = await createConversation(adminToken, staffUser.id);

      const muteRes = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/mute`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});
      assert.equal(muteRes.status, 204);

      const adminList = await request(app).get("/api/chat/conversations").set("Authorization", `Bearer ${adminToken}`);
      assert.equal(adminList.body.find((c) => c.id === conv.body.id).muted, true);

      const staffList = await request(app).get("/api/chat/conversations").set("Authorization", `Bearer ${staffToken}`);
      assert.equal(staffList.body.find((c) => c.id === conv.body.id).muted, false);

      const unmuteRes = await request(app)
        .delete(`/api/chat/conversations/${conv.body.id}/mute`)
        .set("Authorization", `Bearer ${adminToken}`);
      assert.equal(unmuteRes.status, 204);

      const afterList = await request(app).get("/api/chat/conversations").set("Authorization", `Bearer ${adminToken}`);
      assert.equal(afterList.body.find((c) => c.id === conv.body.id).muted, false);
    });

    test("muting a conversation doesn't affect SSE delivery or unread count (it only ever gates push, see src/routes/chat.js)", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/mute`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});

      const adminWaiter = waitForEvent(adminUser.id, "message");
      const sendRes = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/messages`)
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ body: "hi muted admin" });
      assert.equal(sendRes.status, 201);

      // Still delivered live over SSE — muting only silences push.
      const ssePayload = await adminWaiter;
      assert.equal(ssePayload.body, "hi muted admin");

      const adminList = await request(app).get("/api/chat/conversations").set("Authorization", `Bearer ${adminToken}`);
      assert.equal(adminList.body.find((c) => c.id === conv.body.id).unreadCount, 1, "unread count is unaffected by muting");
    });
  });

  describe("POST /chat/conversations/:id/typing", () => {
    async function createConversation(token, userId) {
      return request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${token}`)
        .send({ userId });
    }

    test("requires authentication", async () => {
      const res = await request(app).post("/api/chat/conversations/1/typing").send({});
      assert.equal(res.status, 401);
    });

    test("404 for a non-participant", async () => {
      const conv = await createConversation(adminToken, staffUser.id);
      const res = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/typing`)
        .set("Authorization", `Bearer ${otherToken}`)
        .send({});
      assert.equal(res.status, 404);
    });

    test("publishes a typing event to the other participant, not the caller", async () => {
      const conv = await createConversation(adminToken, staffUser.id);

      const staffWaiter = waitForEvent(staffUser.id, "typing");
      const adminWaiter = waitForEvent(adminUser.id, "typing", 200).catch((err) => err);

      const res = await request(app)
        .post(`/api/chat/conversations/${conv.body.id}/typing`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});
      assert.equal(res.status, 204);

      const payload = await staffWaiter;
      assert.equal(payload.conversationId, conv.body.id);
      assert.equal(payload.userId, adminUser.id);

      assert.ok((await adminWaiter) instanceof Error, "the caller must not receive their own typing event");
    });
  });

  describe("POST /chat/stream-ticket and GET /chat/stream", () => {
    test("stream-ticket requires authentication", async () => {
      const res = await request(app).post("/api/chat/stream-ticket").send({});
      assert.equal(res.status, 401);
    });

    test("returns a ticket", async () => {
      const res = await request(app)
        .post("/api/chat/stream-ticket")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});
      assert.equal(res.status, 200);
      assert.equal(typeof res.body.ticket, "string");
      assert.ok(res.body.ticket.length > 0);
    });

    test("a valid ticket is accepted once and rejected on reuse", async () => {
      const issued = await request(app)
        .post("/api/chat/stream-ticket")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});
      const ticket = issued.body.ticket;

      const first = await probeStream(`?ticket=${ticket}`);
      assert.equal(first.status, 200);
      assert.equal(first.headers["content-type"], "text/event-stream");

      const second = await probeStream(`?ticket=${ticket}`);
      assert.equal(second.status, 401);
    });

    test("a bogus ticket is rejected", async () => {
      const res = await probeStream("?ticket=not-a-real-ticket");
      assert.equal(res.status, 401);
    });

    test("a missing ticket is rejected", async () => {
      const res = await probeStream("");
      assert.equal(res.status, 401);
    });

    // Ticket TTL is 30s (TICKET_TTL_MS in src/routes/chat.js) and is not
    // exposed for injection/mocking, so a real expiry test would need an
    // actual 30-second sleep. That's exactly the kind of slow, flaky test
    // this repo's conventions call for skipping in favour of a code read:
    // consumeTicket() compares `entry.expiresAt < Date.now()` and deletes
    // the entry either way, so an expired-but-not-yet-swept ticket is
    // correctly treated as invalid on next use. Left unexercised at the
    // integration-test level deliberately.
  });

  describe("DELETE /api/users/me with chat data (409 guard)", () => {
    test("requires authentication", async () => {
      const res = await request(app).delete("/api/users/me");
      assert.equal(res.status, 401);
    });

    test("409s when the caller has a conversation, matching the route's response shape", async () => {
      const chatty = await createUser({ email: "chatty@test.com", password: "pass12345" });
      const chattyToken = await login("chatty@test.com", "pass12345");
      await makeFriends(chatty, staffUser);

      const conv = await request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${chattyToken}`)
        .send({ userId: staffUser.id });
      assert.equal(conv.status, 201);

      const res = await request(app).delete("/api/users/me").set("Authorization", `Bearer ${chattyToken}`);
      assert.equal(res.status, 409);
      assert.deepEqual(res.body, { error: "Cannot delete an account with chat conversations" });

      const stillThere = await prisma.user.findUnique({ where: { id: chatty.id } });
      assert.ok(stillThere, "user must not have been deleted");
    });

    test("409s (with the message-specific error) when the caller has a sent message but is not a Conversation participant themselves", async () => {
      // In normal use a message's senderId is always one of the
      // conversation's two participants (POST /messages 404s a
      // non-participant sender), so the "sent messages" guard in
      // src/routes/users.js is a defense-in-depth check that the API
      // itself can't produce a counter-example for. Exercise it directly
      // via Prisma so the guard itself — not just the more common
      // conversation-participant path — is covered.
      const messenger = await createUser({ email: "messenger@test.com", password: "pass12345" });
      const messengerToken = await login("messenger@test.com", "pass12345");

      const conv = await request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ userId: otherUser.id });
      assert.equal(conv.status, 201);

      await prisma.message.create({
        data: { conversationId: conv.body.id, senderId: messenger.id, body: "orphaned sender" },
      });

      const res = await request(app)
        .delete("/api/users/me")
        .set("Authorization", `Bearer ${messengerToken}`);
      assert.equal(res.status, 409);
      assert.deepEqual(res.body, { error: "Cannot delete an account with sent messages" });
    });

    test("does not 500 (falls through to a clean delete) for a caller with no chat data", async () => {
      await createUser({ email: "nochat@test.com", password: "pass12345" });
      const nochatToken = await login("nochat@test.com", "pass12345");

      const res = await request(app).delete("/api/users/me").set("Authorization", `Bearer ${nochatToken}`);
      assert.equal(res.status, 204);
    });
  });
});

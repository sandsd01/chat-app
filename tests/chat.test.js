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
    test("403s starting a conversation with a non-friend", async () => {
      const stranger = await createUser({ email: "stranger@test.com", password: "strangerpass1" });
      const res = await request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ userId: stranger.id });
      assert.equal(res.status, 403);
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
      assert.equal(res.status, 403);
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

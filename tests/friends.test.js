const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { resetDb, createUser, makeFriends, prisma } = require("./helpers/db");
const app = require("../src/app");
const chatBus = require("../src/lib/chatBus");

async function login(email, password) {
  const res = await request(app).post("/api/auth/login").send({ email, password });
  return res.body.token;
}

describe("Friends API", () => {
  let alice, aliceToken;
  let bob, bobToken;
  let carol, carolToken;

  beforeEach(async () => {
    await resetDb();
    alice = await createUser({ email: "alice@test.com", password: "alicepass1", name: "Alice" });
    bob = await createUser({ email: "bob@test.com", password: "bobpass1", name: "Bob" });
    carol = await createUser({ email: "carol@test.com", password: "carolpass1", name: "Carol" });
    aliceToken = await login("alice@test.com", "alicepass1");
    bobToken = await login("bob@test.com", "bobpass1");
    carolToken = await login("carol@test.com", "carolpass1");
  });

  describe("GET /friends/lookup", () => {
    test("requires authentication", async () => {
      const res = await request(app).get(`/api/friends/lookup?publicId=${bob.publicId}`);
      assert.equal(res.status, 401);
    });

    test("400 without a publicId", async () => {
      const res = await request(app).get("/api/friends/lookup").set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(res.status, 400);
    });

    test("404 for an unknown code", async () => {
      const res = await request(app)
        .get("/api/friends/lookup?publicId=NOSUCHID")
        .set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(res.status, 404);
    });

    test("400 when looking up your own id", async () => {
      const res = await request(app)
        .get(`/api/friends/lookup?publicId=${alice.publicId}`)
        .set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(res.status, 400);
    });

    test("is case-insensitive and reports relationship: none/requestSent/requestReceived/friends", async () => {
      const lower = await request(app)
        .get(`/api/friends/lookup?publicId=${bob.publicId.toLowerCase()}`)
        .set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(lower.status, 200);
      assert.equal(lower.body.id, bob.id);
      assert.equal(lower.body.relationship, "none");
      assert.deepEqual(Object.keys(lower.body).sort(), ["email", "id", "name", "publicId", "relationship"]);

      await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ publicId: bob.publicId });

      const fromAlice = await request(app)
        .get(`/api/friends/lookup?publicId=${bob.publicId}`)
        .set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(fromAlice.body.relationship, "requestSent");

      const fromBob = await request(app)
        .get(`/api/friends/lookup?publicId=${alice.publicId}`)
        .set("Authorization", `Bearer ${bobToken}`);
      assert.equal(fromBob.body.relationship, "requestReceived");

      await makeFriends(alice, bob);
      const nowFriends = await request(app)
        .get(`/api/friends/lookup?publicId=${bob.publicId}`)
        .set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(nowFriends.body.relationship, "friends");
    });
  });

  describe("POST /friends/requests", () => {
    test("requires authentication", async () => {
      const res = await request(app).post("/api/friends/requests").send({ publicId: bob.publicId });
      assert.equal(res.status, 401);
    });

    test("400 without a publicId", async () => {
      const res = await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({});
      assert.equal(res.status, 400);
    });

    test("404 for an unknown code", async () => {
      const res = await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ publicId: "NOSUCHID" });
      assert.equal(res.status, 404);
    });

    test("400 requesting yourself", async () => {
      const res = await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ publicId: alice.publicId });
      assert.equal(res.status, 400);
    });

    test("201 creates a pending request; repeating it from the same side is idempotent (200)", async () => {
      const first = await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ publicId: bob.publicId });
      assert.equal(first.status, 201);
      assert.equal(first.body.status, "pending");

      const again = await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ publicId: bob.publicId });
      assert.equal(again.status, 200);
      assert.equal(again.body.requestId, first.body.requestId);

      const count = await prisma.friendship.count();
      assert.equal(count, 1, "no duplicate row for the same pair");
    });

    test("a mutual request (B requests A back while A's request is still pending) auto-accepts", async () => {
      await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ publicId: bob.publicId });

      const res = await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${bobToken}`)
        .send({ publicId: alice.publicId });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "accepted");

      const friends = await request(app).get("/api/friends").set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(friends.body.length, 1);
      assert.equal(friends.body[0].otherUser.id, bob.id);
    });

    test("403s a request to someone who blocked you", async () => {
      await request(app)
        .post(`/api/friends/${alice.id}/block`)
        .set("Authorization", `Bearer ${bobToken}`);

      const res = await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ publicId: bob.publicId });
      assert.equal(res.status, 403);
    });
  });

  describe("GET /friends/requests", () => {
    test("splits pending requests into incoming and outgoing", async () => {
      await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ publicId: bob.publicId });

      const aliceView = await request(app)
        .get("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(aliceView.body.outgoing.length, 1);
      assert.equal(aliceView.body.incoming.length, 0);
      assert.equal(aliceView.body.outgoing[0].otherUser.id, bob.id);

      const bobView = await request(app)
        .get("/api/friends/requests")
        .set("Authorization", `Bearer ${bobToken}`);
      assert.equal(bobView.body.incoming.length, 1);
      assert.equal(bobView.body.outgoing.length, 0);
      assert.equal(bobView.body.incoming[0].otherUser.id, alice.id);
    });
  });

  describe("POST /friends/requests/:id/accept", () => {
    test("the addressee can accept; the pair then shows up as friends for both", async () => {
      const req = await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ publicId: bob.publicId });

      const accept = await request(app)
        .post(`/api/friends/requests/${req.body.requestId}/accept`)
        .set("Authorization", `Bearer ${bobToken}`);
      assert.equal(accept.status, 200);

      const aliceFriends = await request(app).get("/api/friends").set("Authorization", `Bearer ${aliceToken}`);
      const bobFriends = await request(app).get("/api/friends").set("Authorization", `Bearer ${bobToken}`);
      assert.equal(aliceFriends.body[0].otherUser.id, bob.id);
      assert.equal(bobFriends.body[0].otherUser.id, alice.id);
    });

    test("the requester cannot accept their own request", async () => {
      const req = await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ publicId: bob.publicId });

      const res = await request(app)
        .post(`/api/friends/requests/${req.body.requestId}/accept`)
        .set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(res.status, 400);
    });

    test("a non-participant gets 404", async () => {
      const req = await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ publicId: bob.publicId });

      const res = await request(app)
        .post(`/api/friends/requests/${req.body.requestId}/accept`)
        .set("Authorization", `Bearer ${carolToken}`);
      assert.equal(res.status, 404);
    });
  });

  describe("POST /friends/requests/:id/decline", () => {
    test("declining deletes the row, allowing a fresh request later", async () => {
      const req = await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ publicId: bob.publicId });

      const decline = await request(app)
        .post(`/api/friends/requests/${req.body.requestId}/decline`)
        .set("Authorization", `Bearer ${bobToken}`);
      assert.equal(decline.status, 204);
      assert.equal(await prisma.friendship.count(), 0);

      const retry = await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ publicId: bob.publicId });
      assert.equal(retry.status, 201);
    });

    test("the requester cannot decline their own request (use cancel)", async () => {
      const req = await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ publicId: bob.publicId });

      const res = await request(app)
        .post(`/api/friends/requests/${req.body.requestId}/decline`)
        .set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(res.status, 400);
    });
  });

  describe("DELETE /friends/requests/:id (cancel)", () => {
    test("the sender can cancel their own pending request", async () => {
      const req = await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ publicId: bob.publicId });

      const cancel = await request(app)
        .delete(`/api/friends/requests/${req.body.requestId}`)
        .set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(cancel.status, 204);
      assert.equal(await prisma.friendship.count(), 0);
    });

    test("the addressee cannot cancel someone else's request", async () => {
      const req = await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ publicId: bob.publicId });

      const res = await request(app)
        .delete(`/api/friends/requests/${req.body.requestId}`)
        .set("Authorization", `Bearer ${bobToken}`);
      assert.equal(res.status, 400);
    });
  });

  describe("GET /friends", () => {
    test("only lists accepted friendships, not pending ones", async () => {
      await makeFriends(alice, bob);
      await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ publicId: carol.publicId });

      const res = await request(app).get("/api/friends").set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.length, 1);
      assert.equal(res.body[0].otherUser.id, bob.id);
    });
  });

  describe("DELETE /friends/:userId (unfriend)", () => {
    test("removes an accepted friendship", async () => {
      await makeFriends(alice, bob);
      const res = await request(app)
        .delete(`/api/friends/${bob.id}`)
        .set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(res.status, 204);
      assert.equal(await prisma.friendship.count(), 0);
    });

    test("404s if you're not friends with that account", async () => {
      const res = await request(app)
        .delete(`/api/friends/${bob.id}`)
        .set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(res.status, 404);
    });
  });

  describe("Block / unblock", () => {
    test("blocking an existing friend removes them from the friends list and prevents re-requesting", async () => {
      await makeFriends(alice, bob);
      const block = await request(app)
        .post(`/api/friends/${bob.id}/block`)
        .set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(block.status, 204);

      const friends = await request(app).get("/api/friends").set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(friends.body.length, 0);

      const reRequest = await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${bobToken}`)
        .send({ publicId: alice.publicId });
      assert.equal(reRequest.status, 403);
    });

    test("only the blocker can unblock", async () => {
      await request(app).post(`/api/friends/${bob.id}/block`).set("Authorization", `Bearer ${aliceToken}`);

      const wrongSide = await request(app)
        .post(`/api/friends/${alice.id}/unblock`)
        .set("Authorization", `Bearer ${bobToken}`);
      assert.equal(wrongSide.status, 404);

      const rightSide = await request(app)
        .post(`/api/friends/${bob.id}/unblock`)
        .set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(rightSide.status, 204);
      assert.equal(await prisma.friendship.count(), 0);
    });

    test("400 blocking yourself", async () => {
      const res = await request(app)
        .post(`/api/friends/${alice.id}/block`)
        .set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(res.status, 400);
    });
  });

  describe("Live SSE friend events (chatBus, mirrors the push-notification trigger points)", () => {
    test("a new request publishes request_received to the recipient", async (t) => {
      const published = [];
      t.mock.method(chatBus, "publish", (userId, event, payload) => published.push({ userId, event, payload }));

      const res = await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ publicId: bob.publicId });
      assert.equal(res.status, 201);

      assert.deepEqual(published, [{ userId: bob.id, event: "friend", payload: { type: "request_received" } }]);
    });

    test("accepting a request publishes request_accepted to the original sender", async (t) => {
      const outgoing = await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ publicId: bob.publicId });
      const requestId = outgoing.body.requestId;

      const published = [];
      t.mock.method(chatBus, "publish", (userId, event, payload) => published.push({ userId, event, payload }));

      const res = await request(app)
        .post(`/api/friends/requests/${requestId}/accept`)
        .set("Authorization", `Bearer ${bobToken}`);
      assert.equal(res.status, 200);

      assert.deepEqual(published, [{ userId: alice.id, event: "friend", payload: { type: "request_accepted" } }]);
    });

    test("a mutual auto-accept (both sides request each other) publishes request_accepted to the original sender", async (t) => {
      await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ publicId: bob.publicId });

      const published = [];
      t.mock.method(chatBus, "publish", (userId, event, payload) => published.push({ userId, event, payload }));

      const res = await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${bobToken}`)
        .send({ publicId: alice.publicId });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "accepted");

      assert.deepEqual(published, [{ userId: alice.id, event: "friend", payload: { type: "request_accepted" } }]);
    });

    test("declining or cancelling a request does not publish a friend event (matches the existing no-push behaviour)", async (t) => {
      const outgoing = await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ publicId: bob.publicId });
      const requestId = outgoing.body.requestId;

      const published = [];
      t.mock.method(chatBus, "publish", (userId, event, payload) => published.push({ userId, event, payload }));

      const res = await request(app)
        .post(`/api/friends/requests/${requestId}/decline`)
        .set("Authorization", `Bearer ${bobToken}`);
      assert.equal(res.status, 204);
      assert.deepEqual(published, []);
    });
  });
});

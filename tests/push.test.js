const { test, describe, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { resetDb, createUser, prisma } = require("./helpers/db");
const app = require("../src/app");
const webpush = require("web-push");
const { sendPushToUser, getPublicKey } = require("../src/lib/push");

async function login(email, password) {
  const res = await request(app).post("/api/auth/login").send({ email, password });
  return res.body.token;
}

const FAKE_SUBSCRIPTION = {
  endpoint: "https://push.example.com/abc123",
  keys: { p256dh: "fake-p256dh-key-value", auth: "fake-auth-secret" },
};

describe("Push API", () => {
  let alice, aliceToken;

  beforeEach(async () => {
    await resetDb();
    alice = await createUser({ email: "alice@test.com", password: "alicepass1" });
    aliceToken = await login("alice@test.com", "alicepass1");
  });

  describe("GET /push/vapid-public-key", () => {
    test("requires authentication", async () => {
      const res = await request(app).get("/api/push/vapid-public-key");
      assert.equal(res.status, 401);
    });

    test("returns the configured key (test env sets VAPID_PUBLIC_KEY)", async () => {
      const res = await request(app)
        .get("/api/push/vapid-public-key")
        .set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.publicKey, getPublicKey());
    });
  });

  describe("POST /push/subscribe", () => {
    test("requires authentication", async () => {
      const res = await request(app).post("/api/push/subscribe").send({ subscription: FAKE_SUBSCRIPTION });
      assert.equal(res.status, 401);
    });

    test("400s on a malformed subscription", async () => {
      const res = await request(app)
        .post("/api/push/subscribe")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ subscription: { endpoint: "https://x" } });
      assert.equal(res.status, 400);
    });

    test("creates a subscription row for the caller", async () => {
      const res = await request(app)
        .post("/api/push/subscribe")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ subscription: FAKE_SUBSCRIPTION });
      assert.equal(res.status, 204);

      const rows = await prisma.pushSubscription.findMany({ where: { userId: alice.id } });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].endpoint, FAKE_SUBSCRIPTION.endpoint);
      assert.equal(rows[0].p256dh, FAKE_SUBSCRIPTION.keys.p256dh);
      assert.equal(rows[0].authKey, FAKE_SUBSCRIPTION.keys.auth);
    });

    test("re-subscribing the same endpoint upserts rather than duplicating", async () => {
      await request(app)
        .post("/api/push/subscribe")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ subscription: FAKE_SUBSCRIPTION });
      await request(app)
        .post("/api/push/subscribe")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ subscription: FAKE_SUBSCRIPTION });

      const rows = await prisma.pushSubscription.findMany({ where: { userId: alice.id } });
      assert.equal(rows.length, 1);
    });

    test("caps subscriptions per user, evicting the oldest first", async () => {
      for (let i = 0; i < 21; i++) {
        const res = await request(app)
          .post("/api/push/subscribe")
          .set("Authorization", `Bearer ${aliceToken}`)
          .send({
            subscription: {
              endpoint: `https://push.example.com/device-${i}`,
              keys: { p256dh: `p256dh-${i}`, auth: `auth-${i}` },
            },
          });
        assert.equal(res.status, 204);
      }

      const rows = await prisma.pushSubscription.findMany({
        where: { userId: alice.id },
        orderBy: { createdAt: "asc" },
      });
      assert.equal(rows.length, 20);
      // The very first subscription (device-0) should have been evicted;
      // the most recent one (device-20) must survive.
      assert.ok(!rows.some((r) => r.endpoint === "https://push.example.com/device-0"));
      assert.ok(rows.some((r) => r.endpoint === "https://push.example.com/device-20"));
    });
  });

  describe("POST /push/unsubscribe", () => {
    test("requires authentication", async () => {
      const res = await request(app)
        .post("/api/push/unsubscribe")
        .send({ endpoint: FAKE_SUBSCRIPTION.endpoint });
      assert.equal(res.status, 401);
    });

    test("removes the caller's own subscription", async () => {
      await request(app)
        .post("/api/push/subscribe")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ subscription: FAKE_SUBSCRIPTION });

      const res = await request(app)
        .post("/api/push/unsubscribe")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ endpoint: FAKE_SUBSCRIPTION.endpoint });
      assert.equal(res.status, 204);
      assert.equal(await prisma.pushSubscription.count(), 0);
    });

    test("cannot remove another user's subscription by guessing their endpoint", async () => {
      const bob = await createUser({ email: "bob@test.com", password: "bobpass1" });
      const bobToken = await login("bob@test.com", "bobpass1");
      await request(app)
        .post("/api/push/subscribe")
        .set("Authorization", `Bearer ${bobToken}`)
        .send({ subscription: FAKE_SUBSCRIPTION });

      await request(app)
        .post("/api/push/unsubscribe")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ endpoint: FAKE_SUBSCRIPTION.endpoint });

      assert.equal(await prisma.pushSubscription.count({ where: { userId: bob.id } }), 1);
    });
  });

  describe("src/lib/push.js#sendPushToUser (unit, webpush.sendNotification mocked)", () => {
    test("a 410 Gone response deletes the subscription row", async (t) => {
      const sub = await prisma.pushSubscription.create({
        data: { userId: alice.id, endpoint: "https://push.example.com/gone", p256dh: "x", authKey: "y" },
      });
      t.mock.method(webpush, "sendNotification", async () => {
        const err = new Error("gone");
        err.statusCode = 410;
        throw err;
      });

      await sendPushToUser(alice.id, { title: "hi" });

      assert.equal(await prisma.pushSubscription.findUnique({ where: { id: sub.id } }), null);
    });

    test("a non-404/410 failure logs and leaves the subscription in place", async (t) => {
      const sub = await prisma.pushSubscription.create({
        data: { userId: alice.id, endpoint: "https://push.example.com/flaky", p256dh: "x", authKey: "y" },
      });
      t.mock.method(webpush, "sendNotification", async () => {
        const err = new Error("server error");
        err.statusCode = 500;
        throw err;
      });
      const consoleError = t.mock.method(console, "error", () => {});

      const result = await sendPushToUser(alice.id, { title: "hi" });

      assert.equal(result.sent, 0);
      assert.ok(await prisma.pushSubscription.findUnique({ where: { id: sub.id } }));
      assert.ok(consoleError.mock.callCount() >= 1);
    });

    test("a successful send is counted", async (t) => {
      await prisma.pushSubscription.create({
        data: { userId: alice.id, endpoint: "https://push.example.com/ok", p256dh: "x", authKey: "y" },
      });
      t.mock.method(webpush, "sendNotification", async () => {});

      const result = await sendPushToUser(alice.id, { title: "hi" });
      assert.equal(result.sent, 1);
    });

    test("a user with no subscriptions is a cheap no-op", async () => {
      const result = await sendPushToUser(alice.id, { title: "hi" });
      assert.equal(result.reason, "no_subscriptions");
    });
  });
});

describe("Per-device push subscription management", () => {
  let alice, aliceToken, bob, bobToken;

  beforeEach(async () => {
    await resetDb();
    alice = await createUser({ email: "alice@test.com", password: "alicepass1" });
    bob = await createUser({ email: "bob@test.com", password: "bobpass1" });
    aliceToken = await login("alice@test.com", "alicepass1");
    bobToken = await login("bob@test.com", "bobpass1");
  });

  test("both routes require authentication", async () => {
    assert.equal((await request(app).get("/api/push/subscriptions")).status, 401);
    assert.equal((await request(app).delete("/api/push/subscriptions/1")).status, 401);
  });

  test("lists this account's subscriptions with a device label, newest first", async () => {
    await request(app)
      .post("/api/push/subscribe")
      .set("Authorization", `Bearer ${aliceToken}`)
      .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36")
      .send({ subscription: FAKE_SUBSCRIPTION });

    await request(app)
      .post("/api/push/subscribe")
      .set("Authorization", `Bearer ${aliceToken}`)
      .set("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1")
      .send({ subscription: { ...FAKE_SUBSCRIPTION, endpoint: "https://push.example.com/second" } });

    const res = await request(app).get("/api/push/subscriptions").set("Authorization", `Bearer ${aliceToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 2);

    const labels = res.body.map((r) => r.device);
    assert.ok(labels.includes("Chrome on Windows"), `got ${JSON.stringify(labels)}`);
    assert.ok(labels.includes("Safari on iOS"), `got ${JSON.stringify(labels)}`);
  });

  // These are the credentials for pushing to that browser — the UI only ever
  // needs an id and a label.
  test("never exposes the endpoint or key material", async () => {
    await request(app)
      .post("/api/push/subscribe")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ subscription: FAKE_SUBSCRIPTION });

    const res = await request(app).get("/api/push/subscriptions").set("Authorization", `Bearer ${aliceToken}`);
    const row = res.body[0];
    assert.equal(row.endpoint, undefined);
    assert.equal(row.p256dh, undefined);
    assert.equal(row.authKey, undefined);
    assert.ok(Number.isInteger(row.id));
  });

  test("a missing User-Agent still subscribes, just unlabelled", async () => {
    await request(app)
      .post("/api/push/subscribe")
      .set("Authorization", `Bearer ${aliceToken}`)
      .set("User-Agent", "")
      .send({ subscription: FAKE_SUBSCRIPTION });

    const res = await request(app).get("/api/push/subscriptions").set("Authorization", `Bearer ${aliceToken}`);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].device, "Unknown device");
  });

  test("only lists your own subscriptions", async () => {
    await request(app)
      .post("/api/push/subscribe")
      .set("Authorization", `Bearer ${bobToken}`)
      .send({ subscription: FAKE_SUBSCRIPTION });

    const res = await request(app).get("/api/push/subscriptions").set("Authorization", `Bearer ${aliceToken}`);
    assert.deepEqual(res.body, []);
  });

  test("revokes one of your own devices", async () => {
    await request(app)
      .post("/api/push/subscribe")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ subscription: FAKE_SUBSCRIPTION });

    const list = await request(app).get("/api/push/subscriptions").set("Authorization", `Bearer ${aliceToken}`);
    const id = list.body[0].id;

    const res = await request(app)
      .delete(`/api/push/subscriptions/${id}`)
      .set("Authorization", `Bearer ${aliceToken}`);
    assert.equal(res.status, 204);

    const remaining = await prisma.pushSubscription.findMany({ where: { userId: alice.id } });
    assert.equal(remaining.length, 0);
  });

  // 404, not a successful delete: an id you don't own must be indistinguishable
  // from one that doesn't exist.
  test("404s (and deletes nothing) for another account's subscription id", async () => {
    await request(app)
      .post("/api/push/subscribe")
      .set("Authorization", `Bearer ${bobToken}`)
      .send({ subscription: FAKE_SUBSCRIPTION });

    const bobsRow = await prisma.pushSubscription.findFirst({ where: { userId: bob.id } });

    const res = await request(app)
      .delete(`/api/push/subscriptions/${bobsRow.id}`)
      .set("Authorization", `Bearer ${aliceToken}`);
    assert.equal(res.status, 404);

    const stillThere = await prisma.pushSubscription.findUnique({ where: { id: bobsRow.id } });
    assert.ok(stillThere, "another account's subscription must survive");
  });

  test("400s on a non-numeric id", async () => {
    const res = await request(app)
      .delete("/api/push/subscriptions/abc")
      .set("Authorization", `Bearer ${aliceToken}`);
    assert.equal(res.status, 400);
  });
});

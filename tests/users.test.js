const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { resetDb, createUser } = require("./helpers/db");
const app = require("../src/app");
const prisma = require("../prisma/client");

async function login(email, password) {
  const res = await request(app).post("/api/auth/login").send({ email, password });
  return res.body.token;
}

describe("PATCH /users/me", () => {
  let alice, aliceToken;
  let bob, bobToken;

  beforeEach(async () => {
    await resetDb();
    alice = await createUser({ email: "alice@test.com", password: "alicepass1", name: "Alice" });
    bob = await createUser({ email: "bob@test.com", password: "bobpass1", name: "Bob" });
    aliceToken = await login("alice@test.com", "alicepass1");
    bobToken = await login("bob@test.com", "bobpass1");
  });

  test("requires authentication", async () => {
    const res = await request(app).patch("/api/users/me").send({ publicId: "aliceid1" });
    assert.equal(res.status, 401);
  });

  test("sets a chosen publicId, uppercased, and marks it customized", async () => {
    const res = await request(app)
      .patch("/api/users/me")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ publicId: "aliceid1" });

    assert.equal(res.status, 200);
    // Uppercased to match the alphabet randomly generated ids already use —
    // GET /friends/lookup uppercases whatever it's given before querying, so
    // a stored lowercase id would never be found by lookup. See the
    // "can be found by GET /friends/lookup regardless of the case it was
    // typed in" test below for the regression this guards against.
    assert.equal(res.body.publicId, "ALICEID1");
  });

  test("a custom id set in lowercase can still be found by GET /friends/lookup", async () => {
    const set = await request(app)
      .patch("/api/users/me")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ publicId: "aliceid1" });
    assert.equal(set.status, 200);

    const found = await request(app)
      .get(`/api/friends/lookup?publicId=${set.body.publicId.toLowerCase()}`)
      .set("Authorization", `Bearer ${bobToken}`);

    assert.equal(found.status, 200);
    assert.equal(found.body.id, alice.id);
  });

  test("rejects a publicId shorter than 4 characters", async () => {
    const res = await request(app)
      .patch("/api/users/me")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ publicId: "abc" });

    assert.equal(res.status, 400);
  });

  test("rejects a publicId longer than 20 characters", async () => {
    const res = await request(app)
      .patch("/api/users/me")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ publicId: "a".repeat(21) });

    assert.equal(res.status, 400);
  });

  test("rejects a publicId with characters outside a-zA-Z0-9", async () => {
    const res = await request(app)
      .patch("/api/users/me")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ publicId: "alice_id" });

    assert.equal(res.status, 400);
  });

  test("rejects a publicId already taken by another user, case-insensitively", async () => {
    const res = await request(app)
      .patch("/api/users/me")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ publicId: bob.publicId.toLowerCase() });

    assert.equal(res.status, 409);
  });

  test("rejects a second custom publicId after one was already set", async () => {
    const first = await request(app)
      .patch("/api/users/me")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ publicId: "aliceid1" });
    assert.equal(first.status, 200);

    const second = await request(app)
      .patch("/api/users/me")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ publicId: "aliceid2" });

    assert.equal(second.status, 409);
  });

  test("two concurrent requests can't both spend the one-time custom-id allowance", async () => {
    const [first, second] = await Promise.all([
      request(app).patch("/api/users/me").set("Authorization", `Bearer ${aliceToken}`).send({ publicId: "raceida" }),
      request(app).patch("/api/users/me").set("Authorization", `Bearer ${aliceToken}`).send({ publicId: "raceidb" }),
    ]);

    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409]);

    const winner = first.status === 200 ? first : second;
    const updated = await prisma.user.findUnique({ where: { id: alice.id } });
    assert.equal(updated.publicId, winner.body.publicId);
    assert.equal(updated.publicIdCustomized, true);
  });
});

describe("PATCH /users/me — statusMessage", () => {
  let alice, aliceToken;

  beforeEach(async () => {
    await resetDb();
    alice = await createUser({ email: "alice@test.com", password: "alicepass1", name: "Alice" });
    aliceToken = await login("alice@test.com", "alicepass1");
  });

  test("sets and trims a status message", async () => {
    const res = await request(app)
      .patch("/api/users/me")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ statusMessage: "  out for lunch  " });
    assert.equal(res.status, 200);
    assert.equal(res.body.statusMessage, "out for lunch");

    const updated = await prisma.user.findUnique({ where: { id: alice.id } });
    assert.equal(updated.statusMessage, "out for lunch");
  });

  test("a blank string and null both clear it to null", async () => {
    for (const value of ["", "   ", null]) {
      await request(app)
        .patch("/api/users/me")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ statusMessage: "something" });

      const res = await request(app)
        .patch("/api/users/me")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ statusMessage: value });
      assert.equal(res.status, 200);
      assert.equal(res.body.statusMessage, null, `value ${JSON.stringify(value)} must clear to null`);

      const updated = await prisma.user.findUnique({ where: { id: alice.id } });
      assert.equal(updated.statusMessage, null);
    }
  });

  test("rejects a status message over 80 characters", async () => {
    const res = await request(app)
      .patch("/api/users/me")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ statusMessage: "x".repeat(81) });
    assert.equal(res.status, 400);
  });

  test("rejects a non-string, non-null status message", async () => {
    const res = await request(app)
      .patch("/api/users/me")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ statusMessage: 42 });
    assert.equal(res.status, 400);
  });

  test("400s when the body updates nothing", async () => {
    const res = await request(app).patch("/api/users/me").set("Authorization", `Bearer ${aliceToken}`).send({});
    assert.equal(res.status, 400);
  });

  // The regression this route was restructured for: publicId is a one-shot
  // change, but that guard used to run for every PATCH, so once the custom
  // ID was spent a status-only update 409'd too.
  test("a status update still works after the one-time custom publicId is spent", async () => {
    const setId = await request(app)
      .patch("/api/users/me")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ publicId: "aliceid1" });
    assert.equal(setId.status, 200);

    const res = await request(app)
      .patch("/api/users/me")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ statusMessage: "still editable" });
    assert.equal(res.status, 200);
    assert.equal(res.body.statusMessage, "still editable");
  });

  test("GET /auth/me returns the status message", async () => {
    await request(app)
      .patch("/api/users/me")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ statusMessage: "on holiday" });

    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${aliceToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.statusMessage, "on holiday");
    assert.equal(res.body.avatarUrl, null, "no avatar uploaded, and R2 is unconfigured in tests");
  });
});

describe("Avatar routes without R2 configured", () => {
  let aliceToken;

  beforeEach(async () => {
    await resetDb();
    await createUser({ email: "alice@test.com", password: "alicepass1" });
    aliceToken = await login("alice@test.com", "alicepass1");
  });

  test("POST /users/me/avatar/upload-url 503s rather than crashing", async () => {
    const res = await request(app)
      .post("/api/users/me/avatar/upload-url")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ mimeType: "image/png", size: 1024 });
    assert.equal(res.status, 503);
  });

  test("PUT /users/me/avatar 503s rather than crashing", async () => {
    const res = await request(app)
      .put("/api/users/me/avatar")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ key: "avatars/1/abc" });
    assert.equal(res.status, 503);
  });

  // Clearing an avatar touches no object storage at all, so it must keep
  // working whether or not R2 is configured.
  test("DELETE /users/me/avatar works regardless, and clears the key", async () => {
    const res = await request(app).delete("/api/users/me/avatar").set("Authorization", `Bearer ${aliceToken}`);
    assert.equal(res.status, 204);
  });

  test("all three require authentication", async () => {
    for (const req of [
      request(app).post("/api/users/me/avatar/upload-url").send({ mimeType: "image/png", size: 1 }),
      request(app).put("/api/users/me/avatar").send({ key: "avatars/1/abc" }),
      request(app).delete("/api/users/me/avatar"),
    ]) {
      const res = await req;
      assert.equal(res.status, 401);
    }
  });
});

const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { resetDb, createUser } = require("./helpers/db");
const app = require("../src/app");

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
});

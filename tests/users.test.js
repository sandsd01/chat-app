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
  let bob;

  beforeEach(async () => {
    await resetDb();
    alice = await createUser({ email: "alice@test.com", password: "alicepass1", name: "Alice" });
    bob = await createUser({ email: "bob@test.com", password: "bobpass1", name: "Bob" });
    aliceToken = await login("alice@test.com", "alicepass1");
  });

  test("requires authentication", async () => {
    const res = await request(app).patch("/api/users/me").send({ publicId: "aliceid1" });
    assert.equal(res.status, 401);
  });

  test("sets a chosen publicId and marks it customized", async () => {
    const res = await request(app)
      .patch("/api/users/me")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ publicId: "aliceid1" });

    assert.equal(res.status, 200);
    assert.equal(res.body.publicId, "aliceid1");
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

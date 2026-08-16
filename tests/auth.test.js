const crypto = require("node:crypto");
const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const { resetDb, createUser, prisma } = require("./helpers/db");
const { createUserWithUniquePublicId } = require("../src/lib/publicId");
const app = require("../src/app");

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

describe("Google sign-in, not configured (no GOOGLE_* env vars in this test process)", () => {
  test("GET /auth/google 503s rather than crashing", async () => {
    const res = await request(app).get("/api/auth/google");
    assert.equal(res.status, 503);
  });
});

describe("POST /auth/signup", () => {
  beforeEach(async () => {
    await resetDb();
  });

  test("creates an account with a token and a generated publicId", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "newbie@test.com", password: "newbiepass1", name: "Newbie" });
    assert.equal(res.status, 201);
    assert.ok(res.body.token);
    assert.equal(res.body.user.email, "newbie@test.com");
    assert.equal(res.body.user.name, "Newbie");
    assert.match(res.body.user.publicId, /^[2-9A-HJ-NP-Z]{8}$/);
    assert.equal(res.body.user.passwordHash, undefined);
  });

  test("requires email and password", async () => {
    const res = await request(app).post("/api/auth/signup").send({ email: "newbie@test.com" });
    assert.equal(res.status, 400);
  });

  test("rejects a password shorter than 8 characters", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "newbie@test.com", password: "short" });
    assert.equal(res.status, 400);
  });

  test("rejects an invalid email format", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "notanemail", password: "newbiepass1" });
    assert.equal(res.status, 400);
  });

  test("409s on a duplicate email", async () => {
    await createUser({ email: "dup@test.com", password: "duppass1" });
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "dup@test.com", password: "anotherpass1" });
    assert.equal(res.status, 409);
  });

  test("two signups never collide on publicId", async () => {
    const a = await request(app)
      .post("/api/auth/signup")
      .send({ email: "a@test.com", password: "apassword1" });
    const b = await request(app)
      .post("/api/auth/signup")
      .send({ email: "b@test.com", password: "bpassword1" });
    assert.notEqual(a.body.user.publicId, b.body.user.publicId);
  });

  test("a new account starts unverified and gets a verify token (RESEND_API_KEY unset in tests, so no real email sends)", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "unverified@test.com", password: "newbiepass1" });
    assert.equal(res.body.user.emailVerifiedAt, null);

    const stored = await prisma.user.findUnique({ where: { email: "unverified@test.com" } });
    assert.ok(stored.verifyTokenHash);
    assert.ok(stored.verifyTokenExpiresAt > new Date());
  });
});

describe("Email verification", () => {
  let user;

  beforeEach(async () => {
    await resetDb();
    user = await createUser({ email: "toverify@test.com", password: "verifypass1", verified: false });
  });

  test("POST /auth/verify-email with a valid token marks the account verified", async () => {
    const token = "test-verify-token";
    await prisma.user.update({
      where: { id: user.id },
      data: { verifyTokenHash: hashToken(token), verifyTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    });

    const res = await request(app)
      .post("/api/auth/verify-email")
      .send({ email: "toverify@test.com", token });
    assert.equal(res.status, 200);
    assert.ok(res.body.emailVerifiedAt);

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    assert.ok(updated.emailVerifiedAt);
    assert.equal(updated.verifyTokenHash, null);
    assert.equal(updated.verifyTokenExpiresAt, null);
  });

  test("rejects an invalid token", async () => {
    await prisma.user.update({
      where: { id: user.id },
      data: { verifyTokenHash: hashToken("real-token"), verifyTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    });
    const res = await request(app)
      .post("/api/auth/verify-email")
      .send({ email: "toverify@test.com", token: "wrong-token" });
    assert.equal(res.status, 400);
  });

  test("rejects an expired token", async () => {
    await prisma.user.update({
      where: { id: user.id },
      data: { verifyTokenHash: hashToken("expired-token"), verifyTokenExpiresAt: new Date(Date.now() - 1000) },
    });
    const res = await request(app)
      .post("/api/auth/verify-email")
      .send({ email: "toverify@test.com", token: "expired-token" });
    assert.equal(res.status, 400);
  });

  test("400s on missing email or token", async () => {
    const res = await request(app).post("/api/auth/verify-email").send({ email: "toverify@test.com" });
    assert.equal(res.status, 400);
  });

  test("POST /auth/resend-verification requires authentication", async () => {
    const res = await request(app).post("/api/auth/resend-verification");
    assert.equal(res.status, 401);
  });

  test("POST /auth/resend-verification issues a fresh token for an unverified account", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "toverify@test.com", password: "verifypass1" });

    const res = await request(app)
      .post("/api/auth/resend-verification")
      .set("Authorization", `Bearer ${login.body.token}`);
    assert.equal(res.status, 200);

    const stored = await prisma.user.findUnique({ where: { id: user.id } });
    assert.ok(stored.verifyTokenHash);
    assert.ok(stored.verifyTokenExpiresAt > new Date());
  });

  test("POST /auth/resend-verification is a no-op message for an already-verified account", async () => {
    const verified = await createUser({ email: "already@test.com", password: "verifypass1", verified: true });
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "already@test.com", password: "verifypass1" });

    const res = await request(app)
      .post("/api/auth/resend-verification")
      .set("Authorization", `Bearer ${login.body.token}`);
    assert.equal(res.status, 200);

    const stored = await prisma.user.findUnique({ where: { id: verified.id } });
    assert.equal(stored.verifyTokenHash, null);
  });
});

describe("GET /auth/captcha-config", () => {
  test("reports not configured (no TURNSTILE_SECRET_KEY in this test process)", async () => {
    const res = await request(app).get("/api/auth/captcha-config");
    assert.equal(res.status, 200);
    assert.equal(res.body.configured, false);
    assert.equal(res.body.siteKey, null);
  });
});

describe("POST /auth/login", () => {
  let alice;

  beforeEach(async () => {
    await resetDb();
    alice = await createUser({ email: "alice@test.com", password: "alicepass1" });
  });

  test("returns a token and user for valid credentials", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "alice@test.com", password: "alicepass1" });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    assert.equal(res.body.user.email, "alice@test.com");
    assert.equal(res.body.user.passwordHash, undefined);
    assert.equal(res.body.user.hasPassword, true);
  });

  test("rejects an incorrect password", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "alice@test.com", password: "wrong-password" });
    assert.equal(res.status, 401);
  });

  test("rejects an unknown email", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@test.com", password: "alicepass1" });
    assert.equal(res.status, 401);
  });

  test("requires email and password", async () => {
    const res = await request(app).post("/api/auth/login").send({});
    assert.equal(res.status, 400);
  });

  test("logs in with the account's publicId as the identifier, instead of email", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ identifier: alice.publicId, password: "alicepass1" });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, "alice@test.com");
  });

  test("publicId login is case-insensitive", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ identifier: alice.publicId.toLowerCase(), password: "alicepass1" });
    assert.equal(res.status, 200);
  });

  test("rejects an unknown publicId", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ identifier: "ZZZZZZZZ", password: "alicepass1" });
    assert.equal(res.status, 401);
  });
});

describe("GET /auth/me", () => {
  beforeEach(async () => {
    await resetDb();
  });

  test("requires authentication", async () => {
    const res = await request(app).get("/api/auth/me");
    assert.equal(res.status, 401);
  });

  test("returns the caller's own profile without the password hash", async () => {
    await createUser({ email: "alice@test.com", password: "alicepass1", name: "Alice" });
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "alice@test.com", password: "alicepass1" });

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${login.body.token}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.email, "alice@test.com");
    assert.equal(res.body.name, "Alice");
    assert.equal(res.body.passwordHash, undefined);
  });

  test("reports publicIdCustomized so the client knows whether the one-time change is still available", async () => {
    await createUser({ email: "alice@test.com", password: "alicepass1", name: "Alice" });
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "alice@test.com", password: "alicepass1" });

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${login.body.token}`);

    assert.equal(res.body.publicIdCustomized, false);
  });
});

describe("PATCH /auth/password", () => {
  let token;

  beforeEach(async () => {
    await resetDb();
    await createUser({ email: "alice@test.com", password: "alicepass1" });
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "alice@test.com", password: "alicepass1" });
    token = login.body.token;
  });

  test("requires authentication", async () => {
    const res = await request(app)
      .patch("/api/auth/password")
      .send({ currentPassword: "alicepass1", newPassword: "newpassword1" });
    assert.equal(res.status, 401);
  });

  test("changes the password and allows login with the new one", async () => {
    const res = await request(app)
      .patch("/api/auth/password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "alicepass1", newPassword: "newpassword1" });
    assert.equal(res.status, 200);

    const oldLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: "alice@test.com", password: "alicepass1" });
    assert.equal(oldLogin.status, 401);

    const newLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: "alice@test.com", password: "newpassword1" });
    assert.equal(newLogin.status, 200);
  });

  test("rejects an incorrect current password", async () => {
    const res = await request(app)
      .patch("/api/auth/password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "wrong", newPassword: "newpassword1" });
    assert.equal(res.status, 401);
  });

  test("rejects a new password shorter than 8 characters", async () => {
    const res = await request(app)
      .patch("/api/auth/password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "alicepass1", newPassword: "short" });
    assert.equal(res.status, 400);
  });
});

describe("PATCH /auth/password, setting a first password on a Google-only account", () => {
  let googleUser;
  let token;

  beforeEach(async () => {
    await resetDb();
    googleUser = await createUserWithUniquePublicId(prisma, {
      email: "googleuser@test.com",
      googleId: "google-sub-test",
      emailVerifiedAt: new Date(),
    });
    token = jwt.sign({ sub: googleUser.id, email: googleUser.email }, process.env.JWT_SECRET, { expiresIn: "8h" });
  });

  test("GET /auth/me reports hasPassword: false before a password is set", async () => {
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    assert.equal(res.body.hasPassword, false);
  });

  test("sets a password without requiring currentPassword", async () => {
    const res = await request(app)
      .patch("/api/auth/password")
      .set("Authorization", `Bearer ${token}`)
      .send({ newPassword: "newpassword1" });
    assert.equal(res.status, 200);
  });

  test("the new password then logs in, including by publicId", async () => {
    await request(app)
      .patch("/api/auth/password")
      .set("Authorization", `Bearer ${token}`)
      .send({ newPassword: "newpassword1" });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ identifier: googleUser.publicId, password: "newpassword1" });
    assert.equal(res.status, 200);
  });

  test("GET /auth/me reports hasPassword: true after a password is set", async () => {
    await request(app)
      .patch("/api/auth/password")
      .set("Authorization", `Bearer ${token}`)
      .send({ newPassword: "newpassword1" });

    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    assert.equal(res.body.hasPassword, true);
  });

  test("rejects a newPassword shorter than 8 characters", async () => {
    const res = await request(app)
      .patch("/api/auth/password")
      .set("Authorization", `Bearer ${token}`)
      .send({ newPassword: "short" });
    assert.equal(res.status, 400);
  });
});

describe("Account lockout", () => {
  beforeEach(async () => {
    await resetDb();
    await createUser({ email: "alice@test.com", password: "alicepass1" });
  });

  test("locks the account after 5 failed attempts", async () => {
    for (let i = 0; i < 4; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "alice@test.com", password: "wrong" });
      assert.equal(res.status, 401);
    }

    const fifthAttempt = await request(app)
      .post("/api/auth/login")
      .send({ email: "alice@test.com", password: "wrong" });
    assert.equal(fifthAttempt.status, 423);

    const correctPasswordWhileLocked = await request(app)
      .post("/api/auth/login")
      .send({ email: "alice@test.com", password: "alicepass1" });
    assert.equal(correctPasswordWhileLocked.status, 423);
  });

  test("a successful login resets the failed attempt counter", async () => {
    await request(app).post("/api/auth/login").send({ email: "alice@test.com", password: "wrong" });
    await request(app).post("/api/auth/login").send({ email: "alice@test.com", password: "wrong" });

    const success = await request(app)
      .post("/api/auth/login")
      .send({ email: "alice@test.com", password: "alicepass1" });
    assert.equal(success.status, 200);

    for (let i = 0; i < 4; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "alice@test.com", password: "wrong" });
      assert.equal(res.status, 401, "counter should have reset after the successful login");
    }
  });
});

describe("Password reset", () => {
  let user;

  beforeEach(async () => {
    await resetDb();
    user = await createUser({ email: "alice@test.com", password: "alicepass1" });
  });

  test("forgot-password returns a generic message for both existing and unknown emails", async () => {
    const known = await request(app).post("/api/auth/forgot-password").send({ email: "alice@test.com" });
    const unknown = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "nobody@test.com" });
    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.equal(known.body.message, unknown.body.message);
  });

  test("forgot-password sets a reset token on the user", async () => {
    await request(app).post("/api/auth/forgot-password").send({ email: "alice@test.com" });
    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    assert.ok(updated.resetTokenHash);
    assert.ok(updated.resetTokenExpiresAt > new Date());
  });

  test("reset-password with a valid token updates the password and unlocks the account", async () => {
    const token = "test-reset-token";
    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetTokenHash: hashToken(token),
        resetTokenExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
        failedLoginAttempts: 3,
      },
    });

    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ email: "alice@test.com", token, newPassword: "brandnewpass1" });
    assert.equal(res.status, 200);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "alice@test.com", password: "brandnewpass1" });
    assert.equal(login.status, 200);

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    assert.equal(updated.resetTokenHash, null);
    assert.equal(updated.failedLoginAttempts, 0);
  });

  test("reset-password rejects an invalid token", async () => {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetTokenHash: hashToken("real-token"),
        resetTokenExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    });

    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ email: "alice@test.com", token: "wrong-token", newPassword: "brandnewpass1" });
    assert.equal(res.status, 400);
  });

  test("reset-password rejects an expired token", async () => {
    const token = "expired-token";
    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetTokenHash: hashToken(token),
        resetTokenExpiresAt: new Date(Date.now() - 1000),
      },
    });

    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ email: "alice@test.com", token, newPassword: "brandnewpass1" });
    assert.equal(res.status, 400);
  });

  test("reset-password rejects a new password shorter than 8 characters", async () => {
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ email: "alice@test.com", token: "whatever", newPassword: "short" });
    assert.equal(res.status, 400);
  });
});

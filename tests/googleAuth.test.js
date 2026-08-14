// Sets GOOGLE_* before requiring src/app.js, because src/routes/auth.js
// builds its single OAuth2Client instance once at module-eval time — `node
// --test` runs each test file in its own process, so this doesn't leak into
// other test files (see tests/auth.test.js for the "not configured" case,
// which relies on exactly the opposite: those never set these vars).
process.env.GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.GOOGLE_REDIRECT_URI = "http://localhost:3000/api/auth/google/callback";
process.env.APP_URL = "http://localhost:5173";

const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { OAuth2Client } = require("google-auth-library");
const { resetDb, createUser, prisma } = require("./helpers/db");
const app = require("../src/app");

function mockGoogleIdentity(t, payload) {
  t.mock.method(OAuth2Client.prototype, "getToken", async () => ({
    tokens: { id_token: "fake-id-token" },
  }));
  t.mock.method(OAuth2Client.prototype, "verifyIdToken", async () => ({
    getPayload: () => payload,
  }));
}

function parseQuery(url) {
  return Object.fromEntries(new URL(url).searchParams);
}

describe("Google OAuth", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("GET /auth/google", () => {
    test("redirects to Google with a state param and sets a state cookie", async () => {
      const res = await request(app).get("/api/auth/google");
      assert.equal(res.status, 302);
      assert.match(res.headers.location, /^https:\/\/accounts\.google\.com/);

      const q = parseQuery(res.headers.location);
      assert.equal(q.client_id, process.env.GOOGLE_CLIENT_ID);
      assert.equal(q.redirect_uri, process.env.GOOGLE_REDIRECT_URI);
      assert.ok(q.scope.includes("email"));
      assert.ok(q.state);

      const setCookie = res.headers["set-cookie"]?.join(";") || "";
      assert.match(setCookie, /g_oauth_state=/);
      assert.match(setCookie, /HttpOnly/i);
    });
  });

  describe("GET /auth/google/callback", () => {
    test("missing code/state redirects to /login with an error", async () => {
      const res = await request(app).get("/api/auth/google/callback");
      assert.equal(res.status, 302);
      assert.match(res.headers.location, /^http:\/\/localhost:5173\/login\?error=invalid_state/);
    });

    test("a state that doesn't match the cookie is rejected", async () => {
      const agent = request.agent(app);
      await agent.get("/api/auth/google"); // sets the real state cookie
      const res = await agent.get("/api/auth/google/callback?code=abc&state=not-the-real-state");
      assert.equal(res.status, 302);
      assert.match(res.headers.location, /error=invalid_state/);
    });

    test("an unverified Google email is rejected", async (t) => {
      mockGoogleIdentity(t, {
        sub: "google-sub-1",
        email: "unverified@test.com",
        email_verified: false,
      });
      const agent = request.agent(app);
      const start = await agent.get("/api/auth/google");
      const state = parseQuery(start.headers.location).state;
      const res = await agent.get(`/api/auth/google/callback?code=abc&state=${state}`);
      assert.equal(res.status, 302);
      assert.match(res.headers.location, /error=email_not_verified/);
    });

    test("Google's token/id-token exchange failing redirects with an error", async (t) => {
      t.mock.method(OAuth2Client.prototype, "getToken", async () => {
        throw new Error("network error");
      });
      const agent = request.agent(app);
      const start = await agent.get("/api/auth/google");
      const state = parseQuery(start.headers.location).state;
      const res = await agent.get(`/api/auth/google/callback?code=abc&state=${state}`);
      assert.equal(res.status, 302);
      assert.match(res.headers.location, /error=google_exchange_failed/);
    });

    test("creates a new account on first sign-in and the ticket exchanges for a real session", async (t) => {
      mockGoogleIdentity(t, {
        sub: "google-sub-new",
        email: "newgoogleuser@test.com",
        email_verified: true,
        name: "New Googler",
      });
      const agent = request.agent(app);
      const start = await agent.get("/api/auth/google");
      const state = parseQuery(start.headers.location).state;
      const callback = await agent.get(`/api/auth/google/callback?code=abc&state=${state}`);
      assert.equal(callback.status, 302);
      assert.match(callback.headers.location, /^http:\/\/localhost:5173\/oauth-callback\?ticket=/);

      const ticket = parseQuery(callback.headers.location).ticket;
      const exchange = await request(app).post("/api/auth/google/exchange").send({ ticket });
      assert.equal(exchange.status, 200);
      assert.ok(exchange.body.token);
      assert.equal(exchange.body.user.email, "newgoogleuser@test.com");
      assert.equal(exchange.body.user.name, "New Googler");
      assert.match(exchange.body.user.publicId, /^[2-9A-HJ-NP-Z]{8}$/);

      const stored = await prisma.user.findUnique({ where: { email: "newgoogleuser@test.com" } });
      assert.equal(stored.googleId, "google-sub-new");
      assert.equal(stored.passwordHash, null);
      assert.ok(stored.emailVerifiedAt, "Google already required email_verified, so this account starts verified");
    });

    test("auto-links to an existing password account with the same verified email", async (t) => {
      const existing = await createUser({ email: "linkme@test.com", password: "somepassword1" });
      mockGoogleIdentity(t, { sub: "google-sub-link", email: "linkme@test.com", email_verified: true });

      const agent = request.agent(app);
      const start = await agent.get("/api/auth/google");
      const state = parseQuery(start.headers.location).state;
      const callback = await agent.get(`/api/auth/google/callback?code=abc&state=${state}`);
      const ticket = parseQuery(callback.headers.location).ticket;
      const exchange = await request(app).post("/api/auth/google/exchange").send({ ticket });

      assert.equal(exchange.body.user.id, existing.id);
      const stored = await prisma.user.findUnique({ where: { id: existing.id } });
      assert.equal(stored.googleId, "google-sub-link");
      assert.ok(stored.passwordHash, "the original password must survive linking");
    });

    test("auto-linking also verifies the email if the password account hadn't verified yet", async (t) => {
      const existing = await createUser({ email: "unverified-link@test.com", password: "somepassword1", verified: false });
      mockGoogleIdentity(t, { sub: "google-sub-link2", email: "unverified-link@test.com", email_verified: true });

      const agent = request.agent(app);
      const state = parseQuery((await agent.get("/api/auth/google")).headers.location).state;
      const callback = await agent.get(`/api/auth/google/callback?code=abc&state=${state}`);
      const ticket = parseQuery(callback.headers.location).ticket;
      await request(app).post("/api/auth/google/exchange").send({ ticket });

      const stored = await prisma.user.findUnique({ where: { id: existing.id } });
      assert.ok(stored.emailVerifiedAt, "linking via Google is itself proof of a verified email");
    });

    test("a returning Google user (by googleId) logs into the same account", async (t) => {
      mockGoogleIdentity(t, { sub: "google-sub-return", email: "returner@test.com", email_verified: true });
      const agent = request.agent(app);

      let state = parseQuery((await agent.get("/api/auth/google")).headers.location).state;
      let callback = await agent.get(`/api/auth/google/callback?code=abc&state=${state}`);
      const firstTicket = parseQuery(callback.headers.location).ticket;
      const first = await request(app).post("/api/auth/google/exchange").send({ ticket: firstTicket });

      state = parseQuery((await agent.get("/api/auth/google")).headers.location).state;
      callback = await agent.get(`/api/auth/google/callback?code=abc&state=${state}`);
      const secondTicket = parseQuery(callback.headers.location).ticket;
      const second = await request(app).post("/api/auth/google/exchange").send({ ticket: secondTicket });

      assert.equal(first.body.user.id, second.body.user.id);
      assert.equal(await prisma.user.count(), 1);
    });
  });

  describe("POST /auth/google/exchange", () => {
    test("400/401s a missing or bogus ticket", async () => {
      const missing = await request(app).post("/api/auth/google/exchange").send({});
      assert.equal(missing.status, 401);
      const bogus = await request(app).post("/api/auth/google/exchange").send({ ticket: "not-a-real-ticket" });
      assert.equal(bogus.status, 401);
    });

    test("a ticket can only be exchanged once", async (t) => {
      mockGoogleIdentity(t, { sub: "google-sub-once", email: "onceonly@test.com", email_verified: true });
      const agent = request.agent(app);
      const state = parseQuery((await agent.get("/api/auth/google")).headers.location).state;
      const callback = await agent.get(`/api/auth/google/callback?code=abc&state=${state}`);
      const ticket = parseQuery(callback.headers.location).ticket;

      const first = await request(app).post("/api/auth/google/exchange").send({ ticket });
      assert.equal(first.status, 200);
      const second = await request(app).post("/api/auth/google/exchange").send({ ticket });
      assert.equal(second.status, 401);
    });
  });

  describe("Interaction with password auth", () => {
    test("POST /auth/login on a Google-only account (no password) returns a clear 401, not a crash", async (t) => {
      mockGoogleIdentity(t, { sub: "google-sub-nopass", email: "nopassword@test.com", email_verified: true });
      const agent = request.agent(app);
      const state = parseQuery((await agent.get("/api/auth/google")).headers.location).state;
      await agent.get(`/api/auth/google/callback?code=abc&state=${state}`);

      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "nopassword@test.com", password: "whatever12345" });
      assert.equal(res.status, 401);
      assert.match(res.body.error, /Google/);
    });

    test("PATCH /auth/password on a Google-only account 400s instead of crashing", async (t) => {
      mockGoogleIdentity(t, { sub: "google-sub-nopass2", email: "nopassword2@test.com", email_verified: true });
      const agent = request.agent(app);
      const state = parseQuery((await agent.get("/api/auth/google")).headers.location).state;
      const callback = await agent.get(`/api/auth/google/callback?code=abc&state=${state}`);
      const ticket = parseQuery(callback.headers.location).ticket;
      const { body } = await request(app).post("/api/auth/google/exchange").send({ ticket });

      const res = await request(app)
        .patch("/api/auth/password")
        .set("Authorization", `Bearer ${body.token}`)
        .send({ currentPassword: "whatever", newPassword: "newpassword123" });
      assert.equal(res.status, 400);
    });
  });
});

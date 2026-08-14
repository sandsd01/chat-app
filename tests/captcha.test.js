// Sets TURNSTILE_SECRET_KEY/TURNSTILE_SITE_KEY before requiring src/app.js,
// because src/lib/captcha.js computes captchaConfigured once at module-eval
// time — `node --test` runs each test file in its own process, so this
// doesn't leak into other test files (see tests/auth.test.js's
// "GET /auth/captcha-config" test, which relies on exactly the opposite:
// that file never sets these).
process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret";
process.env.TURNSTILE_SITE_KEY = "test-turnstile-site-key";

const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { resetDb } = require("./helpers/db");
const app = require("../src/app");

describe("CAPTCHA on signup (TURNSTILE_SECRET_KEY set in this test process)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  test("GET /auth/captcha-config reports configured, with the (non-secret) site key", async () => {
    const res = await request(app).get("/api/auth/captcha-config");
    assert.equal(res.status, 200);
    assert.equal(res.body.configured, true);
    assert.equal(res.body.siteKey, "test-turnstile-site-key");
  });

  test("signup 400s when captchaToken is missing", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "nocap@test.com", password: "newbiepass1" });
    assert.equal(res.status, 400);
  });

  test("signup 400s when Turnstile rejects the token", async (t) => {
    t.mock.method(global, "fetch", async () => ({
      ok: true,
      json: async () => ({ success: false }),
    }));
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "badcap@test.com", password: "newbiepass1", captchaToken: "bogus" });
    assert.equal(res.status, 400);
  });

  test("signup succeeds when Turnstile accepts the token, forwarding it to the verify request", async (t) => {
    let verifyUrl;
    let sentBody;
    t.mock.method(global, "fetch", async (url, options) => {
      verifyUrl = url;
      sentBody = options.body.toString();
      return { ok: true, json: async () => ({ success: true }) };
    });
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "goodcap@test.com", password: "newbiepass1", captchaToken: "real-token" });
    assert.equal(res.status, 201);
    assert.equal(verifyUrl, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    assert.match(sentBody, /response=real-token/);
    assert.match(sentBody, /secret=test-turnstile-secret/);
  });

  test("a failed/erroring Turnstile request fails closed (400, not 500)", async (t) => {
    t.mock.method(global, "fetch", async () => {
      throw new Error("network down");
    });
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "downcap@test.com", password: "newbiepass1", captchaToken: "whatever" });
    assert.equal(res.status, 400);
  });
});

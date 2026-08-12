// Sets GOOGLE_*/DRIVE_*/TOKEN_ENCRYPTION_KEY before requiring src/app.js,
// because src/lib/drive.js computes `driveConfigured` and builds its
// OAuth2Client once at module-eval time — `node --test` runs each test file
// in its own process, so this doesn't leak into other test files (see
// tests/auth.test.js for the "not configured" case, which relies on exactly
// the opposite: that file never sets these).
process.env.GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.DRIVE_REDIRECT_URI = "http://localhost:3000/api/drive/connect/callback";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.APP_URL = "http://localhost:5173";

const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { OAuth2Client } = require("google-auth-library");
const { resetDb, createUser, prisma } = require("./helpers/db");
const { encryptSecret, decryptSecret } = require("../src/lib/crypto");
const { archiveUserConversations, pruneArchivedMessages, readArchivedMessages } = require("../src/lib/drive");
const app = require("../src/app");

function parseQuery(url) {
  return Object.fromEntries(new URL(url).searchParams);
}

async function login(email, password) {
  const res = await request(app).post("/api/auth/login").send({ email, password });
  return res.body.token;
}

async function makeConversation(userA, userB) {
  const userAId = Math.min(userA.id, userB.id);
  const userBId = Math.max(userA.id, userB.id);
  return prisma.conversation.create({ data: { userAId, userBId } });
}

async function sendMessage(conversation, sender, body) {
  return prisma.message.create({ data: { conversationId: conversation.id, senderId: sender.id, body } });
}

// A minimal in-memory stand-in for the Drive v3 REST API + the OAuth token
// endpoint, so archiveUserConversations/pruneArchivedMessages run for real
// against it rather than being mocked away themselves — only their network
// edges (fetch, and google-auth-library's token refresh) are faked.
function installFakeDrive(t) {
  const filesById = new Map();
  let nextId = 1;

  t.mock.method(OAuth2Client.prototype, "getAccessToken", async () => ({ token: "fake-access-token" }));

  t.mock.method(global, "fetch", async (url, options = {}) => {
    const u = new URL(url);
    const method = options.method || "GET";

    if (u.hostname === "oauth2.googleapis.com" && u.pathname === "/revoke") {
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    }

    if (u.hostname === "www.googleapis.com" && u.pathname === "/drive/v3/files" && method === "GET") {
      const q = u.searchParams.get("q") || "";
      const matches = [...filesById.entries()].filter(
        ([, f]) => f.mimeType === "application/vnd.google-apps.folder" && q.includes(f.name)
      );
      return { ok: true, status: 200, json: async () => ({ files: matches.map(([id]) => ({ id })) }) };
    }

    if (u.hostname === "www.googleapis.com" && u.pathname === "/drive/v3/files" && method === "POST") {
      const body = JSON.parse(options.body);
      const id = `file-${nextId++}`;
      filesById.set(id, { name: body.name, mimeType: body.mimeType, parents: body.parents, content: "" });
      return { ok: true, status: 200, json: async () => ({ id }) };
    }

    const getMatch = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (u.hostname === "www.googleapis.com" && getMatch && method === "GET" && u.searchParams.get("alt") === "media") {
      const file = filesById.get(getMatch[1]);
      return { ok: true, status: 200, text: async () => file?.content || "" };
    }

    const uploadMatch = u.pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
    if (u.hostname === "www.googleapis.com" && uploadMatch && method === "PATCH") {
      const file = filesById.get(uploadMatch[1]);
      file.content = options.body;
      return { ok: true, status: 200, json: async () => ({ id: uploadMatch[1] }) };
    }

    throw new Error(`Unhandled fake Drive request: ${method} ${url}`);
  });

  return filesById;
}

describe("Google Drive backup", () => {
  let alice, bob, aliceToken, bobToken;

  beforeEach(async () => {
    await resetDb();
    alice = await createUser({ email: "alice@test.com", password: "alicepass1" });
    bob = await createUser({ email: "bob@test.com", password: "bobpass1" });
    aliceToken = await login("alice@test.com", "alicepass1");
    bobToken = await login("bob@test.com", "bobpass1");
  });

  describe("src/lib/crypto.js encrypt/decrypt", () => {
    test("round-trips a secret and never stores it in plaintext", () => {
      const enc = encryptSecret("a-refresh-token-value");
      assert.notEqual(enc, "a-refresh-token-value");
      assert.equal(decryptSecret(enc), "a-refresh-token-value");
    });
  });

  describe("GET /drive/status", () => {
    test("requires authentication", async () => {
      const res = await request(app).get("/api/drive/status");
      assert.equal(res.status, 401);
    });

    test("reports disconnected for a fresh user", async () => {
      const res = await request(app).get("/api/drive/status").set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.connected, false);
    });
  });

  describe("POST /drive/connect/start", () => {
    test("requires authentication", async () => {
      const res = await request(app).post("/api/drive/connect/start");
      assert.equal(res.status, 401);
    });

    test("returns a Google URL requesting offline access to drive.file, and sets a state cookie", async () => {
      const res = await request(app)
        .post("/api/drive/connect/start")
        .set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(res.status, 200);
      assert.match(res.body.url, /^https:\/\/accounts\.google\.com/);

      const q = parseQuery(res.body.url);
      assert.equal(q.access_type, "offline");
      assert.equal(q.prompt, "consent");
      assert.equal(q.scope, "https://www.googleapis.com/auth/drive.file");
      assert.ok(q.state);

      const setCookie = res.headers["set-cookie"]?.join(";") || "";
      assert.match(setCookie, /g_drive_state=/);
      assert.match(setCookie, /HttpOnly/i);
    });
  });

  describe("GET /drive/connect/callback", () => {
    test("missing code/state redirects to /account with an error", async () => {
      const res = await request(app).get("/api/drive/connect/callback");
      assert.equal(res.status, 302);
      assert.match(res.headers.location, /^http:\/\/localhost:5173\/account\?driveError=invalid_state/);
    });

    test("a state that doesn't match the cookie is rejected", async () => {
      const agent = request.agent(app);
      await agent.post("/api/drive/connect/start").set("Authorization", `Bearer ${aliceToken}`);
      const res = await agent.get("/api/drive/connect/callback?code=abc&state=not-the-real-state");
      assert.equal(res.status, 302);
      assert.match(res.headers.location, /driveError=invalid_state/);
    });

    test("Google not returning a refresh_token is treated as a failure", async (t) => {
      t.mock.method(OAuth2Client.prototype, "getToken", async () => ({ tokens: { id_token: "x" } }));
      const agent = request.agent(app);
      const start = await agent.post("/api/drive/connect/start").set("Authorization", `Bearer ${aliceToken}`);
      const state = parseQuery(start.body.url).state;
      const res = await agent.get(`/api/drive/connect/callback?code=abc&state=${state}`);
      assert.equal(res.status, 302);
      assert.match(res.headers.location, /driveError=no_refresh_token/);
    });

    test("the token exchange failing redirects with an error", async (t) => {
      t.mock.method(OAuth2Client.prototype, "getToken", async () => {
        throw new Error("network error");
      });
      const agent = request.agent(app);
      const start = await agent.post("/api/drive/connect/start").set("Authorization", `Bearer ${aliceToken}`);
      const state = parseQuery(start.body.url).state;
      const res = await agent.get(`/api/drive/connect/callback?code=abc&state=${state}`);
      assert.equal(res.status, 302);
      assert.match(res.headers.location, /driveError=drive_exchange_failed/);
    });

    test("a successful exchange stores the encrypted refresh token and connects the right account", async (t) => {
      t.mock.method(OAuth2Client.prototype, "getToken", async () => ({
        tokens: { refresh_token: "the-real-refresh-token" },
      }));
      const agent = request.agent(app);
      const start = await agent.post("/api/drive/connect/start").set("Authorization", `Bearer ${aliceToken}`);
      const state = parseQuery(start.body.url).state;
      const res = await agent.get(`/api/drive/connect/callback?code=abc&state=${state}`);
      assert.equal(res.status, 302);
      assert.equal(res.headers.location, "http://localhost:5173/account?drive=connected");

      const updated = await prisma.user.findUnique({ where: { id: alice.id } });
      assert.ok(updated.driveConnectedAt);
      assert.notEqual(updated.driveRefreshTokenEnc, "the-real-refresh-token");
      assert.equal(decryptSecret(updated.driveRefreshTokenEnc), "the-real-refresh-token");

      const status = await request(app).get("/api/drive/status").set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(status.body.connected, true);
    });
  });

  describe("POST /drive/disconnect", () => {
    test("requires authentication", async () => {
      const res = await request(app).post("/api/drive/disconnect");
      assert.equal(res.status, 401);
    });

    test("clears the stored token and any archive tracking rows", async (t) => {
      installFakeDrive(t);
      await prisma.user.update({
        where: { id: alice.id },
        data: { driveRefreshTokenEnc: encryptSecret("refresh-token"), driveConnectedAt: new Date() },
      });
      const conversation = await makeConversation(alice, bob);
      await prisma.driveArchiveFile.create({
        data: { userId: alice.id, conversationId: conversation.id, driveFileId: "file-1" },
      });

      const res = await request(app).post("/api/drive/disconnect").set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(res.status, 200);

      const updated = await prisma.user.findUnique({ where: { id: alice.id } });
      assert.equal(updated.driveRefreshTokenEnc, null);
      assert.equal(updated.driveConnectedAt, null);
      assert.equal(await prisma.driveArchiveFile.count({ where: { userId: alice.id } }), 0);
    });
  });

  describe("POST /drive/sync", () => {
    test("requires authentication", async () => {
      const res = await request(app).post("/api/drive/sync");
      assert.equal(res.status, 401);
    });

    test("400s when Drive isn't connected", async () => {
      const res = await request(app).post("/api/drive/sync").set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(res.status, 400);
    });

    test("archives new messages and reports how many", async (t) => {
      installFakeDrive(t);
      await prisma.user.update({
        where: { id: alice.id },
        data: { driveRefreshTokenEnc: encryptSecret("refresh-token"), driveConnectedAt: new Date() },
      });
      const conversation = await makeConversation(alice, bob);
      await sendMessage(conversation, alice, "hey bob");
      await sendMessage(conversation, bob, "hey alice");

      const res = await request(app).post("/api/drive/sync").set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.messagesArchived, 2);
      assert.equal(res.body.filesUpdated, 1);

      const archiveRow = await prisma.driveArchiveFile.findUnique({
        where: { userId_conversationId: { userId: alice.id, conversationId: conversation.id } },
      });
      assert.ok(archiveRow);
      assert.ok(archiveRow.lastArchivedMessageId > 0);
    });
  });

  describe("src/lib/drive.js#archiveUserConversations", () => {
    test("no-ops for a user with no Drive connection", async () => {
      const result = await archiveUserConversations(alice.id);
      assert.deepEqual(result, { messagesArchived: 0, filesUpdated: 0 });
    });

    test("writes archived messages into the fake Drive file's content", async (t) => {
      const fakeDrive = installFakeDrive(t);
      await prisma.user.update({
        where: { id: alice.id },
        data: { driveRefreshTokenEnc: encryptSecret("refresh-token"), driveConnectedAt: new Date() },
      });
      const conversation = await makeConversation(alice, bob);
      await sendMessage(conversation, alice, "first message");
      await sendMessage(conversation, bob, "second message");

      await archiveUserConversations(alice.id);

      const files = [...fakeDrive.values()].filter((f) => f.mimeType === "text/plain");
      assert.equal(files.length, 1);
      const lines = files[0].content.trim().split("\n").map((l) => JSON.parse(l));
      assert.deepEqual(
        lines.map((l) => l.body),
        ["first message", "second message"]
      );
    });

    test("a second sync with no new messages archives nothing further", async (t) => {
      installFakeDrive(t);
      await prisma.user.update({
        where: { id: alice.id },
        data: { driveRefreshTokenEnc: encryptSecret("refresh-token"), driveConnectedAt: new Date() },
      });
      const conversation = await makeConversation(alice, bob);
      await sendMessage(conversation, alice, "only message");

      const first = await archiveUserConversations(alice.id);
      assert.equal(first.messagesArchived, 1);

      const second = await archiveUserConversations(alice.id);
      assert.deepEqual(second, { messagesArchived: 0, filesUpdated: 0 });
    });
  });

  describe("src/lib/drive.js#pruneArchivedMessages", () => {
    test("never deletes a message until every participant has archived past it", async (t) => {
      installFakeDrive(t);
      await prisma.user.update({
        where: { id: alice.id },
        data: { driveRefreshTokenEnc: encryptSecret("alice-refresh-token"), driveConnectedAt: new Date() },
      });
      const conversation = await makeConversation(alice, bob);
      const message = await sendMessage(conversation, alice, "prune me once both sides archive");

      await archiveUserConversations(alice.id);
      await pruneArchivedMessages();
      assert.ok(
        await prisma.message.findUnique({ where: { id: message.id } }),
        "must survive: bob hasn't connected Drive at all"
      );

      await prisma.user.update({
        where: { id: bob.id },
        data: { driveRefreshTokenEnc: encryptSecret("bob-refresh-token"), driveConnectedAt: new Date() },
      });
      await archiveUserConversations(bob.id);
      await pruneArchivedMessages();
      assert.equal(
        await prisma.message.findUnique({ where: { id: message.id } }),
        null,
        "both sides have now archived it, so it should be pruned"
      );
    });
  });

  describe("src/lib/drive.js#readArchivedMessages", () => {
    test("empty page for a user with no Drive connection", async () => {
      const conversation = await makeConversation(alice, bob);
      const result = await readArchivedMessages(alice.id, conversation.id);
      assert.deepEqual(result, { data: [], hasMore: false, nextBefore: null });
    });

    test("empty page for a connected user who never archived this conversation", async (t) => {
      installFakeDrive(t);
      await prisma.user.update({
        where: { id: alice.id },
        data: { driveRefreshTokenEnc: encryptSecret("refresh-token"), driveConnectedAt: new Date() },
      });
      const conversation = await makeConversation(alice, bob);
      const result = await readArchivedMessages(alice.id, conversation.id);
      assert.deepEqual(result, { data: [], hasMore: false, nextBefore: null });
    });

    test("reads back messages that were pruned from Postgres, newest-first", async (t) => {
      installFakeDrive(t);
      await prisma.user.update({
        where: { id: alice.id },
        data: { driveRefreshTokenEnc: encryptSecret("refresh-token"), driveConnectedAt: new Date() },
      });
      const conversation = await makeConversation(alice, bob);
      const m1 = await sendMessage(conversation, alice, "one");
      const m2 = await sendMessage(conversation, bob, "two");
      const m3 = await sendMessage(conversation, alice, "three");

      await archiveUserConversations(alice.id);
      // Simulate the prune this app only ever does once BOTH sides have
      // archived — here we just delete directly to isolate this test from
      // needing a second connected account.
      await prisma.message.deleteMany({ where: { conversationId: conversation.id } });

      const result = await readArchivedMessages(alice.id, conversation.id);
      assert.equal(result.hasMore, false);
      assert.deepEqual(
        result.data.map((m) => m.id),
        [m3.id, m2.id, m1.id]
      );
      assert.deepEqual(
        result.data.map((m) => m.body),
        ["three", "two", "one"]
      );
      // conversationId is stamped on even though the archive file itself
      // doesn't store it (see fileNameForConversation) — the caller always
      // knows which conversation it asked about.
      assert.ok(result.data.every((m) => m.conversationId === conversation.id));
    });

    test("paginates with the same before/hasMore/nextBefore convention as the Postgres route", async (t) => {
      installFakeDrive(t);
      await prisma.user.update({
        where: { id: alice.id },
        data: { driveRefreshTokenEnc: encryptSecret("refresh-token"), driveConnectedAt: new Date() },
      });
      const conversation = await makeConversation(alice, bob);
      const sent = [];
      for (let i = 0; i < 5; i++) {
        sent.push(await sendMessage(conversation, alice, `msg-${i}`));
      }
      await archiveUserConversations(alice.id);
      await prisma.message.deleteMany({ where: { conversationId: conversation.id } });

      const firstPage = await readArchivedMessages(alice.id, conversation.id, { limit: 2 });
      assert.equal(firstPage.hasMore, true);
      assert.deepEqual(
        firstPage.data.map((m) => m.id),
        [sent[4].id, sent[3].id]
      );
      assert.equal(firstPage.nextBefore, sent[3].id);

      const secondPage = await readArchivedMessages(alice.id, conversation.id, {
        before: firstPage.nextBefore,
        limit: 2,
      });
      assert.equal(secondPage.hasMore, true);
      assert.deepEqual(
        secondPage.data.map((m) => m.id),
        [sent[2].id, sent[1].id]
      );

      const thirdPage = await readArchivedMessages(alice.id, conversation.id, {
        before: secondPage.nextBefore,
        limit: 2,
      });
      assert.equal(thirdPage.hasMore, false);
      assert.deepEqual(
        thirdPage.data.map((m) => m.id),
        [sent[0].id]
      );
      assert.equal(thirdPage.nextBefore, null);
    });
  });

  describe("GET /chat/conversations/:id/messages/drive-history", () => {
    test("requires authentication", async () => {
      const res = await request(app).get("/api/chat/conversations/1/messages/drive-history");
      assert.equal(res.status, 401);
    });

    test("404s for a non-participant", async (t) => {
      installFakeDrive(t);
      const conversation = await makeConversation(alice, bob);
      await createUser({ email: "carol@test.com", password: "carolpass1" });
      const carolToken = await login("carol@test.com", "carolpass1");

      const res = await request(app)
        .get(`/api/chat/conversations/${conversation.id}/messages/drive-history`)
        .set("Authorization", `Bearer ${carolToken}`);
      assert.equal(res.status, 404);
    });

    test("returns pruned history for a participant with Drive connected", async (t) => {
      installFakeDrive(t);
      await prisma.user.update({
        where: { id: alice.id },
        data: { driveRefreshTokenEnc: encryptSecret("refresh-token"), driveConnectedAt: new Date() },
      });
      const conversation = await makeConversation(alice, bob);
      const message = await sendMessage(conversation, alice, "archived and pruned");
      await archiveUserConversations(alice.id);
      await prisma.message.deleteMany({ where: { conversationId: conversation.id } });

      const res = await request(app)
        .get(`/api/chat/conversations/${conversation.id}/messages/drive-history`)
        .set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 1);
      assert.equal(res.body.data[0].id, message.id);
      assert.equal(res.body.data[0].body, "archived and pruned");
    });

    test("400s on a non-numeric before", async () => {
      const conversation = await makeConversation(alice, bob);
      const res = await request(app)
        .get(`/api/chat/conversations/${conversation.id}/messages/drive-history?before=not-a-number`)
        .set("Authorization", `Bearer ${aliceToken}`);
      assert.equal(res.status, 400);
    });
  });
});

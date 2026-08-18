process.env.R2_ACCOUNT_ID = "test-account-id";
process.env.R2_ACCESS_KEY_ID = "test-access-key";
process.env.R2_SECRET_ACCESS_KEY = "test-secret-key";
process.env.R2_BUCKET_NAME = "test-bucket";

const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { S3Client } = require("@aws-sdk/client-s3");
const presigner = require("@aws-sdk/s3-request-presigner");
const { resetDb, createUser, makeFriends, prisma } = require("./helpers/db");
const app = require("../src/app");
const {
  validateUpload,
  attachmentTypeFor,
  keyFor,
  createDownloadUrl,
  MAX_IMAGE_BYTES,
  MAX_FILE_BYTES,
} = require("../src/lib/attachments");

async function login(email, password) {
  const res = await request(app).post("/api/auth/login").send({ email, password });
  return res.body.token;
}

async function makeConversation(userA, userB) {
  const userAId = Math.min(userA.id, userB.id);
  const userBId = Math.max(userA.id, userB.id);
  return prisma.conversation.create({ data: { userAId, userBId } });
}

describe("src/lib/attachments.js#attachmentTypeFor", () => {
  test("classifies an image/* mime type as image", () => {
    assert.equal(attachmentTypeFor("image/png"), "image");
  });

  test("classifies anything else as file", () => {
    assert.equal(attachmentTypeFor("application/pdf"), "file");
  });

  test("classifies image/svg+xml as file, not image — SVG is XML that can carry a <script>", () => {
    assert.equal(attachmentTypeFor("image/svg+xml"), "file");
  });
});

describe("src/lib/attachments.js#createDownloadUrl", () => {
  test("renders images inline but forces a download disposition for anything else", async (t) => {
    const seen = [];
    t.mock.method(presigner, "getSignedUrl", async (_client, command) => {
      seen.push(command.input.ResponseContentDisposition);
      return `https://fake.r2.example/${command.input.Key}`;
    });

    await createDownloadUrl("some-key", "image");
    await createDownloadUrl("some-key", "file");

    assert.deepEqual(seen, ["inline", "attachment"]);
  });
});

describe("src/lib/attachments.js#validateUpload", () => {
  test("accepts an image under the image size limit", () => {
    const type = validateUpload({ fileName: "photo.jpg", mimeType: "image/jpeg", size: MAX_IMAGE_BYTES - 1 });
    assert.equal(type, "image");
  });

  test("rejects an image over the image size limit", () => {
    assert.throws(() => validateUpload({ fileName: "photo.jpg", mimeType: "image/jpeg", size: MAX_IMAGE_BYTES + 1 }));
  });

  test("accepts a non-image file under the file size limit", () => {
    const type = validateUpload({ fileName: "report.pdf", mimeType: "application/pdf", size: MAX_FILE_BYTES - 1 });
    assert.equal(type, "file");
  });

  test("rejects a non-image file over the file size limit", () => {
    assert.throws(() =>
      validateUpload({ fileName: "report.pdf", mimeType: "application/pdf", size: MAX_FILE_BYTES + 1 })
    );
  });

  test("rejects a blocked executable extension", () => {
    assert.throws(() =>
      validateUpload({ fileName: "installer.exe", mimeType: "application/octet-stream", size: 100 })
    );
  });

  test("rejects a blocked extension case-insensitively", () => {
    assert.throws(() => validateUpload({ fileName: "script.SH", mimeType: "text/plain", size: 100 }));
  });
});

describe("src/lib/attachments.js#keyFor", () => {
  test("produces different keys for the same file name", () => {
    const a = keyFor(1, "photo.jpg");
    const b = keyFor(1, "photo.jpg");
    assert.notEqual(a, b);
  });

  test("scopes the key under the conversation id", () => {
    const key = keyFor(42, "photo.jpg");
    assert.match(key, /^conversations\/42\//);
  });

  test("strips characters that aren't safe in an object key", () => {
    const key = keyFor(1, "my photo (final)!.jpg");
    assert.doesNotMatch(key, /[ ()!]/);
  });
});

describe("POST /chat/uploads", () => {
  let alice, aliceToken;
  let bob;
  let carol, carolToken;
  let conversation;

  beforeEach(async () => {
    await resetDb();
    alice = await createUser({ email: "alice@test.com", password: "alicepass1", name: "Alice" });
    bob = await createUser({ email: "bob@test.com", password: "bobpass1", name: "Bob" });
    carol = await createUser({ email: "carol@test.com", password: "carolpass1", name: "Carol" });
    aliceToken = await login("alice@test.com", "alicepass1");
    carolToken = await login("carol@test.com", "carolpass1");
    await makeFriends(alice, bob);
    conversation = await makeConversation(alice, bob);
  });

  test("requires authentication", async () => {
    const res = await request(app)
      .post("/api/chat/uploads")
      .send({ conversationId: conversation.id, fileName: "photo.jpg", mimeType: "image/jpeg", size: 1000 });
    assert.equal(res.status, 401);
  });

  test("404s for a conversation the caller isn't part of", async () => {
    const res = await request(app)
      .post("/api/chat/uploads")
      .set("Authorization", `Bearer ${carolToken}`)
      .send({ conversationId: conversation.id, fileName: "photo.jpg", mimeType: "image/jpeg", size: 1000 });
    assert.equal(res.status, 404);
  });

  test("400s on a file that fails validation (too large)", async () => {
    const res = await request(app)
      .post("/api/chat/uploads")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ conversationId: conversation.id, fileName: "photo.jpg", mimeType: "image/jpeg", size: MAX_IMAGE_BYTES + 1 });
    assert.equal(res.status, 400);
  });

  test("returns a presigned PUT url and key for a valid request", async (t) => {
    t.mock.method(presigner, "getSignedUrl", async (_client, command) => `https://fake.r2.example/${command.input.Key}`);

    const res = await request(app)
      .post("/api/chat/uploads")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ conversationId: conversation.id, fileName: "photo.jpg", mimeType: "image/jpeg", size: 1000 });

    assert.equal(res.status, 200);
    assert.equal(res.body.attachmentType, "image");
    assert.match(res.body.key, new RegExp(`^conversations/${conversation.id}/`));
    assert.equal(res.body.url, `https://fake.r2.example/${res.body.key}`);
  });
});

describe("POST /conversations/:id/messages with an attachment", () => {
  let alice, aliceToken;
  let bob;
  let conversation;

  beforeEach(async () => {
    await resetDb();
    alice = await createUser({ email: "alice@test.com", password: "alicepass1", name: "Alice" });
    bob = await createUser({ email: "bob@test.com", password: "bobpass1", name: "Bob" });
    aliceToken = await login("alice@test.com", "alicepass1");
    await makeFriends(alice, bob);
    conversation = await makeConversation(alice, bob);
  });

  test("creates a message from an attachment with no body", async (t) => {
    t.mock.method(S3Client.prototype, "send", async (command) => {
      if (command.constructor.name === "HeadObjectCommand") {
        return { ContentLength: 1000, ContentType: "image/jpeg" };
      }
      throw new Error(`Unexpected command ${command.constructor.name}`);
    });

    const res = await request(app)
      .post(`/api/chat/conversations/${conversation.id}/messages`)
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ attachmentKey: `conversations/${conversation.id}/abc-photo.jpg`, attachmentName: "photo.jpg" });

    assert.equal(res.status, 201);
    assert.equal(res.body.body, null);
    assert.equal(res.body.attachmentName, "photo.jpg");
    assert.equal(res.body.attachmentType, "image");
    assert.equal(res.body.attachmentSize, 1000);
  });

  test("400s when neither body nor attachmentKey is present", async () => {
    const res = await request(app)
      .post(`/api/chat/conversations/${conversation.id}/messages`)
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({});
    assert.equal(res.status, 400);
  });

  test("400s when the attachment key doesn't exist on R2", async (t) => {
    t.mock.method(S3Client.prototype, "send", async () => {
      throw Object.assign(new Error("NotFound"), { name: "NotFound" });
    });

    const res = await request(app)
      .post(`/api/chat/conversations/${conversation.id}/messages`)
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ attachmentKey: `conversations/${conversation.id}/missing.jpg`, attachmentName: "missing.jpg" });

    assert.equal(res.status, 400);
  });

  test("400s when an attachment key belongs to another conversation", async (t) => {
    let headRequested = false;
    t.mock.method(S3Client.prototype, "send", async () => {
      headRequested = true;
      return { ContentLength: 1000, ContentType: "image/jpeg" };
    });

    const res = await request(app)
      .post(`/api/chat/conversations/${conversation.id}/messages`)
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ attachmentKey: `conversations/${conversation.id + 1}/other-chat-photo.jpg` });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /doesn't belong to this conversation/);
    assert.equal(headRequested, false);
  });

  test("still supports a plain text message with no attachment", async () => {
    const res = await request(app)
      .post(`/api/chat/conversations/${conversation.id}/messages`)
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ body: "hello" });

    assert.equal(res.status, 201);
    assert.equal(res.body.body, "hello");
    assert.equal(res.body.attachmentKey, null);
  });
});

describe("GET /conversations/:id/messages with an attachment", () => {
  test("includes a freshly presigned attachmentUrl for a message with an attachment", async (t) => {
    await resetDb();
    const alice = await createUser({ email: "alice@test.com", password: "alicepass1", name: "Alice" });
    const bob = await createUser({ email: "bob@test.com", password: "bobpass1", name: "Bob" });
    const aliceToken = await login("alice@test.com", "alicepass1");
    await makeFriends(alice, bob);
    const conversation = await makeConversation(alice, bob);

    t.mock.method(S3Client.prototype, "send", async () => ({ ContentLength: 1000, ContentType: "image/jpeg" }));
    t.mock.method(presigner, "getSignedUrl", async (_client, command) => `https://fake.r2.example/${command.input.Key}`);

    await request(app)
      .post(`/api/chat/conversations/${conversation.id}/messages`)
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ attachmentKey: `conversations/${conversation.id}/abc-photo.jpg`, attachmentName: "photo.jpg" });

    const res = await request(app)
      .get(`/api/chat/conversations/${conversation.id}/messages`)
      .set("Authorization", `Bearer ${aliceToken}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.data[0].attachmentUrl, `https://fake.r2.example/conversations/${conversation.id}/abc-photo.jpg`);
  });

  test("attachmentUrl is null for a plain text message", async () => {
    await resetDb();
    const alice = await createUser({ email: "alice@test.com", password: "alicepass1", name: "Alice" });
    const bob = await createUser({ email: "bob@test.com", password: "bobpass1", name: "Bob" });
    const aliceToken = await login("alice@test.com", "alicepass1");
    await makeFriends(alice, bob);
    const conversation = await makeConversation(alice, bob);

    await request(app)
      .post(`/api/chat/conversations/${conversation.id}/messages`)
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ body: "hello" });

    const res = await request(app)
      .get(`/api/chat/conversations/${conversation.id}/messages`)
      .set("Authorization", `Bearer ${aliceToken}`);

    assert.equal(res.body.data[0].attachmentUrl, null);
  });
});

describe("Avatar upload with R2 configured", () => {
  let alice, aliceToken, bob;

  beforeEach(async () => {
    await resetDb();
    alice = await createUser({ email: "alice@test.com", password: "alicepass1", name: "Alice" });
    bob = await createUser({ email: "bob@test.com", password: "bobpass1", name: "Bob" });
    aliceToken = await login("alice@test.com", "alicepass1");
  });

  test("mints a presigned PUT under this user's own avatars/ prefix", async (t) => {
    t.mock.method(presigner, "getSignedUrl", async (_client, command) => `https://fake.r2.example/${command.input.Key}`);

    const res = await request(app)
      .post("/api/users/me/avatar/upload-url")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ mimeType: "image/png", size: 4096 });

    assert.equal(res.status, 200);
    assert.ok(res.body.key.startsWith(`avatars/${alice.id}/`), `unexpected key ${res.body.key}`);
  });

  test("rejects a non-image avatar", async () => {
    const res = await request(app)
      .post("/api/users/me/avatar/upload-url")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ mimeType: "application/pdf", size: 4096 });
    assert.equal(res.status, 400);
  });

  // SVG is XML that can carry an inline <script>; the attachment pipeline
  // already classes it "file" rather than "image" for that reason, and an
  // avatar renders straight into an <img>, so it must not slip through.
  test("rejects an SVG avatar", async () => {
    const res = await request(app)
      .post("/api/users/me/avatar/upload-url")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ mimeType: "image/svg+xml", size: 4096 });
    assert.equal(res.status, 400);
  });

  test("rejects an avatar over 2MB", async () => {
    const res = await request(app)
      .post("/api/users/me/avatar/upload-url")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ mimeType: "image/png", size: 3 * 1024 * 1024 });
    assert.equal(res.status, 400);
  });

  test("confirming an upload stores the key and returns a URL", async (t) => {
    t.mock.method(S3Client.prototype, "send", async () => ({ ContentLength: 2048, ContentType: "image/png" }));
    t.mock.method(presigner, "getSignedUrl", async (_client, command) => `https://fake.r2.example/${command.input.Key}`);

    const key = `avatars/${alice.id}/some-uuid`;
    const res = await request(app)
      .put("/api/users/me/avatar")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ key });

    assert.equal(res.status, 200);
    assert.ok(res.body.avatarUrl.includes(key));

    const updated = await prisma.user.findUnique({ where: { id: alice.id } });
    assert.equal(updated.avatarKey, key);
  });

  // The key round-trips through the client, so the server has to re-check it
  // belongs to the caller — otherwise anyone could claim someone else's
  // avatar object, or a chat attachment, as their own profile picture.
  test("refuses a key belonging to another user", async () => {
    const res = await request(app)
      .put("/api/users/me/avatar")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ key: `avatars/${bob.id}/some-uuid` });

    assert.equal(res.status, 400);
    const updated = await prisma.user.findUnique({ where: { id: alice.id } });
    assert.equal(updated.avatarKey, null);
  });

  test("refuses a conversation attachment key", async () => {
    const res = await request(app)
      .put("/api/users/me/avatar")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ key: "conversations/1/some-uuid-photo.png" });
    assert.equal(res.status, 400);
  });

  // R2 is the source of truth for what actually landed, not the mimeType
  // claimed when the URL was minted.
  test("refuses an object R2 reports as a non-image", async (t) => {
    t.mock.method(S3Client.prototype, "send", async () => ({ ContentLength: 2048, ContentType: "application/pdf" }));

    const res = await request(app)
      .put("/api/users/me/avatar")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ key: `avatars/${alice.id}/some-uuid` });
    assert.equal(res.status, 400);
  });

  test("an avatar shows up as a presigned avatarUrl on the friends list", async (t) => {
    t.mock.method(S3Client.prototype, "send", async () => ({ ContentLength: 2048, ContentType: "image/png" }));
    t.mock.method(presigner, "getSignedUrl", async (_client, command) => `https://fake.r2.example/${command.input.Key}`);

    await makeFriends(alice, bob);
    const key = `avatars/${bob.id}/bob-uuid`;
    await prisma.user.update({ where: { id: bob.id }, data: { avatarKey: key } });

    const res = await request(app).get("/api/friends").set("Authorization", `Bearer ${aliceToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.ok(res.body[0].otherUser.avatarUrl.includes(key));
    assert.equal(res.body[0].otherUser.avatarKey, undefined, "the raw key must never be exposed");
  });

  test("DELETE clears the key but leaves the R2 object alone", async () => {
    await prisma.user.update({ where: { id: alice.id }, data: { avatarKey: `avatars/${alice.id}/x` } });

    const res = await request(app).delete("/api/users/me/avatar").set("Authorization", `Bearer ${aliceToken}`);
    assert.equal(res.status, 204);

    const updated = await prisma.user.findUnique({ where: { id: alice.id } });
    assert.equal(updated.avatarKey, null);
  });
});

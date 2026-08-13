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
const { validateUpload, attachmentTypeFor, keyFor, MAX_IMAGE_BYTES, MAX_FILE_BYTES } = require("../src/lib/attachments");

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

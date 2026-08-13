# Chat Media Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let two friends send images and general files to each other in a 1:1 chat, in addition to text.

**Architecture:** Files never pass through the app's single Node process. The client asks the backend for a presigned Cloudflare R2 (S3-compatible) PUT URL, uploads directly to R2, then tells the backend the upload finished; the backend re-verifies the object actually exists on R2 (real size/type, never trusting client-claimed values) before creating the `Message` row. Reads mint a fresh, short-lived presigned GET URL on every page load rather than storing a permanent link.

**Tech Stack:** `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (new dependencies) against Cloudflare R2's S3-compatible endpoint; Express 5, Prisma, `node:test` + Supertest on the backend; React + Vite on the frontend.

**Spec:** `docs/superpowers/specs/2026-08-13-chat-media-attachments-design.md`

## Global Constraints

- Images ≤ 10MB, other files ≤ 25MB.
- All file types allowed except executables/scripts: `.exe .bat .cmd .sh .msi .app .apk .dll .com .scr .ps1 .vbs .jar` (case-insensitive).
- A presigned download URL must only ever be issued to a participant of that conversation, expires in 5 minutes, and is re-minted on every read — never a permanent link.
- No dependency on this feature being configured: if the four `R2_*` env vars aren't all set, `POST /api/chat/uploads` 503s and the rest of the app (including text-only chat) works exactly as before.
- Out of scope this round (do not implement): video, audio/voice messages, sticker files, deleting R2 objects when a `Message` is pruned/deleted, backing up attachment bytes to Google Drive, image compression before upload.
- Backend code, comments, identifiers, and commit messages are English-only, matching the rest of this repo.

---

### Task 1: `src/lib/attachments.js` — validation and key generation

**Files:**
- Create: `src/lib/attachments.js`
- Test: `tests/attachments.test.js`

**Interfaces:**
- Produces: `MAX_IMAGE_BYTES` (number, `10 * 1024 * 1024`), `MAX_FILE_BYTES` (number, `25 * 1024 * 1024`), `attachmentTypeFor(mimeType: string): "image" | "file"`, `validateUpload({ fileName: string, mimeType: string, size: number }): "image" | "file"` (throws `Error` with a user-facing message if the extension is blocked or size exceeds the limit for its type), `keyFor(conversationId: number, fileName: string): string` (unique R2 object key). Task 2 imports all of these.

This task is pure logic — no R2/network calls, no mocking needed.

- [ ] **Step 1: Write the failing tests**

Create `tests/attachments.test.js`:

```js
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { validateUpload, attachmentTypeFor, keyFor, MAX_IMAGE_BYTES, MAX_FILE_BYTES } = require("../src/lib/attachments");

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
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
export DATABASE_URL="postgresql://postgres:420420@localhost:5432/chatapp_test" JWT_SECRET="test-secret" NODE_ENV="test"
node --test tests/attachments.test.js
```

Expected: every test fails with `Cannot find module '../src/lib/attachments'` — the file doesn't exist yet.

- [ ] **Step 3: Write `src/lib/attachments.js`**

```js
const crypto = require("crypto");

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

// Case-insensitive; checked against the file name's extension regardless of
// the mimeType the client claims, since mimeType is easy to spoof and this
// list exists specifically to keep executables out.
const BLOCKED_EXTENSIONS = new Set([
  ".exe", ".bat", ".cmd", ".sh", ".msi", ".app", ".apk", ".dll", ".com", ".scr", ".ps1", ".vbs", ".jar",
]);

function extensionOf(fileName) {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot).toLowerCase();
}

function attachmentTypeFor(mimeType) {
  return mimeType.startsWith("image/") ? "image" : "file";
}

/**
 * Throws a user-facing Error if the upload isn't allowed. Returns the
 * attachment type ("image" | "file") on success, which the caller needs to
 * pick the right size limit and, later, how the message renders.
 */
function validateUpload({ fileName, mimeType, size }) {
  if (BLOCKED_EXTENSIONS.has(extensionOf(fileName))) {
    throw new Error("This file type isn't allowed");
  }
  const attachmentType = attachmentTypeFor(mimeType);
  const maxBytes = attachmentType === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  if (size > maxBytes) {
    throw new Error(`File is too large (max ${Math.round(maxBytes / (1024 * 1024))}MB)`);
  }
  return attachmentType;
}

/// Scoped under the conversation so objects for one chat are easy to find/
/// reason about in the bucket, and prefixed with a random UUID (not just the
/// original file name) so two people uploading "photo.jpg" the same minute
/// never collide.
function keyFor(conversationId, fileName) {
  const safeName = fileName.replace(/[^a-zA-Z0-9.\-_]/g, "_").slice(-100);
  return `conversations/${conversationId}/${crypto.randomUUID()}-${safeName}`;
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_FILE_BYTES,
  BLOCKED_EXTENSIONS,
  attachmentTypeFor,
  validateUpload,
  keyFor,
};
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
node --test tests/attachments.test.js
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/attachments.js tests/attachments.test.js
git commit -m "$(cat <<'EOF'
Add upload validation and key generation for chat attachments

Pure logic (no R2 calls yet): size/type limits per Global Constraints,
a denylist of executable extensions checked against the file name
regardless of the claimed mimeType, and unique per-conversation R2
object keys.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: R2 client, presigned URLs, and `POST /api/chat/uploads`

**Files:**
- Modify: `src/lib/attachments.js` (add R2 client + presign functions)
- Modify: `src/routes/chat.js` (add `POST /uploads`, after `router.use(authenticate)` at line 75)
- Modify: `tests/chat.test.js` (one "not configured" test — this file never sets `R2_*` env vars, mirroring how `tests/auth.test.js` covers Google's "not configured" case by never setting `GOOGLE_*`)
- Modify: `tests/attachments.test.js` (route tests, with `R2_*` env vars set at the top of the file before `require("../src/app")`)
- Modify: `package.json` (add `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`)
- Modify: `.env.example` (document the four `R2_*` vars)

**Interfaces:**
- Consumes: everything from Task 1; `getConversationForParticipant(conversationId, userId)` and `areFriends(userId, otherUserId)`, both already in `src/routes/chat.js`.
- Produces: `attachmentsConfigured` (boolean, exported from `src/lib/attachments.js`), `createUploadUrl({ conversationId, fileName, mimeType, size }): Promise<{ url: string, key: string, attachmentType: "image" | "file" }>`. `POST /api/chat/uploads` request body `{ conversationId: number, fileName: string, mimeType: string, size: number }`, response `{ url, key, attachmentType }` (200) — Task 3's frontend work and Task 6 both rely on this exact shape.

- [ ] **Step 1: Install the R2 SDK packages**

```bash
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

- [ ] **Step 2: Write the failing tests**

Add to `tests/chat.test.js`, inside the existing `describe("Chat API", ...)` block (add this as a new sibling `describe`, alongside `describe("friend gating on POST /chat/conversations and sending", ...)`). `adminUser`/`staffUser`/`adminToken` come from that file's outer `beforeEach`, already friended with each other:

```js
  describe("POST /chat/uploads", () => {
    test("503s when attachments aren't configured", async () => {
      const conv = await request(app)
        .post("/api/chat/conversations")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ userId: staffUser.id });

      const res = await request(app)
        .post("/api/chat/uploads")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ conversationId: conv.body.id, fileName: "photo.jpg", mimeType: "image/jpeg", size: 1000 });
      assert.equal(res.status, 503);
    });
  });
```

Create `tests/attachments.test.js`'s route-level tests — append to the file created in Task 1, above the `require` line add the env vars (this must come before `require("../src/app")` anywhere in the file, since `src/lib/attachments.js` reads `process.env.R2_*` at module-eval time):

```js
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
```

- [ ] **Step 3: Run the new tests and verify they fail**

```bash
node --test tests/attachments.test.js tests/chat.test.js
```

Expected: the "not configured" test in `tests/chat.test.js` fails with 404 (route doesn't exist yet, not 503); everything in the new `describe("POST /chat/uploads", ...)` in `tests/attachments.test.js` fails the same way.

- [ ] **Step 4: Add the R2 client and presign functions to `src/lib/attachments.js`**

Add near the top of the file, after the existing `crypto` require:

```js
const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
// Imported as a namespace, not destructured, so tests can mock
// presigner.getSignedUrl directly (see tests/attachments.test.js) — the same
// reason src/lib/push.js's tests mock a method on the whole `webpush` module
// object rather than a destructured function.
const presigner = require("@aws-sdk/s3-request-presigner");

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;

const attachmentsConfigured = Boolean(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME);

// Optional like Drive/Push/Google sign-in: null rather than a client built
// from undefined credentials when unconfigured, so nothing downstream can
// accidentally make a real network call in that state.
const s3Client = attachmentsConfigured
  ? new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    })
  : null;

const PRESIGN_TTL_SECONDS = 5 * 60;
```

Add at the bottom of the file, before `module.exports`:

```js
/// Mints a presigned PUT URL for a validated upload. ContentType and
/// ContentLength are bound into the signature, so the browser's PUT request
/// must send matching Content-Type/Content-Length headers or R2 rejects it —
/// this is what stops someone getting a URL for a 1KB image and then PUTting
/// a 50MB file to it.
async function createUploadUrl({ conversationId, fileName, mimeType, size }) {
  const attachmentType = validateUpload({ fileName, mimeType, size });
  const key = keyFor(conversationId, fileName);
  const command = new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    ContentType: mimeType,
    ContentLength: size,
  });
  const url = await presigner.getSignedUrl(s3Client, command, { expiresIn: PRESIGN_TTL_SECONDS });
  return { url, key, attachmentType };
}

/// Confirms an object actually exists on R2 and reads its real size/type —
/// never trusts what a client claims after the fact, since a client could in
/// principle skip the PUT, or overwrite the key with something else. Throws
/// if the object is missing or exceeds the size limit for its real type.
async function verifyUploadedObject(key) {
  let head;
  try {
    head = await s3Client.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
  } catch {
    throw new Error("Attachment not found — upload may not have completed");
  }
  const mimeType = head.ContentType || "application/octet-stream";
  const attachmentType = attachmentTypeFor(mimeType);
  const maxBytes = attachmentType === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  const size = head.ContentLength || 0;
  if (size > maxBytes) {
    throw new Error(`File is too large (max ${Math.round(maxBytes / (1024 * 1024))}MB)`);
  }
  return { size, attachmentType, mimeType };
}

/// Fresh, short-lived download link — never a permanent URL. Callers are
/// responsible for only calling this once they've confirmed the requester is
/// a participant of the conversation the attachment belongs to.
async function createDownloadUrl(key) {
  const command = new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key });
  return presigner.getSignedUrl(s3Client, command, { expiresIn: PRESIGN_TTL_SECONDS });
}
```

Update `module.exports` at the bottom to also include `attachmentsConfigured, createUploadUrl, verifyUploadedObject, createDownloadUrl`.

- [ ] **Step 5: Add `POST /api/chat/uploads` to `src/routes/chat.js`**

Add the import near the top, after the existing `const { readArchivedMessages } = require("../lib/drive");` (line 8):

```js
const { attachmentsConfigured, createUploadUrl } = require("../lib/attachments");
```

Add the route after `router.use(authenticate)` (line 75), before the `// --- Conversations` comment:

```js
router.post("/uploads", async (req, res) => {
  if (!attachmentsConfigured) {
    return res.status(503).json({ error: "File attachments are not configured" });
  }

  const conversationId = Number(req.body?.conversationId);
  const conversation = await getConversationForParticipant(conversationId, req.user.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  const otherUserId = conversation.userAId === req.user.id ? conversation.userBId : conversation.userAId;
  if (!(await areFriends(req.user.id, otherUserId))) {
    return res.status(403).json({ error: "You can only message accounts you're friends with" });
  }

  const { fileName, mimeType, size } = req.body || {};
  if (
    typeof fileName !== "string" ||
    !fileName ||
    typeof mimeType !== "string" ||
    !mimeType ||
    !Number.isInteger(size) ||
    size <= 0
  ) {
    return res.status(400).json({ error: "fileName, mimeType, and size are required" });
  }

  let result;
  try {
    result = await createUploadUrl({ conversationId, fileName, mimeType, size });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  res.json(result);
});
```

Note `getConversationForParticipant` is defined further down the file (around line 86) but hoisting makes this fine since it's a `function` declaration, not a `const`.

- [ ] **Step 6: Run the tests and verify they pass**

```bash
node --test tests/attachments.test.js tests/chat.test.js
```

Expected: all pass, including the pre-existing tests in `tests/chat.test.js`.

- [ ] **Step 7: Add the `.env.example` entry**

Add after the `DRIVE_SYNC_CRON` block at the end of `.env.example`:

```
# Chat file attachments (images + general files) via Cloudflare R2, an
# S3-compatible object store. Optional — the app runs fine without it,
# POST /api/chat/uploads just 503s and users can still send text messages.
# Create a bucket at https://dash.cloudflare.com -> R2, then an API token
# scoped to that bucket (Manage R2 API Tokens -> Create API Token).
# R2_ACCOUNT_ID=""
# R2_ACCESS_KEY_ID=""
# R2_SECRET_ACCESS_KEY=""
# R2_BUCKET_NAME=""
```

- [ ] **Step 8: Run the full backend suite to check for regressions**

```bash
npm run test:migrate
node --test --test-concurrency=1 "tests/**/*.test.js"
```

Expected: all pass (run this alone — not alongside any other `node --test` process hitting the same database, or you'll see unrelated unique-constraint failures from the two processes racing `resetDb()`).

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src/lib/attachments.js src/routes/chat.js tests/attachments.test.js tests/chat.test.js .env.example
git commit -m "$(cat <<'EOF'
Add POST /api/chat/uploads: presigned R2 upload URLs

Files never pass through this app's single Node process. A caller who
is a participant of the conversation and still friends with the other
side gets back a presigned PUT URL scoped to one validated upload;
ContentType/ContentLength are bound into the signature so R2 itself
rejects a PUT that doesn't match what was validated. 503s cleanly when
R2_* env vars aren't set, the same optional-service pattern as Drive/
Push/Google sign-in.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Schema migration + accept attachments when creating a message

**Files:**
- Modify: `prisma/schema.prisma` (`Message` model)
- Create: migration via `prisma migrate dev`
- Modify: `src/routes/chat.js` (`POST /conversations/:id/messages`, currently lines 254-319)
- Modify: `tests/attachments.test.js`

**Interfaces:**
- Consumes: `verifyUploadedObject(key): Promise<{ size, attachmentType, mimeType }>` from Task 2.
- Produces: `POST /conversations/:id/messages` now accepts `{ body?: string, attachmentKey?: string, attachmentName?: string }` (at least one of `body`/`attachmentKey` required) and its 201 response gains `attachmentKey, attachmentName, attachmentMimeType, attachmentSize, attachmentType` (all `null` for a text-only message) alongside the existing `id, conversationId, senderId, body, createdAt`. Task 4 and Task 5 both read these exact field names.

- [ ] **Step 1: Update the schema**

In `prisma/schema.prisma`, replace the `Message` model's `body` field and add the new columns:

```prisma
model Message {
  id                 Int      @id @default(autoincrement())
  conversationId     Int
  senderId           Int
  /// Nullable: a message can be attachment-only with no text. Application
  /// code (not the database) enforces that body and the attachment fields
  /// below aren't both empty — see POST /conversations/:id/messages.
  body               String?  @db.Text
  /// The four fields below are all set together or all null — there's no
  /// case where only some of them are populated. attachmentType is derived
  /// server-side from the real, R2-verified mimeType at creation time
  /// ("image" if it starts with "image/", "file" otherwise); it decides
  /// whether the client renders an inline image or a download card.
  attachmentKey      String?
  attachmentName     String?
  attachmentMimeType String?
  attachmentSize     Int?
  attachmentType     String?
  createdAt          DateTime @default(now())

  conversation Conversation @relation(fields: [conversationId], references: [id])
  sender       User         @relation("MessageSender", fields: [senderId], references: [id])

  @@index([conversationId, createdAt])
  @@map("messages")
}
```

- [ ] **Step 2: Create and apply the migration**

```bash
npx prisma migrate dev --name add_message_attachments
```

Expected output includes `Applying migration` and the new folder under `prisma/migrations/`. This also regenerates the Prisma Client — if a later step reports the new fields as unrecognized, run `npx prisma generate` explicitly.

- [ ] **Step 3: Apply the same migration to the test database**

```bash
export DATABASE_URL="postgresql://postgres:420420@localhost:5432/chatapp_test"
npx prisma migrate deploy
```

- [ ] **Step 4: Write the failing tests**

Append to the `describe("POST /chat/uploads", ...)` block's file, `tests/attachments.test.js`, a new sibling `describe`:

```js
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
      .send({ attachmentKey: "conversations/1/abc-photo.jpg", attachmentName: "photo.jpg" });

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
      .send({ attachmentKey: "conversations/1/missing.jpg", attachmentName: "missing.jpg" });

    assert.equal(res.status, 400);
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
```

Add `S3Client` to the existing `@aws-sdk/client-s3` import line at the top of `tests/attachments.test.js` (it currently only imports it for reference — confirm the import line reads `const { S3Client } = require("@aws-sdk/client-s3");`).

- [ ] **Step 5: Run the tests and verify they fail**

```bash
node --test tests/attachments.test.js
```

Expected: the new tests fail — `body` is still required, so requests with only `attachmentKey` get a 400 "body is required" instead of the behavior under test.

- [ ] **Step 6: Update `POST /conversations/:id/messages` in `src/routes/chat.js`**

Add to the import line from Task 2 (now importing three things from `../lib/attachments`):

```js
const { attachmentsConfigured, createUploadUrl, verifyUploadedObject } = require("../lib/attachments");
```

Replace the body from `const body = typeof req.body?.body...` (line 267) through the `res.status(201).json(payload);` line (318) with:

```js
  const rawBody = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  const attachmentKey = typeof req.body?.attachmentKey === "string" ? req.body.attachmentKey : null;
  const attachmentName = typeof req.body?.attachmentName === "string" ? req.body.attachmentName : null;

  if (!rawBody && !attachmentKey) {
    return res.status(400).json({ error: "body or attachmentKey is required" });
  }
  if (rawBody.length > 4000) {
    return res.status(400).json({ error: "body must be 4000 characters or fewer" });
  }

  let attachmentFields = {
    attachmentKey: null,
    attachmentName: null,
    attachmentMimeType: null,
    attachmentSize: null,
    attachmentType: null,
  };
  if (attachmentKey) {
    let verified;
    try {
      verified = await verifyUploadedObject(attachmentKey);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    attachmentFields = {
      attachmentKey,
      attachmentName: attachmentName || attachmentKey.split("/").pop(),
      attachmentMimeType: verified.mimeType,
      attachmentSize: verified.size,
      attachmentType: verified.attachmentType,
    };
  }

  const body = rawBody || null;

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: { conversationId, senderId: req.user.id, body, ...attachmentFields },
    });
    await tx.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: created.createdAt },
    });
    return created;
  });

  const payload = {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    body: message.body,
    createdAt: message.createdAt,
    attachmentKey: message.attachmentKey,
    attachmentName: message.attachmentName,
    attachmentMimeType: message.attachmentMimeType,
    attachmentSize: message.attachmentSize,
    attachmentType: message.attachmentType,
  };

  // Deliberately not logged via src/lib/audit.js — message content doesn't
  // belong in an audit trail.
  chatBus.publish(conversation.userAId, "message", payload);
  chatBus.publish(conversation.userBId, "message", payload);

  // Push is the fallback for "not connected," not a duplicate of the SSE
  // event — skip it entirely when the recipient already has a live stream
  // open, both to avoid a redundant OS notification and to avoid the extra
  // sender-name lookup on the (much more common) both-online path. Fired
  // without awaiting: a slow or failing push must never delay the response
  // the sender is waiting on.
  if (!chatBus.hasSubscribers(otherUserId)) {
    prisma.user
      .findUnique({ where: { id: req.user.id }, select: { name: true, email: true } })
      .then((sender) => {
        const pushBody = message.body
          ? message.body.length > 120
            ? `${message.body.slice(0, 117)}…`
            : message.body
          : message.attachmentType === "image"
            ? "Sent a photo"
            : `Sent a file: ${message.attachmentName}`;
        return sendPushToUser(otherUserId, {
          title: sender?.name || sender?.email || "New message",
          body: pushBody,
          conversationId,
        });
      })
      .catch((err) => console.error("Push notification failed:", err));
  }

  res.status(201).json(payload);
```

This keeps the existing 404/403 checks above it (conversation lookup, `areFriends`) untouched — only the body-required-and-below section changes.

- [ ] **Step 7: Run the tests and verify they pass**

```bash
node --test tests/attachments.test.js tests/chat.test.js
```

- [ ] **Step 8: Run the full backend suite**

```bash
node --test --test-concurrency=1 "tests/**/*.test.js"
```

Expected: all pass. Pay attention to any other test in `tests/chat.test.js` or `tests/drive.test.js` that asserted the exact shape of a message payload (e.g. `assert.deepEqual(res.body, {...})` rather than checking individual fields) — the new `attachmentKey`/etc. fields being present and `null` could break a strict equality check. If you find one, update its expected object to include the new `null` fields rather than loosening the assertion.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/ src/routes/chat.js tests/attachments.test.js
git commit -m "$(cat <<'EOF'
Let POST /conversations/:id/messages create attachment-only messages

body is now nullable on Message; a request needs body or
attachmentKey (or both), not always body. When attachmentKey is
present the server re-verifies the object on R2 (real size and
mimeType, never the client's claim) before creating the row. The push
notification fallback text becomes "Sent a photo" / "Sent a file: X"
when there's no body to show instead.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Serve attachments back — presigned download URLs on read

**Files:**
- Modify: `src/routes/chat.js` (`GET /conversations/:id/messages`, currently lines 188-218; SSE `message` payload building happens in the route from Task 3)
- Modify: `tests/attachments.test.js`

**Interfaces:**
- Consumes: `createDownloadUrl(key): Promise<string>` from Task 2.
- Produces: every message object returned by `GET /conversations/:id/messages` and every `message` SSE event gains `attachmentUrl: string | null` — a freshly minted presigned URL when `attachmentKey` is set, `null` otherwise. Task 6 (frontend) renders from this field.

- [ ] **Step 1: Write the failing test**

Append to `tests/attachments.test.js`:

```js
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
      .send({ attachmentKey: "conversations/1/abc-photo.jpg", attachmentName: "photo.jpg" });

    const res = await request(app)
      .get(`/api/chat/conversations/${conversation.id}/messages`)
      .set("Authorization", `Bearer ${aliceToken}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.data[0].attachmentUrl, "https://fake.r2.example/conversations/1/abc-photo.jpg");
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
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
node --test tests/attachments.test.js
```

Expected: fails — `res.body.data[0].attachmentUrl` is `undefined`, the field doesn't exist in the response yet.

- [ ] **Step 3: Update `GET /conversations/:id/messages` in `src/routes/chat.js`**

Add `createDownloadUrl` to the Task 2/3 import line, so it now reads:

```js
const { attachmentsConfigured, createUploadUrl, verifyUploadedObject, createDownloadUrl } = require("../lib/attachments");
```

Replace the body of the route (lines ~205-217, from `const rows = await prisma.message.findMany` through the final `res.json(...)`) with:

```js
  const rows = await prisma.message.findMany({
    where: {
      conversationId,
      ...(before !== undefined ? { id: { lt: before } } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  // Presigned GET URLs are minted fresh on every read rather than stored —
  // never a permanent link, and this route already only reaches rows for a
  // conversation the caller is confirmed a participant of (see
  // getConversationForParticipant above).
  const data = await Promise.all(
    page.map(async (m) => ({
      ...m,
      attachmentUrl: m.attachmentKey ? await createDownloadUrl(m.attachmentKey) : null,
    }))
  );

  res.json({ data, hasMore, nextBefore: hasMore ? page[page.length - 1].id : null });
```

Now find the `chatBus.publish` calls added/kept in Task 3 (inside `POST /conversations/:id/messages`) and give the SSE payload the same treatment — it currently builds `payload` with `attachmentKey` etc. but not `attachmentUrl`. Add one line right before the `chatBus.publish(...)` calls:

```js
  const attachmentUrl = payload.attachmentKey ? await createDownloadUrl(payload.attachmentKey) : null;
  const ssePayload = { ...payload, attachmentUrl };

  chatBus.publish(conversation.userAId, "message", ssePayload);
  chatBus.publish(conversation.userBId, "message", ssePayload);
```

(Replacing the two `chatBus.publish(..., payload)` lines from Task 3 with these three lines.) Leave the HTTP response (`res.status(201).json(payload)`) as the non-URL `payload` — the sender doesn't need a presigned URL for their own just-sent attachment in the same way a reader does; simplest to keep the two paths distinct. Actually — for consistency and so the sender's own optimistic-UI replacement (Task 6) can render the image immediately without a second fetch, change the final line to `res.status(201).json(ssePayload);` as well, reusing the same object.

- [ ] **Step 4: Run the tests and verify they pass**

```bash
node --test tests/attachments.test.js tests/chat.test.js
```

- [ ] **Step 5: Run the full backend suite**

```bash
node --test --test-concurrency=1 "tests/**/*.test.js"
```

- [ ] **Step 6: Commit**

```bash
git add src/routes/chat.js tests/attachments.test.js
git commit -m "$(cat <<'EOF'
Serve attachments with freshly presigned URLs on every read

GET /conversations/:id/messages and the "message" SSE event both mint
a new, short-lived presigned GET URL per attachment on every request
rather than storing one — matches the app's existing privacy model
(non-participants can't reach a conversation's data at all).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Drive backup — record that an attachment existed

**Files:**
- Modify: `src/lib/drive.js` (`archiveUserConversations` JSONL mapping, currently lines 168-178; `readArchivedMessages`, currently lines 211-249)
- Modify: `tests/drive.test.js`

**Interfaces:**
- Produces: the JSONL line `archiveUserConversations` writes per message gains `hasAttachment: boolean, attachmentName: string | null` (the attachment's bytes are still never backed up — out of scope, see the spec). `readArchivedMessages`'s returned rows gain the same two fields, so a conversation's "load older from Drive" view can show that an attachment existed instead of a blank bubble.

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe("src/lib/drive.js#archiveUserConversations", () => { ... })` block in `tests/drive.test.js`, as a sibling of `"writes archived messages into the fake Drive file's content"` — reusing that same test's `installFakeDrive(t)` fake and `makeConversation(alice, bob)` helper, both already defined in this file:

```js
    test("records hasAttachment/attachmentName for a message with an attachment", async (t) => {
      const fakeDrive = installFakeDrive(t);
      await prisma.user.update({
        where: { id: alice.id },
        data: { driveRefreshTokenEnc: encryptSecret("refresh-token"), driveConnectedAt: new Date() },
      });
      const conversation = await makeConversation(alice, bob);
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          senderId: alice.id,
          body: null,
          attachmentKey: "conversations/1/photo.jpg",
          attachmentName: "photo.jpg",
          attachmentMimeType: "image/jpeg",
          attachmentSize: 1000,
          attachmentType: "image",
        },
      });

      await archiveUserConversations(alice.id);

      const files = [...fakeDrive.values()].filter((f) => f.mimeType === "text/plain");
      const lines = files[0].content.trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(lines[0].hasAttachment, true);
      assert.equal(lines[0].attachmentName, "photo.jpg");
    });
```

Add this second test inside the existing `describe("src/lib/drive.js#readArchivedMessages", () => { ... })` block, as a sibling of `"reads back messages that were pruned from Postgres, newest-first"` — reusing the same setup pattern:

```js
    test("surfaces hasAttachment/attachmentName for an archived-then-pruned attachment message", async (t) => {
      installFakeDrive(t);
      await prisma.user.update({
        where: { id: alice.id },
        data: { driveRefreshTokenEnc: encryptSecret("refresh-token"), driveConnectedAt: new Date() },
      });
      const conversation = await makeConversation(alice, bob);
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          senderId: alice.id,
          body: null,
          attachmentKey: "conversations/1/photo.jpg",
          attachmentName: "photo.jpg",
          attachmentMimeType: "image/jpeg",
          attachmentSize: 1000,
          attachmentType: "image",
        },
      });

      await archiveUserConversations(alice.id);
      await prisma.message.deleteMany({ where: { conversationId: conversation.id } });

      const result = await readArchivedMessages(alice.id, conversation.id);
      assert.equal(result.data[0].hasAttachment, true);
      assert.equal(result.data[0].attachmentName, "photo.jpg");
    });
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
node --test tests/drive.test.js
```

Expected: both fail — the parsed JSONL line has no `hasAttachment` key yet, and `readArchivedMessages`'s returned rows don't have it either.

- [ ] **Step 3: Update `archiveUserConversations` in `src/lib/drive.js`**

In the `newLines` mapping (lines 168-178), change:

```js
    const newLines = newMessages
      .map((m) =>
        JSON.stringify({
          id: m.id,
          senderId: m.senderId,
          senderName: m.sender.name || m.sender.email,
          body: m.body,
          createdAt: m.createdAt,
        })
      )
      .join("\n");
```

to:

```js
    const newLines = newMessages
      .map((m) =>
        JSON.stringify({
          id: m.id,
          senderId: m.senderId,
          senderName: m.sender.name || m.sender.email,
          body: m.body,
          // Attachment bytes are never backed up here — out of scope for
          // now (see the design spec). Recording that one existed at
          // least keeps the archived history from looking like a message
          // silently vanished.
          hasAttachment: Boolean(m.attachmentKey),
          attachmentName: m.attachmentName || null,
          createdAt: m.createdAt,
        })
      )
      .join("\n");
```

- [ ] **Step 4: Update `readArchivedMessages` in `src/lib/drive.js`**

In the `page` mapping (inside `readArchivedMessages`, currently around line 243-246), change:

```js
    .map((m) => ({ id: m.id, conversationId, senderId: m.senderId, body: m.body, createdAt: m.createdAt }));
```

to:

```js
    .map((m) => ({
      id: m.id,
      conversationId,
      senderId: m.senderId,
      body: m.body,
      hasAttachment: m.hasAttachment || false,
      attachmentName: m.attachmentName || null,
      createdAt: m.createdAt,
    }));
```

- [ ] **Step 5: Run the tests and verify they pass**

```bash
node --test tests/drive.test.js
```

- [ ] **Step 6: Run the full backend suite**

```bash
node --test --test-concurrency=1 "tests/**/*.test.js"
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/drive.js tests/drive.test.js
git commit -m "$(cat <<'EOF'
Note attachments in the Drive JSONL archive without backing up bytes

archiveUserConversations now records hasAttachment/attachmentName per
message so an attachment-only message doesn't look like it silently
vanished when read back via readArchivedMessages — the file itself is
still never uploaded to Drive, which stays out of scope.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Frontend — upload button, composer wiring, and bubble rendering

**Files:**
- Modify: `web/src/api/chat.js` (add `requestUpload`, `uploadFileToR2`; modify `sendMessage`)
- Modify: `web/src/pages/ChatPage.jsx` (composer: attach button + file input; bubble rendering for image/file)
- Modify: `web/src/index.css` (attachment button, upload progress, image bubble, file card styles)
- Modify: `web/src/i18n/translations.js` (new keys, English + Thai)
- Test: none (no frontend test suite in this repo) — verify with `npm run lint`, `npm run build`, and manual testing per Step 8 below

**Interfaces:**
- Consumes: `POST /api/chat/uploads` → `{ url, key, attachmentType }` (Task 2); `POST /conversations/:id/messages` accepting `{ body?, attachmentKey?, attachmentName? }` and returning attachment fields including `attachmentUrl` (Tasks 3-4).
- Produces: nothing consumed elsewhere in this plan — this is the last task.

- [ ] **Step 1: Add API wrappers to `web/src/api/chat.js`**

Add after the existing `sendMessage` function:

```js
export function requestUpload(conversationId, { fileName, mimeType, size }, token) {
  return apiFetch('/chat/uploads', {
    method: 'POST',
    body: { conversationId, fileName, mimeType, size },
    token,
  })
}

// PUTs directly to R2 — not through apiFetch, since this isn't a /api call
// and doesn't take a bearer token (the presigned URL itself is the auth).
// Content-Type must match what was sent to requestUpload(), since it's
// bound into the presigned URL's signature.
export async function uploadFileToR2(url, file) {
  const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file })
  if (!res.ok) throw new Error('Upload failed')
}
```

Change `sendMessage` from:

```js
export function sendMessage(conversationId, body, token) {
  return apiFetch(`/chat/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: { body },
    token,
  })
}
```

to:

```js
export function sendMessage(conversationId, { body, attachmentKey, attachmentName } = {}, token) {
  return apiFetch(`/chat/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: { body, attachmentKey, attachmentName },
    token,
  })
}
```

- [ ] **Step 2: Update the one existing caller of `sendMessage`**

In `web/src/pages/ChatPage.jsx`, find `attemptSend` (around line 269, `const real = await sendMessage(conversationId, body, token)`) and change that call to:

```js
const real = await sendMessage(conversationId, { body }, token)
```

- [ ] **Step 3: Add the file-attach handler to `ChatPage.jsx`**

Add near the top of the component, alongside the existing `[emojiPickerOpen, ...]` state (find that line and add below it):

```jsx
  const [uploadBusy, setUploadBusy] = useState(false)
  const [uploadError, setUploadError] = useState(null)
  const fileInputRef = useRef(null)
```

Add the import for `requestUpload`/`uploadFileToR2` alongside the existing `import { listMessages, listDriveHistory, sendMessage } from '../api/chat'` line — change it to:

```jsx
import { listMessages, listDriveHistory, sendMessage, requestUpload, uploadFileToR2 } from '../api/chat'
```

Add this handler near `attemptSend`/`handleSend` (after `handleSend`):

```jsx
  async function handleFileSelected(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file later
    if (!file || !activeConversationId) return

    setUploadError(null)
    setUploadBusy(true)
    try {
      const { url, key } = await requestUpload(
        activeConversationId,
        { fileName: file.name, mimeType: file.type || 'application/octet-stream', size: file.size },
        token
      )
      await uploadFileToR2(url, file)
      const real = await sendMessage(activeConversationId, { attachmentKey: key, attachmentName: file.name }, token)
      setMessages((prev) => [...prev, real])
      isAtBottomRef.current = true
      requestAnimationFrame(scrollToBottom)
    } catch (err) {
      setUploadError(err.message)
    } finally {
      setUploadBusy(false)
    }
  }
```

- [ ] **Step 4: Add the attach button and hidden file input to the composer**

In the `<form className="chat-composer" onSubmit={handleSend}>` block, right after the closing `</div>` of `chat-composer-emoji-wrap` and before the message `<input>`, add:

```jsx
                <input
                  type="file"
                  ref={fileInputRef}
                  className="chat-composer-file-input"
                  onChange={handleFileSelected}
                  disabled={uploadBusy}
                />
                <button
                  type="button"
                  className="chat-composer-attach-btn"
                  aria-label={t('chat.attachFile')}
                  disabled={uploadBusy}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {uploadBusy ? '…' : '📎'}
                </button>
```

Add `{uploadError && <p className="error">{uploadError}</p>}` immediately above the `<form className="chat-composer" ...>` line, so an upload failure shows in the same place other chat errors do.

- [ ] **Step 5: Render attachments in the message bubble**

In the messages `.map((m) => ...)` block, find:

```jsx
                            <div className="chat-bubble">
                              {m.body}
                              <span className="chat-bubble-time">{formatTime(m.createdAt, language)}</span>
                            </div>
```

Replace with:

```jsx
                            <div className="chat-bubble">
                              {m.attachmentType === 'image' && (
                                <a href={m.attachmentUrl} target="_blank" rel="noreferrer" className="chat-attachment-image-link">
                                  <img src={m.attachmentUrl} alt={m.attachmentName || ''} className="chat-attachment-image" />
                                </a>
                              )}
                              {m.attachmentType === 'file' && (
                                <a
                                  href={m.attachmentUrl}
                                  download={m.attachmentName}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="chat-attachment-file"
                                >
                                  <span className="chat-attachment-file-icon">📄</span>
                                  <span className="chat-attachment-file-info">
                                    <span className="chat-attachment-file-name">{m.attachmentName}</span>
                                    <span className="chat-attachment-file-size">
                                      {m.attachmentSize ? `${Math.round(m.attachmentSize / 1024)} KB` : ''}
                                    </span>
                                  </span>
                                </a>
                              )}
                              {m.body}
                              <span className="chat-bubble-time">{formatTime(m.createdAt, language)}</span>
                            </div>
```

- [ ] **Step 6: Add CSS**

Add to `web/src/index.css`, after the `.emoji-picker-item:hover` rule added by the emoji picker work:

```css
.chat-composer-file-input {
  display: none;
}

.chat-composer-attach-btn {
  flex-shrink: 0;
  min-width: unset;
  width: 36px;
  height: 36px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--bg-subtle);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}

.chat-composer-attach-btn:hover:not(:disabled) {
  background: var(--bg-raised);
}

.chat-composer-attach-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.chat-attachment-image-link {
  display: block;
}

.chat-attachment-image {
  display: block;
  max-width: 240px;
  max-height: 240px;
  border-radius: 8px;
  margin-bottom: 4px;
  object-fit: cover;
}

.chat-attachment-file {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  margin-bottom: 4px;
  border-radius: 8px;
  background: var(--bg-subtle);
  text-decoration: none;
  color: inherit;
}

.chat-attachment-file-icon {
  font-size: 24px;
}

.chat-attachment-file-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.chat-attachment-file-name {
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-attachment-file-size {
  font-size: 12px;
  opacity: 0.7;
}
```

- [ ] **Step 7: Add translation keys**

In `web/src/i18n/translations.js`, English section, add after `'chat.emojiPicker': 'Emoji',`:

```js
    'chat.attachFile': 'Attach a file',
```

Thai section, add after `'chat.emojiPicker': 'อีโมจิ',`:

```js
    'chat.attachFile': 'แนบไฟล์',
```

- [ ] **Step 8: Lint, build, and manually verify**

```bash
cd web
npm run lint
npm run build
```

Then, with the backend running and real `R2_*` env vars set (see Task 2's `.env.example` entry — this step needs a real Cloudflare R2 bucket, unlike every earlier task which only needed the mocked test suite):

- Send an image under 10MB between two friended test accounts — confirm it renders inline in both browsers, live via SSE for the recipient without a refresh.
- Send a non-image file under 25MB — confirm it renders as a name+size card with a working download link.
- Try a file named `virus.exe` — confirm `POST /api/chat/uploads` rejects it (400) before any upload happens.
- Try an image over 10MB — confirm it's rejected.
- Confirm a plain text message (no attachment) still sends and displays exactly as before.

- [ ] **Step 9: Commit**

```bash
git add web/src/api/chat.js web/src/pages/ChatPage.jsx web/src/index.css web/src/i18n/translations.js
git commit -m "$(cat <<'EOF'
Add image/file attachments to the chat composer and message bubbles

Selecting a file requests a presigned upload URL, PUTs directly to R2
(never through this app's server), then sends a message referencing
the resulting key. Images render inline in the bubble with a
max-width/max-height so layout can't break; other files render as a
name+size download card. Falls back to an inline error message on any
step failing (validation, upload, or message creation).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Final Checklist (after all tasks)

- [ ] `npm test` passes in full, run alone (not alongside any other test process)
- [ ] `cd web && npm run lint && npm run build` both pass
- [ ] `git status` clean
- [ ] A real Cloudflare R2 bucket exists with `R2_*` values in `.env`, and the manual verification list in Task 6 Step 8 has been run against it
- [ ] `CLAUDE.md` — consider adding a short bullet describing this feature (storage choice, presigned-URL flow, what's out of scope) the same way Drive backup and Push are documented, so a future session doesn't have to rediscover it from code. Not required for this plan to be "done," but recommended before merging.

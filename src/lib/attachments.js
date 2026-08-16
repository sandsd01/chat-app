const crypto = require("crypto");
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

// Optional like Push/Google sign-in: null rather than a client built
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

// Deliberately an allowlist, not "startsWith('image/')": an SVG is XML that
// can carry an inline <script>, and image/* covers it too. Anything not on
// this list — including SVG — is classed "file" below, which forces a
// download disposition on the presigned GET URL instead of letting a browser
// render (and execute) it inline just because the tab it opened in trusted
// a same-app URL.
const SAFE_INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

function attachmentTypeFor(mimeType) {
  return SAFE_INLINE_IMAGE_TYPES.has(mimeType.toLowerCase()) ? "image" : "file";
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
///
/// `attachmentType` forces the response's Content-Disposition: "image" (from
/// the SAFE_INLINE_IMAGE_TYPES allowlist above) renders inline as a preview,
/// anything else downloads instead of opening directly in the browser tab —
/// the thing that would otherwise let a non-image object with a spoofable
/// Content-Type render/execute as if it were trusted first-party content.
async function createDownloadUrl(key, attachmentType) {
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    ResponseContentDisposition: attachmentType === "image" ? "inline" : "attachment",
  });
  return presigner.getSignedUrl(s3Client, command, { expiresIn: PRESIGN_TTL_SECONDS });
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_FILE_BYTES,
  BLOCKED_EXTENSIONS,
  attachmentTypeFor,
  validateUpload,
  keyFor,
  attachmentsConfigured,
  createUploadUrl,
  verifyUploadedObject,
  createDownloadUrl,
};

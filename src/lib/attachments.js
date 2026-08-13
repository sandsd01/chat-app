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

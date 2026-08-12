const crypto = require("crypto");

// A Drive refresh token is a long-lived, non-expiring credential (it's what
// lets us act as the user against their own Drive indefinitely), so it is
// never stored in plaintext — only its AES-256-GCM ciphertext, under a key
// that lives outside the database (TOKEN_ENCRYPTION_KEY). Anyone with only a
// DB dump then has ciphertext, not a usable credential.
const KEY_ENV = "TOKEN_ENCRYPTION_KEY";
const IV_LENGTH = 12; // 96-bit nonce, the size GCM is designed for

function loadKey() {
  const raw = process.env[KEY_ENV];
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(`${KEY_ENV} must decode (as base64) to exactly 32 bytes for AES-256-GCM`);
  }
  return key;
}

function encryptSecret(plaintext) {
  const key = loadKey();
  if (!key) throw new Error(`${KEY_ENV} is not set`);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // iv:authTag:ciphertext, each base64 — self-contained so a key rotation
  // only needs the key, not a side-channel for which iv was used.
  return [iv, authTag, ciphertext].map((b) => b.toString("base64")).join(":");
}

function decryptSecret(stored) {
  const key = loadKey();
  if (!key) throw new Error(`${KEY_ENV} is not set`);
  const [ivB64, authTagB64, ciphertextB64] = stored.split(":");
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function tokenEncryptionConfigured() {
  return Boolean(process.env[KEY_ENV]);
}

module.exports = { encryptSecret, decryptSecret, tokenEncryptionConfigured };

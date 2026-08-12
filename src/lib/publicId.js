const crypto = require("crypto");

// Excludes 0/O, 1/I/L — characters that are easy to misread when someone is
// reading a code out loud or copying it off a screen.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const LENGTH = 8;

function generatePublicId() {
  const bytes = crypto.randomBytes(LENGTH);
  let id = "";
  for (let i = 0; i < LENGTH; i++) {
    id += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return id;
}

// A collision is astronomically unlikely at this alphabet/length (31^8 ≈ 852
// billion), but "unlikely" isn't "impossible" and the unique constraint would
// otherwise surface as a raw Prisma error on someone's first signup. Retry a
// few times before giving up rather than trusting the odds silently.
const MAX_ATTEMPTS = 5;

async function createUserWithUniquePublicId(prisma, data) {
  let lastError;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await prisma.user.create({ data: { ...data, publicId: generatePublicId() } });
    } catch (err) {
      if (err.code === "P2002" && err.meta?.target?.includes("publicId")) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

module.exports = { generatePublicId, createUserWithUniquePublicId };

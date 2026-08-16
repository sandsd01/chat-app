process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/chatapp_test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
// Fake but well-formed-enough values so src/lib/push.js#ensureConfigured()
// takes the "configured" path in tests — actual network calls to a push
// service are mocked (see tests/push.test.js) rather than made for real.
process.env.VAPID_PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY ||
  "BDn-sseZsRNWFx7tSgu6lhKFC1JwFTOdj2V_DyNh5jHLPvx3wlIwps2ZZZcmoZcJPmdP065KcKdbrGHL5B8CdMc";
process.env.VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "zUPloQdUN-nersT6XNG1BMaENNGa-t2ypwKiTUNj3sY";
process.env.VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:test@example.com";

const bcrypt = require("bcryptjs");
const prisma = require("../../prisma/client");
const { createUserWithUniquePublicId } = require("../../src/lib/publicId");

async function resetDb() {
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.friendship.deleteMany();
  await prisma.pushSubscription.deleteMany();
  await prisma.user.deleteMany();
}

// Defaults to a verified account: most tests aren't exercising the
// verification-gating behaviour itself and shouldn't have to think about it
// (see tests/auth.test.js and tests/friends.test.js for the tests that
// specifically pass verified: false).
async function createUser({ email, password = "password123", name, verified = true }) {
  const passwordHash = await bcrypt.hash(password, 10);
  return createUserWithUniquePublicId(prisma, {
    email,
    passwordHash,
    name,
    emailVerifiedAt: verified ? new Date() : null,
  });
}

/** Makes (or upgrades) a Friendship row between two users to "accepted", for
 * tests that need to get past the chat-gating check without exercising the
 * request flow itself. Upserts rather than creates so it also works when a
 * pending row already exists for the pair (e.g. a test that sent a request
 * and then wants to skip straight to "and now they're friends"). */
async function makeFriends(userA, userB) {
  const userAId = Math.min(userA.id, userB.id);
  const userBId = Math.max(userA.id, userB.id);
  return prisma.friendship.upsert({
    where: { userAId_userBId: { userAId, userBId } },
    update: { status: "accepted", respondedAt: new Date() },
    create: { userAId, userBId, status: "accepted", requestedById: userA.id, respondedAt: new Date() },
  });
}

module.exports = { prisma, resetDb, createUser, makeFriends };

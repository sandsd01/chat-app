process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/chatapp_test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const bcrypt = require("bcryptjs");
const prisma = require("../../prisma/client");
const { createUserWithUniquePublicId } = require("../../src/lib/publicId");

async function resetDb() {
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.friendship.deleteMany();
  await prisma.user.deleteMany();
}

async function createUser({ email, password = "password123", name }) {
  const passwordHash = await bcrypt.hash(password, 10);
  return createUserWithUniquePublicId(prisma, { email, passwordHash, name });
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

require("dotenv/config");
const bcrypt = require("bcryptjs");

const prisma = require("./client");
const { createUserWithUniquePublicId } = require("../src/lib/publicId");

// A couple of ordinary accounts to log in and chat with locally. Override
// via env if you want different seed credentials.
const SEED_USERS = [
  {
    email: process.env.SEED_USER_1_EMAIL || "alice@example.com",
    password: process.env.SEED_USER_1_PASSWORD || "changeme123",
    name: "Alice",
  },
  {
    email: process.env.SEED_USER_2_EMAIL || "bob@example.com",
    password: process.env.SEED_USER_2_PASSWORD || "changeme123",
    name: "Bob",
  },
];

async function main() {
  const users = [];
  for (const { email, password, name } of SEED_USERS) {
    let user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      console.log(`User ${email} already exists, skipping.`);
    } else {
      const passwordHash = await bcrypt.hash(password, 10);
      user = await createUserWithUniquePublicId(prisma, { email, passwordHash, name });
      console.log(`Seeded user: ${email} (${user.publicId})`);
    }
    users.push(user);
  }

  // Pre-friend the seed accounts so local testing doesn't require walking
  // through the add-by-ID flow just to have someone to message.
  if (users.length === 2) {
    const [a, b] = users;
    const userAId = Math.min(a.id, b.id);
    const userBId = Math.max(a.id, b.id);
    await prisma.friendship.upsert({
      where: { userAId_userBId: { userAId, userBId } },
      update: {},
      create: { userAId, userBId, status: "accepted", requestedById: a.id, respondedAt: new Date() },
    });
    console.log(`${a.email} and ${b.email} are now friends.`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

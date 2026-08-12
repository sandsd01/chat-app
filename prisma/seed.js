require("dotenv/config");
const bcrypt = require("bcryptjs");

const prisma = require("./client");

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
  for (const { email, password, name } of SEED_USERS) {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      console.log(`User ${email} already exists, skipping.`);
      continue;
    }
    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.user.create({ data: { email, passwordHash, name } });
    console.log(`Seeded user: ${email}`);
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

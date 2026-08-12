const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env and point it at your PostgreSQL database."
  );
}

const adapter = new PrismaPg({ connectionString });

module.exports = new PrismaClient({ adapter });

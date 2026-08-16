const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const root = path.resolve(__dirname, "..");
const testDatabaseUrl = process.env.TEST_DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/chatapp_test";
const testEnv = { ...process.env, DATABASE_URL: testDatabaseUrl, JWT_SECRET: "test-secret", NODE_ENV: "test" };

// Tests intentionally cover every optional integration's unconfigured state.
// Keep local development credentials from .env out of the child test process;
// individual integration tests set the variables they need themselves.
for (const key of [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
]) {
  delete testEnv[key];
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: testEnv, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function testFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(entryPath);
    return entry.name.endsWith(".test.js") ? [entryPath] : [];
  });
}

const task = process.argv[2] || "all";
const requestedTestFiles = process.argv.slice(3).map((file) => path.resolve(root, file));
if (!new Set(["all", "migrate", "run"]).has(task)) {
  throw new Error("Usage: node scripts/run-tests.js [all|migrate|run]");
}

if (task === "all" || task === "migrate") {
  run(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "deploy"]);
}

if (task === "all" || task === "run") {
  const files = requestedTestFiles.length > 0 ? requestedTestFiles : testFiles(path.join(root, "tests"));
  run(process.execPath, ["--test", "--test-concurrency=1", ...files]);
}

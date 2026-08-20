require("dotenv/config");
const cron = require("node-cron");
const app = require("./app");
const { expireMessages } = require("./lib/messageExpiry");

const port = process.env.PORT || 3000;

// A guessable signing key means anyone can mint a token for any account, so
// refuse to boot on a missing, placeholder, or too-short secret rather than
// starting up in a state that looks healthy but isn't.
const PLACEHOLDER_SECRETS = new Set(["replace-with-a-long-random-secret", "changeme", "secret"]);
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  console.error("JWT_SECRET environment variable is required");
  process.exit(1);
}
if (PLACEHOLDER_SECRETS.has(jwtSecret) || jwtSecret.length < 32) {
  console.error(
    "JWT_SECRET must be a random value of at least 32 characters (the .env.example placeholder is not usable). " +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
  process.exit(1);
}

// Long-lived responses (GET /api/chat/stream holds an SSE response open
// indefinitely) are left on Node's default HTTP timeouts on purpose:
//
//   server.requestTimeout   300_000  bounds RECEIVING the request, not the
//                                    response. A bodyless GET is complete the
//                                    moment its headers arrive, so the timer
//                                    never trips no matter how long the
//                                    response stays open. Verified on Node 22
//                                    by holding an SSE response open for 330s
//                                    (past the 300s mark) — it stayed up,
//                                    while a control request with a stalled
//                                    body was killed exactly on the timeout.
//   server.headersTimeout    60_000  likewise only covers arrival of headers.
//   server.keepAliveTimeout   5_000  only applies to an IDLE connection
//                                    between requests, not one mid-response.
//   server.timeout                0  no socket inactivity timeout (Node >= 13).
//
// So do NOT "fix" a dropped stream by setting `server.requestTimeout = 0`:
// that wouldn't have been the cause, and it removes the slow-request
// (slowloris) protection from every other route. If a stream does die at a
// fixed interval in production, look at the proxy in front of Node, not
// here — the route's 25s `: ping` heartbeat exists to keep those proxies
// from calling the connection idle.
app.listen(port, () => {
  console.log(`API listening on port ${port}`);
});

// Deletes messages whose disappearing-message timer has elapsed. Deliberately
// NOT gated behind an optional-service flag: a conversation's timer is a
// promise the app made to both participants, so this has to run in every
// deployment, not only ones that configured something. Runs every minute by
// default — the resolution users can actually perceive at the shortest
// offered duration (5 minutes).
const expirySchedule = process.env.MESSAGE_EXPIRY_CRON || "* * * * *";
cron.schedule(expirySchedule, () => {
  expireMessages().catch((err) => console.error("Message expiry sweep failed:", err));
});

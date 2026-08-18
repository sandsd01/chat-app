const express = require("express");
const prisma = require("../../prisma/client");
const { authenticate } = require("../middleware/auth");
const { encryptSecret, decryptSecret } = require("../lib/crypto");
const {
  driveConfigured,
  driveOauthClient,
  DRIVE_SCOPE,
  archiveUserConversations,
} = require("../lib/drive");
const { createTicketStore } = require("../lib/ticketStore");

const router = express.Router();

const DRIVE_REDIRECT_URI = process.env.DRIVE_REDIRECT_URI;

function appUrl() {
  return process.env.APP_URL || "http://localhost:5173";
}

// Same shape as src/routes/auth.js's OAuth state cookie, but this flow can't
// rely on the cookie alone to identify *who* is connecting: the state is
// minted from an authenticated POST (the SPA already has a JWT at this
// point, it's just about to leave for a full-page redirect that can't carry
// one), so the server-side map below ties the state to that user's id — the
// cookie is defense in depth (same browser completes the round trip), not
// the only thing standing between an attacker and account takeover.
const DRIVE_STATE_COOKIE = "g_drive_state";
const DRIVE_STATE_TTL_MS = 5 * 60 * 1000;
const driveConnectStates = createTicketStore(DRIVE_STATE_TTL_MS);

router.get("/status", authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  res.json({ connected: Boolean(user.driveConnectedAt), connectedAt: user.driveConnectedAt });
});

router.post("/connect/start", authenticate, (req, res) => {
  if (!driveConfigured) {
    return res.status(503).json({ error: "Google Drive backup is not configured" });
  }

  const state = driveConnectStates.issue(req.user.id);

  res.cookie(DRIVE_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: DRIVE_STATE_TTL_MS,
  });

  // access_type "offline" + prompt "consent" is what gets a refresh_token
  // back — without prompt=consent, Google silently omits it on anything
  // after the very first authorization for this user+client+scope set.
  const url = driveOauthClient.generateAuthUrl({
    access_type: "offline",
    scope: [DRIVE_SCOPE],
    state,
    prompt: "consent",
  });
  res.json({ url });
});

// A top-level browser redirect from Google — it can't carry an
// Authorization header, so this route is deliberately NOT behind
// `authenticate`. Which account it's for comes from `driveConnectStates`
// instead (populated by the authenticated /connect/start above).
router.get("/connect/callback", async (req, res) => {
  const failure = (reason) => res.redirect(`${appUrl()}/account?driveError=${encodeURIComponent(reason)}`);

  if (!driveConfigured) return failure("drive_not_configured");

  const { code, state } = req.query;
  const cookieState = req.cookies?.[DRIVE_STATE_COOKIE];
  res.clearCookie(DRIVE_STATE_COOKIE);

  const connectingUserId = state ? driveConnectStates.consume(state) : null;

  if (!code || !state || !cookieState || state !== cookieState || !connectingUserId) {
    return failure("invalid_state");
  }

  try {
    const { tokens } = await driveOauthClient.getToken({ code, redirect_uri: DRIVE_REDIRECT_URI });
    if (!tokens.refresh_token) {
      // Shouldn't happen given prompt=consent, but Drive access without a
      // refresh token can't be renewed once the short-lived access token
      // expires, so treat it as a failure rather than silently degrading.
      return failure("no_refresh_token");
    }
    await prisma.user.update({
      where: { id: connectingUserId },
      data: {
        driveRefreshTokenEnc: encryptSecret(tokens.refresh_token),
        driveConnectedAt: new Date(),
        driveFolderId: null,
      },
    });
  } catch (err) {
    console.error("Google Drive connect exchange failed:", err.message);
    return failure("drive_exchange_failed");
  }

  res.redirect(`${appUrl()}/account?drive=connected`);
});

router.post("/disconnect", authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });

  if (user.driveRefreshTokenEnc) {
    try {
      const refreshToken = decryptSecret(user.driveRefreshTokenEnc);
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, {
        method: "POST",
      });
    } catch (err) {
      // Best-effort: even if Google's revoke call fails, we still forget the
      // token on our side below — the user asked to disconnect, and a stray
      // still-valid grant on Google's side doesn't let us do anything with
      // it once we've deleted our copy.
      console.error("Google token revoke failed:", err.message);
    }
  }

  await prisma.$transaction([
    prisma.driveArchiveFile.deleteMany({ where: { userId: req.user.id } }),
    prisma.user.update({
      where: { id: req.user.id },
      data: { driveRefreshTokenEnc: null, driveConnectedAt: null, driveFolderId: null },
    }),
  ]);

  res.json({ message: "Google Drive disconnected" });
});

router.post("/sync", authenticate, async (req, res) => {
  if (!driveConfigured) {
    return res.status(503).json({ error: "Google Drive backup is not configured" });
  }

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user.driveRefreshTokenEnc) {
    return res.status(400).json({ error: "Google Drive is not connected" });
  }

  try {
    // Pruning is a full-conversation-table scan across every user, not just
    // this one — it only runs from the cron sweep (src/server.js#runArchiveSweep),
    // never from a single user's request, so one account can't force a
    // system-wide scan/delete just by hitting this endpoint repeatedly.
    const result = await archiveUserConversations(req.user.id);
    res.json(result);
  } catch (err) {
    console.error("Google Drive sync failed:", err.message);
    res.status(502).json({ error: "Google Drive sync failed" });
  }
});

module.exports = { router };

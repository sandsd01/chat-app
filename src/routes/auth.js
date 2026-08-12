const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const prisma = require("../../prisma/client");
const { authenticate } = require("../middleware/auth");
const { authLimiter } = require("../middleware/rateLimit");
const { sendPasswordResetEmail } = require("../lib/email");
const { createUserWithUniquePublicId } = require("../lib/publicId");

const router = express.Router();

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;
const RESET_TOKEN_EXPIRY_MS = 30 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: "8h" });
}

function publicUser(user) {
  return { id: user.id, publicId: user.publicId, email: user.email, name: user.name };
}

function appUrl() {
  return process.env.APP_URL || "http://localhost:5173";
}

// --- Google sign-in --------------------------------------------------------
// Optional: the app runs fine without these set, GET /auth/google just 503s.
// See CLAUDE.md for why the callback hands the browser a short-lived ticket
// instead of the real JWT (same reasoning as the chat SSE ticket).
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const googleConfigured = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI);
const oauthClient = googleConfigured
  ? new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI)
  : null;

const OAUTH_STATE_COOKIE = "g_oauth_state";
const OAUTH_STATE_TTL_MS = 5 * 60 * 1000;

// Single-use, 30-second login ticket, exactly the same in-memory-Map shape as
// src/routes/chat.js's SSE ticket — a full top-level browser redirect back
// from Google can't hand the SPA a JWT directly without it sitting in the
// URL (history, Referer, server logs), so the callback mints one of these
// instead and the SPA exchanges it for the real token from JS.
const LOGIN_TICKET_TTL_MS = 30 * 1000;
const loginTickets = new Map(); // ticket -> { userId, expiresAt }

function issueLoginTicket(userId) {
  const ticket = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + LOGIN_TICKET_TTL_MS;
  loginTickets.set(ticket, { userId, expiresAt });
  const timer = setTimeout(() => loginTickets.delete(ticket), LOGIN_TICKET_TTL_MS);
  timer.unref?.();
  return ticket;
}

function consumeLoginTicket(ticket) {
  const entry = loginTickets.get(ticket);
  if (!entry) return null;
  loginTickets.delete(ticket);
  if (entry.expiresAt < Date.now()) return null;
  return entry.userId;
}

router.get("/google", (_req, res) => {
  if (!googleConfigured) {
    return res.status(503).json({ error: "Google sign-in is not configured" });
  }

  const state = crypto.randomBytes(16).toString("hex");
  res.cookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: OAUTH_STATE_TTL_MS,
  });

  const authUrl = oauthClient.generateAuthUrl({
    access_type: "online",
    scope: ["openid", "email", "profile"],
    state,
    prompt: "select_account",
  });
  res.redirect(authUrl);
});

router.get("/google/callback", async (req, res) => {
  const failure = (reason) => res.redirect(`${appUrl()}/login?error=${encodeURIComponent(reason)}`);

  if (!googleConfigured) return failure("google_not_configured");

  const { code, state } = req.query;
  const cookieState = req.cookies?.[OAUTH_STATE_COOKIE];
  res.clearCookie(OAUTH_STATE_COOKIE);

  if (!code || !state || !cookieState || state !== cookieState) {
    return failure("invalid_state");
  }

  let payload;
  try {
    const { tokens } = await oauthClient.getToken({ code, redirect_uri: GOOGLE_REDIRECT_URI });
    const ticket = await oauthClient.verifyIdToken({ idToken: tokens.id_token, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (err) {
    console.error("Google OAuth exchange failed:", err.message);
    return failure("google_exchange_failed");
  }

  if (!payload?.email_verified) {
    return failure("email_not_verified");
  }

  let user = await prisma.user.findUnique({ where: { googleId: payload.sub } });
  if (!user) {
    // Auto-link by email: Google has already verified this address, so an
    // existing password-based account with the same email is the same
    // person signing in a different way, not a spoof risk.
    const byEmail = await prisma.user.findUnique({ where: { email: payload.email } });
    if (byEmail) {
      user = await prisma.user.update({ where: { id: byEmail.id }, data: { googleId: payload.sub } });
    } else {
      user = await createUserWithUniquePublicId(prisma, {
        email: payload.email,
        googleId: payload.sub,
        name: payload.name || undefined,
      });
    }
  }

  const loginTicket = issueLoginTicket(user.id);
  res.redirect(`${appUrl()}/oauth-callback?ticket=${loginTicket}`);
});

router.post("/google/exchange", async (req, res) => {
  const { ticket } = req.body || {};
  const userId = typeof ticket === "string" ? consumeLoginTicket(ticket) : null;
  if (!userId) return res.status(401).json({ error: "Invalid or expired ticket" });

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return res.status(404).json({ error: "User not found" });

  res.json({ token: signToken(user), user: publicUser(user) });
});

// Minimal email+password self-signup. This is a placeholder for the Google
// sign-in phase (see CLAUDE.md's Roadmap) — kept intentionally bare (no email
// verification, no CAPTCHA) because it exists only so the friend-by-ID system
// has real accounts to test against locally, not as the production signup
// flow. Revisit rate limiting and abuse protection before this is the only
// way to create an account in a public deployment.
router.post("/signup", authLimiter, async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return res.status(409).json({ error: "An account with this email already exists" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await createUserWithUniquePublicId(prisma, {
    email,
    passwordHash,
    name: name || undefined,
  });

  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

router.post("/login", authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return res.status(423).json({
      error: "Account locked due to too many failed login attempts. Try again later.",
    });
  }

  if (!user.passwordHash) {
    return res.status(401).json({ error: "This account signs in with Google. Use 'Continue with Google' instead." });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    const failedLoginAttempts = user.failedLoginAttempts + 1;
    const lockingNow = failedLoginAttempts >= MAX_FAILED_ATTEMPTS;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: lockingNow ? 0 : failedLoginAttempts,
        lockedUntil: lockingNow ? new Date(Date.now() + LOCK_DURATION_MS) : null,
      },
    });

    if (lockingNow) {
      return res.status(423).json({
        error: "Account locked due to too many failed login attempts. Try again later.",
      });
    }
    return res.status(401).json({ error: "Invalid email or password" });
  }

  if (user.failedLoginAttempts > 0 || user.lockedUntil) {
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
  }

  res.json({ token: signToken(user), user: publicUser(user) });
});

router.get("/me", authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) return res.status(404).json({ error: "User not found" });

  res.json({ ...publicUser(user), createdAt: user.createdAt });
});

router.post("/logout", (_req, res) => {
  res.json({ message: "Logged out. Discard the token client-side." });
});

router.patch("/password", authenticate, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "currentPassword and newPassword are required" });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: "newPassword must be at least 8 characters" });
  }

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user.passwordHash) {
    return res.status(400).json({ error: "This account signs in with Google and has no password to change" });
  }
  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

  res.json({ message: "Password updated" });
});

router.post("/forgot-password", authLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (!email) {
    return res.status(400).json({ error: "email is required" });
  }

  const genericResponse = { message: "If that email exists, a password reset link has been sent." };

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return res.json(genericResponse);
  }

  const token = crypto.randomBytes(32).toString("hex");
  await prisma.user.update({
    where: { id: user.id },
    data: {
      resetTokenHash: hashToken(token),
      resetTokenExpiresAt: new Date(Date.now() + RESET_TOKEN_EXPIRY_MS),
    },
  });

  const appUrl = process.env.APP_URL || "http://localhost:5173";
  const resetUrl = `${appUrl}/reset-password?token=${token}&email=${encodeURIComponent(email)}`;

  try {
    await sendPasswordResetEmail(user, resetUrl);
  } catch (err) {
    console.error("Failed to send password reset email:", err);
  }

  res.json(genericResponse);
});

router.post("/reset-password", async (req, res) => {
  const { email, token, newPassword } = req.body || {};
  if (!email || !token || !newPassword) {
    return res.status(400).json({ error: "email, token, and newPassword are required" });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: "newPassword must be at least 8 characters" });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (
    !user ||
    !user.resetTokenHash ||
    !user.resetTokenExpiresAt ||
    user.resetTokenExpiresAt < new Date() ||
    user.resetTokenHash !== hashToken(token)
  ) {
    return res.status(400).json({ error: "Invalid or expired reset token" });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      resetTokenHash: null,
      resetTokenExpiresAt: null,
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  });

  res.json({ message: "Password has been reset. You can now log in." });
});

module.exports = router;

const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const prisma = require("../../prisma/client");
const { authenticate } = require("../middleware/auth");
const { authLimiter } = require("../middleware/rateLimit");
const { sendPasswordResetEmail, sendVerificationEmail } = require("../lib/email");
const { captchaConfigured, siteKey: captchaSiteKey, verifyCaptcha } = require("../lib/captcha");
const { createUserWithUniquePublicId } = require("../lib/publicId");
const { createTicketStore } = require("../lib/ticketStore");

const router = express.Router();

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;
const RESET_TOKEN_EXPIRY_MS = 30 * 60 * 1000;
// Longer-lived than the password reset token: that one guards changing a
// credential right now, this one just confirms an inbox is real, so there's
// less harm in a link still working a day later.
const VERIFY_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// crypto.timingSafeEqual over `!==` for the same reason password checks go
// through bcrypt.compare instead of a plain string compare — both sides are
// fixed-length sha256 hex digests here, so lengths always match and this
// never throws on that account.
function hashesMatch(a, b) {
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: "8h" });
}

function publicUser(user) {
  return {
    id: user.id,
    publicId: user.publicId,
    publicIdCustomized: user.publicIdCustomized,
    email: user.email,
    name: user.name,
    emailVerifiedAt: user.emailVerifiedAt,
    hasPassword: Boolean(user.passwordHash),
  };
}

function appUrl() {
  return process.env.APP_URL || "http://localhost:5173";
}

// Generates and stores a fresh verify token for `user`, then emails it —
// shared by signup and POST /auth/resend-verification so there's one place
// that decides the token shape/expiry/email copy. Never throws on a failed
// send (matches forgot-password's own try/catch): a bounced or unconfigured
// mail provider shouldn't turn into a 500 for the caller.
async function issueEmailVerification(user) {
  const token = crypto.randomBytes(32).toString("hex");
  await prisma.user.update({
    where: { id: user.id },
    data: {
      verifyTokenHash: hashToken(token),
      verifyTokenExpiresAt: new Date(Date.now() + VERIFY_TOKEN_EXPIRY_MS),
    },
  });

  const verifyUrl = `${appUrl()}/verify-email?token=${token}&email=${encodeURIComponent(user.email)}`;
  try {
    await sendVerificationEmail(user, verifyUrl);
  } catch (err) {
    console.error("Failed to send verification email:", err);
  }
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

// Single-use, 30-second login ticket — a full top-level browser redirect
// back from Google can't hand the SPA a JWT directly without it sitting in
// the URL (history, Referer, server logs), so the callback mints one of
// these instead and the SPA exchanges it for the real token from JS.
const loginTickets = createTicketStore(30 * 1000);

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
      // Also marks the account verified if it somehow wasn't yet — reaching
      // this branch already required payload.email_verified above, so this
      // is a Google-verified email regardless of how the account started.
      user = await prisma.user.update({
        where: { id: byEmail.id },
        data: { googleId: payload.sub, emailVerifiedAt: byEmail.emailVerifiedAt || new Date() },
      });
    } else {
      user = await createUserWithUniquePublicId(prisma, {
        email: payload.email,
        googleId: payload.sub,
        name: payload.name || undefined,
        emailVerifiedAt: new Date(),
      });
    }
  }

  const loginTicket = loginTickets.issue(user.id);
  res.redirect(`${appUrl()}/oauth-callback?ticket=${loginTicket}`);
});

router.post("/google/exchange", async (req, res) => {
  const { ticket } = req.body || {};
  const userId = typeof ticket === "string" ? loginTickets.consume(ticket) : null;
  if (!userId) return res.status(401).json({ error: "Invalid or expired ticket" });

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return res.status(404).json({ error: "User not found" });

  res.json({ token: signToken(user), user: publicUser(user) });
});

// Email+password self-signup. Google sign-in (below) is Google-vetted and
// already comes with a verified email for free; this path doesn't have
// that, so it carries its own hardening: an optional CAPTCHA check (see
// captchaConfigured below) and a mandatory post-signup email verification
// step. Neither blocks local/dev use — see src/lib/captcha.js and
// issueEmailVerification's own not-configured fallback.
router.post("/signup", authLimiter, async (req, res) => {
  const { email, password, name, captchaToken } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "email is not a valid email address" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }
  if (captchaConfigured && !(await verifyCaptcha(captchaToken, req.ip))) {
    return res.status(400).json({ error: "CAPTCHA verification failed" });
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
  await issueEmailVerification(user);

  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

router.post("/login", authLimiter, async (req, res) => {
  const { password } = req.body || {};
  const identifier = req.body?.identifier || req.body?.email;
  if (!identifier || !password) {
    return res.status(400).json({ error: "identifier and password are required" });
  }

  // Same email-shape detection already used elsewhere in this file — anything
  // that isn't email-shaped is treated as a publicId lookup, uppercased to
  // match how publicIds are always stored (see src/lib/publicId.js and
  // GET /friends/lookup's identical .toUpperCase() normalization).
  const user = EMAIL_RE.test(identifier)
    ? await prisma.user.findUnique({ where: { email: identifier } })
    : await prisma.user.findUnique({ where: { publicId: identifier.toUpperCase() } });
  if (!user) {
    return res.status(401).json({ error: "Invalid ID/email or password" });
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
    // Atomic increment rather than read-then-write: two concurrent wrong
    // guesses both reading the same stale count would otherwise both write
    // the same +1, silently losing an attempt and letting a parallelized
    // brute force outrun MAX_FAILED_ATTEMPTS.
    const afterIncrement = await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: { increment: 1 } },
    });
    const lockingNow = afterIncrement.failedLoginAttempts >= MAX_FAILED_ATTEMPTS;

    if (lockingNow) {
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockedUntil: new Date(Date.now() + LOCK_DURATION_MS) },
      });
      return res.status(423).json({
        error: "Account locked due to too many failed login attempts. Try again later.",
      });
    }
    return res.status(401).json({ error: "Invalid ID/email or password" });
  }

  if (user.failedLoginAttempts > 0 || user.lockedUntil) {
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
  }

  res.json({ token: signToken(user), user: publicUser(user) });
});

// Public: the signup page needs this before there's any session to
// authenticate. siteKey is safe to hand out (it's meant to be embedded in a
// page); returning null when unconfigured lets the frontend just skip
// rendering the widget, same shape as every other optional-service check.
router.get("/captcha-config", (_req, res) => {
  res.json({ configured: captchaConfigured, siteKey: captchaConfigured ? captchaSiteKey : null });
});

router.post("/verify-email", authLimiter, async (req, res) => {
  const { email, token } = req.body || {};
  if (!email || !token) {
    return res.status(400).json({ error: "email and token are required" });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (
    !user ||
    !user.verifyTokenHash ||
    !user.verifyTokenExpiresAt ||
    user.verifyTokenExpiresAt < new Date() ||
    !hashesMatch(user.verifyTokenHash, hashToken(token))
  ) {
    return res.status(400).json({ error: "Invalid or expired verification link" });
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { emailVerifiedAt: new Date(), verifyTokenHash: null, verifyTokenExpiresAt: null },
  });

  res.json({ message: "Email verified.", emailVerifiedAt: updated.emailVerifiedAt });
});

// Authenticated (unlike verify-email above) since there's no token to prove
// identity here — the caller's own session is what says who to re-email.
router.post("/resend-verification", authLimiter, authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) return res.status(404).json({ error: "User not found" });

  if (user.emailVerifiedAt) {
    return res.json({ message: "Your email is already verified." });
  }

  await issueEmailVerification(user);
  res.json({ message: "Verification email sent." });
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
  if (!newPassword) {
    return res.status(400).json({ error: "newPassword is required" });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: "newPassword must be at least 8 characters" });
  }

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  // A Google-only account (passwordHash null) has nothing to verify against —
  // this is *setting* its first password, not changing one, so currentPassword
  // isn't required. An account that already has a password still needs it.
  if (user.passwordHash) {
    if (!currentPassword) {
      return res.status(400).json({ error: "currentPassword is required" });
    }
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

  res.json({ message: user.passwordHash ? "Password updated" : "Password set" });
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

  const resetUrl = `${appUrl()}/reset-password?token=${token}&email=${encodeURIComponent(email)}`;

  try {
    await sendPasswordResetEmail(user, resetUrl);
  } catch (err) {
    console.error("Failed to send password reset email:", err);
  }

  res.json(genericResponse);
});

router.post("/reset-password", authLimiter, async (req, res) => {
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
    !hashesMatch(user.resetTokenHash, hashToken(token))
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

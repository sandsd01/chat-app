const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
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

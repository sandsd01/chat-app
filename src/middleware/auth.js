const jwt = require("jsonwebtoken");
const prisma = require("../../prisma/client");

function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Missing or invalid authorization header" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email, role: payload.role };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden: insufficient role" });
    }
    next();
  };
}

// Queried fresh per-request rather than embedded in the JWT: the token is
// signed once at login and doesn't change when POST /auth/verify-email
// succeeds later, so a claim baked in at sign-time would stay stale for the
// rest of that session's 8-hour life. This is only applied to the one route
// that's actually the abuse vector (sending a friend request) — see
// src/routes/friends.js — not to every authenticated route.
async function requireVerifiedEmail(req, res, next) {
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { emailVerifiedAt: true } });
  if (!user?.emailVerifiedAt) {
    return res.status(403).json({ error: "Verify your email address before doing this" });
  }
  next();
}

module.exports = { authenticate, requireRole, requireVerifiedEmail };

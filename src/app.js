const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const chatRoutes = require("./routes/chat");
const { router: friendRoutes } = require("./routes/friends");
const pushRoutes = require("./routes/push");
const { router: driveRoutes } = require("./routes/drive");
const { apiLimiter } = require("./middleware/rateLimit");

const app = express();

// Behind a load balancer (Railway, Render, nginx, …) req.ip is the proxy's
// address unless we trust the forwarding headers — which would bucket every
// client into one rate-limit key. Opt in explicitly: trusting these headers
// when NOT behind a proxy lets a client spoof its own IP via X-Forwarded-For.
if (process.env.TRUST_PROXY) {
  const value = Number(process.env.TRUST_PROXY);
  app.set("trust proxy", Number.isNaN(value) ? process.env.TRUST_PROXY : value);
}

// Attachments (src/lib/attachments.js) are served/uploaded via presigned R2
// URLs that the browser talks to directly — img tags load them and
// uploadFileToR2 PUTs to them — so both img-src and connect-src need that
// origin allowed, or the default same-origin CSP silently blocks every
// attachment. Only added when R2 is actually configured, same
// optional-service gating as attachmentsConfigured itself.
const r2Origin = process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : null;

app.use(
  helmet({
    // The SPA and the API share an origin in production, so the default
    // same-origin CSP fits.
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "img-src": ["'self'", "data:", "blob:", ...(r2Origin ? [r2Origin] : [])],
        "connect-src": ["'self'", ...(r2Origin ? [r2Origin] : [])],
        // Vite injects the stylesheet as a file, but a few components set
        // inline style attributes, which style-src-attr covers.
        "style-src": ["'self'", "'unsafe-inline'"],
        "style-src-attr": ["'self'", "'unsafe-inline'"],
        "upgrade-insecure-requests": null,
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

// In production the SPA is served from this same origin, so no CORS is needed.
// Set CORS_ORIGIN (comma-separated) when the frontend is hosted separately;
// leaving it unset in production means same-origin only.
const corsOrigin = process.env.CORS_ORIGIN;
if (corsOrigin) {
  app.use(cors({ origin: corsOrigin.split(",").map((o) => o.trim()) }));
} else if (process.env.NODE_ENV !== "production") {
  app.use(cors());
}

app.use(express.json());
// Only used by the Google OAuth state cookie (src/routes/auth.js) — the app
// otherwise has no session/cookie state, auth is bearer-JWT only.
app.use(cookieParser());

// No response-compression middleware is mounted, deliberately. gzip buffers
// output, so it would hold GET /api/chat/stream's SSE frames instead of
// flushing each one — the stream would connect and then appear to deliver
// nothing. If compression is ever added, exclude text/event-stream from it
// (compression's `filter` option) and keep the route's X-Accel-Buffering: no.

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use(apiLimiter);

// Everything the SPA must not swallow. The API lives under /api precisely so
// that client-side routes like /chat can't collide with it.
const API_PREFIXES = ["/api", "/health"];

const apiRouter = express.Router();
apiRouter.use("/auth", authRoutes);
apiRouter.use("/users", userRoutes);
apiRouter.use("/chat", chatRoutes);
apiRouter.use("/friends", friendRoutes);
apiRouter.use("/push", pushRoutes);
apiRouter.use("/drive", driveRoutes);

// The API is namespaced under /api so the SPA can own the rest of the URL
// space: a client route such as /chat/42 would otherwise resolve to the API
// router and return JSON when a browser asks for a page.
app.use("/api", apiRouter);
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

// Serve the built SPA when it exists (production/single-container deploys).
// In dev the Vite server handles this, and in tests web/dist usually isn't
// built at all — hence the existence check rather than an env flag.
const distDir = path.join(__dirname, "..", "web", "dist");
const indexHtml = path.join(distDir, "index.html");
if (fs.existsSync(indexHtml)) {
  app.use(express.static(distDir));

  // Client-side routes (/chat, /chat/42, …) must fall back to index.html, but
  // an unknown API path has to keep returning the JSON 404 below rather than
  // an HTML page a fetch() caller can't parse.
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (API_PREFIXES.some((p) => req.path === p || req.path.startsWith(`${p}/`))) return next();
    res.sendFile(indexHtml);
  });
}

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

module.exports = app;

const express = require("express");
const prisma = require("../../prisma/client");
const { authenticate } = require("../middleware/auth");
const { getPublicKey } = require("../lib/push");

const router = express.Router();
router.use(authenticate);

// One legitimate user rarely has more than a handful of browsers/devices;
// this just bounds how many endpoints sendPushToUser (src/lib/push.js) fans
// a single message out to, so a account can't grow an unbounded subscription
// list that slows down its own delivery.
const MAX_SUBSCRIPTIONS_PER_USER = 20;

router.get("/vapid-public-key", (_req, res) => {
  const key = getPublicKey();
  if (!key) return res.status(503).json({ error: "Push notifications are not configured" });
  res.json({ publicKey: key });
});

router.post("/subscribe", async (req, res) => {
  const { endpoint, keys } = req.body?.subscription || req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: "A valid PushSubscription (endpoint, keys.p256dh, keys.auth) is required" });
  }

  // Upsert on endpoint: re-subscribing the same browser (e.g. after clearing
  // and re-granting permission) replaces the row rather than erroring on the
  // unique constraint or accumulating dead duplicates.
  // Stored only to label this row in GET /subscriptions below, so someone
  // revoking a device can tell which one it is. Truncated because a UA string
  // is attacker-controlled free text and nothing here needs a long one.
  const userAgent = (req.get("user-agent") || "").slice(0, 400) || null;

  await prisma.pushSubscription.upsert({
    where: { endpoint },
    update: { userId: req.user.id, p256dh: keys.p256dh, authKey: keys.auth, userAgent },
    create: { userId: req.user.id, endpoint, p256dh: keys.p256dh, authKey: keys.auth, userAgent },
  });

  // Evict oldest-first if this pushed the user over the cap — re-subscribing
  // an existing endpoint (the common case) never adds a row, so this is a
  // no-op unless a genuinely new device/browser just subscribed.
  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (subscriptions.length > MAX_SUBSCRIPTIONS_PER_USER) {
    const overflowIds = subscriptions.slice(0, subscriptions.length - MAX_SUBSCRIPTIONS_PER_USER).map((s) => s.id);
    await prisma.pushSubscription.deleteMany({ where: { id: { in: overflowIds } } });
  }

  res.status(204).send();
});

router.post("/unsubscribe", async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: "endpoint is required" });

  // Deleting by endpoint alone (not scoped to req.user.id) would let anyone
  // who knows an endpoint URL delete someone else's subscription — scope it.
  await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: req.user.id } });
  res.status(204).send();
});

// --- Per-device management --------------------------------------------------
// POST /unsubscribe above can only ever remove the browser making the call
// (it's the one that knows its own endpoint). These two exist for the other
// case: revoking a device you no longer have — an old phone, a shared
// computer — from whichever browser you're actually sitting at.

/// Best-effort, deliberately coarse: enough to recognise your own devices in
/// a list, not a device-fingerprinting exercise. Unknown UAs fall back to a
/// generic label rather than dumping the raw string into the UI.
function describeDevice(userAgent) {
  if (!userAgent) return "Unknown device";

  const browser =
    /\bEdg\//.test(userAgent) ? "Edge"
    : /\bOPR\/|\bOpera\b/.test(userAgent) ? "Opera"
    : /\bChrome\/|\bCriOS\//.test(userAgent) ? "Chrome"
    : /\bFirefox\/|\bFxiOS\//.test(userAgent) ? "Firefox"
    : /\bSafari\//.test(userAgent) ? "Safari"
    : null;

  const platform =
    /\bAndroid\b/.test(userAgent) ? "Android"
    : /\biPhone\b|\biPad\b|\biPod\b/.test(userAgent) ? "iOS"
    : /\bMac OS X\b|\bMacintosh\b/.test(userAgent) ? "macOS"
    : /\bWindows\b/.test(userAgent) ? "Windows"
    : /\bLinux\b/.test(userAgent) ? "Linux"
    : null;

  if (browser && platform) return `${browser} on ${platform}`;
  return browser || platform || "Unknown device";
}

/// Never returns `endpoint` or the `p256dh`/`authKey` crypto material: those
/// are the credentials for actually pushing to that browser, and the UI only
/// needs to name a row and identify it back by id.
router.get("/subscriptions", async (req, res) => {
  const rows = await prisma.pushSubscription.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, userAgent: true, createdAt: true },
  });

  res.json(
    rows.map((r) => ({ id: r.id, device: describeDevice(r.userAgent), createdAt: r.createdAt }))
  );
});

router.delete("/subscriptions/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid subscription id" });

  // deleteMany scoped to userId rather than delete-by-id: an id belonging to
  // someone else must be a 404, never a successful delete of their row.
  const { count } = await prisma.pushSubscription.deleteMany({ where: { id, userId: req.user.id } });
  if (count === 0) return res.status(404).json({ error: "Subscription not found" });

  res.status(204).send();
});

module.exports = router;

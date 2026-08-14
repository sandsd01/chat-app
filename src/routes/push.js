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
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    update: { userId: req.user.id, p256dh: keys.p256dh, authKey: keys.auth },
    create: { userId: req.user.id, endpoint, p256dh: keys.p256dh, authKey: keys.auth },
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

module.exports = router;

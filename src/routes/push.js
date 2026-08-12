const express = require("express");
const prisma = require("../../prisma/client");
const { authenticate } = require("../middleware/auth");
const { getPublicKey } = require("../lib/push");

const router = express.Router();
router.use(authenticate);

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

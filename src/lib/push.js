const webpush = require("web-push");
const prisma = require("../../prisma/client");

let configured = false;

function ensureConfigured() {
  if (configured) return true;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(VAPID_SUBJECT || "mailto:admin@example.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

/**
 * Push `payload` (plain object, JSON-serialised) to every subscription the
 * user has registered. Best-effort: a subscription the push service reports
 * as gone (404/410 — the browser itself revoked it) is deleted; any other
 * per-subscription failure is logged and skipped rather than aborting the
 * rest. Silently a no-op if VAPID keys aren't configured (RESEND_API_KEY-style
 * optional-external-service pattern — see src/lib/email.js).
 */
async function sendPushToUser(userId, payload) {
  if (!ensureConfigured()) return { sent: 0, reason: "not_configured" };

  const subscriptions = await prisma.pushSubscription.findMany({ where: { userId } });
  if (subscriptions.length === 0) return { sent: 0, reason: "no_subscriptions" };

  const body = JSON.stringify(payload);
  let sent = 0;
  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.authKey },
          },
          body
        );
        sent += 1;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
        } else {
          console.error(`Push to subscription ${sub.id} failed:`, err.statusCode || err.message);
        }
      }
    })
  );

  return { sent };
}

function getPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

module.exports = { sendPushToUser, getPublicKey };

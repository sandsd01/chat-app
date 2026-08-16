const express = require("express");
const prisma = require("../../prisma/client");
const { authenticate } = require("../middleware/auth");
const {
  attachmentsConfigured,
  createAvatarUploadUrl,
  verifyUploadedObject,
  createDownloadUrl,
} = require("../lib/attachments");

const router = express.Router();

router.use(authenticate);

const PUBLIC_ID_PATTERN = /^[a-zA-Z0-9]{4,20}$/;

// Short on purpose: this renders inline under a display name in the friends
// list and chat header, not on a profile page of its own.
const STATUS_MESSAGE_MAX_LENGTH = 80;

// Each field this route accepts is independent: `publicId` is a one-shot
// change guarded by publicIdCustomized, while `statusMessage` is freely
// editable. So each is handled only when actually present in the body —
// patching just a status must not trip the "already set a custom ID" 409,
// which is what a single shared guard at the top of this handler would do.
router.patch("/me", async (req, res) => {
  const wantsPublicId = req.body?.publicId !== undefined;
  const wantsStatus = req.body?.statusMessage !== undefined;
  if (!wantsPublicId && !wantsStatus) {
    return res.status(400).json({ error: "Nothing to update" });
  }

  const response = {};

  if (wantsStatus) {
    const raw = req.body.statusMessage;
    if (raw !== null && typeof raw !== "string") {
      return res.status(400).json({ error: "statusMessage must be a string or null" });
    }
    const trimmed = raw === null ? "" : raw.trim();
    if (trimmed.length > STATUS_MESSAGE_MAX_LENGTH) {
      return res
        .status(400)
        .json({ error: `statusMessage must be ${STATUS_MESSAGE_MAX_LENGTH} characters or fewer` });
    }
    // Blank collapses to null so readers only ever have one "unset" state to
    // check, rather than distinguishing null from "".
    const statusMessage = trimmed || null;
    await prisma.user.update({ where: { id: req.user.id }, data: { statusMessage } });
    response.statusMessage = statusMessage;
  }

  if (wantsPublicId) {
    const raw = req.body.publicId;

    // req.user is just the JWT payload — publicIdCustomized lives in the
    // database, not the token, so it has to be read fresh here.
    const me = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (me.publicIdCustomized) {
      return res.status(409).json({ error: "You've already set a custom ID" });
    }
    if (typeof raw !== "string" || !PUBLIC_ID_PATTERN.test(raw)) {
      return res.status(400).json({ error: "publicId must be 4-20 letters or numbers" });
    }
    // Uppercased to match the alphabet randomly generated ids already use
    // (src/lib/publicId.js) — GET /friends/lookup uppercases whatever it's
    // given before querying, so a stored lowercase id would never match a
    // lookup and 404 as "No account with that ID".
    const publicId = raw.toUpperCase();

    const existing = await prisma.user.findFirst({
      where: { publicId: { equals: publicId, mode: "insensitive" } },
    });
    if (existing) {
      return res.status(409).json({ error: "That ID is already taken" });
    }

    // updateMany (not update) so the WHERE clause re-checks
    // publicIdCustomized at write time, not just in the read above — two
    // concurrent requests that both passed the read-time check would
    // otherwise both succeed, spending the "one custom ID" allowance twice
    // (last write wins).
    const { count } = await prisma.user.updateMany({
      where: { id: req.user.id, publicIdCustomized: false },
      data: { publicId, publicIdCustomized: true },
    });
    if (count === 0) {
      return res.status(409).json({ error: "You've already set a custom ID" });
    }
    response.publicId = publicId;
  }

  res.json(response);
});

// --- Avatar -----------------------------------------------------------------
// Two steps, the same shape as a message attachment: mint a presigned PUT the
// browser uploads to directly (the file never passes through this server),
// then confirm the object landed and record its key. Splitting it this way is
// what keeps the upload off the API process entirely.

router.post("/me/avatar/upload-url", async (req, res) => {
  if (!attachmentsConfigured) {
    return res.status(503).json({ error: "Image uploads are not configured" });
  }

  const { mimeType, size } = req.body || {};
  if (typeof mimeType !== "string" || !mimeType) {
    return res.status(400).json({ error: "mimeType is required" });
  }

  try {
    const result = await createAvatarUploadUrl({ userId: req.user.id, mimeType, size });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put("/me/avatar", async (req, res) => {
  if (!attachmentsConfigured) {
    return res.status(503).json({ error: "Image uploads are not configured" });
  }

  const key = typeof req.body?.key === "string" ? req.body.key : "";
  // The client hands back the key it was given, so it has to be re-checked
  // against this caller: without this, anyone could claim any object in the
  // bucket — including another user's avatar or a chat attachment — as their
  // own profile picture.
  if (!key.startsWith(`avatars/${req.user.id}/`)) {
    return res.status(400).json({ error: "That upload doesn't belong to this account" });
  }

  // Re-reads the object's real type/size off R2 rather than trusting what was
  // claimed when the URL was minted.
  let verified;
  try {
    verified = await verifyUploadedObject(key);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (verified.attachmentType !== "image") {
    return res.status(400).json({ error: "Avatar must be an image" });
  }

  await prisma.user.update({ where: { id: req.user.id }, data: { avatarKey: key } });
  res.json({ avatarUrl: await createDownloadUrl(key, "image") });
});

// Clears the pointer, deliberately not the R2 object: a presigned URL handed
// out moments ago would 404 mid-render, and orphaned avatar objects are a
// bucket-lifecycle concern rather than something to do inline on a request.
router.delete("/me/avatar", async (req, res) => {
  await prisma.user.update({ where: { id: req.user.id }, data: { avatarKey: null } });
  res.status(204).send();
});

// There is no admin role in this app (phase 1 is email+password only, one
// flat kind of account), so the only user-management action is deleting
// your own account — never someone else's.
router.delete("/me", async (req, res) => {
  const id = req.user.id;

  // Chat is FK-linked to User (Conversation.userAId/userBId, Message.senderId)
  // and, unlike an audit-log row, a DM thread has no "detach and keep going"
  // story — so refuse the delete with a clear 409 rather than letting it fail
  // on the FK constraint.
  const hasConversations = await prisma.conversation.findFirst({
    where: { OR: [{ userAId: id }, { userBId: id }] },
  });
  if (hasConversations) {
    return res.status(409).json({ error: "Cannot delete an account with chat conversations" });
  }
  const hasMessages = await prisma.message.findFirst({ where: { senderId: id } });
  if (hasMessages) {
    return res.status(409).json({ error: "Cannot delete an account with sent messages" });
  }
  // Friendship rows are the other place account deletion would otherwise
  // orphan someone else's data (their side of the relationship/request) —
  // same "refuse rather than orphan" reasoning as conversations/messages
  // above. Reachable independently of those two checks: two accounts can be
  // friends (or have a pending request) without ever having opened a chat.
  const hasFriendships = await prisma.friendship.findFirst({
    where: { OR: [{ userAId: id }, { userBId: id }] },
  });
  if (hasFriendships) {
    return res.status(409).json({ error: "Cannot delete an account with friend connections or pending requests" });
  }

  try {
    // Unlike conversations/friendships, a push subscription is this
    // account's own device registration with no other party's data in it —
    // safe to clear here rather than 409ing and making deletion depend on a
    // "manage your push subscriptions" step that doesn't otherwise exist.
    await prisma.pushSubscription.deleteMany({ where: { userId: id } });
    await prisma.user.delete({ where: { id } });
  } catch (err) {
    // The checks above are read-then-act, not transactional — a message
    // sent in the gap between them and this delete hits the FK constraint
    // here instead. Translate that into the same clean 409 rather than
    // letting it fall through to a raw 500.
    if (err.code === "P2003") {
      return res.status(409).json({ error: "Cannot delete an account with chat conversations" });
    }
    throw err;
  }
  res.status(204).send();
});

module.exports = router;

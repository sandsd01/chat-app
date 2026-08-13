const express = require("express");
const prisma = require("../../prisma/client");
const { authenticate } = require("../middleware/auth");

const router = express.Router();

router.use(authenticate);

const PUBLIC_ID_PATTERN = /^[a-zA-Z0-9]{4,20}$/;

// A user gets one shot at replacing their randomly generated publicId with a
// chosen one (see the publicIdCustomized comment on the User model) — once
// spent, this always 409s rather than letting them keep picking a new one.
router.patch("/me", async (req, res) => {
  const raw = req.body?.publicId;

  // req.user is just the JWT payload (id/email/role) — publicIdCustomized
  // lives in the database, not the token, so it has to be read fresh here.
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

  const updated = await prisma.user.update({
    where: { id: req.user.id },
    data: { publicId, publicIdCustomized: true },
  });
  res.json({ publicId: updated.publicId });
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

  await prisma.user.delete({ where: { id } });
  res.status(204).send();
});

module.exports = router;

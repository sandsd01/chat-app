const express = require("express");
const prisma = require("../../prisma/client");
const { authenticate } = require("../middleware/auth");

const router = express.Router();

router.use(authenticate);

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

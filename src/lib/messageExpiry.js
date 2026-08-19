const prisma = require("../../prisma/client");
const chatBus = require("./chatBus");

/**
 * Hard-deletes every message whose disappearing-message timer has elapsed,
 * and tells both participants so their open threads can drop the bubble.
 *
 * Hard delete, not the soft delete DELETE .../messages/:messageId performs:
 * an expiring message leaves nothing behind, not even the "This message was
 * deleted" tombstone. A reply pointing at one survives with `replyToId`
 * nulled by the foreign key's ON DELETE SET NULL, exactly as it already does
 * for a message pruned after being archived.
 *
 * This sweep owns every row with `expiresAt` set, exclusively: src/lib/drive.js
 * neither archives nor prunes them. That division is not an optimisation —
 * prune deletes by "id at or below the watermark", which is only sound while
 * everything below the watermark has actually been archived, and an expiring
 * message deliberately never is.
 */
async function expireMessages() {
  const due = await prisma.message.findMany({
    where: { expiresAt: { lte: new Date() } },
    select: { id: true, conversationId: true },
  });
  if (due.length === 0) return { deleted: 0 };

  // Fetched before the delete: afterwards there is no row to learn the
  // participants from.
  const conversations = await prisma.conversation.findMany({
    where: { id: { in: [...new Set(due.map((m) => m.conversationId))] } },
    select: { id: true, userAId: true, userBId: true },
  });
  const participantsByConversation = new Map(conversations.map((c) => [c.id, [c.userAId, c.userBId]]));

  const result = await prisma.message.deleteMany({ where: { id: { in: due.map((m) => m.id) } } });

  // Published only after the delete has actually committed, so a client that
  // reacts by refetching can't race back a row that is about to vanish.
  for (const message of due) {
    const payload = { conversationId: message.conversationId, id: message.id };
    for (const userId of participantsByConversation.get(message.conversationId) || []) {
      chatBus.publish(userId, "message-expired", payload);
    }
  }

  return { deleted: result.count };
}

module.exports = { expireMessages };

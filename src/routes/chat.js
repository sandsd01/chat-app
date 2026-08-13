const crypto = require("crypto");
const express = require("express");
const prisma = require("../../prisma/client");
const { authenticate } = require("../middleware/auth");
const chatBus = require("../lib/chatBus");
const { areFriends } = require("./friends");
const { sendPushToUser } = require("../lib/push");
const { readArchivedMessages } = require("../lib/drive");
const { attachmentsConfigured, createUploadUrl, verifyUploadedObject, createDownloadUrl } = require("../lib/attachments");

const router = express.Router();

const PUBLIC_USER_SELECT = { id: true, name: true, email: true };

// --- SSE stream tickets --------------------------------------------------
// EventSource can't set an Authorization header, so GET /stream can't go
// through the normal JWT middleware. Instead an authenticated client first
// calls POST /stream-ticket to mint a short-lived, single-use ticket, then
// opens the EventSource against /stream?ticket=... . Tickets live only in
// this process's memory (fine for a single-container deploy, same caveat as
// chatBus) and are deleted the moment they're consumed or expire.
const TICKET_TTL_MS = 30 * 1000;
const tickets = new Map(); // ticket -> { userId, expiresAt }

function issueTicket(userId) {
  const ticket = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + TICKET_TTL_MS;
  tickets.set(ticket, { userId, expiresAt });
  const timer = setTimeout(() => tickets.delete(ticket), TICKET_TTL_MS);
  timer.unref?.();
  return ticket;
}

/** Single-use: returns the associated userId and removes the ticket, or null. */
function consumeTicket(ticket) {
  const entry = tickets.get(ticket);
  if (!entry) return null;
  tickets.delete(ticket);
  if (entry.expiresAt < Date.now()) return null;
  return entry.userId;
}

// Must be registered before router.use(authenticate) below so a request for
// this exact path never hits the JWT check — it authenticates itself via the
// ticket instead.
router.get("/stream", (req, res) => {
  const ticket = typeof req.query.ticket === "string" ? req.query.ticket : "";
  const userId = ticket ? consumeTicket(ticket) : null;
  if (!userId) {
    return res.status(401).json({ error: "Invalid or expired ticket" });
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // Disables buffering on nginx-style proxies (e.g. in front of Render/etc.)
  // that would otherwise hold the stream open with nothing flushed to the client.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 25000);

  const unsubscribe = chatBus.subscribe(userId, (event, payload) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  });

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

router.use(authenticate);

// User discovery is no longer an open directory search here — GET
// /api/friends/lookup?publicId= (src/routes/friends.js) is the only way to
// find another account, and only by the exact code they shared with you.
// Browsing every registered user by name/email is a real privacy problem
// once signup is public, so that route was removed rather than kept as a
// second, looser way to find people.

router.post("/uploads", async (req, res) => {
  if (!attachmentsConfigured) {
    return res.status(503).json({ error: "File attachments are not configured" });
  }

  const conversationId = Number(req.body?.conversationId);
  const conversation = await getConversationForParticipant(conversationId, req.user.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  const otherUserId = conversation.userAId === req.user.id ? conversation.userBId : conversation.userAId;
  if (!(await areFriends(req.user.id, otherUserId))) {
    return res.status(403).json({ error: "You can only message accounts you're friends with" });
  }

  const { fileName, mimeType, size } = req.body || {};
  if (
    typeof fileName !== "string" ||
    !fileName ||
    typeof mimeType !== "string" ||
    !mimeType ||
    !Number.isInteger(size) ||
    size <= 0
  ) {
    return res.status(400).json({ error: "fileName, mimeType, and size are required" });
  }

  let result;
  try {
    result = await createUploadUrl({ conversationId, fileName, mimeType, size });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  res.json(result);
});

// --- Conversations ----------------------------------------------------------

async function getConversationForParticipant(conversationId, userId) {
  if (!Number.isInteger(conversationId)) return null;
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation) return null;
  if (conversation.userAId !== userId && conversation.userBId !== userId) return null;
  return conversation;
}

function conversationSummary(conversation, meId) {
  const isUserA = conversation.userAId === meId;
  const otherUser = isUserA ? conversation.userB : conversation.userA;
  return {
    id: conversation.id,
    otherUser,
    lastMessageAt: conversation.lastMessageAt,
    createdAt: conversation.createdAt,
  };
}

router.get("/conversations", async (req, res) => {
  const meId = req.user.id;

  const conversations = await prisma.conversation.findMany({
    where: { OR: [{ userAId: meId }, { userBId: meId }] },
    include: {
      userA: { select: PUBLIC_USER_SELECT },
      userB: { select: PUBLIC_USER_SELECT },
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  // lastMessageAt is only set once a conversation has a message; falling back
  // to createdAt keeps a brand-new, still-empty conversation from sorting as
  // if it were older than everything (it would otherwise compare as null).
  conversations.sort((a, b) => {
    const aTime = (a.lastMessageAt ?? a.createdAt).getTime();
    const bTime = (b.lastMessageAt ?? b.createdAt).getTime();
    return bTime - aTime;
  });

  const data = await Promise.all(
    conversations.map(async (c) => {
      const isUserA = c.userAId === meId;
      const myLastReadAt = isUserA ? c.userALastReadAt : c.userBLastReadAt;
      const unreadCount = await prisma.message.count({
        where: {
          conversationId: c.id,
          senderId: { not: meId },
          // A null last-read means "unread since the beginning" — every
          // message from the other participant still counts.
          ...(myLastReadAt ? { createdAt: { gt: myLastReadAt } } : {}),
        },
      });

      return {
        ...conversationSummary(c, meId),
        lastMessage: c.messages[0] || null,
        unreadCount,
      };
    })
  );

  res.json(data);
});

router.post("/conversations", async (req, res) => {
  const meId = req.user.id;
  const targetId = Number(req.body?.userId);

  if (!Number.isInteger(targetId)) {
    return res.status(400).json({ error: "userId is required" });
  }
  if (targetId === meId) {
    return res.status(400).json({ error: "Cannot start a conversation with yourself" });
  }

  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) return res.status(404).json({ error: "User not found" });

  if (!(await areFriends(meId, targetId))) {
    return res.status(403).json({ error: "You can only message accounts you're friends with" });
  }

  // Canonicalise the pair so the unique index gives us an idempotent
  // find-or-create with no separate participants table to reason about.
  const userAId = Math.min(meId, targetId);
  const userBId = Math.max(meId, targetId);

  const include = { userA: { select: PUBLIC_USER_SELECT }, userB: { select: PUBLIC_USER_SELECT } };

  const existing = await prisma.conversation.findUnique({
    where: { userAId_userBId: { userAId, userBId } },
    include,
  });
  if (existing) {
    return res.status(200).json(conversationSummary(existing, meId));
  }

  const created = await prisma.conversation.create({ data: { userAId, userBId }, include });
  res.status(201).json(conversationSummary(created, meId));
});

router.get("/conversations/:id/messages", async (req, res) => {
  const conversationId = Number(req.params.id);
  const conversation = await getConversationForParticipant(conversationId, req.user.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));

  let before;
  if (req.query.before !== undefined && req.query.before !== "") {
    before = Number(req.query.before);
    if (!Number.isInteger(before)) {
      return res.status(400).json({ error: "before must be a message id" });
    }
  }

  // Newest-first, walking backward on scroll-up: fetch one extra row so we
  // can tell whether there's more without a separate count query.
  const rows = await prisma.message.findMany({
    where: {
      conversationId,
      ...(before !== undefined ? { id: { lt: before } } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  // Presigned GET URLs are minted fresh on every read rather than stored —
  // never a permanent link, and this route already only reaches rows for a
  // conversation the caller is confirmed a participant of (see
  // getConversationForParticipant above).
  const data = await Promise.all(
    page.map(async (m) => ({
      ...m,
      attachmentUrl: m.attachmentKey ? await createDownloadUrl(m.attachmentKey) : null,
    }))
  );

  res.json({ data, hasMore, nextBefore: hasMore ? page[page.length - 1].id : null });
});

// Falls back to the CALLER's own Google Drive archive once Postgres has
// nothing older than `before` left — a message only leaves Postgres once
// every participant has archived it (src/lib/drive.js#pruneArchivedMessages),
// so a still-there message wouldn't be here anyway. Same {data, hasMore,
// nextBefore} shape as the route above on purpose, so the frontend's
// "keep scrolling up" logic doesn't need to care which source a page came
// from. Never 404s for "not connected" or "never archived this
// conversation" — those are normal, empty-page outcomes here, not errors;
// only an actual failure to reach Drive (a real network/API problem) is a
// 502.
router.get("/conversations/:id/messages/drive-history", async (req, res) => {
  const conversationId = Number(req.params.id);
  const conversation = await getConversationForParticipant(conversationId, req.user.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));

  let before;
  if (req.query.before !== undefined && req.query.before !== "") {
    before = Number(req.query.before);
    if (!Number.isInteger(before)) {
      return res.status(400).json({ error: "before must be a message id" });
    }
  }

  try {
    const result = await readArchivedMessages(req.user.id, conversationId, { before, limit });
    res.json(result);
  } catch (err) {
    console.error("Reading Drive-archived history failed:", err.message);
    res.status(502).json({ error: "Could not read archived history from Google Drive" });
  }
});

router.post("/conversations/:id/messages", async (req, res) => {
  const conversationId = Number(req.params.id);
  const conversation = await getConversationForParticipant(conversationId, req.user.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  // Re-checked at send time, not just at conversation creation: either side
  // may have unfriended (or blocked) the other since, and old messages
  // should stay readable without new ones being sendable.
  const otherUserId = conversation.userAId === req.user.id ? conversation.userBId : conversation.userAId;
  if (!(await areFriends(req.user.id, otherUserId))) {
    return res.status(403).json({ error: "You can only message accounts you're friends with" });
  }

  const rawBody = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  const attachmentKey = typeof req.body?.attachmentKey === "string" ? req.body.attachmentKey : null;
  const attachmentName = typeof req.body?.attachmentName === "string" ? req.body.attachmentName : null;

  if (!rawBody && !attachmentKey) {
    return res.status(400).json({ error: "body or attachmentKey is required" });
  }
  if (rawBody.length > 4000) {
    return res.status(400).json({ error: "body must be 4000 characters or fewer" });
  }

  let attachmentFields = {
    attachmentKey: null,
    attachmentName: null,
    attachmentMimeType: null,
    attachmentSize: null,
    attachmentType: null,
  };
  if (attachmentKey) {
    const expectedKeyPrefix = `conversations/${conversationId}/`;
    if (!attachmentKey.startsWith(expectedKeyPrefix)) {
      return res.status(400).json({ error: "Attachment doesn't belong to this conversation" });
    }

    let verified;
    try {
      verified = await verifyUploadedObject(attachmentKey);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    attachmentFields = {
      attachmentKey,
      attachmentName: attachmentName || attachmentKey.split("/").pop(),
      attachmentMimeType: verified.mimeType,
      attachmentSize: verified.size,
      attachmentType: verified.attachmentType,
    };
  }

  const body = rawBody || null;

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: { conversationId, senderId: req.user.id, body, ...attachmentFields },
    });
    await tx.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: created.createdAt },
    });
    return created;
  });

  const payload = {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    body: message.body,
    createdAt: message.createdAt,
    attachmentKey: message.attachmentKey,
    attachmentName: message.attachmentName,
    attachmentMimeType: message.attachmentMimeType,
    attachmentSize: message.attachmentSize,
    attachmentType: message.attachmentType,
  };

  const attachmentUrl = payload.attachmentKey ? await createDownloadUrl(payload.attachmentKey) : null;
  const ssePayload = { ...payload, attachmentUrl };

  // Deliberately not logged via src/lib/audit.js — message content doesn't
  // belong in an audit trail.
  chatBus.publish(conversation.userAId, "message", ssePayload);
  chatBus.publish(conversation.userBId, "message", ssePayload);

  // Push is the fallback for "not connected," not a duplicate of the SSE
  // event — skip it entirely when the recipient already has a live stream
  // open, both to avoid a redundant OS notification and to avoid the extra
  // sender-name lookup on the (much more common) both-online path. Fired
  // without awaiting: a slow or failing push must never delay the response
  // the sender is waiting on.
  if (!chatBus.hasSubscribers(otherUserId)) {
    prisma.user
      .findUnique({ where: { id: req.user.id }, select: { name: true, email: true } })
      .then((sender) => {
        const pushBody = message.body
          ? message.body.length > 120
            ? `${message.body.slice(0, 117)}…`
            : message.body
          : message.attachmentType === "image"
            ? "Sent a photo"
            : `Sent a file: ${message.attachmentName}`;
        return sendPushToUser(otherUserId, {
          title: sender?.name || sender?.email || "New message",
          body: pushBody,
          conversationId,
        });
      })
      .catch((err) => console.error("Push notification failed:", err));
  }

  res.status(201).json(ssePayload);
});

async function getOwnMessage(conversationId, messageId, userId) {
  if (!Number.isInteger(messageId)) return { status: 404 };
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message || message.conversationId !== conversationId || message.deletedAt) {
    return { status: 404 };
  }
  if (message.senderId !== userId) return { status: 403 };
  return { message };
}

router.patch("/conversations/:id/messages/:messageId", async (req, res) => {
  const conversationId = Number(req.params.id);
  const conversation = await getConversationForParticipant(conversationId, req.user.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  const lookup = await getOwnMessage(conversationId, Number(req.params.messageId), req.user.id);
  if (lookup.status === 404) return res.status(404).json({ error: "Message not found" });
  if (lookup.status === 403) return res.status(403).json({ error: "You can only edit your own messages" });

  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!body) return res.status(400).json({ error: "body is required" });
  if (body.length > 4000) return res.status(400).json({ error: "body must be 4000 characters or fewer" });

  const updated = await prisma.message.update({
    where: { id: lookup.message.id },
    data: { body, editedAt: new Date() },
  });

  const payload = { id: updated.id, conversationId, body: updated.body, editedAt: updated.editedAt };
  chatBus.publish(conversation.userAId, "message-edited", payload);
  chatBus.publish(conversation.userBId, "message-edited", payload);

  res.json(payload);
});

router.delete("/conversations/:id/messages/:messageId", async (req, res) => {
  const conversationId = Number(req.params.id);
  const conversation = await getConversationForParticipant(conversationId, req.user.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  const lookup = await getOwnMessage(conversationId, Number(req.params.messageId), req.user.id);
  if (lookup.status === 404) return res.status(404).json({ error: "Message not found" });
  if (lookup.status === 403) return res.status(403).json({ error: "You can only delete your own messages" });

  // Content is cleared, not just flagged: a deleted message shouldn't keep
  // its body/attachment sitting in the row indefinitely just because the
  // row itself stays around for conversationId/senderId/ordering.
  const updated = await prisma.message.update({
    where: { id: lookup.message.id },
    data: {
      deletedAt: new Date(),
      body: null,
      attachmentKey: null,
      attachmentName: null,
      attachmentMimeType: null,
      attachmentSize: null,
      attachmentType: null,
    },
  });

  const payload = { id: updated.id, conversationId, deletedAt: updated.deletedAt };
  chatBus.publish(conversation.userAId, "message-deleted", payload);
  chatBus.publish(conversation.userBId, "message-deleted", payload);

  res.json(payload);
});

// Transient, non-persisted presence signal: no DB write, just a chatBus
// event to the other participant. The frontend fires this throttled while
// the composer has focus and clears its own "is typing" indicator on a
// short client-side timeout if no further event arrives, so there's no
// matching "stopped typing" event to publish here.
router.post("/conversations/:id/typing", async (req, res) => {
  const conversationId = Number(req.params.id);
  const conversation = await getConversationForParticipant(conversationId, req.user.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  const otherUserId = conversation.userAId === req.user.id ? conversation.userBId : conversation.userAId;
  chatBus.publish(otherUserId, "typing", { conversationId, userId: req.user.id });

  res.status(204).end();
});

router.post("/conversations/:id/read", async (req, res) => {
  const conversationId = Number(req.params.id);
  const conversation = await getConversationForParticipant(conversationId, req.user.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  const isUserA = conversation.userAId === req.user.id;
  const now = new Date();
  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: isUserA ? { userALastReadAt: now } : { userBLastReadAt: now },
  });

  res.json({
    conversationId: updated.id,
    lastReadAt: isUserA ? updated.userALastReadAt : updated.userBLastReadAt,
  });
});

router.post("/stream-ticket", (req, res) => {
  const ticket = issueTicket(req.user.id);
  res.json({ ticket });
});

module.exports = router;

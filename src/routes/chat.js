const express = require("express");
const prisma = require("../../prisma/client");
const { authenticate } = require("../middleware/auth");
const chatBus = require("../lib/chatBus");
const { areFriends } = require("./friends");
const { sendPushToUser } = require("../lib/push");
const { attachmentsConfigured, createUploadUrl, verifyUploadedObject, createDownloadUrl } = require("../lib/attachments");
const { createTicketStore } = require("../lib/ticketStore");
const { PUBLIC_USER_SELECT, toPublicUser } = require("../lib/publicUser");
const { extractFirstUrl, resolveLinkPreview, withUserFetchSlot } = require("../lib/linkPreview");

const router = express.Router();


// --- SSE stream tickets --------------------------------------------------
// EventSource can't set an Authorization header, so GET /stream can't go
// through the normal JWT middleware. Instead an authenticated client first
// calls POST /stream-ticket to mint a short-lived, single-use ticket, then
// opens the EventSource against /stream?ticket=... . Tickets live only in
// this process's memory (fine for a single-container deploy, same caveat as
// chatBus) and are deleted the moment they're consumed or expire.
const TICKET_TTL_MS = 30 * 1000;
const tickets = createTicketStore(TICKET_TTL_MS);

// Must be registered before router.use(authenticate) below so a request for
// this exact path never hits the JWT check — it authenticates itself via the
// ticket instead.
router.get("/stream", (req, res) => {
  const ticket = typeof req.query.ticket === "string" ? req.query.ticket : "";
  const userId = ticket ? tickets.consume(ticket) : null;
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

  const otherUserId = otherParticipantId(conversation, req.user.id);
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

function otherParticipantId(conversation, meId) {
  return conversation.userAId === meId ? conversation.userBId : conversation.userAId;
}

/** Every conversation-scoped SSE event goes to both participants; this is that fan-out in one place. */
function publishToBoth(conversation, event, payload) {
  chatBus.publish(conversation.userAId, event, payload);
  chatBus.publish(conversation.userBId, event, payload);
}

// Shared by every `before`-cursor route below. Returns null if `before` is
// present but not a valid message id, which callers turn into a 400.
function parsePagingParams(req) {
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  if (req.query.before === undefined || req.query.before === "") {
    return { limit, before: undefined };
  }
  const before = Number(req.query.before);
  if (!Number.isInteger(before)) return null;
  return { limit, before };
}

// The caller's own side of a pin — never the other participant's, since it's
// a private per-user preference the other side never sees.
function myPinnedAt(conversation, meId) {
  return conversation.userAId === meId ? conversation.userAPinnedAt : conversation.userBPinnedAt;
}

async function conversationSummary(conversation, meId) {
  const isUserA = conversation.userAId === meId;
  const other = isUserA ? conversation.userB : conversation.userA;
  return {
    id: conversation.id,
    // Same point-in-time presence read as GET /friends — see the comment
    // there for why this isn't its own live event.
    otherUser: { ...(await toPublicUser(other)), isOnline: chatBus.hasSubscribers(other.id) },
    lastMessageAt: conversation.lastMessageAt,
    createdAt: conversation.createdAt,
    // The other participant's own last-read timestamp (not the caller's) —
    // lets the thread UI show a "Read" tick on the caller's own last
    // message once it's at or before this. No new column: this is exactly
    // the field POST .../read already writes for whichever side isn't `me`.
    otherLastReadAt: isUserA ? conversation.userBLastReadAt : conversation.userALastReadAt,
    // The CALLER's own mute state — every consumer of this summary is
    // reading it as "do I have this muted," never the other side's.
    muted: isUserA ? conversation.userAMuted : conversation.userBMuted,
    pinned: Boolean(myPinnedAt(conversation, meId)),
    // Not per-side, unlike pinned/muted above: both participants share one
    // timer and both see the same value.
    disappearingSeconds: conversation.disappearingSeconds,
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

  // Pinned conversations sort first (most-recently-pinned first), then
  // everything else by recency. lastMessageAt is only set once a
  // conversation has a message; falling back to createdAt keeps a
  // brand-new, still-empty conversation from sorting as if it were older
  // than everything (it would otherwise compare as null).
  conversations.sort((a, b) => {
    const aPinnedAt = myPinnedAt(a, meId);
    const bPinnedAt = myPinnedAt(b, meId);
    if (aPinnedAt && bPinnedAt) return bPinnedAt.getTime() - aPinnedAt.getTime();
    if (aPinnedAt) return -1;
    if (bPinnedAt) return 1;
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
        ...(await conversationSummary(c, meId)),
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
    return res.status(200).json(await conversationSummary(existing, meId));
  }

  const created = await prisma.conversation.create({ data: { userAId, userBId }, include });
  res.status(201).json(await conversationSummary(created, meId));
});

router.get("/conversations/:id/messages", async (req, res) => {
  const conversationId = Number(req.params.id);
  const conversation = await getConversationForParticipant(conversationId, req.user.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  const paging = parsePagingParams(req);
  if (!paging) return res.status(400).json({ error: "before must be a message id" });
  const { limit, before } = paging;

  // Newest-first, walking backward on scroll-up: fetch one extra row so we
  // can tell whether there's more without a separate count query.
  const rows = await prisma.message.findMany({
    where: {
      conversationId,
      ...(before !== undefined ? { id: { lt: before } } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: { linkPreview: true },
  });

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  const reactionsByMessage = await reactionsForMessages(page.map((m) => m.id), req.user.id);
  const replyPreviews = await replyPreviewsForMessages(page);

  // Presigned GET URLs are minted fresh on every read rather than stored —
  // never a permanent link, and this route already only reaches rows for a
  // conversation the caller is confirmed a participant of (see
  // getConversationForParticipant above).
  // The joined `linkPreview` relation is destructured out rather than spread:
  // it carries the raw image bytes, which belong on the image route below and
  // nowhere near a JSON message list.
  const data = await Promise.all(
    page.map(async ({ linkPreview, ...m }) => ({
      ...m,
      attachmentUrl: m.attachmentKey ? await createDownloadUrl(m.attachmentKey, m.attachmentType) : null,
      reactions: reactionsByMessage.get(m.id) || [],
      replyTo: m.replyToId ? replyPreviews.get(m.replyToId) || null : null,
      linkPreview: linkPreviewPayload(linkPreview),
    }))
  );

  res.json({ data, hasMore, nextBefore: hasMore ? page[page.length - 1].id : null });
});

// Same cursor/shape convention as the route above, scoped down to messages
// whose body matches `q`. A plain case-insensitive `contains` rather than a
// Postgres full-text index/tsvector column — this app has no evidence yet
// that per-conversation message volume needs anything beyond a substring
// scan, and a tsvector column is real schema surface to add speculatively.
// `contains` on a null `body` never matches, so soft-deleted (body cleared)
// and attachment-only messages are excluded from results with no extra
// filter needed.
router.get("/conversations/:id/messages/search", async (req, res) => {
  const conversationId = Number(req.params.id);
  const conversation = await getConversationForParticipant(conversationId, req.user.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) return res.status(400).json({ error: "q is required" });
  if (q.length > 200) return res.status(400).json({ error: "q must be 200 characters or fewer" });

  const paging = parsePagingParams(req);
  if (!paging) return res.status(400).json({ error: "before must be a message id" });
  const { limit, before } = paging;

  const rows = await prisma.message.findMany({
    where: {
      conversationId,
      body: { contains: q, mode: "insensitive" },
      ...(before !== undefined ? { id: { lt: before } } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const replyPreviews = await replyPreviewsForMessages(page);

  const data = await Promise.all(
    page.map(async (m) => ({
      ...m,
      attachmentUrl: m.attachmentKey ? await createDownloadUrl(m.attachmentKey, m.attachmentType) : null,
      replyTo: m.replyToId ? replyPreviews.get(m.replyToId) || null : null,
    }))
  );

  res.json({ data, hasMore, nextBefore: hasMore ? page[page.length - 1].id : null });
});

const EXPORT_PAGE_SIZE = 100;

/**
 * Every message in a conversation, walking the same before-cursor
 * pagination GET .../messages uses. Normalizes rows into one flat,
 * portable shape (no presigned attachment URLs — this is a point-in-time
 * export, not a live view) and returns oldest-first, like a transcript.
 */
async function collectAllMessagesForExport(conversationId) {
  const rows = [];
  let before;

  for (;;) {
    const page = await prisma.message.findMany({
      where: { conversationId, ...(before !== undefined ? { id: { lt: before } } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: EXPORT_PAGE_SIZE,
    });
    if (page.length === 0) break;
    for (const m of page) {
      rows.push({
        id: m.id,
        senderId: m.senderId,
        body: m.body,
        createdAt: m.createdAt,
        editedAt: m.editedAt,
        deletedAt: m.deletedAt,
        hasAttachment: Boolean(m.attachmentKey),
        attachmentName: m.attachmentName,
      });
    }
    before = page[page.length - 1].id;
    if (page.length < EXPORT_PAGE_SIZE) break;
  }

  return rows.reverse();
}

router.get("/conversations/:id/export", async (req, res) => {
  const conversationId = Number(req.params.id);
  const conversation = await getConversationForParticipant(conversationId, req.user.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  const messages = await collectAllMessagesForExport(conversationId);

  res.setHeader("Content-Disposition", `attachment; filename="conversation-${conversationId}.json"`);
  res.json({ conversationId, exportedAt: new Date(), messages });
});

router.post("/conversations/:id/messages", async (req, res) => {
  const conversationId = Number(req.params.id);
  const conversation = await getConversationForParticipant(conversationId, req.user.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  // Re-checked at send time, not just at conversation creation: either side
  // may have unfriended (or blocked) the other since, and old messages
  // should stay readable without new ones being sendable.
  const otherUserId = otherParticipantId(conversation, req.user.id);
  if (!(await areFriends(req.user.id, otherUserId))) {
    return res.status(403).json({ error: "You can only message accounts you're friends with" });
  }

  // Captured once, before the message is even created, and reused below for
  // both the "delivered" flag and the push-skip check — the recipient could
  // in principle connect or disconnect in the gap between two separate
  // hasSubscribers() calls, and the two would then disagree about whether
  // the same message SSE-delivered at send time.
  const deliveredAtSend = chatBus.hasSubscribers(otherUserId);

  const rawBody = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  const attachmentKey = typeof req.body?.attachmentKey === "string" ? req.body.attachmentKey : null;
  const attachmentName = typeof req.body?.attachmentName === "string" ? req.body.attachmentName : null;

  if (!rawBody && !attachmentKey) {
    return res.status(400).json({ error: "body or attachmentKey is required" });
  }
  if (rawBody.length > 4000) {
    return res.status(400).json({ error: "body must be 4000 characters or fewer" });
  }

  // getMessageInConversation already excludes a soft-deleted message
  // (deletedAt set) — you can't start a new reply quoting one that's
  // already gone, the same way the UI would never offer a reply action on
  // a bubble already showing "This message was deleted."
  const replyToIdRaw = req.body?.replyToId;
  let replyTarget = null;
  if (replyToIdRaw !== undefined && replyToIdRaw !== null) {
    replyTarget = await getMessageInConversation(conversationId, Number(replyToIdRaw));
    if (!replyTarget) {
      return res.status(400).json({ error: "replyToId must reference a message in this conversation" });
    }
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

  // Read once, here, and frozen onto the row as an absolute instant. Nothing
  // later re-reads conversation.disappearingSeconds for this message, which
  // is exactly why changing the timer can't retroact on messages already
  // sent — the sender knew this message's lifetime when they sent it.
  const expiresAt = conversation.disappearingSeconds
    ? new Date(Date.now() + conversation.disappearingSeconds * 1000)
    : null;

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        conversationId,
        senderId: req.user.id,
        body,
        replyToId: replyTarget?.id ?? null,
        expiresAt,
        ...attachmentFields,
      },
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
    expiresAt: message.expiresAt,
    attachmentKey: message.attachmentKey,
    attachmentName: message.attachmentName,
    attachmentMimeType: message.attachmentMimeType,
    attachmentSize: message.attachmentSize,
    attachmentType: message.attachmentType,
    // True only if the recipient's device had a live SSE connection open at
    // the moment this was sent — it does not upgrade later if they connect
    // afterwards but before reading, unlike a real delivery receipt. That's
    // an intentional scope cut: upgrading it would need a second signal
    // path (e.g. published on every new /stream connection), and the
    // sender already gets the strictly-stronger "Read" tick once they do
    // read it.
    delivered: deliveredAtSend,
    // A small snapshot, not a live reference — reusing the exact row
    // getMessageInConversation already fetched to validate replyToId above,
    // rather than a second query. If the original is edited or deleted
    // after this reply is sent, this quoted snippet doesn't follow along;
    // GET .../messages re-fetches it fresh on every page load instead (see
    // replyPreviewsForMessages below), so a reload always shows the
    // original's current state even though this specific SSE/response
    // payload is frozen at send time.
    replyTo: replyTarget
      ? { id: replyTarget.id, senderId: replyTarget.senderId, body: replyTarget.body, deletedAt: replyTarget.deletedAt }
      : null,
  };

  const attachmentUrl = payload.attachmentKey
    ? await createDownloadUrl(payload.attachmentKey, payload.attachmentType)
    : null;
  const ssePayload = { ...payload, attachmentUrl };

  // Deliberately not logged via src/lib/audit.js — message content doesn't
  // belong in an audit trail.
  publishToBoth(conversation, "message", ssePayload);

  // Push is the fallback for "not connected," not a duplicate of the SSE
  // event — skip it entirely when the recipient already has a live stream
  // open, both to avoid a redundant OS notification and to avoid the extra
  // sender-name lookup on the (much more common) both-online path. Fired
  // without awaiting: a slow or failing push must never delay the response
  // the sender is waiting on.
  const otherMuted = otherUserId === conversation.userAId ? conversation.userAMuted : conversation.userBMuted;
  if (!deliveredAtSend && !otherMuted) {
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

  schedulePreviewResolution(message, conversation);

  res.status(201).json(ssePayload);
});

// --- Link previews -------------------------------------------------------

/**
 * The wire shape of a preview. `imageData` deliberately never crosses the
 * API — the bytes are served by the conversation-scoped image route below, so
 * a message list stays small and the browser keeps talking only to us.
 * A "failed" row renders as no card at all.
 */
function linkPreviewPayload(preview) {
  if (!preview || preview.status !== "ok") return null;
  return {
    id: preview.id,
    url: preview.url,
    title: preview.title,
    description: preview.description,
    siteName: preview.siteName,
    hasImage: Boolean(preview.imageMimeType),
  };
}

/**
 * Resolves a message's link preview out of band and announces it.
 *
 * Fire-and-forget, exactly like the push call in POST .../messages and for
 * the same reason: an unresponsive third-party server must never hold up the
 * response the sender is waiting on. A failure here is logged and dropped —
 * the message itself is already sent and is not in question.
 */
function schedulePreviewResolution(message, conversation) {
  const url = extractFirstUrl(message.body);
  if (!url) return;

  withUserFetchSlot(message.senderId, () => resolveLinkPreview(url))
    .then(async (preview) => {
      // null means the sender is already at their concurrent-fetch cap; the
      // message stands, it just doesn't get a card.
      if (!preview?.id) return;

      const current = await prisma.message.findUnique({ where: { id: message.id } });
      // The message may have been edited or deleted while we were off
      // fetching; attaching a preview now would resurrect a card for content
      // that no longer exists.
      if (!current || current.deletedAt || current.body !== message.body) return;

      await prisma.message.update({ where: { id: message.id }, data: { linkPreviewId: preview.id } });
      const payload = {
        conversationId: conversation.id,
        messageId: message.id,
        linkPreview: linkPreviewPayload(preview),
      };
      chatBus.publish(conversation.userAId, "link-preview", payload);
      chatBus.publish(conversation.userBId, "link-preview", payload);
    })
    .catch((err) => console.error("Link preview resolution failed:", err.message));
}

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

  // Editing a URL out of a message must not leave its card behind, and
  // editing a different one in should unfurl the new one.
  const previousUrl = extractFirstUrl(lookup.message.body);
  const nextUrl = extractFirstUrl(body);
  if (previousUrl !== nextUrl) {
    await prisma.message.update({ where: { id: updated.id }, data: { linkPreviewId: null } });
    schedulePreviewResolution(updated, conversation);
  }

  const payload = { id: updated.id, conversationId, body: updated.body, editedAt: updated.editedAt };
  publishToBoth(conversation, "message-edited", payload);

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
      linkPreviewId: null,
    },
  });

  const payload = { id: updated.id, conversationId, deletedAt: updated.deletedAt };
  publishToBoth(conversation, "message-deleted", payload);

  res.json(payload);
});

/**
 * Batched lookup of the small quoted-snippet shape for every replyToId on a
 * page — one query for the whole page rather than one per reply. Re-fetched
 * fresh on every call (not cached anywhere), so unlike the send-time
 * payload's frozen replyTo, a reload always reflects the original's
 * current edited/deleted state.
 */
async function replyPreviewsForMessages(messages) {
  const result = new Map();
  const ids = [...new Set(messages.map((m) => m.replyToId).filter((id) => id != null))];
  if (ids.length === 0) return result;

  const rows = await prisma.message.findMany({
    where: { id: { in: ids } },
    select: { id: true, senderId: true, body: true, deletedAt: true },
  });
  for (const row of rows) result.set(row.id, row);
  return result;
}

// --- Reactions ----------------------------------------------------------
// One row per (message, user, emoji) — see prisma/schema.prisma's
// MessageReaction model for why that triple is the unique key. Either
// participant can react to either side's message, unlike edit/delete which
// are sender-only.

const REACTION_EMOJI_MAX_LENGTH = 8;

/** Rolls MessageReaction rows up into the {emoji, count, mine} summary GET .../messages embeds per message. */
async function reactionsForMessages(messageIds, meId) {
  const result = new Map();
  if (messageIds.length === 0) return result;

  const rows = await prisma.messageReaction.findMany({ where: { messageId: { in: messageIds } } });

  const byMessage = new Map();
  for (const row of rows) {
    if (!byMessage.has(row.messageId)) byMessage.set(row.messageId, new Map());
    const byEmoji = byMessage.get(row.messageId);
    const entry = byEmoji.get(row.emoji) || { emoji: row.emoji, count: 0, mine: false };
    entry.count += 1;
    if (row.userId === meId) entry.mine = true;
    byEmoji.set(row.emoji, entry);
  }
  for (const [messageId, byEmoji] of byMessage) {
    result.set(messageId, [...byEmoji.values()]);
  }
  return result;
}

/** Same "does this message belong to this conversation" check edit/delete use, minus the sender-only restriction. */
async function getMessageInConversation(conversationId, messageId) {
  if (!Number.isInteger(messageId)) return null;
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message || message.conversationId !== conversationId || message.deletedAt) return null;
  return message;
}

// Conversation-scoped rather than a flat /link-previews/:id/image, so it
// inherits getConversationForParticipant and this app's 404-not-403
// convention — and so nobody can walk a sequential id space to learn which
// URLs have been shared on this instance.
router.get("/conversations/:id/messages/:messageId/link-preview-image", async (req, res) => {
  const conversationId = Number(req.params.id);
  const conversation = await getConversationForParticipant(conversationId, req.user.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  const message = await getMessageInConversation(conversationId, Number(req.params.messageId));
  if (!message?.linkPreviewId) return res.status(404).json({ error: "Not found" });

  const preview = await prisma.linkPreview.findUnique({ where: { id: message.linkPreviewId } });
  if (!preview?.imageData || !preview.imageMimeType) return res.status(404).json({ error: "Not found" });

  res.setHeader("Content-Type", preview.imageMimeType);
  // Immutable: a preview is never refetched, so the bytes behind this URL
  // cannot change.
  res.setHeader("Cache-Control", "private, max-age=86400, immutable");
  res.send(Buffer.from(preview.imageData));
});

router.post("/conversations/:id/messages/:messageId/reactions", async (req, res) => {
  const conversationId = Number(req.params.id);
  const conversation = await getConversationForParticipant(conversationId, req.user.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  const message = await getMessageInConversation(conversationId, Number(req.params.messageId));
  if (!message) return res.status(404).json({ error: "Message not found" });

  const emoji = typeof req.body?.emoji === "string" ? req.body.emoji.trim() : "";
  if (!emoji || emoji.length > REACTION_EMOJI_MAX_LENGTH) {
    return res
      .status(400)
      .json({ error: `emoji is required and must be ${REACTION_EMOJI_MAX_LENGTH} characters or fewer` });
  }

  // Idempotent add: reacting again with the same emoji is a no-op (200, no
  // re-publish) rather than a duplicate row or a second event.
  const existing = await prisma.messageReaction.findUnique({
    where: { messageId_userId_emoji: { messageId: message.id, userId: req.user.id, emoji } },
  });
  const payload = { conversationId, messageId: message.id, emoji, userId: req.user.id };
  if (existing) {
    return res.status(200).json(payload);
  }

  try {
    await prisma.messageReaction.create({ data: { messageId: message.id, userId: req.user.id, emoji } });
  } catch (err) {
    // Two near-simultaneous adds (a double-tap) can both pass the findUnique
    // check above and race here — P2002 is that race, not a real conflict,
    // so it gets the same idempotent 200 the pre-check above returns.
    if (err.code === "P2002") return res.status(200).json(payload);
    throw err;
  }

  publishToBoth(conversation, "reaction-added", payload);

  res.status(201).json(payload);
});

router.delete("/conversations/:id/messages/:messageId/reactions/:emoji", async (req, res) => {
  const conversationId = Number(req.params.id);
  const conversation = await getConversationForParticipant(conversationId, req.user.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  const message = await getMessageInConversation(conversationId, Number(req.params.messageId));
  if (!message) return res.status(404).json({ error: "Message not found" });

  const emoji = req.params.emoji;

  try {
    await prisma.messageReaction.delete({
      where: { messageId_userId_emoji: { messageId: message.id, userId: req.user.id, emoji } },
    });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Reaction not found" });
    throw err;
  }

  const payload = { conversationId, messageId: message.id, emoji, userId: req.user.id };
  publishToBoth(conversation, "reaction-removed", payload);

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

  const otherUserId = otherParticipantId(conversation, req.user.id);
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

  const lastReadAt = isUserA ? updated.userALastReadAt : updated.userBLastReadAt;
  const otherUserId = isUserA ? updated.userBId : updated.userAId;
  chatBus.publish(otherUserId, "read", { conversationId: updated.id, readerId: req.user.id, lastReadAt });

  res.json({ conversationId: updated.id, lastReadAt });
});

// Pin is a purely private, per-user preference — unlike read receipts and
// typing, the other participant is never told about it, so there's no
// chatBus.publish here.
router.post("/conversations/:id/pin", async (req, res) => {
  const conversationId = Number(req.params.id);
  const conversation = await getConversationForParticipant(conversationId, req.user.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  const isUserA = conversation.userAId === req.user.id;
  await prisma.conversation.update({
    where: { id: conversationId },
    data: isUserA ? { userAPinnedAt: new Date() } : { userBPinnedAt: new Date() },
  });
  res.status(204).end();
});

router.delete("/conversations/:id/pin", async (req, res) => {
  const conversationId = Number(req.params.id);
  const conversation = await getConversationForParticipant(conversationId, req.user.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  const isUserA = conversation.userAId === req.user.id;
  await prisma.conversation.update({
    where: { id: conversationId },
    data: isUserA ? { userAPinnedAt: null } : { userBPinnedAt: null },
  });
  res.status(204).end();
});

// Muting only suppresses the push notification a new message would
// otherwise trigger (see the push-gating in POST .../messages below) — it
// never touches the SSE "message" event, so an open tab keeps updating
// live either way. Purely the caller's own setting: nothing published to
// the other participant, unlike /read.
async function setMuted(conversationId, userId, muted) {
  const conversation = await getConversationForParticipant(conversationId, userId);
  if (!conversation) return null;
  const isUserA = conversation.userAId === userId;
  return prisma.conversation.update({
    where: { id: conversationId },
    data: isUserA ? { userAMuted: muted } : { userBMuted: muted },
  });
}

router.post("/conversations/:id/mute", async (req, res) => {
  const updated = await setMuted(Number(req.params.id), req.user.id, true);
  if (!updated) return res.status(404).json({ error: "Conversation not found" });
  res.json({ conversationId: updated.id, muted: true });
});

router.post("/conversations/:id/unmute", async (req, res) => {
  const updated = await setMuted(Number(req.params.id), req.user.id, false);
  if (!updated) return res.status(404).json({ error: "Conversation not found" });
  res.json({ conversationId: updated.id, muted: false });
});

// Validated against a fixed set rather than any positive integer, so the
// durations the UI offers and the ones the server will accept can't drift
// apart. Unlike mute (which is per-side and silent), this is state both
// participants share and see, so the change is published to both.
const DISAPPEARING_SECONDS = new Set([300, 3600, 86400, 604800]);

router.post("/conversations/:id/disappearing", async (req, res) => {
  const conversationId = Number(req.params.id);
  const conversation = await getConversationForParticipant(conversationId, req.user.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  const raw = req.body?.seconds;
  // null and 0 both mean "off" — 0 because a client computing a duration is
  // likelier to land on it than on null.
  const seconds = raw === null || raw === undefined || raw === 0 ? null : raw;
  if (seconds !== null && !DISAPPEARING_SECONDS.has(seconds)) {
    return res.status(400).json({
      error: `seconds must be null or one of ${[...DISAPPEARING_SECONDS].join(", ")}`,
    });
  }

  await prisma.conversation.update({ where: { id: conversationId }, data: { disappearingSeconds: seconds } });

  const payload = { conversationId, seconds };
  chatBus.publish(conversation.userAId, "disappearing-changed", payload);
  chatBus.publish(conversation.userBId, "disappearing-changed", payload);

  res.json(payload);
});

router.post("/stream-ticket", (req, res) => {
  const ticket = tickets.issue(req.user.id);
  res.json({ ticket });
});

module.exports = router;

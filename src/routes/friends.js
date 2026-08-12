const express = require("express");
const prisma = require("../../prisma/client");
const { authenticate } = require("../middleware/auth");
const { sendPushToUser } = require("../lib/push");
const chatBus = require("../lib/chatBus");

const router = express.Router();
router.use(authenticate);

// Push notifications here are unconditional (not gated on
// chatBus.hasSubscribers like chat messages are), because that would only
// tell us the recipient has a *chat* stream open, not that they've seen the
// request — there's no equivalent "already saw it live" signal to check
// against for push specifically.
async function notify(userId, title, body) {
  sendPushToUser(userId, { title, body }).catch((err) => console.error("Push notification failed:", err));
}

// Reuses chat's SSE stream/bus rather than a separate one: GET /api/chat/stream
// already forwards any event name chatBus.publish sends for a given userId,
// so FriendsContext just needs to add a listener for "friend" events on the
// connection ChatContext already holds open (see
// web/src/context/ChatContext.jsx#subscribeToFriendEvents) instead of a
// second SSE connection/ticket system. The payload only carries `type` —
// deliberately no request/friend details — because every consumer of this
// event just triggers a full refetch (FriendsContext#refresh) rather than
// trying to patch its own state from a partial live payload.
function publishFriendEvent(userId, type) {
  chatBus.publish(userId, "friend", { type });
}

const PUBLIC_USER_SELECT = { id: true, publicId: true, name: true, email: true };

function pair(a, b) {
  return { userAId: Math.min(a, b), userBId: Math.max(a, b) };
}

function otherUserOf(friendship, meId) {
  return friendship.userAId === meId ? friendship.userB : friendship.userA;
}

/** Exported for chat.js — true only for an `accepted` row between the two ids. */
async function areFriends(userId1, userId2) {
  const { userAId, userBId } = pair(userId1, userId2);
  const row = await prisma.friendship.findUnique({ where: { userAId_userBId: { userAId, userBId } } });
  return row?.status === "accepted";
}

// --- Look up someone by the code they shared with you -----------------------

router.get("/lookup", async (req, res) => {
  const publicId = typeof req.query.publicId === "string" ? req.query.publicId.trim().toUpperCase() : "";
  if (!publicId) return res.status(400).json({ error: "publicId is required" });

  const target = await prisma.user.findUnique({ where: { publicId }, select: PUBLIC_USER_SELECT });
  if (!target) return res.status(404).json({ error: "No account with that ID" });
  if (target.id === req.user.id) return res.status(400).json({ error: "That's your own ID" });

  const { userAId, userBId } = pair(req.user.id, target.id);
  const existing = await prisma.friendship.findUnique({ where: { userAId_userBId: { userAId, userBId } } });

  let relationship = "none";
  if (existing) {
    if (existing.status === "accepted") relationship = "friends";
    else if (existing.status === "blocked") relationship = "blocked";
    else if (existing.status === "pending") {
      relationship = existing.requestedById === req.user.id ? "requestSent" : "requestReceived";
    }
  }

  res.json({ ...target, relationship });
});

// --- Friends list -----------------------------------------------------------

router.get("/", async (req, res) => {
  const meId = req.user.id;
  const rows = await prisma.friendship.findMany({
    where: { status: "accepted", OR: [{ userAId: meId }, { userBId: meId }] },
    include: { userA: { select: PUBLIC_USER_SELECT }, userB: { select: PUBLIC_USER_SELECT } },
    orderBy: { respondedAt: "desc" },
  });

  res.json(rows.map((r) => ({ friendshipId: r.id, otherUser: otherUserOf(r, meId), since: r.respondedAt })));
});

// --- Requests -----------------------------------------------------------------

router.get("/requests", async (req, res) => {
  const meId = req.user.id;
  const rows = await prisma.friendship.findMany({
    where: { status: "pending", OR: [{ userAId: meId }, { userBId: meId }] },
    include: { userA: { select: PUBLIC_USER_SELECT }, userB: { select: PUBLIC_USER_SELECT } },
    orderBy: { createdAt: "desc" },
  });

  const incoming = [];
  const outgoing = [];
  for (const r of rows) {
    const entry = { requestId: r.id, otherUser: otherUserOf(r, meId), createdAt: r.createdAt };
    (r.requestedById === meId ? outgoing : incoming).push(entry);
  }

  res.json({ incoming, outgoing });
});

router.post("/requests", async (req, res) => {
  const meId = req.user.id;
  const publicId = typeof req.body?.publicId === "string" ? req.body.publicId.trim().toUpperCase() : "";
  if (!publicId) return res.status(400).json({ error: "publicId is required" });

  const target = await prisma.user.findUnique({ where: { publicId } });
  if (!target) return res.status(404).json({ error: "No account with that ID" });
  if (target.id === meId) return res.status(400).json({ error: "You can't add yourself" });

  const { userAId, userBId } = pair(meId, target.id);
  const existing = await prisma.friendship.findUnique({ where: { userAId_userBId: { userAId, userBId } } });

  if (!existing) {
    const created = await prisma.friendship.create({
      data: { userAId, userBId, status: "pending", requestedById: meId },
    });
    const me = await prisma.user.findUnique({ where: { id: meId }, select: { name: true, email: true } });
    notify(target.id, "New friend request", me.name || me.email);
    publishFriendEvent(target.id, "request_received");
    return res.status(201).json({ requestId: created.id, status: "pending" });
  }

  if (existing.status === "blocked") {
    return res.status(403).json({ error: "Can't send a friend request to this account" });
  }
  if (existing.status === "accepted") {
    return res.status(200).json({ status: "accepted" });
  }
  // status === "pending"
  if (existing.requestedById === meId) {
    return res.status(200).json({ requestId: existing.id, status: "pending" });
  }
  // They already requested us — the same "add each other" the two of you
  // just did in person accepts on the spot instead of leaving a request
  // each of you has to separately go tap Accept on.
  const accepted = await prisma.friendship.update({
    where: { id: existing.id },
    data: { status: "accepted", respondedAt: new Date() },
  });
  const me = await prisma.user.findUnique({ where: { id: meId }, select: { name: true, email: true } });
  notify(target.id, "Friend request accepted", `${me.name || me.email} accepted your request`);
  publishFriendEvent(target.id, "request_accepted");
  res.status(200).json({ requestId: accepted.id, status: "accepted" });
});

async function loadOwnPendingRequest(requestId, meId) {
  if (!Number.isInteger(requestId)) return null;
  const row = await prisma.friendship.findUnique({ where: { id: requestId } });
  if (!row) return null;
  if (row.userAId !== meId && row.userBId !== meId) return null;
  if (row.status !== "pending") return null;
  return row;
}

router.post("/requests/:id/accept", async (req, res) => {
  const row = await loadOwnPendingRequest(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: "Friend request not found" });
  if (row.requestedById === req.user.id) {
    return res.status(400).json({ error: "You can't accept your own request" });
  }

  await prisma.friendship.update({
    where: { id: row.id },
    data: { status: "accepted", respondedAt: new Date() },
  });
  const me = await prisma.user.findUnique({ where: { id: req.user.id }, select: { name: true, email: true } });
  notify(row.requestedById, "Friend request accepted", `${me.name || me.email} accepted your request`);
  publishFriendEvent(row.requestedById, "request_accepted");
  res.json({ status: "accepted" });
});

router.post("/requests/:id/decline", async (req, res) => {
  const row = await loadOwnPendingRequest(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: "Friend request not found" });
  if (row.requestedById === req.user.id) {
    return res.status(400).json({ error: "You can't decline your own request — cancel it instead" });
  }

  // Deleted, not kept as a "declined" row, so the same two people can try
  // again later without a stale row blocking a fresh request.
  await prisma.friendship.delete({ where: { id: row.id } });
  res.status(204).send();
});

router.delete("/requests/:id", async (req, res) => {
  const row = await loadOwnPendingRequest(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: "Friend request not found" });
  if (row.requestedById !== req.user.id) {
    return res.status(400).json({ error: "Only the sender can cancel a request" });
  }

  await prisma.friendship.delete({ where: { id: row.id } });
  res.status(204).send();
});

// --- Existing friends ---------------------------------------------------------

router.delete("/:userId", async (req, res) => {
  const targetId = Number(req.params.userId);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: "Invalid user id" });

  const { userAId, userBId } = pair(req.user.id, targetId);
  const row = await prisma.friendship.findUnique({ where: { userAId_userBId: { userAId, userBId } } });
  if (!row || row.status !== "accepted") {
    return res.status(404).json({ error: "You're not friends with that account" });
  }

  await prisma.friendship.delete({ where: { id: row.id } });
  res.status(204).send();
});

router.post("/:userId/block", async (req, res) => {
  const targetId = Number(req.params.userId);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: "Invalid user id" });
  if (targetId === req.user.id) return res.status(400).json({ error: "You can't block yourself" });

  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) return res.status(404).json({ error: "User not found" });

  const { userAId, userBId } = pair(req.user.id, targetId);
  await prisma.friendship.upsert({
    where: { userAId_userBId: { userAId, userBId } },
    update: { status: "blocked", requestedById: req.user.id, respondedAt: new Date() },
    create: { userAId, userBId, status: "blocked", requestedById: req.user.id },
  });
  res.status(204).send();
});

router.post("/:userId/unblock", async (req, res) => {
  const targetId = Number(req.params.userId);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: "Invalid user id" });

  const { userAId, userBId } = pair(req.user.id, targetId);
  const row = await prisma.friendship.findUnique({ where: { userAId_userBId: { userAId, userBId } } });
  if (!row || row.status !== "blocked" || row.requestedById !== req.user.id) {
    return res.status(404).json({ error: "No block from you on that account" });
  }

  await prisma.friendship.delete({ where: { id: row.id } });
  res.status(204).send();
});

module.exports = { router, areFriends };

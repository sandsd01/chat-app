const { OAuth2Client } = require("google-auth-library");
const prisma = require("../../prisma/client");
const { encryptSecret, decryptSecret, tokenEncryptionConfigured } = require("./crypto");

// Optional, like Google sign-in itself: the app runs fine with Drive backup
// simply unavailable if any of these are unset. Deliberately reuses the same
// GOOGLE_CLIENT_ID/SECRET as sign-in (one Google Cloud OAuth client, two
// different consent flows) rather than provisioning a second client, but
// needs its own redirect URI — sign-in's callback only ever requests
// access_type "online" (no refresh token), while this flow must request
// "offline" + the drive.file scope, and Google ties the requested scopes to
// the exact redirect URI that was authorized for them.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const DRIVE_REDIRECT_URI = process.env.DRIVE_REDIRECT_URI;
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

const driveConfigured = Boolean(
  GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && DRIVE_REDIRECT_URI && tokenEncryptionConfigured()
);

const driveOauthClient = driveConfigured
  ? new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, DRIVE_REDIRECT_URI)
  : null;

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
// drive.file only ever sees files/folders this app itself created in the
// user's Drive, so every archive lives inside one folder we create once.
const BACKUP_FOLDER_NAME = "Chat Backups";

async function getAccessTokenForUser(user) {
  const refreshToken = decryptSecret(user.driveRefreshTokenEnc);
  const client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  client.setCredentials({ refresh_token: refreshToken });
  const { token } = await client.getAccessToken();
  if (!token) throw new Error("Failed to obtain a Drive access token");
  return token;
}

async function driveFetch(accessToken, url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Drive API ${options.method || "GET"} ${url} failed: ${res.status} ${body}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function ensureBackupFolder(user, accessToken) {
  if (user.driveFolderId) return user.driveFolderId;

  const q = encodeURIComponent(
    `name = '${BACKUP_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'root' in parents`
  );
  const searchRes = await driveFetch(accessToken, `${DRIVE_API}/files?q=${q}&fields=files(id)`);
  const { files } = await searchRes.json();
  let folderId = files?.[0]?.id;

  if (!folderId) {
    const createRes = await driveFetch(accessToken, `${DRIVE_API}/files?fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: BACKUP_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
    });
    folderId = (await createRes.json()).id;
  }

  await prisma.user.update({ where: { id: user.id }, data: { driveFolderId: folderId } });
  return folderId;
}

function fileNameForConversation(conversation, forUserId) {
  const otherId = conversation.userAId === forUserId ? conversation.userBId : conversation.userAId;
  return `conversation-${conversation.id}-with-user-${otherId}.jsonl`;
}

async function ensureArchiveFile(user, conversation, accessToken, folderId) {
  const existing = await prisma.driveArchiveFile.findUnique({
    where: { userId_conversationId: { userId: user.id, conversationId: conversation.id } },
  });
  if (existing) return existing;

  const name = fileNameForConversation(conversation, user.id);
  const createRes = await driveFetch(accessToken, `${DRIVE_API}/files?fields=id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, parents: [folderId], mimeType: "text/plain" }),
  });
  const driveFileId = (await createRes.json()).id;

  return prisma.driveArchiveFile.create({
    data: { userId: user.id, conversationId: conversation.id, driveFileId, lastArchivedMessageId: 0 },
  });
}

async function downloadFileContent(accessToken, fileId) {
  const res = await driveFetch(accessToken, `${DRIVE_API}/files/${fileId}?alt=media`);
  return res.text();
}

async function uploadFileContent(accessToken, fileId, content) {
  await driveFetch(accessToken, `${DRIVE_UPLOAD_API}/files/${fileId}?uploadType=media`, {
    method: "PATCH",
    headers: { "Content-Type": "text/plain" },
    body: content,
  });
}

// Archives every message this user hasn't archived yet, across every
// conversation they're in, into their own per-conversation JSONL file in
// their own Drive. Re-downloads and re-uploads the whole file on each sync
// (rather than a true append) to keep this a plain REST call instead of a
// resumable upload session — fine at this app's message volumes; revisit if
// a single conversation's archive file grows into the tens of MB.
async function archiveUserConversations(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.driveRefreshTokenEnc) return { messagesArchived: 0, filesUpdated: 0 };

  const accessToken = await getAccessTokenForUser(user);
  const folderId = await ensureBackupFolder(user, accessToken);

  const conversations = await prisma.conversation.findMany({
    where: { OR: [{ userAId: userId }, { userBId: userId }] },
  });

  let messagesArchived = 0;
  let filesUpdated = 0;

  for (const conversation of conversations) {
    const archiveFile = await ensureArchiveFile(user, conversation, accessToken, folderId);
    const newMessages = await prisma.message.findMany({
      where: { conversationId: conversation.id, id: { gt: archiveFile.lastArchivedMessageId } },
      orderBy: { id: "asc" },
      include: { sender: { select: { id: true, name: true, email: true } } },
    });
    if (newMessages.length === 0) continue;

    const existingContent = await downloadFileContent(accessToken, archiveFile.driveFileId).catch(() => "");
    const newLines = newMessages
      .map((m) =>
        JSON.stringify({
          id: m.id,
          senderId: m.senderId,
          senderName: m.sender.name || m.sender.email,
          body: m.body,
          createdAt: m.createdAt,
        })
      )
      .join("\n");
    const separator = existingContent && !existingContent.endsWith("\n") ? "\n" : "";
    await uploadFileContent(accessToken, archiveFile.driveFileId, existingContent + separator + newLines + "\n");

    const lastArchivedMessageId = newMessages[newMessages.length - 1].id;
    await prisma.driveArchiveFile.update({
      where: { id: archiveFile.id },
      data: { lastArchivedMessageId },
    });

    messagesArchived += newMessages.length;
    filesUpdated += 1;
  }

  return { messagesArchived, filesUpdated };
}

// Deletes a Message once every participant of its conversation has an
// archive watermark at or past it — never just one side, and never a
// conversation where a participant hasn't connected Drive at all (they'd
// have no DriveArchiveFile row, so `archives.length` falls short of
// `participantIds.length` and nothing in that conversation is pruned).
async function pruneArchivedMessages() {
  const conversations = await prisma.conversation.findMany({
    include: { driveArchiveFiles: true },
  });

  let deleted = 0;
  for (const conversation of conversations) {
    const participantIds = [conversation.userAId, conversation.userBId];
    const archives = conversation.driveArchiveFiles.filter((a) => participantIds.includes(a.userId));
    if (archives.length < participantIds.length) continue;

    const minWatermark = Math.min(...archives.map((a) => a.lastArchivedMessageId));
    if (minWatermark <= 0) continue;

    const result = await prisma.message.deleteMany({
      where: { conversationId: conversation.id, id: { lte: minWatermark } },
    });
    deleted += result.count;
  }

  return { deleted };
}

async function runArchiveSweep() {
  const users = await prisma.user.findMany({ where: { driveRefreshTokenEnc: { not: null } } });
  for (const user of users) {
    try {
      await archiveUserConversations(user.id);
    } catch (err) {
      console.error(`Drive archive sweep failed for user ${user.id}:`, err.message);
    }
  }
  return pruneArchivedMessages();
}

module.exports = {
  driveConfigured,
  driveOauthClient,
  DRIVE_SCOPE,
  archiveUserConversations,
  pruneArchivedMessages,
  runArchiveSweep,
};

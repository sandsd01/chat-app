const { attachmentsConfigured, createDownloadUrl } = require("./attachments");

// The shape of "another user" as any route is allowed to hand it back:
// enough to render them (name/avatar/status) plus the public code you'd use
// to add them. Never passwordHash, googleId, email-verification state, or
// anything else on the User row — routes select exactly this rather than
// fetching the whole row and trusting themselves to strip it afterwards.
const PUBLIC_USER_SELECT = {
  id: true,
  publicId: true,
  name: true,
  email: true,
  statusMessage: true,
  avatarKey: true,
};

/**
 * Swaps the stored `avatarKey` for a short-lived presigned `avatarUrl`, the
 * same way message attachments are served — the key itself never leaves the
 * server, and no permanent public URL to a user's avatar ever exists.
 * `avatarUrl` is null both when the user has no avatar and when R2 isn't
 * configured, so callers render the initials badge in either case rather
 * than having to distinguish them.
 */
async function toPublicUser(user) {
  if (!user) return user;
  const { avatarKey, ...rest } = user;
  // Guarded on attachmentsConfigured, not just on avatarKey: presigning with
  // no S3 client throws, and this runs on every rendered user, so an account
  // that uploaded an avatar while R2 was configured must not break every
  // friends/conversations response if R2 is later unset.
  const canSign = attachmentsConfigured && Boolean(avatarKey);
  return { ...rest, avatarUrl: canSign ? await createDownloadUrl(avatarKey, "image") : null };
}

module.exports = { PUBLIC_USER_SELECT, toPublicUser };

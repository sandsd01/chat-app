-- Short status line shown under a user's display name, and the R2 object key
-- for their avatar (null = fall back to the initials badge).
ALTER TABLE "users" ADD COLUMN "statusMessage" TEXT;
ALTER TABLE "users" ADD COLUMN "avatarKey" TEXT;

-- Labels a push subscription with the browser that registered it, so the
-- account page can show which device each one belongs to.
ALTER TABLE "push_subscriptions" ADD COLUMN "userAgent" TEXT;

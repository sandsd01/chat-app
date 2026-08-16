-- AlterTable
ALTER TABLE "users" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifyTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "verifyTokenHash" TEXT;

-- Grandfather every account that already existed before verification was
-- introduced: retroactively locking out accounts already in use would be a
-- regression, not a security fix. Only a signup from this point forward
-- starts out with emailVerifiedAt = NULL.
UPDATE "users" SET "emailVerifiedAt" = "createdAt" WHERE "emailVerifiedAt" IS NULL;

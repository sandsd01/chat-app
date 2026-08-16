-- Removes the Google Drive backup feature: the per-user OAuth/folder columns
-- and the per-participant archive watermark table. Dropping these is
-- irreversible for any archive state that existed, but the Drive files
-- themselves live in each user's own Drive and are untouched by this.
DROP TABLE IF EXISTS "drive_archive_files";

ALTER TABLE "users" DROP COLUMN IF EXISTS "driveRefreshTokenEnc";
ALTER TABLE "users" DROP COLUMN IF EXISTS "driveConnectedAt";
ALTER TABLE "users" DROP COLUMN IF EXISTS "driveFolderId";

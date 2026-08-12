-- AlterTable
ALTER TABLE "users" ADD COLUMN     "driveRefreshTokenEnc" TEXT,
ADD COLUMN     "driveConnectedAt" TIMESTAMP(3),
ADD COLUMN     "driveFolderId" TEXT;

-- CreateTable
CREATE TABLE "drive_archive_files" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "driveFileId" TEXT NOT NULL,
    "lastArchivedMessageId" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drive_archive_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "drive_archive_files_userId_conversationId_key" ON "drive_archive_files"("userId", "conversationId");

-- AddForeignKey
ALTER TABLE "drive_archive_files" ADD CONSTRAINT "drive_archive_files_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drive_archive_files" ADD CONSTRAINT "drive_archive_files_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

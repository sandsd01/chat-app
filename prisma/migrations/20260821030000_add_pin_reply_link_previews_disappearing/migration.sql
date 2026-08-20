-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "userAPinnedAt" TIMESTAMP(3),
ADD COLUMN     "userBPinnedAt" TIMESTAMP(3),
ADD COLUMN     "disappearingSeconds" INTEGER;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "replyToId" INTEGER,
ADD COLUMN     "linkPreviewId" INTEGER,
ADD COLUMN     "expiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "messages_expiresAt_idx" ON "messages"("expiresAt");

-- CreateTable
CREATE TABLE "link_previews" (
    "id" SERIAL NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "status" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "siteName" TEXT,
    "imageData" BYTEA,
    "imageMimeType" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "link_previews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "link_previews_url_key" ON "link_previews"("url");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_linkPreviewId_fkey" FOREIGN KEY ("linkPreviewId") REFERENCES "link_previews"("id") ON DELETE SET NULL ON UPDATE CASCADE;

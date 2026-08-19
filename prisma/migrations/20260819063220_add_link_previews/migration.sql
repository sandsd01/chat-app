-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "linkPreviewId" INTEGER;

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
ALTER TABLE "messages" ADD CONSTRAINT "messages_linkPreviewId_fkey" FOREIGN KEY ("linkPreviewId") REFERENCES "link_previews"("id") ON DELETE SET NULL ON UPDATE CASCADE;

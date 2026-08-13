-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "attachmentKey" TEXT,
ADD COLUMN     "attachmentMimeType" TEXT,
ADD COLUMN     "attachmentName" TEXT,
ADD COLUMN     "attachmentSize" INTEGER,
ADD COLUMN     "attachmentType" TEXT,
ALTER COLUMN "body" DROP NOT NULL;

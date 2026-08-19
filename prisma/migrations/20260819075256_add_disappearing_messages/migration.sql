-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "disappearingSeconds" INTEGER;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "expiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "messages_expiresAt_idx" ON "messages"("expiresAt");

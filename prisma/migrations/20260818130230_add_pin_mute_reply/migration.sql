-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "userAMutedAt" TIMESTAMP(3),
ADD COLUMN     "userAPinnedAt" TIMESTAMP(3),
ADD COLUMN     "userBMutedAt" TIMESTAMP(3),
ADD COLUMN     "userBPinnedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "replyToId" INTEGER;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

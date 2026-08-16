-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "userAMuted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "userBMuted" BOOLEAN NOT NULL DEFAULT false;

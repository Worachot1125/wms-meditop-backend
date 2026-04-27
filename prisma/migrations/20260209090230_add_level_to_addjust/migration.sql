-- AlterTable
ALTER TABLE "adjustments" ADD COLUMN     "level" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN     "type" TEXT;

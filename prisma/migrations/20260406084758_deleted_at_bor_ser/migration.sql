-- AlterTable
ALTER TABLE "bor_stocks" ADD COLUMN     "deleted_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ser_stocks" ADD COLUMN     "deleted_at" TIMESTAMP(3);

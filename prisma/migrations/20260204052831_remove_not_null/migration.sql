-- DropIndex
DROP INDEX "adjustments_no_key";

-- AlterTable
ALTER TABLE "adjustments" ALTER COLUMN "no" DROP NOT NULL;

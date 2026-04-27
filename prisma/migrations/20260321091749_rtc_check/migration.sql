-- AlterTable
ALTER TABLE "goods_out_items" ADD COLUMN     "rtc_check" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "transfer_docs" ALTER COLUMN "department" DROP NOT NULL;

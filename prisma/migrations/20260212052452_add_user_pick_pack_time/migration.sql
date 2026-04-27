-- AlterTable
ALTER TABLE "goods_out_items" ADD COLUMN     "pack_time" TIMESTAMP(3),
ADD COLUMN     "pick_time" TIMESTAMP(3),
ADD COLUMN     "user_pack" TEXT,
ADD COLUMN     "user_pick" TEXT;

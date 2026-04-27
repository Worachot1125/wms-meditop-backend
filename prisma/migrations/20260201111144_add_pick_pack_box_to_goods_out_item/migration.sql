-- AlterTable
ALTER TABLE "goods_out_items" ADD COLUMN     "box_id" TEXT,
ADD COLUMN     "pack" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pick" INTEGER NOT NULL DEFAULT 0;

-- AddForeignKey
ALTER TABLE "goods_out_items" ADD CONSTRAINT "goods_out_items_box_id_fkey" FOREIGN KEY ("box_id") REFERENCES "boxes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

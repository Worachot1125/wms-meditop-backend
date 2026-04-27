-- AlterTable
ALTER TABLE "goods_out_items" ADD COLUMN     "barcode_id" INTEGER;

-- AddForeignKey
ALTER TABLE "goods_out_items" ADD CONSTRAINT "goods_out_items_barcode_id_fkey" FOREIGN KEY ("barcode_id") REFERENCES "barcodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

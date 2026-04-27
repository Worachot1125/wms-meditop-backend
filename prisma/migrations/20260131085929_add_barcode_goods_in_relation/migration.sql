-- AddForeignKey
ALTER TABLE "goods_ins" ADD CONSTRAINT "goods_ins_barcode_id_fkey" FOREIGN KEY ("barcode_id") REFERENCES "barcodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_out_item_location_return" ADD CONSTRAINT "goods_out_item_location_return_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "pack_products" ADD COLUMN     "transport_bkk_id" INTEGER;

-- AddForeignKey
ALTER TABLE "pack_products" ADD CONSTRAINT "pack_products_transport_bkk_id_fkey" FOREIGN KEY ("transport_bkk_id") REFERENCES "transports_bkk"("id") ON DELETE SET NULL ON UPDATE CASCADE;

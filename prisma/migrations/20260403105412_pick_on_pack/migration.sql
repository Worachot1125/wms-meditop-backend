-- AlterTable
ALTER TABLE "pack_products" ADD COLUMN     "batch_name" TEXT;

-- CreateIndex
CREATE INDEX "pack_products_batch_name_idx" ON "pack_products"("batch_name");

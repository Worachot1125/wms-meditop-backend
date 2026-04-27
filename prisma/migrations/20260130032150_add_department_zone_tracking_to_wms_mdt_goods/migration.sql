-- AlterTable
ALTER TABLE "wms_mdt_goods" ADD COLUMN     "department_id" INTEGER,
ADD COLUMN     "tracking" TEXT,
ADD COLUMN     "zone_id" INTEGER;

-- CreateIndex
CREATE INDEX "wms_mdt_goods_product_id_idx" ON "wms_mdt_goods"("product_id");

-- CreateIndex
CREATE INDEX "wms_mdt_goods_department_id_idx" ON "wms_mdt_goods"("department_id");

-- CreateIndex
CREATE INDEX "wms_mdt_goods_zone_id_idx" ON "wms_mdt_goods"("zone_id");

-- AlterTable
ALTER TABLE "goods_ins" ADD COLUMN     "odoo_line_key" TEXT,
ADD COLUMN     "odoo_sequence" INTEGER;

-- CreateIndex
CREATE INDEX "goods_ins_inbound_id_product_id_idx" ON "goods_ins"("inbound_id", "product_id");

-- CreateIndex
CREATE INDEX "goods_ins_odoo_line_key_idx" ON "goods_ins"("odoo_line_key");

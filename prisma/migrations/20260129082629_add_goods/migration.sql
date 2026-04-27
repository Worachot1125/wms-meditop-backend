-- CreateTable
CREATE TABLE "wms_mdt_goods" (
    "product_id" INTEGER NOT NULL,
    "product_code" TEXT,
    "product_name" TEXT,
    "product_type" TEXT,
    "lot_id" INTEGER,
    "lot_name" TEXT,
    "expiration_date" TIMESTAMP(3),
    "department_code" TEXT,
    "department_name" TEXT,
    "unit" TEXT,
    "zone_type" TEXT,
    "user_manaul_url" TEXT,
    "active" BOOLEAN,
    "product_last_modified_date" TIMESTAMP(3),
    "lot_last_modified_date" TIMESTAMP(3),

    CONSTRAINT "wms_mdt_goods_pkey" PRIMARY KEY ("product_id")
);

-- CreateIndex
CREATE INDEX "wms_mdt_goods_product_code_idx" ON "wms_mdt_goods"("product_code");

-- CreateIndex
CREATE INDEX "wms_mdt_goods_lot_id_idx" ON "wms_mdt_goods"("lot_id");

-- CreateTable
CREATE TABLE "wms_stock_daily" (
    "id" SERIAL NOT NULL,
    "snapshot_date" TIMESTAMP(3) NOT NULL,
    "bucket_key" TEXT NOT NULL,
    "product_id" INTEGER NOT NULL,
    "product_code" TEXT,
    "product_name" TEXT,
    "unit" TEXT,
    "location_id" INTEGER,
    "location_name" TEXT,
    "lot_id" INTEGER,
    "lot_name" TEXT,
    "expiration_date" TIMESTAMP(3),
    "quantity" DECIMAL(18,3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wms_stock_daily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wms_stock_daily_snapshot_date_idx" ON "wms_stock_daily"("snapshot_date");

-- CreateIndex
CREATE INDEX "wms_stock_daily_product_id_snapshot_date_idx" ON "wms_stock_daily"("product_id", "snapshot_date");

-- CreateIndex
CREATE UNIQUE INDEX "wms_stock_daily_snapshot_date_bucket_key_key" ON "wms_stock_daily"("snapshot_date", "bucket_key");

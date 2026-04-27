-- CreateTable
CREATE TABLE "stock_balances" (
    "id" SERIAL NOT NULL,
    "snapshot_date" TIMESTAMP(3) NOT NULL,
    "product_id" INTEGER NOT NULL,
    "product_code" TEXT NOT NULL,
    "location_id" INTEGER,
    "location_path" TEXT,
    "location_name" TEXT,
    "lot_id" INTEGER,
    "lot_name" TEXT,
    "quantity" DECIMAL(18,3) NOT NULL,
    "expiration_date" TIMESTAMP(3),
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "stock_balances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_balances_snapshot_date_source_idx" ON "stock_balances"("snapshot_date", "source");

-- CreateIndex
CREATE INDEX "stock_balances_snapshot_date_product_id_source_idx" ON "stock_balances"("snapshot_date", "product_id", "source");

-- CreateIndex
CREATE INDEX "stock_balances_product_id_lot_id_location_id_snapshot_date__idx" ON "stock_balances"("product_id", "lot_id", "location_id", "snapshot_date", "source");

-- CreateIndex
CREATE UNIQUE INDEX "stock_balances_snapshot_date_product_id_location_id_lot_id__key" ON "stock_balances"("snapshot_date", "product_id", "location_id", "lot_id", "source");

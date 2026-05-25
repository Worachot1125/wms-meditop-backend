-- AlterTable
ALTER TABLE "borrow_stocks" ADD COLUMN     "movement_type" TEXT NOT NULL DEFAULT 'borrow';

-- CreateTable
CREATE TABLE "borrow_stock_dailies" (
    "id" SERIAL NOT NULL,
    "snapshot_date" TIMESTAMP(3) NOT NULL,
    "borrow_stock_id" INTEGER,
    "item_id" INTEGER,
    "department_id" INTEGER,
    "department_name" TEXT,
    "location_name" TEXT NOT NULL,
    "product_code" TEXT NOT NULL,
    "product_name" TEXT,
    "lot_serial" TEXT NOT NULL,
    "expiration_date" TIMESTAMP(3),
    "in_qty" INTEGER NOT NULL DEFAULT 0,
    "out_qty" INTEGER NOT NULL DEFAULT 0,
    "net_qty" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT,
    "user_ref" TEXT,
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "borrow_stock_dailies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "borrow_stock_dailies_snapshot_date_idx" ON "borrow_stock_dailies"("snapshot_date");

-- CreateIndex
CREATE INDEX "borrow_stock_dailies_product_code_lot_serial_idx" ON "borrow_stock_dailies"("product_code", "lot_serial");

-- CreateIndex
CREATE INDEX "borrow_stock_dailies_department_id_idx" ON "borrow_stock_dailies"("department_id");

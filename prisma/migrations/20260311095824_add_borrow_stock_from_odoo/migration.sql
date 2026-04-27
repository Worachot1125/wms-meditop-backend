/*
  Warnings:

  - A unique constraint covering the columns `[no]` on the table `borrow_stocks` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[odoo_id]` on the table `locations` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "borrow_stock_items" ADD COLUMN     "barcode_text" TEXT,
ADD COLUMN     "lot_id" INTEGER,
ADD COLUMN     "odoo_line_key" TEXT,
ADD COLUMN     "product_id" INTEGER,
ADD COLUMN     "source_sequence" INTEGER,
ADD COLUMN     "tracking" TEXT,
ADD COLUMN     "unit" TEXT;

-- AlterTable
ALTER TABLE "borrow_stocks" ADD COLUMN     "location_id" INTEGER,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "no" TEXT,
ADD COLUMN     "odoo_location_id" INTEGER,
ADD COLUMN     "origin" TEXT,
ADD COLUMN     "picking_id" INTEGER,
ADD COLUMN     "reference" TEXT,
ADD COLUMN     "source_location" TEXT,
ADD COLUMN     "source_location_id" INTEGER;

-- AlterTable
ALTER TABLE "locations" ADD COLUMN     "odoo_id" INTEGER;

-- CreateIndex
CREATE INDEX "borrow_stock_items_borrow_stock_id_product_id_idx" ON "borrow_stock_items"("borrow_stock_id", "product_id");

-- CreateIndex
CREATE INDEX "borrow_stock_items_odoo_line_key_idx" ON "borrow_stock_items"("odoo_line_key");

-- CreateIndex
CREATE UNIQUE INDEX "borrow_stocks_no_key" ON "borrow_stocks"("no");

-- CreateIndex
CREATE INDEX "borrow_stocks_picking_id_idx" ON "borrow_stocks"("picking_id");

-- CreateIndex
CREATE INDEX "borrow_stocks_location_id_idx" ON "borrow_stocks"("location_id");

-- CreateIndex
CREATE INDEX "borrow_stocks_status_idx" ON "borrow_stocks"("status");

-- CreateIndex
CREATE INDEX "borrow_stocks_name_idx" ON "borrow_stocks"("name");

-- CreateIndex
CREATE UNIQUE INDEX "locations_odoo_id_key" ON "locations"("odoo_id");

-- AddForeignKey
ALTER TABLE "borrow_stocks" ADD CONSTRAINT "borrow_stocks_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

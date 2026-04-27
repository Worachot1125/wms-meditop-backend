-- CreateTable
CREATE TABLE "swaps" (
    "id" SERIAL NOT NULL,
    "name" TEXT,
    "no" TEXT,
    "picking_id" INTEGER,
    "odoo_location_id" INTEGER,
    "source_location_id" INTEGER,
    "source_location" TEXT,
    "location_id" INTEGER,
    "location_name" TEXT NOT NULL,
    "department_id" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "user_ref" TEXT,
    "remark" TEXT,
    "origin" TEXT,
    "reference" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "swaps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "swap_items" (
    "id" SERIAL NOT NULL,
    "swap_id" INTEGER NOT NULL,
    "source_sequence" INTEGER,
    "odoo_line_key" TEXT,
    "product_id" INTEGER,
    "code" TEXT,
    "name" TEXT,
    "unit" TEXT,
    "tracking" TEXT,
    "lot_id" INTEGER,
    "lot_serial" TEXT,
    "barcode_text" TEXT,
    "expiration_date" TIMESTAMP(3),
    "system_qty" INTEGER NOT NULL DEFAULT 0,
    "executed_qty" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "swap_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "swaps_no_key" ON "swaps"("no");

-- CreateIndex
CREATE INDEX "swaps_picking_id_idx" ON "swaps"("picking_id");

-- CreateIndex
CREATE INDEX "swaps_location_id_idx" ON "swaps"("location_id");

-- CreateIndex
CREATE INDEX "swaps_department_id_idx" ON "swaps"("department_id");

-- CreateIndex
CREATE INDEX "swaps_status_idx" ON "swaps"("status");

-- CreateIndex
CREATE INDEX "swaps_name_idx" ON "swaps"("name");

-- CreateIndex
CREATE INDEX "swap_items_swap_id_idx" ON "swap_items"("swap_id");

-- CreateIndex
CREATE INDEX "swap_items_product_id_idx" ON "swap_items"("product_id");

-- CreateIndex
CREATE INDEX "swap_items_lot_serial_idx" ON "swap_items"("lot_serial");

-- CreateIndex
CREATE INDEX "swap_items_odoo_line_key_idx" ON "swap_items"("odoo_line_key");

-- AddForeignKey
ALTER TABLE "swaps" ADD CONSTRAINT "swaps_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "swaps" ADD CONSTRAINT "swaps_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "swap_items" ADD CONSTRAINT "swap_items_swap_id_fkey" FOREIGN KEY ("swap_id") REFERENCES "swaps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

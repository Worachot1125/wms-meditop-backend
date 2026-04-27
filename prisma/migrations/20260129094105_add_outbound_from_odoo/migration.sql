-- CreateTable
CREATE TABLE "outbounds" (
    "no" TEXT NOT NULL,
    "picking_id" INTEGER,
    "location_id" INTEGER,
    "location" TEXT,
    "location_dest_id" INTEGER,
    "location_dest" TEXT,
    "department_id" TEXT,
    "department" TEXT NOT NULL,
    "reference" TEXT,
    "origin" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "out_type" TEXT NOT NULL DEFAULT 'DO',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "outbounds_pkey" PRIMARY KEY ("no")
);

-- CreateTable
CREATE TABLE "goods_out_items" (
    "id" TEXT NOT NULL,
    "out_no" TEXT NOT NULL,
    "sequence" INTEGER,
    "product_id" INTEGER,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "tracking" TEXT,
    "lot_id" INTEGER,
    "lot_serial" TEXT,
    "qty" INTEGER,
    "sku" TEXT,
    "lock_no" TEXT,
    "lock_name" TEXT,
    "barcode" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "goods_out_items_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "goods_out_items" ADD CONSTRAINT "goods_out_items_out_no_fkey" FOREIGN KEY ("out_no") REFERENCES "outbounds"("no") ON DELETE RESTRICT ON UPDATE CASCADE;

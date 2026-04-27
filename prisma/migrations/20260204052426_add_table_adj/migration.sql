-- CreateTable
CREATE TABLE "adjustments" (
    "id" SERIAL NOT NULL,
    "no" TEXT NOT NULL,
    "inventory_id" INTEGER,
    "picking_id" INTEGER,
    "picking_no" TEXT,
    "department_id" TEXT,
    "department" TEXT NOT NULL,
    "reference" TEXT,
    "origin" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adjustment_items" (
    "id" SERIAL NOT NULL,
    "adjustment_id" INTEGER NOT NULL,
    "sequence" INTEGER,
    "product_id" INTEGER,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "location_id" INTEGER,
    "location" TEXT,
    "location_dest_id" INTEGER,
    "location_dest" TEXT,
    "tracking" TEXT,
    "lot_id" INTEGER,
    "lot_serial" TEXT,
    "qty" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "adjustment_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "adjustments_no_key" ON "adjustments"("no");

-- AddForeignKey
ALTER TABLE "adjustment_items" ADD CONSTRAINT "adjustment_items_adjustment_id_fkey" FOREIGN KEY ("adjustment_id") REFERENCES "adjustments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

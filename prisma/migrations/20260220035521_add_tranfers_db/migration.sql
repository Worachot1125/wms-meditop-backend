-- AlterTable
ALTER TABLE "batch_outbounds" ALTER COLUMN "status" SET DEFAULT 'process';

-- CreateTable
CREATE TABLE "transfer_docs" (
    "lot" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "quantity" INTEGER,
    "in_type" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "department_id" TEXT,
    "location" TEXT,
    "location_dest" TEXT,
    "location_dest_id" INTEGER,
    "location_id" INTEGER,
    "origin" TEXT,
    "picking_id" INTEGER,
    "reference" TEXT,
    "no" TEXT NOT NULL,
    "id" SERIAL NOT NULL,

    CONSTRAINT "transfer_docs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_doc_items" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity_receive" INTEGER,
    "quantity_count" INTEGER,
    "unit" TEXT NOT NULL,
    "zone_type" TEXT,
    "lot" TEXT,
    "exp" TIMESTAMP(3),
    "barcode13" TEXT,
    "qr_payload" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "code" TEXT,
    "lot_id" INTEGER,
    "lot_serial" TEXT,
    "product_id" INTEGER,
    "qty" INTEGER,
    "sequence" INTEGER,
    "tracking" TEXT,
    "transfer_doc_id" INTEGER,
    "barcode_id" INTEGER,
    "barcode_text" TEXT,
    "barcode_payload" TEXT,
    "confirmed_qty" INTEGER DEFAULT 0,
    "user_ref" TEXT,
    "in_process" BOOLEAN NOT NULL DEFAULT false,
    "odoo_line_key" TEXT,
    "odoo_sequence" INTEGER,

    CONSTRAINT "transfer_doc_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_doc_item_location_confirm" (
    "id" SERIAL NOT NULL,
    "transfer_doc_item_id" TEXT NOT NULL,
    "location_id" INTEGER NOT NULL,
    "confirmed_qty" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfer_doc_item_location_confirm_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "transfer_docs_no_key" ON "transfer_docs"("no");

-- CreateIndex
CREATE INDEX "transfer_doc_items_odoo_line_key_idx" ON "transfer_doc_items"("odoo_line_key");

-- CreateIndex
CREATE INDEX "transfer_doc_items_transfer_doc_id_product_id_idx" ON "transfer_doc_items"("transfer_doc_id", "product_id");

-- CreateIndex
CREATE INDEX "transfer_doc_item_location_confirm_transfer_doc_item_id_idx" ON "transfer_doc_item_location_confirm"("transfer_doc_item_id");

-- CreateIndex
CREATE INDEX "transfer_doc_item_location_confirm_location_id_idx" ON "transfer_doc_item_location_confirm"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "transfer_doc_item_location_confirm_transfer_doc_item_id_loc_key" ON "transfer_doc_item_location_confirm"("transfer_doc_item_id", "location_id");

-- AddForeignKey
ALTER TABLE "transfer_doc_items" ADD CONSTRAINT "transfer_doc_items_barcode_id_fkey" FOREIGN KEY ("barcode_id") REFERENCES "barcodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_doc_items" ADD CONSTRAINT "transfer_doc_items_transfer_doc_id_fkey" FOREIGN KEY ("transfer_doc_id") REFERENCES "transfer_docs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_doc_item_location_confirm" ADD CONSTRAINT "transfer_doc_item_location_confirm_transfer_doc_item_id_fkey" FOREIGN KEY ("transfer_doc_item_id") REFERENCES "transfer_doc_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_doc_item_location_confirm" ADD CONSTRAINT "transfer_doc_item_location_confirm_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

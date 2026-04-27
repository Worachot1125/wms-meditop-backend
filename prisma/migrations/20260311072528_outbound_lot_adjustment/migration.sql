-- AlterTable
ALTER TABLE "goods_out_items" ADD COLUMN     "is_split_generated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lot_adjustment_id" INTEGER,
ADD COLUMN     "source_item_id" INTEGER;

-- CreateTable
CREATE TABLE "outbound_lot_adjustment" (
    "id" SERIAL NOT NULL,
    "outbound_id" INTEGER NOT NULL,
    "goods_out_item_id" INTEGER NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_by" TEXT,
    "updated_by" TEXT,
    "original_lot_serial" TEXT,
    "original_lot_id" INTEGER,
    "original_qty" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "outbound_lot_adjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_lot_adjustment_line" (
    "id" SERIAL NOT NULL,
    "adjustment_id" INTEGER NOT NULL,
    "lot_id" INTEGER,
    "lot_serial" TEXT,
    "qty" INTEGER NOT NULL,
    "is_original_lot" BOOLEAN NOT NULL DEFAULT false,
    "goods_out_item_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "outbound_lot_adjustment_line_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbound_lot_adjustment_outbound_id_idx" ON "outbound_lot_adjustment"("outbound_id");

-- CreateIndex
CREATE INDEX "outbound_lot_adjustment_goods_out_item_id_idx" ON "outbound_lot_adjustment"("goods_out_item_id");

-- CreateIndex
CREATE INDEX "outbound_lot_adjustment_status_idx" ON "outbound_lot_adjustment"("status");

-- CreateIndex
CREATE INDEX "outbound_lot_adjustment_line_adjustment_id_idx" ON "outbound_lot_adjustment_line"("adjustment_id");

-- CreateIndex
CREATE INDEX "outbound_lot_adjustment_line_goods_out_item_id_idx" ON "outbound_lot_adjustment_line"("goods_out_item_id");

-- AddForeignKey
ALTER TABLE "goods_out_items" ADD CONSTRAINT "goods_out_items_source_item_id_fkey" FOREIGN KEY ("source_item_id") REFERENCES "goods_out_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_out_items" ADD CONSTRAINT "goods_out_items_lot_adjustment_id_fkey" FOREIGN KEY ("lot_adjustment_id") REFERENCES "outbound_lot_adjustment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_lot_adjustment" ADD CONSTRAINT "outbound_lot_adjustment_outbound_id_fkey" FOREIGN KEY ("outbound_id") REFERENCES "outbounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_lot_adjustment" ADD CONSTRAINT "outbound_lot_adjustment_goods_out_item_id_fkey" FOREIGN KEY ("goods_out_item_id") REFERENCES "goods_out_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_lot_adjustment_line" ADD CONSTRAINT "outbound_lot_adjustment_line_adjustment_id_fkey" FOREIGN KEY ("adjustment_id") REFERENCES "outbound_lot_adjustment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

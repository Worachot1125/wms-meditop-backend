-- CreateTable
CREATE TABLE "goods_in_scan_histories" (
    "id" SERIAL NOT NULL,
    "goods_in_id" TEXT NOT NULL,
    "inbound_id" INTEGER,
    "location_id" INTEGER,
    "location_full_name" TEXT,
    "action_type" TEXT NOT NULL,
    "qty_delta" INTEGER,
    "qty_before" INTEGER,
    "qty_after" INTEGER,
    "loc_qty_before" INTEGER,
    "loc_qty_after" INTEGER,
    "note" TEXT,
    "user_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_in_scan_histories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "goods_in_scan_histories_goods_in_id_created_at_idx" ON "goods_in_scan_histories"("goods_in_id", "created_at");

-- CreateIndex
CREATE INDEX "goods_in_scan_histories_inbound_id_created_at_idx" ON "goods_in_scan_histories"("inbound_id", "created_at");

-- AddForeignKey
ALTER TABLE "goods_in_scan_histories" ADD CONSTRAINT "goods_in_scan_histories_goods_in_id_fkey" FOREIGN KEY ("goods_in_id") REFERENCES "goods_ins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

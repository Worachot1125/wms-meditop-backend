-- CreateTable
CREATE TABLE "goods_out_item_location_confirm" (
    "id" SERIAL NOT NULL,
    "goods_out_item_id" INTEGER NOT NULL,
    "location_id" INTEGER NOT NULL,
    "confirmed_pick" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "goods_out_item_location_confirm_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "goods_out_item_location_confirm_goods_out_item_id_idx" ON "goods_out_item_location_confirm"("goods_out_item_id");

-- CreateIndex
CREATE INDEX "goods_out_item_location_confirm_location_id_idx" ON "goods_out_item_location_confirm"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_out_item_location_confirm_goods_out_item_id_location__key" ON "goods_out_item_location_confirm"("goods_out_item_id", "location_id");

-- AddForeignKey
ALTER TABLE "goods_out_item_location_confirm" ADD CONSTRAINT "goods_out_item_location_confirm_goods_out_item_id_fkey" FOREIGN KEY ("goods_out_item_id") REFERENCES "goods_out_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_out_item_location_confirm" ADD CONSTRAINT "goods_out_item_location_confirm_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "goods_out_item_location_return" (
    "id" SERIAL NOT NULL,
    "goods_out_item_id" INTEGER NOT NULL,
    "location_id" INTEGER NOT NULL,
    "return" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "goods_out_item_location_return_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "goods_out_item_location_return_goods_out_item_id_location_i_key" ON "goods_out_item_location_return"("goods_out_item_id", "location_id");

-- AddForeignKey
ALTER TABLE "goods_out_item_location_return" ADD CONSTRAINT "goods_out_item_location_return_goods_out_item_id_fkey" FOREIGN KEY ("goods_out_item_id") REFERENCES "goods_out_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

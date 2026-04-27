/*
  Warnings:

  - You are about to drop the column `box_id` on the `goods_out_items` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "goods_out_items" DROP CONSTRAINT "goods_out_items_box_id_fkey";

-- AlterTable
ALTER TABLE "goods_out_items" DROP COLUMN "box_id";

-- CreateTable
CREATE TABLE "goods_out_item_boxes" (
    "id" SERIAL NOT NULL,
    "item_id" INTEGER NOT NULL,
    "box_id" TEXT NOT NULL,
    "quantity" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "goods_out_item_boxes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "goods_out_item_boxes_item_id_box_id_key" ON "goods_out_item_boxes"("item_id", "box_id");

-- AddForeignKey
ALTER TABLE "goods_out_item_boxes" ADD CONSTRAINT "goods_out_item_boxes_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "goods_out_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_out_item_boxes" ADD CONSTRAINT "goods_out_item_boxes_box_id_fkey" FOREIGN KEY ("box_id") REFERENCES "boxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

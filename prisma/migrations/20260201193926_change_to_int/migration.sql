/*
  Warnings:

  - The primary key for the `boxes` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `boxes` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Changed the type of `box_id` on the `goods_out_boxes` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `box_id` on the `goods_out_item_boxes` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- DropForeignKey
ALTER TABLE "goods_out_boxes" DROP CONSTRAINT "goods_out_boxes_box_id_fkey";

-- DropForeignKey
ALTER TABLE "goods_out_item_boxes" DROP CONSTRAINT "goods_out_item_boxes_box_id_fkey";

-- AlterTable
ALTER TABLE "boxes" DROP CONSTRAINT "boxes_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "boxes_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "goods_out_boxes" DROP COLUMN "box_id",
ADD COLUMN     "box_id" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "goods_out_item_boxes" DROP COLUMN "box_id",
ADD COLUMN     "box_id" INTEGER NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "goods_out_boxes_goods_out_id_box_id_key" ON "goods_out_boxes"("goods_out_id", "box_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_out_item_boxes_item_id_box_id_key" ON "goods_out_item_boxes"("item_id", "box_id");

-- AddForeignKey
ALTER TABLE "goods_out_boxes" ADD CONSTRAINT "goods_out_boxes_box_id_fkey" FOREIGN KEY ("box_id") REFERENCES "boxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_out_item_boxes" ADD CONSTRAINT "goods_out_item_boxes_box_id_fkey" FOREIGN KEY ("box_id") REFERENCES "boxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

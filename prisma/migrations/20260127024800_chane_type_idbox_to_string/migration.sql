/*
  Warnings:

  - The primary key for the `boxes` table will be changed. If it partially fails, the table could be left without primary key constraint.

*/
-- DropForeignKey
ALTER TABLE "goods_out_boxes" DROP CONSTRAINT "goods_out_boxes_box_id_fkey";

-- AlterTable
ALTER TABLE "boxes" DROP CONSTRAINT "boxes_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ADD CONSTRAINT "boxes_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "boxes_id_seq";

-- AlterTable
ALTER TABLE "goods_out_boxes" ALTER COLUMN "box_id" SET DATA TYPE TEXT;

-- AddForeignKey
ALTER TABLE "goods_out_boxes" ADD CONSTRAINT "goods_out_boxes_box_id_fkey" FOREIGN KEY ("box_id") REFERENCES "boxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

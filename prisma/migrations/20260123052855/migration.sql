/*
  Warnings:

  - The primary key for the `goods_out_boxes` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `goods_out_boxes` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `invoice_items` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `invoice_items` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "goods_out_boxes" DROP CONSTRAINT "goods_out_boxes_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "goods_out_boxes_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "invoice_items" DROP CONSTRAINT "invoice_items_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("id");

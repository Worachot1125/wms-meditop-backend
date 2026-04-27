/*
  Warnings:

  - The primary key for the `wms_mdt_goods` table will be changed. If it partially fails, the table could be left without primary key constraint.

*/
-- AlterTable
ALTER TABLE "wms_mdt_goods" DROP CONSTRAINT "wms_mdt_goods_pkey",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "wms_mdt_goods_pkey" PRIMARY KEY ("id");

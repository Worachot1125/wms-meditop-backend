/*
  Warnings:

  - Made the column `barcode` on table `goods_outs` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "goods_outs" ALTER COLUMN "barcode" SET NOT NULL;

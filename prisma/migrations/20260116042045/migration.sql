/*
  Warnings:

  - Made the column `p_name` on table `goods_ins` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "goods_ins" ALTER COLUMN "p_name" SET NOT NULL;

/*
  Warnings:

  - You are about to drop the `goods` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "goods" DROP CONSTRAINT "goods_department_id_fkey";

-- DropForeignKey
ALTER TABLE "goods" DROP CONSTRAINT "goods_zone_type_id_fkey";

-- DropTable
DROP TABLE "goods";

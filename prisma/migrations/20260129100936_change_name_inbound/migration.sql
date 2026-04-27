/*
  Warnings:

  - You are about to drop the column `sku` on the `inbounds` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "inbounds" DROP COLUMN "sku",
ADD COLUMN     "no" TEXT;

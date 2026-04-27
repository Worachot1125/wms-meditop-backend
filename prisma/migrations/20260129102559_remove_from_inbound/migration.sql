/*
  Warnings:

  - You are about to drop the column `inv_sup` on the `inbounds` table. All the data in the column will be lost.
  - You are about to drop the column `po_no` on the `inbounds` table. All the data in the column will be lost.
  - You are about to drop the column `supplier` on the `inbounds` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "inbounds" DROP COLUMN "inv_sup",
DROP COLUMN "po_no",
DROP COLUMN "supplier";

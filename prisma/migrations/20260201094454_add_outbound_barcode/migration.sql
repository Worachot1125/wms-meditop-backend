/*
  Warnings:

  - A unique constraint covering the columns `[outbound_barcode]` on the table `outbounds` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "outbounds" ADD COLUMN     "outbound_barcode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "outbounds_outbound_barcode_key" ON "outbounds"("outbound_barcode");

/*
  Warnings:

  - The primary key for the `barcodes` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `exp_date_end` on the `barcodes` table. All the data in the column will be lost.
  - You are about to drop the column `exp_date_start` on the `barcodes` table. All the data in the column will be lost.
  - You are about to drop the column `lot_end` on the `barcodes` table. All the data in the column will be lost.
  - You are about to drop the column `sku` on the `barcodes` table. All the data in the column will be lost.
  - The `id` column on the `barcodes` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `lot_start` column on the `barcodes` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `barcode_length` column on the `barcodes` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - A unique constraint covering the columns `[barcode_id]` on the table `barcodes` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "barcodes" DROP CONSTRAINT "barcodes_pkey",
DROP COLUMN "exp_date_end",
DROP COLUMN "exp_date_start",
DROP COLUMN "lot_end",
DROP COLUMN "sku",
ADD COLUMN     "active" BOOLEAN DEFAULT true,
ADD COLUMN     "barcode_id" INTEGER,
ADD COLUMN     "barcode_last_modified_date" TIMESTAMP(3),
ADD COLUMN     "exp_start" INTEGER,
ADD COLUMN     "exp_stop" INTEGER,
ADD COLUMN     "internal_use" BOOLEAN DEFAULT false,
ADD COLUMN     "lot_stop" INTEGER,
ADD COLUMN     "product_code" TEXT,
ADD COLUMN     "product_id" INTEGER,
ADD COLUMN     "product_name" TEXT,
ADD COLUMN     "ratio" DOUBLE PRECISION,
ADD COLUMN     "tracking" TEXT,
ADD COLUMN     "wms_goods_id" INTEGER,
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
DROP COLUMN "lot_start",
ADD COLUMN     "lot_start" INTEGER,
DROP COLUMN "barcode_length",
ADD COLUMN     "barcode_length" INTEGER,
ADD CONSTRAINT "barcodes_pkey" PRIMARY KEY ("id");

-- CreateIndex
CREATE UNIQUE INDEX "barcodes_barcode_id_key" ON "barcodes"("barcode_id");

-- CreateIndex
CREATE INDEX "barcodes_barcode_id_idx" ON "barcodes"("barcode_id");

-- CreateIndex
CREATE INDEX "barcodes_product_id_idx" ON "barcodes"("product_id");

-- CreateIndex
CREATE INDEX "barcodes_wms_goods_id_idx" ON "barcodes"("wms_goods_id");

-- CreateIndex
CREATE INDEX "barcodes_barcode_idx" ON "barcodes"("barcode");

-- AddForeignKey
ALTER TABLE "barcodes" ADD CONSTRAINT "barcodes_wms_goods_id_fkey" FOREIGN KEY ("wms_goods_id") REFERENCES "wms_mdt_goods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

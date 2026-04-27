/*
  Warnings:

  - You are about to drop the column `ncr_location` on the `transfer_doc_items` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "transfer_doc_items" DROP COLUMN "ncr_location";

-- CreateTable
CREATE TABLE "transfer_doc_item_ncr_locations" (
    "id" SERIAL NOT NULL,
    "transfer_doc_item_id" TEXT NOT NULL,
    "location_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfer_doc_item_ncr_locations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transfer_doc_item_ncr_locations_transfer_doc_item_id_idx" ON "transfer_doc_item_ncr_locations"("transfer_doc_item_id");

-- CreateIndex
CREATE INDEX "transfer_doc_item_ncr_locations_location_id_idx" ON "transfer_doc_item_ncr_locations"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "transfer_doc_item_ncr_locations_transfer_doc_item_id_locati_key" ON "transfer_doc_item_ncr_locations"("transfer_doc_item_id", "location_id");

-- AddForeignKey
ALTER TABLE "transfer_doc_item_ncr_locations" ADD CONSTRAINT "transfer_doc_item_ncr_locations_transfer_doc_item_id_fkey" FOREIGN KEY ("transfer_doc_item_id") REFERENCES "transfer_doc_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_doc_item_ncr_locations" ADD CONSTRAINT "transfer_doc_item_ncr_locations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "swaps" ADD COLUMN     "dest_location" TEXT,
ADD COLUMN     "dest_location_id" INTEGER,
ADD COLUMN     "location_dest_id" INTEGER,
ADD COLUMN     "location_dest_name" TEXT,
ADD COLUMN     "odoo_location_dest_id" INTEGER;

-- CreateIndex
CREATE INDEX "swaps_location_dest_id_idx" ON "swaps"("location_dest_id");

-- AddForeignKey
ALTER TABLE "swaps" ADD CONSTRAINT "swaps_location_dest_id_fkey" FOREIGN KEY ("location_dest_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

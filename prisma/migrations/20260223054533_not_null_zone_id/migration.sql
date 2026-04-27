/*
  Warnings:

  - Made the column `zone_id` on table `locations` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "locations" DROP CONSTRAINT "locations_zone_id_fkey";

-- AlterTable
ALTER TABLE "locations" ALTER COLUMN "zone_id" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

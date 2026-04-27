-- DropForeignKey
ALTER TABLE "locations" DROP CONSTRAINT "locations_zone_id_fkey";

-- AlterTable
ALTER TABLE "locations" ALTER COLUMN "zone_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

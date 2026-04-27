/*
  Warnings:

  - The primary key for the `zones` table will be changed. If it partially fails, the table could be left without primary key constraint.

*/
-- DropForeignKey
ALTER TABLE "locations" DROP CONSTRAINT "locations_zone_id_fkey";

-- AlterTable
ALTER TABLE "locations" ALTER COLUMN "zone_id" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "zones" DROP CONSTRAINT "zones_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ADD CONSTRAINT "zones_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "zones_id_seq";

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

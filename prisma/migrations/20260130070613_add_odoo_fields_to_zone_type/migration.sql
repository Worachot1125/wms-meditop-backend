/*
  Warnings:

  - A unique constraint covering the columns `[station_id]` on the table `zone_types` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "zone_types" ADD COLUMN     "description" TEXT,
ADD COLUMN     "humidity_max" DOUBLE PRECISION,
ADD COLUMN     "humidity_min" DOUBLE PRECISION,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "sequence" INTEGER,
ADD COLUMN     "station_id" INTEGER,
ADD COLUMN     "station_name" TEXT,
ADD COLUMN     "temp_max" DOUBLE PRECISION,
ADD COLUMN     "temp_min" DOUBLE PRECISION;

-- CreateIndex
CREATE UNIQUE INDEX "zone_types_station_id_key" ON "zone_types"("station_id");

/*
  Warnings:

  - The primary key for the `buildings` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `buildings` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `locations` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `locations` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `zone_types` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `zone_types` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `zones` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `zones` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Changed the type of `zone_type_id` on the `goods` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `building_id` on the `locations` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `zone_id` on the `locations` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `building_id` on the `zones` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `zone_type_id` on the `zones` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- DropForeignKey
ALTER TABLE "goods" DROP CONSTRAINT "goods_zone_type_id_fkey";

-- DropForeignKey
ALTER TABLE "locations" DROP CONSTRAINT "locations_building_id_fkey";

-- DropForeignKey
ALTER TABLE "locations" DROP CONSTRAINT "locations_zone_id_fkey";

-- DropForeignKey
ALTER TABLE "zones" DROP CONSTRAINT "zones_building_id_fkey";

-- DropForeignKey
ALTER TABLE "zones" DROP CONSTRAINT "zones_zone_type_id_fkey";

-- AlterTable
ALTER TABLE "buildings" DROP CONSTRAINT "buildings_pkey",
ADD COLUMN     "building_code" TEXT,
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "buildings_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "goods" DROP COLUMN "zone_type_id",
ADD COLUMN     "zone_type_id" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "locations" DROP CONSTRAINT "locations_pkey",
ADD COLUMN     "location_code" TEXT,
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
DROP COLUMN "building_id",
ADD COLUMN     "building_id" INTEGER NOT NULL,
DROP COLUMN "zone_id",
ADD COLUMN     "zone_id" INTEGER NOT NULL,
ADD CONSTRAINT "locations_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "zone_types" DROP CONSTRAINT "zone_types_pkey",
ADD COLUMN     "zone_type_code" TEXT,
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "zone_types_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "zones" DROP CONSTRAINT "zones_pkey",
ADD COLUMN     "zone_code" TEXT,
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
DROP COLUMN "building_id",
ADD COLUMN     "building_id" INTEGER NOT NULL,
DROP COLUMN "zone_type_id",
ADD COLUMN     "zone_type_id" INTEGER NOT NULL,
ADD CONSTRAINT "zones_pkey" PRIMARY KEY ("id");

-- AddForeignKey
ALTER TABLE "zones" ADD CONSTRAINT "zones_building_id_fkey" FOREIGN KEY ("building_id") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zones" ADD CONSTRAINT "zones_zone_type_id_fkey" FOREIGN KEY ("zone_type_id") REFERENCES "zone_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_building_id_fkey" FOREIGN KEY ("building_id") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods" ADD CONSTRAINT "goods_zone_type_id_fkey" FOREIGN KEY ("zone_type_id") REFERENCES "zone_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

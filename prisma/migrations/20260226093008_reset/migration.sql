/*
  Warnings:

  - You are about to drop the column `in_process` on the `outbounds` table. All the data in the column will be lost.
  - You are about to drop the column `pick` on the `transfer_movement_items` table. All the data in the column will be lost.
  - You are about to drop the column `put` on the `transfer_movement_items` table. All the data in the column will be lost.
  - You are about to drop the column `user_work_id` on the `transfer_movements` table. All the data in the column will be lost.
  - You are about to drop the `transfer_movement_item_location_confirms` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[no]` on the table `transfer_movements` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "transfer_movement_item_location_confirms" DROP CONSTRAINT "transfer_movement_item_location_confirms_location_id_fkey";

-- DropForeignKey
ALTER TABLE "transfer_movement_item_location_confirms" DROP CONSTRAINT "transfer_movement_item_location_confirms_transfer_movement_fkey";

-- DropForeignKey
ALTER TABLE "transfer_movements" DROP CONSTRAINT "transfer_movements_user_work_id_fkey";

-- DropIndex
DROP INDEX "transfer_movements_user_work_id_idx";

-- AlterTable
ALTER TABLE "outbounds" DROP COLUMN "in_process";

-- AlterTable
ALTER TABLE "transfer_movement_items" DROP COLUMN "pick",
DROP COLUMN "put";

-- AlterTable
ALTER TABLE "transfer_movements" DROP COLUMN "user_work_id";

-- DropTable
DROP TABLE "transfer_movement_item_location_confirms";

-- CreateIndex
CREATE UNIQUE INDEX "transfer_movements_no_key" ON "transfer_movements"("no");

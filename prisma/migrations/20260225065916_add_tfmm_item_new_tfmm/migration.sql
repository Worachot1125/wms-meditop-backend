/*
  Warnings:

  - You are about to drop the column `expiration_date` on the `transfer_movements` table. All the data in the column will be lost.
  - You are about to drop the column `lock_no` on the `transfer_movements` table. All the data in the column will be lost.
  - You are about to drop the column `lot_serial` on the `transfer_movements` table. All the data in the column will be lost.
  - You are about to drop the column `name` on the `transfer_movements` table. All the data in the column will be lost.
  - You are about to drop the column `quantity` on the `transfer_movements` table. All the data in the column will be lost.
  - You are about to drop the column `unit` on the `transfer_movements` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[no]` on the table `transfer_movements` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "transfer_movements" DROP COLUMN "expiration_date",
DROP COLUMN "lock_no",
DROP COLUMN "lot_serial",
DROP COLUMN "name",
DROP COLUMN "quantity",
DROP COLUMN "unit",
ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'OPEN',
ALTER COLUMN "updated_at" DROP NOT NULL;

-- CreateTable
CREATE TABLE "transfer_movement_items" (
    "id" TEXT NOT NULL,
    "sequence" INTEGER,
    "product_id" INTEGER,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "lock_no" TEXT,
    "lot_serial" TEXT,
    "unit" TEXT NOT NULL,
    "exp" TIMESTAMP(3),
    "qty" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "transfer_movement_id" INTEGER,

    CONSTRAINT "transfer_movement_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transfer_movement_items_transfer_movement_id_product_id_idx" ON "transfer_movement_items"("transfer_movement_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "transfer_movements_no_key" ON "transfer_movements"("no");

-- CreateIndex
CREATE INDEX "transfer_movements_user_id_idx" ON "transfer_movements"("user_id");

-- CreateIndex
CREATE INDEX "transfer_movements_department_id_idx" ON "transfer_movements"("department_id");

-- AddForeignKey
ALTER TABLE "transfer_movement_items" ADD CONSTRAINT "transfer_movement_items_transfer_movement_id_fkey" FOREIGN KEY ("transfer_movement_id") REFERENCES "transfer_movements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

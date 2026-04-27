-- AlterTable
ALTER TABLE "transfer_movement_items" ADD COLUMN     "qty_pick" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "qty_put" INTEGER NOT NULL DEFAULT 0;

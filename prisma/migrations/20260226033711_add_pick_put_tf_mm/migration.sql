-- AlterTable
ALTER TABLE "transfer_movement_items" ADD COLUMN     "pick" INTEGER DEFAULT 0,
ADD COLUMN     "put" INTEGER DEFAULT 0;

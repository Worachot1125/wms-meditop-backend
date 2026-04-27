-- AlterTable
ALTER TABLE "bor_stocks" ADD COLUMN     "location_dest_owner" TEXT,
ADD COLUMN     "location_dest_owner_dispalay" TEXT,
ADD COLUMN     "location_owner" TEXT,
ADD COLUMN     "location_owner_display" TEXT;

-- AlterTable
ALTER TABLE "ser_stocks" ADD COLUMN     "location_dest_owner" TEXT,
ADD COLUMN     "location_dest_owner_dispalay" TEXT,
ADD COLUMN     "location_owner" TEXT,
ADD COLUMN     "location_owner_display" TEXT;

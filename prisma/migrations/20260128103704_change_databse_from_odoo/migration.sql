-- AlterTable
ALTER TABLE "goods_ins" ADD COLUMN     "code" TEXT,
ADD COLUMN     "lot_id" INTEGER,
ADD COLUMN     "lot_serial" TEXT,
ADD COLUMN     "product_id" INTEGER,
ADD COLUMN     "qty" INTEGER,
ADD COLUMN     "sequence" INTEGER,
ADD COLUMN     "tracking" TEXT,
ALTER COLUMN "quantity_receive" DROP NOT NULL,
ALTER COLUMN "quantity_count" DROP NOT NULL,
ALTER COLUMN "p_name" DROP NOT NULL;

-- AlterTable
ALTER TABLE "inbounds" ADD COLUMN     "department_id" TEXT,
ADD COLUMN     "location" TEXT,
ADD COLUMN     "location_dest" TEXT,
ADD COLUMN     "location_dest_id" INTEGER,
ADD COLUMN     "location_id" INTEGER,
ADD COLUMN     "origin" TEXT,
ADD COLUMN     "picking_id" INTEGER,
ADD COLUMN     "reference" TEXT,
ALTER COLUMN "sku" DROP NOT NULL,
ALTER COLUMN "lot" DROP NOT NULL,
ALTER COLUMN "quantity" DROP NOT NULL;

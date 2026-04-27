-- AlterTable
ALTER TABLE "buildings" ALTER COLUMN "remark" DROP NOT NULL;

-- AlterTable
ALTER TABLE "departments" ALTER COLUMN "remark" DROP NOT NULL;

-- AlterTable
ALTER TABLE "goods" ALTER COLUMN "remark" DROP NOT NULL;

-- AlterTable
ALTER TABLE "locations" ALTER COLUMN "remark" DROP NOT NULL;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "remark" DROP NOT NULL;

-- AlterTable
ALTER TABLE "zone_types" ALTER COLUMN "remark" DROP NOT NULL;

-- AlterTable
ALTER TABLE "zones" ALTER COLUMN "remark" DROP NOT NULL;

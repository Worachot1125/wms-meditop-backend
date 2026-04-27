/*
  Warnings:

  - Added the required column `product_id` to the `bor_stocks` table without a default value. This is not possible if the table is not empty.
  - Added the required column `source` to the `bor_stocks` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_at` to the `bor_stocks` table without a default value. This is not possible if the table is not empty.
  - Made the column `quantity` on table `bor_stocks` required. This step will fail if there are existing NULL values in that column.
  - Added the required column `product_id` to the `ser_stocks` table without a default value. This is not possible if the table is not empty.
  - Added the required column `source` to the `ser_stocks` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_at` to the `ser_stocks` table without a default value. This is not possible if the table is not empty.
  - Made the column `quantity` on table `ser_stocks` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "bor_stocks" ADD COLUMN     "active" BOOLEAN DEFAULT true,
ADD COLUMN     "count" INTEGER DEFAULT 0,
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "expiration_date" TIMESTAMP(3),
ADD COLUMN     "lot_id" INTEGER,
ADD COLUMN     "lot_name" TEXT,
ADD COLUMN     "product_code" TEXT,
ADD COLUMN     "product_id" INTEGER NOT NULL,
ADD COLUMN     "product_last_modified_date" VARCHAR(50),
ADD COLUMN     "product_name" TEXT,
ADD COLUMN     "source" TEXT NOT NULL,
ADD COLUMN     "unit" TEXT,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "quantity" SET NOT NULL,
ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(18,3);

-- AlterTable
ALTER TABLE "ser_stocks" ADD COLUMN     "active" BOOLEAN DEFAULT true,
ADD COLUMN     "count" INTEGER DEFAULT 0,
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "expiration_date" TIMESTAMP(3),
ADD COLUMN     "lot_id" INTEGER,
ADD COLUMN     "lot_name" TEXT,
ADD COLUMN     "product_code" TEXT,
ADD COLUMN     "product_id" INTEGER NOT NULL,
ADD COLUMN     "product_last_modified_date" VARCHAR(50),
ADD COLUMN     "product_name" TEXT,
ADD COLUMN     "source" TEXT NOT NULL,
ADD COLUMN     "unit" TEXT,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "quantity" SET NOT NULL,
ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(18,3);

/*
  Warnings:

  - The primary key for the `stocks` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `deleted_at` on the `stocks` table. All the data in the column will be lost.
  - You are about to drop the column `exp_date` on the `stocks` table. All the data in the column will be lost.
  - You are about to drop the column `lock_no` on the `stocks` table. All the data in the column will be lost.
  - You are about to drop the column `lot` on the `stocks` table. All the data in the column will be lost.
  - You are about to drop the column `name` on the `stocks` table. All the data in the column will be lost.
  - You are about to drop the column `sku` on the `stocks` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `stocks` table. All the data in the column will be lost.
  - The `id` column on the `stocks` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - A unique constraint covering the columns `[bucket_key]` on the table `stocks` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `bucket_key` to the `stocks` table without a default value. This is not possible if the table is not empty.
  - Added the required column `product_id` to the `stocks` table without a default value. This is not possible if the table is not empty.
  - Added the required column `source` to the `stocks` table without a default value. This is not possible if the table is not empty.
  - Made the column `updated_at` on table `stocks` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "stocks" DROP CONSTRAINT "stocks_pkey",
DROP COLUMN "deleted_at",
DROP COLUMN "exp_date",
DROP COLUMN "lock_no",
DROP COLUMN "lot",
DROP COLUMN "name",
DROP COLUMN "sku",
DROP COLUMN "status",
ADD COLUMN     "bucket_key" TEXT NOT NULL,
ADD COLUMN     "expiration_date" TIMESTAMP(3),
ADD COLUMN     "location_id" INTEGER,
ADD COLUMN     "location_name" TEXT,
ADD COLUMN     "lot_id" INTEGER,
ADD COLUMN     "lot_name" TEXT,
ADD COLUMN     "product_code" TEXT,
ADD COLUMN     "product_id" INTEGER NOT NULL,
ADD COLUMN     "product_last_modified_date" VARCHAR(50),
ADD COLUMN     "product_name" TEXT,
ADD COLUMN     "source" TEXT NOT NULL,
ADD COLUMN     "unit" TEXT,
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(18,3),
ALTER COLUMN "updated_at" SET NOT NULL,
ALTER COLUMN "count" DROP NOT NULL,
ADD CONSTRAINT "stocks_pkey" PRIMARY KEY ("id");

-- CreateIndex
CREATE UNIQUE INDEX "stocks_bucket_key_key" ON "stocks"("bucket_key");

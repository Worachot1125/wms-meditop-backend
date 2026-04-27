/*
  Warnings:

  - A unique constraint covering the columns `[no]` on the table `inbounds` will be added. If there are existing duplicate values, this will fail.
  - Made the column `no` on table `inbounds` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "inbounds" ALTER COLUMN "no" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "inbounds_no_key" ON "inbounds"("no");

/*
  Warnings:

  - A unique constraint covering the columns `[lock_no]` on the table `locations` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "locations_lock_no_key" ON "locations"("lock_no");

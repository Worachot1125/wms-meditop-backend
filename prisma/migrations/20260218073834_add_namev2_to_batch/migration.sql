/*
  Warnings:

  - A unique constraint covering the columns `[name]` on the table `batch_outbounds` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE INDEX "batch_outbounds_name_idx" ON "batch_outbounds"("name");

-- CreateIndex
CREATE UNIQUE INDEX "batch_outbounds_name_key" ON "batch_outbounds"("name");

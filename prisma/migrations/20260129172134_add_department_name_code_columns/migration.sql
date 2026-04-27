/*
  Warnings:

  - A unique constraint covering the columns `[odoo_id]` on the table `departments` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "departments" ADD COLUMN     "department_code" TEXT,
ADD COLUMN     "department_name" TEXT,
ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "last_synced_at" TIMESTAMP(3),
ADD COLUMN     "odoo_id" INTEGER;

-- CreateTable
CREATE TABLE "odoo_sync_logs" (
    "id" SERIAL NOT NULL,
    "entity_type" TEXT NOT NULL,
    "sync_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "records_fetched" INTEGER,
    "records_created" INTEGER,
    "records_updated" INTEGER,
    "records_disabled" INTEGER,
    "error_message" TEXT,
    "triggered_by" TEXT,

    CONSTRAINT "odoo_sync_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "departments_odoo_id_key" ON "departments"("odoo_id");

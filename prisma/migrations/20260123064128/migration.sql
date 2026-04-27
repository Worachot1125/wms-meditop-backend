/*
  Warnings:

  - Made the column `doc_barcode` on table `doc_invoices` required. This step will fail if there are existing NULL values in that column.
  - Made the column `invoice_barcode` on table `invoices` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "doc_invoices" ALTER COLUMN "doc_barcode" SET NOT NULL;

-- AlterTable
ALTER TABLE "invoices" ALTER COLUMN "invoice_barcode" SET NOT NULL;

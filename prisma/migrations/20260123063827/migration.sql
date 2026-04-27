/*
  Warnings:

  - A unique constraint covering the columns `[doc_barcode]` on the table `doc_invoices` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[invoice_barcode]` on the table `invoices` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "doc_invoices" ADD COLUMN     "doc_barcode" TEXT;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "invoice_barcode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "doc_invoices_doc_barcode_key" ON "doc_invoices"("doc_barcode");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_invoice_barcode_key" ON "invoices"("invoice_barcode");

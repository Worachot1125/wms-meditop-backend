-- DropForeignKey
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_doc_invoice_id_fkey";

-- AlterTable
ALTER TABLE "invoices" ALTER COLUMN "doc_invoice_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_doc_invoice_id_fkey" FOREIGN KEY ("doc_invoice_id") REFERENCES "doc_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

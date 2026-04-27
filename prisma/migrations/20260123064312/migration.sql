-- AlterTable
ALTER TABLE "doc_invoices" ALTER COLUMN "doc_barcode" DROP NOT NULL;

-- AlterTable
ALTER TABLE "invoices" ALTER COLUMN "invoice_barcode" DROP NOT NULL;

-- AlterTable
ALTER TABLE "adjust_lot_logs" ADD COLUMN     "api_key_hash" TEXT,
ADD COLUMN     "api_key_masked" TEXT,
ADD COLUMN     "request_headers" JSONB;

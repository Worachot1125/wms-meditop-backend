-- AlterTable
ALTER TABLE "outbound_lot_adjustment" ADD COLUMN     "odoo_payload_fragment" JSONB,
ADD COLUMN     "queue_no" INTEGER,
ADD COLUMN     "send_error" TEXT,
ADD COLUMN     "sent_at" TIMESTAMP(3),
ALTER COLUMN "status" SET DEFAULT 'pending';

-- CreateIndex
CREATE INDEX "outbound_lot_adjustment_queue_no_idx" ON "outbound_lot_adjustment"("queue_no");

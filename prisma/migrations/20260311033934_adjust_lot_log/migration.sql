-- CreateTable
CREATE TABLE "adjust_lot_logs" (
    "id" SERIAL NOT NULL,
    "outbound_id" INTEGER,
    "goods_out_item_id" INTEGER,
    "outbound_no" TEXT,
    "event_name" TEXT,
    "request_path" TEXT,
    "odoo_url" TEXT,
    "request_body" JSONB,
    "response_body" JSONB,
    "response_status" INTEGER,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "adjust_lot_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "adjust_lot_logs_outbound_id_idx" ON "adjust_lot_logs"("outbound_id");

-- CreateIndex
CREATE INDEX "adjust_lot_logs_goods_out_item_id_idx" ON "adjust_lot_logs"("goods_out_item_id");

-- CreateIndex
CREATE INDEX "adjust_lot_logs_outbound_no_idx" ON "adjust_lot_logs"("outbound_no");

-- CreateIndex
CREATE INDEX "adjust_lot_logs_success_idx" ON "adjust_lot_logs"("success");

-- CreateIndex
CREATE INDEX "adjust_lot_logs_started_at_idx" ON "adjust_lot_logs"("started_at");

-- AddForeignKey
ALTER TABLE "adjust_lot_logs" ADD CONSTRAINT "adjust_lot_logs_outbound_id_fkey" FOREIGN KEY ("outbound_id") REFERENCES "outbounds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjust_lot_logs" ADD CONSTRAINT "adjust_lot_logs_goods_out_item_id_fkey" FOREIGN KEY ("goods_out_item_id") REFERENCES "goods_out_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

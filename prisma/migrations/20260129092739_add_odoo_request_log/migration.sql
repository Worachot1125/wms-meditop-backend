-- CreateTable
CREATE TABLE "odoo_request_logs" (
    "id" SERIAL NOT NULL,
    "endpoint" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "request_body" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" TEXT,
    "error_message" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "odoo_request_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "odoo_request_logs_created_at_idx" ON "odoo_request_logs"("created_at");

-- CreateIndex
CREATE INDEX "odoo_request_logs_endpoint_idx" ON "odoo_request_logs"("endpoint");

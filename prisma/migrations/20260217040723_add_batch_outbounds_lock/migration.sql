-- CreateTable
CREATE TABLE "batch_outbounds" (
    "id" SERIAL NOT NULL,
    "outbound_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),

    CONSTRAINT "batch_outbounds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "batch_outbounds_outbound_id_key" ON "batch_outbounds"("outbound_id");

-- CreateIndex
CREATE INDEX "batch_outbounds_user_id_idx" ON "batch_outbounds"("user_id");

-- CreateIndex
CREATE INDEX "batch_outbounds_status_idx" ON "batch_outbounds"("status");

-- AddForeignKey
ALTER TABLE "batch_outbounds" ADD CONSTRAINT "batch_outbounds_outbound_id_fkey" FOREIGN KEY ("outbound_id") REFERENCES "outbounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_outbounds" ADD CONSTRAINT "batch_outbounds_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

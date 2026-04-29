-- CreateTable
CREATE TABLE "adjust_location_confirms" (
    "id" SERIAL NOT NULL,
    "adjustment_id" INTEGER NOT NULL,
    "adjustment_item_id" INTEGER NOT NULL,
    "location_id" INTEGER,
    "location_name" TEXT NOT NULL,
    "confirmed_qty" INTEGER NOT NULL DEFAULT 0,
    "user_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "adjust_location_confirms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "adjust_location_confirms_adjustment_id_idx" ON "adjust_location_confirms"("adjustment_id");

-- CreateIndex
CREATE INDEX "adjust_location_confirms_adjustment_item_id_idx" ON "adjust_location_confirms"("adjustment_item_id");

-- CreateIndex
CREATE INDEX "adjust_location_confirms_location_id_idx" ON "adjust_location_confirms"("location_id");

-- CreateIndex
CREATE INDEX "adjust_location_confirms_location_name_idx" ON "adjust_location_confirms"("location_name");

-- AddForeignKey
ALTER TABLE "adjust_location_confirms" ADD CONSTRAINT "adjust_location_confirms_adjustment_id_fkey" FOREIGN KEY ("adjustment_id") REFERENCES "adjustments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjust_location_confirms" ADD CONSTRAINT "adjust_location_confirms_adjustment_item_id_fkey" FOREIGN KEY ("adjustment_item_id") REFERENCES "adjustment_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

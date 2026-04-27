-- CreateTable
CREATE TABLE "transfer_movement_item_location_confirms" (
    "id" SERIAL NOT NULL,
    "transfer_movement_item_id" TEXT NOT NULL,
    "location_id" INTEGER NOT NULL,
    "confirmed_qty" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfer_movement_item_location_confirms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transfer_movement_item_location_confirms_transfer_movement__idx" ON "transfer_movement_item_location_confirms"("transfer_movement_item_id");

-- CreateIndex
CREATE INDEX "transfer_movement_item_location_confirms_location_id_idx" ON "transfer_movement_item_location_confirms"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "transfer_movement_item_location_confirms_transfer_movement__key" ON "transfer_movement_item_location_confirms"("transfer_movement_item_id", "location_id");

-- AddForeignKey
ALTER TABLE "transfer_movement_item_location_confirms" ADD CONSTRAINT "transfer_movement_item_location_confirms_transfer_movement_fkey" FOREIGN KEY ("transfer_movement_item_id") REFERENCES "transfer_movement_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_movement_item_location_confirms" ADD CONSTRAINT "transfer_movement_item_location_confirms_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

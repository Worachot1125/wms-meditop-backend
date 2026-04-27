-- CreateTable
CREATE TABLE "goods_in_location_confirm" (
    "id" SERIAL NOT NULL,
    "goods_in_id" TEXT NOT NULL,
    "location_id" INTEGER NOT NULL,
    "confirmed_qty" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_in_location_confirm_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "goods_in_location_confirm_goods_in_id_idx" ON "goods_in_location_confirm"("goods_in_id");

-- CreateIndex
CREATE INDEX "goods_in_location_confirm_location_id_idx" ON "goods_in_location_confirm"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_in_location_confirm_goods_in_id_location_id_key" ON "goods_in_location_confirm"("goods_in_id", "location_id");

-- AddForeignKey
ALTER TABLE "goods_in_location_confirm" ADD CONSTRAINT "goods_in_location_confirm_goods_in_id_fkey" FOREIGN KEY ("goods_in_id") REFERENCES "goods_ins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_in_location_confirm" ADD CONSTRAINT "goods_in_location_confirm_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "inbounds" (
    "gr" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "lot" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "in_type" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "supplier" TEXT,
    "po_no" TEXT,
    "inv_sup" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "inbounds_pkey" PRIMARY KEY ("gr")
);

-- CreateTable
CREATE TABLE "goods_ins" (
    "id" TEXT NOT NULL,
    "gr_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity_receive" INTEGER NOT NULL,
    "quantity_count" INTEGER NOT NULL,
    "unit" TEXT NOT NULL,
    "zone_type" TEXT,
    "lot" TEXT,
    "exp" TIMESTAMP(3),
    "barcode13" TEXT,
    "qr_payload" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "goods_ins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "goods_ins_barcode13_key" ON "goods_ins"("barcode13");

-- AddForeignKey
ALTER TABLE "goods_ins" ADD CONSTRAINT "goods_ins_gr_id_fkey" FOREIGN KEY ("gr_id") REFERENCES "inbounds"("gr") ON DELETE RESTRICT ON UPDATE CASCADE;

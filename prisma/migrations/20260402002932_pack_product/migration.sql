-- CreateTable
CREATE TABLE "pack_products" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "scan_prefix" TEXT NOT NULL,
    "max_box" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'process',
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "pack_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pack_product_outbounds" (
    "id" SERIAL NOT NULL,
    "pack_product_id" INTEGER NOT NULL,
    "outbound_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pack_product_outbounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pack_product_boxes" (
    "id" SERIAL NOT NULL,
    "pack_product_id" INTEGER NOT NULL,
    "box_no" INTEGER NOT NULL,
    "box_max" INTEGER NOT NULL,
    "box_label" TEXT NOT NULL,
    "box_code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "pack_product_boxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pack_product_box_items" (
    "id" SERIAL NOT NULL,
    "pack_product_box_id" INTEGER NOT NULL,
    "goods_out_item_id" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "pack_product_box_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pack_products_name_key" ON "pack_products"("name");

-- CreateIndex
CREATE INDEX "pack_products_name_idx" ON "pack_products"("name");

-- CreateIndex
CREATE INDEX "pack_products_scan_prefix_idx" ON "pack_products"("scan_prefix");

-- CreateIndex
CREATE INDEX "pack_product_outbounds_outbound_id_idx" ON "pack_product_outbounds"("outbound_id");

-- CreateIndex
CREATE UNIQUE INDEX "pack_product_outbounds_pack_product_id_outbound_id_key" ON "pack_product_outbounds"("pack_product_id", "outbound_id");

-- CreateIndex
CREATE INDEX "pack_product_boxes_pack_product_id_status_idx" ON "pack_product_boxes"("pack_product_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pack_product_boxes_pack_product_id_box_no_key" ON "pack_product_boxes"("pack_product_id", "box_no");

-- CreateIndex
CREATE INDEX "pack_product_box_items_goods_out_item_id_idx" ON "pack_product_box_items"("goods_out_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "pack_product_box_items_pack_product_box_id_goods_out_item_i_key" ON "pack_product_box_items"("pack_product_box_id", "goods_out_item_id");

-- AddForeignKey
ALTER TABLE "pack_product_outbounds" ADD CONSTRAINT "pack_product_outbounds_pack_product_id_fkey" FOREIGN KEY ("pack_product_id") REFERENCES "pack_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pack_product_outbounds" ADD CONSTRAINT "pack_product_outbounds_outbound_id_fkey" FOREIGN KEY ("outbound_id") REFERENCES "outbounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pack_product_boxes" ADD CONSTRAINT "pack_product_boxes_pack_product_id_fkey" FOREIGN KEY ("pack_product_id") REFERENCES "pack_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pack_product_box_items" ADD CONSTRAINT "pack_product_box_items_pack_product_box_id_fkey" FOREIGN KEY ("pack_product_box_id") REFERENCES "pack_product_boxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pack_product_box_items" ADD CONSTRAINT "pack_product_box_items_goods_out_item_id_fkey" FOREIGN KEY ("goods_out_item_id") REFERENCES "goods_out_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

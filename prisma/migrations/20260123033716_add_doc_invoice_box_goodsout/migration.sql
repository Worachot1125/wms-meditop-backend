-- CreateTable
CREATE TABLE "doc_invoices" (
    "id" TEXT NOT NULL,
    "doc_invoice" TEXT NOT NULL,
    "out_type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "doc_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "no" TEXT NOT NULL,
    "doc_invoice_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_outs" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lock_no" TEXT NOT NULL,
    "lock_name" TEXT NOT NULL,
    "lot" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "pick" INTEGER NOT NULL,
    "pack" INTEGER NOT NULL,
    "box_id" INTEGER,

    CONSTRAINT "goods_outs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_items" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "goods_out_id" TEXT NOT NULL,
    "qty" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "boxes" (
    "id" SERIAL NOT NULL,
    "box_code" TEXT,
    "box_name" TEXT,

    CONSTRAINT "boxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_out_boxes" (
    "id" TEXT NOT NULL,
    "goods_out_id" TEXT NOT NULL,
    "box_id" INTEGER NOT NULL,
    "quantity" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_out_boxes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "doc_invoices_doc_invoice_key" ON "doc_invoices"("doc_invoice");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_no_key" ON "invoices"("no");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_items_invoice_id_goods_out_id_key" ON "invoice_items"("invoice_id", "goods_out_id");

-- CreateIndex
CREATE UNIQUE INDEX "boxes_box_code_key" ON "boxes"("box_code");

-- CreateIndex
CREATE UNIQUE INDEX "goods_out_boxes_goods_out_id_box_id_key" ON "goods_out_boxes"("goods_out_id", "box_id");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_doc_invoice_id_fkey" FOREIGN KEY ("doc_invoice_id") REFERENCES "doc_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_goods_out_id_fkey" FOREIGN KEY ("goods_out_id") REFERENCES "goods_outs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_out_boxes" ADD CONSTRAINT "goods_out_boxes_goods_out_id_fkey" FOREIGN KEY ("goods_out_id") REFERENCES "goods_outs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_out_boxes" ADD CONSTRAINT "goods_out_boxes_box_id_fkey" FOREIGN KEY ("box_id") REFERENCES "boxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

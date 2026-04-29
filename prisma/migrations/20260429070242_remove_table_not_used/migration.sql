/*
  Warnings:

  - You are about to drop the `boxes` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `doc_invoices` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `goods_out_boxes` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `goods_out_item_boxes` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `goods_outs` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `invoice_items` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `invoices` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `lots` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "goods_out_boxes" DROP CONSTRAINT "goods_out_boxes_box_id_fkey";

-- DropForeignKey
ALTER TABLE "goods_out_boxes" DROP CONSTRAINT "goods_out_boxes_goods_out_id_fkey";

-- DropForeignKey
ALTER TABLE "goods_out_item_boxes" DROP CONSTRAINT "goods_out_item_boxes_box_id_fkey";

-- DropForeignKey
ALTER TABLE "goods_out_item_boxes" DROP CONSTRAINT "goods_out_item_boxes_item_id_fkey";

-- DropForeignKey
ALTER TABLE "goods_outs" DROP CONSTRAINT "goods_outs_lot_no_fkey";

-- DropForeignKey
ALTER TABLE "invoice_items" DROP CONSTRAINT "invoice_items_goods_out_id_fkey";

-- DropForeignKey
ALTER TABLE "invoice_items" DROP CONSTRAINT "invoice_items_invoice_id_fkey";

-- DropForeignKey
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_doc_invoice_id_fkey";

-- DropTable
DROP TABLE "boxes";

-- DropTable
DROP TABLE "doc_invoices";

-- DropTable
DROP TABLE "goods_out_boxes";

-- DropTable
DROP TABLE "goods_out_item_boxes";

-- DropTable
DROP TABLE "goods_outs";

-- DropTable
DROP TABLE "invoice_items";

-- DropTable
DROP TABLE "invoices";

-- DropTable
DROP TABLE "lots";

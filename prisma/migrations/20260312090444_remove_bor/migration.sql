/*
  Warnings:

  - You are about to drop the column `barcode_text` on the `borrow_stock_items` table. All the data in the column will be lost.
  - You are about to drop the column `lot_id` on the `borrow_stock_items` table. All the data in the column will be lost.
  - You are about to drop the column `odoo_line_key` on the `borrow_stock_items` table. All the data in the column will be lost.
  - You are about to drop the column `product_id` on the `borrow_stock_items` table. All the data in the column will be lost.
  - You are about to drop the column `source_sequence` on the `borrow_stock_items` table. All the data in the column will be lost.
  - You are about to drop the column `tracking` on the `borrow_stock_items` table. All the data in the column will be lost.
  - You are about to drop the column `unit` on the `borrow_stock_items` table. All the data in the column will be lost.
  - You are about to drop the column `location_id` on the `borrow_stocks` table. All the data in the column will be lost.
  - You are about to drop the column `name` on the `borrow_stocks` table. All the data in the column will be lost.
  - You are about to drop the column `no` on the `borrow_stocks` table. All the data in the column will be lost.
  - You are about to drop the column `odoo_location_id` on the `borrow_stocks` table. All the data in the column will be lost.
  - You are about to drop the column `origin` on the `borrow_stocks` table. All the data in the column will be lost.
  - You are about to drop the column `picking_id` on the `borrow_stocks` table. All the data in the column will be lost.
  - You are about to drop the column `reference` on the `borrow_stocks` table. All the data in the column will be lost.
  - You are about to drop the column `source_location` on the `borrow_stocks` table. All the data in the column will be lost.
  - You are about to drop the column `source_location_id` on the `borrow_stocks` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "borrow_stocks" DROP CONSTRAINT "borrow_stocks_location_id_fkey";

-- DropIndex
DROP INDEX "borrow_stock_items_borrow_stock_id_product_id_idx";

-- DropIndex
DROP INDEX "borrow_stock_items_odoo_line_key_idx";

-- DropIndex
DROP INDEX "borrow_stocks_location_id_idx";

-- DropIndex
DROP INDEX "borrow_stocks_name_idx";

-- DropIndex
DROP INDEX "borrow_stocks_picking_id_idx";

-- DropIndex
DROP INDEX "borrow_stocks_status_idx";

-- AlterTable
ALTER TABLE "borrow_stock_items" DROP COLUMN "barcode_text",
DROP COLUMN "lot_id",
DROP COLUMN "odoo_line_key",
DROP COLUMN "product_id",
DROP COLUMN "source_sequence",
DROP COLUMN "tracking",
DROP COLUMN "unit";

-- AlterTable
ALTER TABLE "borrow_stocks" DROP COLUMN "location_id",
DROP COLUMN "name",
DROP COLUMN "no",
DROP COLUMN "odoo_location_id",
DROP COLUMN "origin",
DROP COLUMN "picking_id",
DROP COLUMN "reference",
DROP COLUMN "source_location",
DROP COLUMN "source_location_id";

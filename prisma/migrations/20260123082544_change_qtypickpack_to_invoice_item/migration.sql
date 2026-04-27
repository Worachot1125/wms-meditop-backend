/*
  Warnings:

  - You are about to drop the column `qty` on the `invoice_items` table. All the data in the column will be lost.
  - You are about to drop the column `pack` on the `invoices` table. All the data in the column will be lost.
  - You are about to drop the column `pick` on the `invoices` table. All the data in the column will be lost.
  - You are about to drop the column `quantity` on the `invoices` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "invoice_items" DROP COLUMN "qty",
ADD COLUMN     "pack" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pick" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "updated_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "invoices" DROP COLUMN "pack",
DROP COLUMN "pick",
DROP COLUMN "quantity";

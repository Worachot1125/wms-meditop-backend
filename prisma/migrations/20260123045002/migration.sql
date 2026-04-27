/*
  Warnings:

  - You are about to drop the column `pack` on the `goods_outs` table. All the data in the column will be lost.
  - You are about to drop the column `pick` on the `goods_outs` table. All the data in the column will be lost.
  - You are about to drop the column `quantity` on the `goods_outs` table. All the data in the column will be lost.
  - Added the required column `pack` to the `invoices` table without a default value. This is not possible if the table is not empty.
  - Added the required column `pick` to the `invoices` table without a default value. This is not possible if the table is not empty.
  - Added the required column `quantity` to the `invoices` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "goods_outs" DROP COLUMN "pack",
DROP COLUMN "pick",
DROP COLUMN "quantity";

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "pack" INTEGER NOT NULL,
ADD COLUMN     "pick" INTEGER NOT NULL,
ADD COLUMN     "quantity" INTEGER NOT NULL;

/*
  Warnings:

  - The primary key for the `inbounds` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `gr` on the `inbounds` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "goods_ins" DROP CONSTRAINT "goods_ins_gr_id_fkey";

-- AlterTable
ALTER TABLE "goods_ins" ADD COLUMN     "inbound_id" INTEGER;

-- AlterTable
ALTER TABLE "inbounds" DROP CONSTRAINT "inbounds_pkey",
DROP COLUMN "gr",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "inbounds_pkey" PRIMARY KEY ("id");

-- AddForeignKey
ALTER TABLE "goods_ins" ADD CONSTRAINT "goods_ins_inbound_id_fkey" FOREIGN KEY ("inbound_id") REFERENCES "inbounds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

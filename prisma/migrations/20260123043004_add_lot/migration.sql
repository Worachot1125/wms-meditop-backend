/*
  Warnings:

  - You are about to drop the column `lot` on the `goods_outs` table. All the data in the column will be lost.
  - Added the required column `lot_no` to the `goods_outs` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "goods_outs" DROP COLUMN "lot",
ADD COLUMN     "lot_no" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "lots" (
    "no" TEXT NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "lots_pkey" PRIMARY KEY ("no")
);

-- AddForeignKey
ALTER TABLE "goods_outs" ADD CONSTRAINT "goods_outs_lot_no_fkey" FOREIGN KEY ("lot_no") REFERENCES "lots"("no") ON DELETE RESTRICT ON UPDATE CASCADE;

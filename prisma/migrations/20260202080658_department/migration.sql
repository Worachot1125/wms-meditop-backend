/*
  Warnings:

  - The primary key for the `departments` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `departments` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Changed the type of `department_id` on the `goods` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `department_id` on the `user_departments` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- DropForeignKey
ALTER TABLE "goods" DROP CONSTRAINT "goods_department_id_fkey";

-- DropForeignKey
ALTER TABLE "user_departments" DROP CONSTRAINT "user_departments_department_id_fkey";

-- AlterTable
ALTER TABLE "departments" DROP CONSTRAINT "departments_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "departments_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "goods" DROP COLUMN "department_id",
ADD COLUMN     "department_id" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "user_departments" DROP COLUMN "department_id",
ADD COLUMN     "department_id" INTEGER NOT NULL;

-- CreateIndex
CREATE INDEX "user_departments_department_id_idx" ON "user_departments"("department_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_departments_user_id_department_id_key" ON "user_departments"("user_id", "department_id");

-- AddForeignKey
ALTER TABLE "user_departments" ADD CONSTRAINT "user_departments_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods" ADD CONSTRAINT "goods_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

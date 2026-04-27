/*
  Warnings:

  - Added the required column `department_id` to the `transfer_movements` table without a default value. This is not possible if the table is not empty.
  - Added the required column `user_id` to the `transfer_movements` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "transfer_movements" ADD COLUMN     "department_id" INTEGER NOT NULL,
ADD COLUMN     "user_id" INTEGER NOT NULL;

-- AddForeignKey
ALTER TABLE "transfer_movements" ADD CONSTRAINT "transfer_movements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_movements" ADD CONSTRAINT "transfer_movements_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

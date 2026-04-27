-- DropIndex
DROP INDEX "transfer_movements_no_key";

-- AlterTable
ALTER TABLE "transfer_movements" ADD COLUMN     "user_work_id" INTEGER;

-- AddForeignKey
ALTER TABLE "transfer_movements" ADD CONSTRAINT "transfer_movements_user_work_id_fkey" FOREIGN KEY ("user_work_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

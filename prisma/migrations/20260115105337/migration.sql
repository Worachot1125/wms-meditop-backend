-- AlterTable
ALTER TABLE "goods_ins" ADD COLUMN     "deleted_at" TIMESTAMP(3),
ALTER COLUMN "updated_at" DROP NOT NULL;

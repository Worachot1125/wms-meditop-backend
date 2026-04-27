/*
  Warnings:

  - You are about to drop the column `department_id` on the `users` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "users" DROP CONSTRAINT "users_department_id_fkey";

-- AlterTable
ALTER TABLE "users" DROP COLUMN "department_id";

-- CreateTable
CREATE TABLE "user_departments" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "department_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_departments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_departments_department_id_idx" ON "user_departments"("department_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_departments_user_id_department_id_key" ON "user_departments"("user_id", "department_id");

-- AddForeignKey
ALTER TABLE "user_departments" ADD CONSTRAINT "user_departments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_departments" ADD CONSTRAINT "user_departments_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

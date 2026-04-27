-- CreateTable
CREATE TABLE "transfer_movement_departments" (
    "id" SERIAL NOT NULL,
    "transfer_movement_id" INTEGER NOT NULL,
    "department_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfer_movement_departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_movement_user_works" (
    "id" SERIAL NOT NULL,
    "transfer_movement_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfer_movement_user_works_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transfer_movement_departments_department_id_idx" ON "transfer_movement_departments"("department_id");

-- CreateIndex
CREATE INDEX "transfer_movement_departments_transfer_movement_id_idx" ON "transfer_movement_departments"("transfer_movement_id");

-- CreateIndex
CREATE UNIQUE INDEX "transfer_movement_departments_transfer_movement_id_departme_key" ON "transfer_movement_departments"("transfer_movement_id", "department_id");

-- CreateIndex
CREATE INDEX "transfer_movement_user_works_user_id_idx" ON "transfer_movement_user_works"("user_id");

-- CreateIndex
CREATE INDEX "transfer_movement_user_works_transfer_movement_id_idx" ON "transfer_movement_user_works"("transfer_movement_id");

-- CreateIndex
CREATE UNIQUE INDEX "transfer_movement_user_works_transfer_movement_id_user_id_key" ON "transfer_movement_user_works"("transfer_movement_id", "user_id");

-- AddForeignKey
ALTER TABLE "transfer_movement_departments" ADD CONSTRAINT "transfer_movement_departments_transfer_movement_id_fkey" FOREIGN KEY ("transfer_movement_id") REFERENCES "transfer_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_movement_departments" ADD CONSTRAINT "transfer_movement_departments_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_movement_user_works" ADD CONSTRAINT "transfer_movement_user_works_transfer_movement_id_fkey" FOREIGN KEY ("transfer_movement_id") REFERENCES "transfer_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_movement_user_works" ADD CONSTRAINT "transfer_movement_user_works_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

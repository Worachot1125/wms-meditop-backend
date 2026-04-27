-- CreateTable
CREATE TABLE "borrow_stock_departments" (
    "id" SERIAL NOT NULL,
    "borrow_stock_id" INTEGER NOT NULL,
    "department_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "borrow_stock_departments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "borrow_stock_departments_borrow_stock_id_idx" ON "borrow_stock_departments"("borrow_stock_id");

-- CreateIndex
CREATE INDEX "borrow_stock_departments_department_id_idx" ON "borrow_stock_departments"("department_id");

-- CreateIndex
CREATE UNIQUE INDEX "borrow_stock_departments_borrow_stock_id_department_id_key" ON "borrow_stock_departments"("borrow_stock_id", "department_id");

-- AddForeignKey
ALTER TABLE "borrow_stock_departments" ADD CONSTRAINT "borrow_stock_departments_borrow_stock_id_fkey" FOREIGN KEY ("borrow_stock_id") REFERENCES "borrow_stocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "borrow_stock_departments" ADD CONSTRAINT "borrow_stock_departments_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

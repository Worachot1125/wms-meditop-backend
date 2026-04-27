-- CreateTable
CREATE TABLE "borrow_stocks" (
    "id" SERIAL NOT NULL,
    "location_name" TEXT NOT NULL,
    "department_id" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "user_ref" TEXT,
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "borrow_stocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "borrow_stock_items" (
    "id" SERIAL NOT NULL,
    "borrow_stock_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "lot_serial" TEXT NOT NULL,
    "expiration_date" TIMESTAMP(3),
    "system_qty" INTEGER NOT NULL,
    "executed_qty" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "borrow_stock_items_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "borrow_stocks" ADD CONSTRAINT "borrow_stocks_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "borrow_stock_items" ADD CONSTRAINT "borrow_stock_items_borrow_stock_id_fkey" FOREIGN KEY ("borrow_stock_id") REFERENCES "borrow_stocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

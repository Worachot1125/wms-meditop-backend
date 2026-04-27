-- CreateTable
CREATE TABLE "transfer_movements" (
    "id" SERIAL NOT NULL,
    "no" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lock_no" TEXT NOT NULL,
    "lot_serial" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit" TEXT NOT NULL,
    "expiration_date" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfer_movements_pkey" PRIMARY KEY ("id")
);

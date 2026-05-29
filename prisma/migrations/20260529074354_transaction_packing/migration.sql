-- CreateTable
CREATE TABLE "transaction_packing" (
    "id" SERIAL NOT NULL,
    "ignore_max_box" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "transaction_packing_pkey" PRIMARY KEY ("id")
);

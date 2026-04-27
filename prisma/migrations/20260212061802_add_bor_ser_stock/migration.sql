-- CreateTable
CREATE TABLE "bor_stocks" (
    "id" SERIAL NOT NULL,
    "snapshot_date" TIMESTAMP(3),
    "no" TEXT,
    "user_pick" TEXT,
    "quantity" INTEGER,
    "location_id" INTEGER,
    "location_name" TEXT,

    CONSTRAINT "bor_stocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ser_stocks" (
    "id" SERIAL NOT NULL,
    "snapshot_date" TIMESTAMP(3),
    "no" TEXT,
    "user_pick" TEXT,
    "quantity" INTEGER,
    "location_id" INTEGER,
    "location_name" TEXT,

    CONSTRAINT "ser_stocks_pkey" PRIMARY KEY ("id")
);

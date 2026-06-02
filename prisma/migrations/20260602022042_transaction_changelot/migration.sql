-- CreateTable
CREATE TABLE "transaction_changelot" (
    "id" SERIAL NOT NULL,
    "ignore_changelot" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "transaction_changelot_pkey" PRIMARY KEY ("id")
);

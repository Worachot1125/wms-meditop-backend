-- CreateTable
CREATE TABLE "transports_bkk" (
    "id" SERIAL NOT NULL,
    "full_name" TEXT NOT NULL,
    "barcode_text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "transports_bkk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "barcode_count_departments" (
    "id" SERIAL NOT NULL,
    "department_code" TEXT,
    "barcode_count" TEXT,

    CONSTRAINT "barcode_count_departments_pkey" PRIMARY KEY ("id")
);

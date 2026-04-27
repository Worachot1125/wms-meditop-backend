/*
  Warnings:

  - Made the column `count` on table `stocks` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "stocks" ALTER COLUMN "count" SET NOT NULL;

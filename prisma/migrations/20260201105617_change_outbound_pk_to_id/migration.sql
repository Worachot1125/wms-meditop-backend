/*
  Warnings:

  - The primary key for the `goods_out_items` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `out_no` on the `goods_out_items` table. All the data in the column will be lost.
  - The `id` column on the `goods_out_items` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `outbounds` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - A unique constraint covering the columns `[no]` on the table `outbounds` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `outbound_id` to the `goods_out_items` table without a default value. This is not possible if the table is not empty.

*/

-- Step 1: เพิ่ม id column ใหม่ใน outbounds (ยังไม่เป็น PK)
ALTER TABLE "outbounds" ADD COLUMN "id" SERIAL;

-- Step 2: เพิ่ม temporary column ใน goods_out_items เพื่อเก็บ out_no เดิม
ALTER TABLE "goods_out_items" ADD COLUMN "temp_out_no" TEXT;
UPDATE "goods_out_items" SET "temp_out_no" = "out_no";

-- Step 3: ลบ FK constraint เดิม
ALTER TABLE "goods_out_items" DROP CONSTRAINT IF EXISTS "goods_out_items_out_no_fkey";

-- Step 4: เพิ่ม outbound_id และ map ข้อมูลจาก out_no -> outbound.id
ALTER TABLE "goods_out_items" ADD COLUMN "outbound_id" INTEGER;
UPDATE "goods_out_items" 
SET "outbound_id" = "outbounds"."id" 
FROM "outbounds" 
WHERE "goods_out_items"."temp_out_no" = "outbounds"."no";

-- Step 5: ทำให้ outbound_id เป็น NOT NULL
ALTER TABLE "goods_out_items" ALTER COLUMN "outbound_id" SET NOT NULL;

-- Step 6: เปลี่ยน PK ของ outbounds
ALTER TABLE "outbounds" DROP CONSTRAINT "outbounds_pkey";
ALTER TABLE "outbounds" ADD CONSTRAINT "outbounds_pkey" PRIMARY KEY ("id");

-- Step 7: สร้าง unique constraint สำหรับ no
CREATE UNIQUE INDEX "outbounds_no_key" ON "outbounds"("no");

-- Step 8: เปลี่ยน PK ของ goods_out_items
ALTER TABLE "goods_out_items" DROP CONSTRAINT "goods_out_items_pkey";

-- Step 9: เปลี่ยน id column จาก TEXT เป็น SERIAL
ALTER TABLE "goods_out_items" RENAME COLUMN "id" TO "old_id";
ALTER TABLE "goods_out_items" ADD COLUMN "id" SERIAL;
ALTER TABLE "goods_out_items" ADD CONSTRAINT "goods_out_items_pkey" PRIMARY KEY ("id");

-- Step 10: ลบ columns ที่ไม่ใช้แล้ว
ALTER TABLE "goods_out_items" DROP COLUMN "out_no";
ALTER TABLE "goods_out_items" DROP COLUMN "temp_out_no";
ALTER TABLE "goods_out_items" DROP COLUMN "old_id";

-- Step 11: เพิ่ม FK constraint ใหม่
ALTER TABLE "goods_out_items" ADD CONSTRAINT "goods_out_items_outbound_id_fkey" 
FOREIGN KEY ("outbound_id") REFERENCES "outbounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

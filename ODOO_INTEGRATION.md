# Odoo Integration - Inbound Transfers

## สรุปการเปลี่ยนแปลง

### 1. Database Schema (Prisma)

#### ตาราง `inbounds`
เพิ่มฟิลด์ใหม่เพื่อรองรับข้อมูลจาก Odoo:
- `picking_id` - Odoo picking ID
- `location_id` - ID ของ location ต้นทาง
- `location` - ชื่อ location ต้นทาง
- `location_dest_id` - ID ของ location ปลายทาง
- `location_dest` - ชื่อ location ปลายทาง
- `department_id` - FK ไป department (String)
- `reference` - เลขอ้างอิง
- `origin` - ต้นทาง

**หมายเหตุ:** ฟิลด์เดิม (`sku`, `lot`, `quantity`) ยังคงอยู่แต่เป็น optional เพื่อ backward compatibility

#### ตาราง `goods_ins`
เพิ่มฟิลด์ใหม่จาก Odoo:
- `sequence` - ลำดับ item
- `product_id` - Odoo product ID
- `code` - รหัสสินค้า (SKU)
- `tracking` - tracking type
- `lot_id` - Odoo lot ID
- `lot_serial` - lot/serial number
- `qty` - จำนวนจาก Odoo

---

## 2. API Endpoint

### POST `/api/inbounds/odoo/transfers`

รับข้อมูล transfers จาก Odoo และบันทึกลงฐานข้อมูล

#### Request Body:
```json
{
  "transfers": [
    {
      "picking_id": 123,
      "no": "GR25-27363",
      "location_id": 1,
      "location": "Stock",
      "location_dest_id": 2,
      "location_dest": "WH/Input",
      "department_id": 10,
      "department": "Warehouse",
      "reference": "REF-001",
      "origin": "PO-001",
      "items": [
        {
          "sequence": 1,
          "product_id": 456,
          "code": "SKU-001",
          "name": "Product Name",
          "unit": "PCS",
          "tracking": "lot",
          "lot_id": 789,
          "lot_serial": "LOT-123",
          "qty": 100
        }
      ]
    }
  ]
}
```

#### Response (Success):
```json
{
  "message": "สร้าง/อัพเดท 1 transfers สำเร็จ",
  "data": [
    {
      "gr": "GR25-27363",
      "picking_id": 123,
      "department": "Warehouse",
      "goods_ins": [
        {
          "id": "GR25-27363-1",
          "name": "Product Name",
          "qty": 100
        }
      ]
    }
  ]
}
```

#### Response (Error):
```json
{
  "error": "ข้อมูล transfers ไม่ถูกต้อง"
}
```

---

## 3. วิธีการทำงาน

1. **รับข้อมูลจาก Odoo**: API รับ array ของ transfers
2. **ตรวจสอบ GR ซ้ำ**: ถ้า GR มีอยู่แล้ว จะทำการ UPDATE, ถ้าไม่มีจะ CREATE
3. **บันทึก Items**: สร้าง/อัพเดท goods_in สำหรับแต่ละ item
4. **ID Generation**: goods_in ID = `{GR}-{sequence}`
   - ตัวอย่าง: `GR25-27363-1`, `GR25-27363-2`

---

## 4. Files ที่สร้าง/แก้ไข

### Created:
- `src/controllers/inbound.odoo.controller.ts` - Controller สำหรับรับข้อมูลจาก Odoo
- `ODOO_INTEGRATION.md` - เอกสารนี้

### Modified:
- `prisma/schema.prisma` - เพิ่มฟิลด์ใน inbound และ goods_in
- `src/types/inbound.ts` - เพิ่ม types สำหรับ Odoo
- `src/routes/inbound.routes.ts` - เพิ่ม route `/odoo/transfers`
- `src/controllers/inbound.controller.ts` - เพิ่ม import OdooInboundRequest type

---

## 5. ตัวอย่างการใช้งาน

### ส่งข้อมูลจาก Odoo
```bash
curl -X POST http://localhost:3000/api/inbounds/odoo/transfers \
  -H "Content-Type: application/json" \
  -d '{
    "transfers": [
      {
        "picking_id": 123,
        "no": "GR25-27363",
        "location_id": 1,
        "location": "Stock",
        "location_dest_id": 2,
        "location_dest": "WH/Input",
        "department_id": 10,
        "department": "Warehouse",
        "reference": "REF-001",
        "origin": "PO-001",
        "items": [
          {
            "sequence": 1,
            "product_id": 456,
            "code": "SKU-001",
            "name": "Product Name",
            "unit": "PCS",
            "tracking": "lot",
            "lot_id": 789,
            "lot_serial": "LOT-123",
            "qty": 100
          }
        ]
      }
    ]
  }'
```

### ดึงข้อมูล Inbound ที่สร้างแล้ว
```bash
curl http://localhost:3000/api/inbounds/get/GR25-27363
```

---

## 6. หมายเหตุสำคัญ

1. **Upsert Logic**: API จะ update ถ้า GR มีอยู่แล้ว, create ถ้าไม่มี
2. **Items Update**: goods_in จะถูก update ทุกครั้งที่มีการส่งข้อมูลใหม่มา
3. **Soft Delete**: ระบบใช้ soft delete (`deleted_at`) ดังนั้นข้อมูลที่ลบจะยังคงอยู่
4. **Date Field**: `date` ใน inbound จะใช้วันที่ปัจจุบันเมื่อสร้างใหม่
5. **In Type**: default เป็น "GR" สำหรับข้อมูลจาก Odoo

---

## 7. Next Steps (แนะนำ)

1. เพิ่ม Authentication/Authorization สำหรับ API endpoint
2. เพิ่ม Webhook จาก Odoo เพื่อส่งข้อมูลอัตโนมัติ
3. เพิ่ม Validation rules สำหรับข้อมูลจาก Odoo
4. สร้าง Error logging และ monitoring
5. เพิ่ม Rate limiting เพื่อป้องกัน API abuse

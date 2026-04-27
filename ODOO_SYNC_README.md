# Odoo Department Sync Documentation

## Overview
ระบบ sync master data (Department) ระหว่าง Odoo และ WMS โดยใช้ Odoo เป็น source of truth

## Features
✅ Sync แบบ Manual (User กด sync เอง)
✅ Sync แบบ Automated (Batch job รันทุก 23:59)
✅ Create/Update/Disable logic
✅ Idempotent (รันหลายครั้งไม่ duplicate)
✅ Audit trail / Sync logs
✅ ไม่ลบข้อมูล (soft disable เท่านั้น)

## Prerequisites

### 1. Database Migration
```bash
npx prisma migrate dev --name add_odoo_sync_fields
```

### 2. Install Required Packages
```bash
npm install axios node-cron
npm install --save-dev @types/node-cron
```

### 3. Environment Variables
Copy `.env.odoo.example` to `.env` และเพิ่มค่าต่อไปนี้:

```env
ODOO_URL=https://your-odoo-instance.com
ODOO_DB=your_database_name
ODOO_USERNAME=your_username
ODOO_PASSWORD=your_password
```

## Database Schema Changes

### Department Table (เพิ่ม fields)
- `odoo_id` - เก็บ ID จาก Odoo (unique)
- `is_active` - สถานะ active/inactive
- `last_synced_at` - เวลา sync ล่าสุด

### New Table: odoo_sync_logs
เก็บประวัติการ sync ทุกครั้ง

## API Endpoints

### 1. Manual Sync
**POST** `/api/sync/departments`

Request Body (optional):
```json
{
  "triggered_by": "user_id_or_name"
}
```

Response:
```json
{
  "success": true,
  "message": "Department sync completed successfully",
  "data": {
    "recordsFetched": 10,
    "recordsCreated": 3,
    "recordsUpdated": 5,
    "recordsDisabled": 2,
    "errors": []
  }
}
```

### 2. Get Sync History
**GET** `/api/sync/departments/history?limit=50`

### 3. Get Last Sync
**GET** `/api/sync/departments/last`

## Sync Logic Flow

```
1. Fetch departments จาก Odoo
   ├─ ใช้ Odoo XML-RPC API
   └─ Model: hr.department

2. Loop แต่ละ Odoo department
   ├─ เช็คว่ามีใน WMS ไหม (by odoo_id)
   │  ├─ ไม่มี → CREATE
   │  └─ มีแล้ว
   │     ├─ Data ไม่ตรง → UPDATE
   │     └─ Data ตรง → SKIP

3. เช็ค WMS departments ที่ไม่มีใน Odoo
   └─ Mark as inactive (is_active = false)
```

## Scheduler

Batch job รันอัตโนมัติทุกวันเวลา **23:59**

Cron expression: `59 23 * * *`

สามารถปรับเวลาได้ที่: `src/schedulers/odoo.sync.scheduler.ts`

## Testing

### 1. ทดสอบ Odoo Connection
```typescript
import { odooService } from './services/odoo.service';

await odooService.authenticate();
const departments = await odooService.getDepartments();
console.log(departments);
```

### 2. ทดสอบ Manual Sync
```bash
# Using curl
curl -X POST http://localhost:8000/api/sync/departments \
  -H "Content-Type: application/json" \
  -d '{"triggered_by": "test_user"}'
```

### 3. ตรวจสอบ Logs
```bash
# ดู sync history
curl http://localhost:8000/api/sync/departments/history

# ดู last sync
curl http://localhost:8000/api/sync/departments/last
```

## Monitoring

### Database
```sql
-- ดู departments ที่ sync จาก Odoo
SELECT * FROM departments WHERE odoo_id IS NOT NULL;

-- ดู sync logs
SELECT * FROM odoo_sync_logs ORDER BY started_at DESC LIMIT 10;

-- นับสถิติ
SELECT 
  status,
  COUNT(*) as count,
  AVG(records_fetched) as avg_fetched,
  AVG(records_created) as avg_created,
  AVG(records_updated) as avg_updated,
  AVG(records_disabled) as avg_disabled
FROM odoo_sync_logs
WHERE entity_type = 'department'
GROUP BY status;
```

### Logs
ดูใน console logs เมื่อ scheduler รัน:
```
✅ Database connected successfully
Odoo sync scheduler initialized. Department sync will run daily at 23:59.
🚀 Server running at http://localhost:8000
```

## Error Handling

ระบบจะ:
1. บันทึก error ใน `odoo_sync_logs.error_message`
2. Mark sync status เป็น `failed` หรือ `partial`
3. Log error ไปที่ console/file log
4. ไม่ rollback data ที่ sync ไปแล้ว

## Extending to Other Entities

สามารถ extend เพื่อ sync entities อื่นได้:
1. สร้าง service ใหม่ (คล้าย `department.sync.service.ts`)
2. เพิ่ม method ใน `odoo.service.ts`
3. เพิ่ม controller และ routes
4. เพิ่ม scheduler (ถ้าต้องการ)

ตัวอย่าง entities ที่อาจต้อง sync:
- Products (wms_mdt_goods)
- Locations (stock.location)
- Stock Levels
- Partners/Customers

## Security Considerations

⚠️ **สำคัญ:**
- เก็บ Odoo credentials ใน `.env` เท่านั้น
- ไม่ commit `.env` เข้า git
- ใช้ HTTPS สำหรับ Odoo URL
- พิจารณาเพิ่ม authentication middleware สำหรับ sync endpoints

## Troubleshooting

### Odoo Connection Failed
- ตรวจสอบ ODOO_URL, ODOO_DB, username, password
- ตรวจสอบ network connectivity
- ตรวจสอบ Odoo server ว่า online

### Sync ไม่สร้างข้อมูล
- ตรวจสอบ department model ใน Odoo มี field ที่ต้องการไหม
- ดู sync logs ว่ามี error message อะไร
- ตรวจสอบ database constraints

### Scheduler ไม่ทำงาน
- ตรวจสอบว่า server running ตลอด 24 ชั่วโมง
- ดู logs ว่า scheduler initialized ไหม
- ตรวจสอบ timezone ของ server

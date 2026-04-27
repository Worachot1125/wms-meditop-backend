# 🚀 Quick Start Guide - หลังจาก Migration

## การเริ่มต้นใช้งาน

### 1. ตรวจสอบโฟลเดอร์ (ถูกสร้างอัตโนมัติแล้ว)

```bash
ls src/assets/images/
# ควรเห็น: users/ locations/ .gitkeep .gitignore
```

### 2. รัน Development Server

```bash
npm run dev
```

Server จะรันที่: `http://localhost:3000`

### 3. ทดสอบการอัปโหลดรูป

#### ทดสอบอัปโหลดรูป User:
```bash
curl -X POST http://localhost:3000/api/users/create \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "first_name=Test" \
  -F "last_name=User" \
  -F "email=test@example.com" \
  -F "tel=0812345678" \
  -F "username=testuser" \
  -F "password=password123" \
  -F "user_level=admin" \
  -F "status=Activate" \
  -F "user_img=@/path/to/image.jpg"
```

#### ตรวจสอบรูปที่อัปโหลด:
```bash
ls src/assets/images/users/
# ควรเห็นโฟลเดอร์ {user_id}/
```

#### เข้าถึงรูปผ่าน browser:
```
http://localhost:3000/assets/images/users/{user_id}/user_img.jpg
```

### 4. Build สำหรับ Production

```bash
# Build และ copy assets
npm run build

# ตรวจสอบว่า assets ถูก copy
ls dist/assets/images/

# รัน production
npm start
```

## สิ่งที่เปลี่ยนจาก Supabase

| Aspect | Before (Supabase) | After (Local) |
|--------|------------------|---------------|
| **Upload** | Supabase API | fs.writeFile |
| **Storage** | Supabase Cloud | Local disk |
| **URL** | https://...supabase.co/... | /assets/images/... |
| **Dependencies** | @supabase/supabase-js | Built-in Node.js fs |
| **Cost** | $$ (paid service) | Free (local storage) |
| **Speed** | Network latency | Direct disk access |

## Environment Variables

### ไม่ต้องใช้แล้ว:
```env
# SUPABASE_URL=...              # ลบได้
# SUPABASE_SERVICE_ROLE_KEY=... # ลบได้
```

### ที่ต้องใช้:
```env
DATABASE_URL=postgresql://...
PORT=3000
NODE_ENV=development  # หรือ production
```

## คำถามที่พบบ่อย (FAQ)

### Q: รูปภาพเก่าที่อยู่ใน Supabase จะเป็นอย่างไร?
**A:** ใช้สคริปต์ `scripts/migrate-images.ts` เพื่อ download และย้ายรูปจาก Supabase มาเก็บใน local

```bash
npx ts-node scripts/migrate-images.ts
```

### Q: จะเก็บ URL ในฐานข้อมูลอย่างไร?
**A:** เก็บเป็น relative path เช่น `/assets/images/users/1/user_img.jpg`

### Q: Frontend ต้องแก้ไขอะไรบ้าง?
**A:** ไม่ต้องแก้ไขอะไรเลย! เพียงแค่ใช้ URL ที่ backend ส่งกลับมา

### Q: พื้นที่ disk เต็มแล้วทำอย่างไร?
**A:** 
1. ลบรูปเก่าที่ไม่ใช้
2. Backup และย้ายไปเครื่องอื่น
3. ใช้ external storage (NAS, S3, etc.)

### Q: ต้อง backup รูปภาพอย่างไร?
**A:** ใช้ rsync หรือ cloud backup
```bash
# Backup ไป external drive
rsync -avz src/assets/images/ /backup/images/

# Backup ไป server อื่น
rsync -avz src/assets/images/ user@backup-server:/backup/
```

### Q: ใช้งานกับ Docker ได้ไหม?
**A:** ได้! แต่ต้อง mount volume สำหรับ assets:
```yaml
# docker-compose.yml
services:
  backend:
    volumes:
      - ./images:/app/src/assets/images
```

## การ Troubleshooting

### ปัญหา: 404 Not Found เมื่อเข้าถึงรูป

**สาเหตุ:**
- ไฟล์ไม่มีอยู่จริง
- Path ไม่ถูกต้อง
- Static middleware ไม่ทำงาน

**แก้ไข:**
```bash
# ตรวจสอบไฟล์มีอยู่
ls src/assets/images/users/1/

# ตรวจสอบ permission
chmod -R 755 src/assets/images

# ตรวจสอบ server log
npm run dev
```

### ปัญหา: Permission Denied เมื่ออัปโหลด

**แก้ไข:**
```bash
# ตั้งค่า permission
chmod -R 755 src/assets/images
```

### ปัญหา: Build แล้วไม่มีโฟลเดอร์ assets ใน dist/

**แก้ไข:**
```bash
# รัน copy-assets manual
npm run copy-assets

# หรือ build ใหม่
npm run build
```

## Next Steps

1. ✅ **ทดสอบระบบ** - อัปโหลดรูปและเข้าถึงได้
2. ✅ **Setup Backup** - ตั้งค่า backup อัตโนมัติ
3. ✅ **Monitor Disk Space** - ติดตามพื้นที่ disk
4. ✅ **Deploy Production** - ดู `DEPLOYMENT_GUIDE.md`

## เอกสารเพิ่มเติม

- 📖 [`MIGRATION_SUMMARY.md`](MIGRATION_SUMMARY.md) - สรุปการเปลี่ยนแปลง
- 📖 [`STORAGE_MIGRATION.md`](STORAGE_MIGRATION.md) - รายละเอียด migration
- 📖 [`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md) - คู่มือ production deployment

---

**🎊 พร้อมใช้งานแล้ว! Happy Coding!**

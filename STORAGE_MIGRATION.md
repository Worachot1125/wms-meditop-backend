# การเปลี่ยนแปลงระบบจัดเก็บรูปภาพ

## สรุป
เปลี่ยนจากการใช้ **Supabase Cloud Storage** มาเป็น **Local File Storage** เพื่อความเหมาะสมกับการ deploy บน production server

## การเปลี่ยนแปลงที่สำคัญ

### 1. ไฟล์ที่ถูกแก้ไข
- ✅ `backend/src/utils/storage.ts` - เปลี่ยนจาก Supabase storage API เป็น Node.js fs module
- ✅ `backend/src/app.ts` - เพิ่ม static file serving สำหรับ `/assets/images`
  
### 2. ไฟล์ที่ถูกลบ
- ❌ `backend/src/lib/supabase.ts` - ไม่ใช้ Supabase client แล้ว
- ❌ `backend/src/utils/uploadToSupabase.ts` - ไม่ใช้แล้ว

### 3. โครงสร้างโฟลเดอร์ใหม่
```
backend/src/assets/images/
├── users/
│   └── {user_id}/
│       └── user_img.{ext}
└── locations/
    └── {location_id}/
        └── location_img.{ext}
```

## วิธีการทำงานใหม่

### การอัปโหลดรูปภาพ
1. รับไฟล์จาก multer (middleware)
2. เขียนไฟล์ลง `src/assets/images/{type}/{id}/{filename}`
3. Return URL path: `/assets/images/{type}/{id}/{filename}`

### การเข้าถึงรูปภาพ
- รูปภาพสามารถเข้าถึงได้ผ่าน URL: `http://your-server:port/assets/images/...`
- Express จะ serve ไฟล์ static จากโฟลเดอร์ `src/assets/images`

## ตัวอย่าง URL
- User image: `http://localhost:3000/assets/images/users/1/user_img.jpg`
- Location image: `http://localhost:3000/assets/images/locations/5/location_img.png`

## Controllers ที่ได้รับผลกระทบ
- `backend/src/controllers/user.controller.ts` - ใช้ `uploadFixedPath()` แบบเดิม (ไม่ต้องแก้)
- `backend/src/controllers/location.controller.ts` - ใช้ `uploadFixedPath()` แบบเดิม (ไม่ต้องแก้)

## การทดสอบ
```bash
# ทดสอบการ compile
npm run build

# รัน development server
npm run dev
```

## หมายเหตุ
- ⚠️ **สำคัญ**: ต้องสร้างโฟลเดอร์ `src/assets/images` บน production server
- ⚠️ Backend จะสร้างโฟลเดอร์ย่อย (`users/{id}`, `locations/{id}`) อัตโนมัติเมื่อมีการอัปโหลดรูป
- ⚠️ ตรวจสอบ permission ของโฟลเดอร์ให้ Node.js สามารถเขียนไฟล์ได้
- 💡 สามารถลบ `@supabase/supabase-js` จาก `package.json` ได้ (ไม่บังคับ)

## Environment Variables ที่ไม่จำเป็นแล้ว
- `SUPABASE_URL` - ไม่ใช้แล้ว
- `SUPABASE_SERVICE_ROLE_KEY` - ไม่ใช้แล้ว

## ข้อดี
✅ ไม่ต้องพึ่งพา external service  
✅ ลดค่าใช้จ่าย (ไม่ต้องจ่ายค่า cloud storage)  
✅ เร็วกว่า (ไม่ต้องผ่าน network)  
✅ ควบคุมข้อมูลได้เต็มที่  

## ข้อควรระวัง
⚠️ ต้อง backup โฟลเดอร์ `src/assets/images` เป็นประจำ  
⚠️ ใช้พื้นที่ disk บน server  
⚠️ หากมี server หลายตัว ต้องใช้ shared storage หรือ sync ไฟล์

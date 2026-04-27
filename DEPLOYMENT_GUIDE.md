# คู่มือการ Deploy สำหรับ Production Server

## การเตรียมโฟลเดอร์สำหรับเก็บรูปภาพ

### 1. สร้างโฟลเดอร์บน Production Server

```bash
# เข้าไปที่โฟลเดอร์โปรเจค
cd /path/to/your/project/backend

# สร้างโฟลเดอร์สำหรับเก็บรูปภาพ
mkdir -p src/assets/images/users
mkdir -p src/assets/images/locations
```

### 2. ตั้งค่า Permission (สำคัญ!)

```bash
# ให้สิทธิ์ Node.js เขียนไฟล์ได้
chmod -R 755 src/assets/images

# หรือถ้าใช้ user เฉพาะ (เช่น www-data)
chown -R www-data:www-data src/assets/images
chmod -R 755 src/assets/images
```

### 3. ตรวจสอบโฟลเดอร์

```bash
ls -la src/assets/images
# ควรเห็น:
# drwxr-xr-x users
# drwxr-xr-x locations
```

## การ Deploy แบบ Production

### วิธีที่ 1: Build และ Deploy ทั้งหมด

```bash
# Build TypeScript
npm run build

# Copy โฟลเดอร์ assets ไปยัง dist
cp -r src/assets dist/

# Start production server
npm start
```

### วิธีที่ 2: ใช้ ts-node-dev (Development/Testing)

```bash
npm run dev
```

## การแก้ไข Path สำหรับ Production

ถ้า build แล้วใช้โฟลเดอร์ `dist/` แทน `src/` ต้องแก้ไข:

### แก้ไขไฟล์ `src/utils/storage.ts`

```typescript
// เปลี่ยนจาก
const ASSETS_DIR = path.join(process.cwd(), "src", "assets", "images");

// เป็น
const ASSETS_DIR = path.join(
  process.cwd(), 
  process.env.NODE_ENV === 'production' ? 'dist' : 'src', 
  "assets", 
  "images"
);
```

### แก้ไขไฟล์ `src/app.ts`

```typescript
// เปลี่ยนจาก
app.use("/assets/images", express.static(path.join(process.cwd(), "src", "assets", "images")));

// เป็น
const assetsPath = path.join(
  process.cwd(),
  process.env.NODE_ENV === 'production' ? 'dist' : 'src',
  "assets",
  "images"
);
app.use("/assets/images", express.static(assetsPath));
```

## การใช้ PM2 (Process Manager)

### ติดตั้ง PM2

```bash
npm install -g pm2
```

### สร้างไฟล์ ecosystem.config.js

```javascript
module.exports = {
  apps: [{
    name: 'wms-backend',
    script: './dist/index.js',
    instances: 1,
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
```

### เริ่ม Server ด้วย PM2

```bash
# Build โปรเจค
npm run build

# Copy assets
cp -r src/assets dist/

# เริ่ม server
pm2 start ecosystem.config.js

# ดู status
pm2 status

# ดู logs
pm2 logs wms-backend

# Restart
pm2 restart wms-backend

# Stop
pm2 stop wms-backend
```

## การ Backup รูปภาพ

### วิธีที่ 1: ใช้ rsync (แนะนำ)

```bash
# Backup ไปยัง server อื่น
rsync -avz --progress src/assets/images/ user@backup-server:/backup/images/

# หรือ backup แบบ local
rsync -avz --progress src/assets/images/ /backup/images/
```

### วิธีที่ 2: ใช้ tar + gzip

```bash
# สร้าง backup archive
tar -czf images-backup-$(date +%Y%m%d).tar.gz src/assets/images/

# Restore จาก backup
tar -xzf images-backup-20260204.tar.gz
```

### วิธีที่ 3: ใช้ cron job สำหรับ auto backup

```bash
# แก้ไข crontab
crontab -e

# เพิ่มบรรทัดนี้ (backup ทุกวันเวลา 02:00)
0 2 * * * rsync -avz /path/to/project/src/assets/images/ /backup/images/ >> /var/log/image-backup.log 2>&1
```

## การใช้งานกับ Nginx (Reverse Proxy)

### ตัวอย่าง Nginx config

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # Serve images directly from Nginx (faster)
    location /assets/images/ {
        alias /path/to/project/backend/src/assets/images/;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # Proxy other requests to Node.js
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## การ Monitor พื้นที่ Disk

```bash
# ดูขนาดโฟลเดอร์รูปภาพ
du -sh src/assets/images/*

# ดูพื้นที่ disk ที่เหลือ
df -h
```

## Troubleshooting

### ปัญหา: Permission denied

```bash
# แก้ไขสิทธิ์
sudo chown -R $USER:$USER src/assets/images
chmod -R 755 src/assets/images
```

### ปัญหา: ไม่เห็นรูปภาพ

```bash
# ตรวจสอบว่าไฟล์มีอยู่จริง
ls -la src/assets/images/users/*/

# ตรวจสอบ server ว่า serve static files ถูกต้อง
curl http://localhost:3000/assets/images/users/1/user_img.jpg
```

### ปัญหา: พื้นที่ disk เต็ม

```bash
# หาไฟล์ใหญ่
find src/assets/images -type f -size +10M

# ลบรูปภาพที่ถูกลบใน database แล้ว
# (ใช้สคริปต์ clean up - ระวังอย่าลบผิด)
```

## Security Considerations

1. **ห้าม** serve โฟลเดอร์อื่นที่ไม่ใช่ images
2. Validate ไฟล์ที่อัปโหลดให้ดี (ขนาด, ประเภทไฟล์)
3. ใช้ rate limiting สำหรับ upload endpoints
4. ตั้งค่า CORS ให้ถูกต้อง
5. Backup เป็นประจำ

## Environment Variables

```env
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://...

# ไม่ต้องใช้แล้ว (เก่า)
# SUPABASE_URL=...
# SUPABASE_SERVICE_ROLE_KEY=...
```

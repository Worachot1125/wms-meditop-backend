import fs from "fs";
import path from "path";
import { promisify } from "util";

const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);

// Base directory สำหรับเก็บรูปภาพ (assets อยู่นอก src)
const ASSETS_DIR = path.join(
  process.cwd(),
  "assets",
  "images"
);

export function getExt(file: Express.Multer.File): string {
  const dot = file.originalname.lastIndexOf(".");
  if (dot !== -1 && dot < file.originalname.length - 1) {
    return file.originalname.slice(dot + 1).toLowerCase();
  }
  const mt = (file.mimetype || "").toLowerCase();
  if (mt.includes("png")) return "png";
  if (mt.includes("jpeg") || mt.includes("jpg")) return "jpg";
  if (mt.includes("webp")) return "webp";
  if (mt.includes("pdf")) return "pdf";
  return "bin";
}

/**
 * อัปโหลดไฟล์ไปยัง local storage
 * @param folder - โฟลเดอร์ เช่น "users/1" หรือ "locations/5"
 * @param file - ไฟล์จาก multer
 * @returns URL สำหรับเข้าถึงไฟล์ เช่น "/assets/images/users/1/photo_1738728000000.jpg"
 */
export async function uploadFixedPath(
  folder: string,
  file: Express.Multer.File
): Promise<string> {
  // ดึงชื่อไฟล์และ extension จากไฟล์ต้นฉบับ
  const originalName = file.originalname;
  const ext = getExt(file);
  const nameWithoutExt = originalName.substring(0, originalName.lastIndexOf('.')) || originalName;
  
  // สร้างชื่อไฟล์ใหม่: ชื่อเดิม_timestamp.ext
  const timestamp = Date.now();
  const fileName = `${nameWithoutExt}_${timestamp}.${ext}`;
  
  // สร้าง full path
  const fullPath = path.join(ASSETS_DIR, folder, fileName);
  const dirPath = path.dirname(fullPath);

  // สร้างโฟลเดอร์ถ้ายังไม่มี
  await mkdir(dirPath, { recursive: true });

  // เขียนไฟล์
  await writeFile(fullPath, file.buffer);

  // Return URL path (ใช้ forward slash สำหรับ URL)
  const urlPath = `${folder}/${fileName}`.replace(/\\/g, "/");
  return `/assets/images/${urlPath}`;
}

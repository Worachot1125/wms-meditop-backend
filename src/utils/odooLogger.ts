import fs from "fs";
import path from "path";

/**
 * บันทึก log ลงไฟล์
 */
export function logToFile(filename: string, data: any) {
  try {
    const logsDir = path.join(process.cwd(), "logs");
    
    // สร้างโฟลเดอร์ logs ถ้ายังไม่มี
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const timestamp = new Date().toISOString();
    const logFile = path.join(logsDir, filename);
    
    const logEntry = {
      timestamp,
      data,
    };

    const logLine = JSON.stringify(logEntry, null, 2) + "\n" + "=".repeat(80) + "\n";

    // Append to file
    fs.appendFileSync(logFile, logLine, "utf8");
    
    console.log(`📝 Log saved to: ${logFile}`);
  } catch (error) {
    console.error("❌ Failed to write log:", error);
  }
}

/**
 * บันทึก request จาก Odoo
 */
export function logOdooRequest(requestBody: any) {
  const date = new Date();
  const dateStr = date.toISOString().split("T")[0]; // YYYY-MM-DD
  const filename = `odoo-requests-${dateStr}.log`;
  
  logToFile(filename, requestBody);
}

/**
 * บันทึก error จาก Odoo
 */
export function logOdooError(error: any, requestBody?: any) {
  const date = new Date();
  const dateStr = date.toISOString().split("T")[0];
  const filename = `odoo-errors-${dateStr}.log`;
  
  logToFile(filename, {
    error: error.message || error,
    stack: error.stack,
    requestBody,
  });
}

/**
 * อ่าน log file
 */
export function readLogFile(filename: string): string | null {
  try {
    const logsDir = path.join(process.cwd(), "logs");
    const logFile = path.join(logsDir, filename);
    
    if (fs.existsSync(logFile)) {
      return fs.readFileSync(logFile, "utf8");
    }
    
    return null;
  } catch (error) {
    console.error("❌ Failed to read log:", error);
    return null;
  }
}

/**
 * ดึงรายชื่อไฟล์ log ทั้งหมด
 */
export function getLogFiles(): string[] {
  try {
    const logsDir = path.join(process.cwd(), "logs");
    
    if (!fs.existsSync(logsDir)) {
      return [];
    }
    
    return fs.readdirSync(logsDir).filter((file) => file.endsWith(".log"));
  } catch (error) {
    console.error("❌ Failed to list log files:", error);
    return [];
  }
}

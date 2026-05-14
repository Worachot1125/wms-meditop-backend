import fs from "fs";
import path from "path";
import { exec } from "child_process";

export type StickerSize = "6x3" | "6x4";

export interface PrintLabelPayload {
  printerName?: string;
  stickerSize?: StickerSize;

  qrPayload: string;

  lotText?: string;
  expText?: string;
  productText?: string;

  copies?: number;
}

function cleanText(value: any): string {
  return String(value ?? "")
    .replace(/"/g, "'")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .trim();
}

function buildTspl(payload: PrintLabelPayload): string {
  const {
    stickerSize = "6x3",
    qrPayload,
    lotText = "XXXXXX",
    expText = "** No Expiry **",
    productText = "---",
    copies = 1,
  } = payload;

  const heightMm = stickerSize === "6x4" ? 40 : 30;

  const safeCopies = Math.max(1, Math.floor(Number(copies) || 1));

  return `
SIZE 60 mm,${heightMm} mm
GAP 2 mm,0
DIRECTION 1
REFERENCE 0,0
CLS

QRCODE 20,20,L,5,A,0,"${cleanText(qrPayload)}"

TEXT 185,25,"0",0,1,1,"${cleanText(lotText)}"
TEXT 185,70,"0",0,1,1,"${cleanText(expText)}"

TEXT 20,${heightMm === 40 ? 290 : 215},"0",0,1,1,"${cleanText(productText)}"

PRINT ${safeCopies}
`;
}

export async function printTsplLabel(
  payload: PrintLabelPayload,
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const printerName = cleanText(
        payload.printerName || "TSC_TE200",
      );

      const tspl = buildTspl(payload);

      const filePath = path.join(
        process.cwd(),
        "temp-label-print.txt",
      );

      fs.writeFileSync(filePath, tspl, "ascii");

      const command = `COPY /B "${filePath}" "\\\\localhost\\${printerName}"`;

      console.log("PRINT COMMAND:", command);

      exec(command, (err, stdout, stderr) => {
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        } catch {
          // ignore
        }

        if (err) {
          console.error("PRINT ERROR:", err);

          reject(
            new Error(
              stderr ||
                err.message ||
                "ไม่สามารถส่งข้อมูลไปยัง printer ได้",
            ),
          );

          return;
        }

        console.log("PRINT SUCCESS");

        resolve();
      });
    } catch (err: any) {
      reject(
        new Error(
          err?.message || "เกิดข้อผิดพลาดในการ print label",
        ),
      );
    }
  });
}
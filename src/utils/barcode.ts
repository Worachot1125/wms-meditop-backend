export function calcEan13CheckDigit(base12: string) {
  if (!/^\d{12}$/.test(base12))
    throw new Error("base12 ต้องเป็นตัวเลข 12 หลัก");
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const n = Number(base12[i]);
    sum += i % 2 === 0 ? n : n * 3;
  }
  const mod = sum % 10;
  return mod === 0 ? 0 : 10 - mod;
}

export function genEan13Prefix01() {
  const rand10 = Array.from({ length: 10 }, () =>
    Math.floor(Math.random() * 10)
  ).join("");
  const base12 = "01" + rand10;
  const cd = calcEan13CheckDigit(base12);
  return base12 + String(cd);
}

export function toExp6(date: Date | null | undefined) {
  if (!date) return "999999";
  const yy = String(date.getFullYear() % 100).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

export function buildQrNumericPayload(
  barcode13: string,
  lot8: string,
  exp6: string
) {
  if (!/^\d{13}$/.test(barcode13))
    throw new Error("barcode13 ต้องเป็น 13 หลัก");
  if (!/^\d{8}$/.test(lot8)) throw new Error("lot ต้องเป็น 8 หลัก");
  if (!/^\d{6}$/.test(exp6)) throw new Error("exp ต้องเป็น 6 หลัก");
  return `${barcode13}${lot8}${exp6}`; // 27 digits
}

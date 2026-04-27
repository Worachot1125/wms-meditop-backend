export const toBool = (v: any): boolean => {
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase().trim();
  return s === "true" || s === "1" || s === "on" || s === "yes";
};

export const toNum = (v: any, field = "number"): number => {
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`${field} ต้องเป็นตัวเลข`);
  return n;
};

export const toDateOrNull = (v: any, field = "date"): Date | null => {
  if (v === undefined || v === null || v === "") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`${field} ไม่ถูกต้อง`);
  return d;
};

export const hasThai = (text: string) => /[\u0E00-\u0E7F]/.test(text);

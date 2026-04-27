import { badRequest } from "./appError";

export function parseDateInput(value: unknown, field: string): Date {
  const raw = String(value ?? "").trim();
  if (!raw) throw badRequest(`${field} ห้ามว่าง`, { field });

  // รองรับ "YYYY-MM-DD" → เติมเวลาให้เป็น ISO
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}T00:00:00.000Z`
    : raw;

  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw badRequest(`${field} รูปแบบไม่ถูกต้อง`, { field });
  }
  return d;
}

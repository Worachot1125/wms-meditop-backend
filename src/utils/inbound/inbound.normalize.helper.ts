import { buildItemKeyForMerge } from "./inbound.key.helper";

export type NormalizedInboundItem = {
  sequence: number | null;
  product_id: number | null;
  code: string | null;
  name: string | null;
  unit: string | null;
  tracking: string | null;

  // ✅ ยังรับ lot_id มาได้ (เพื่อเก็บลง DB/flow อื่น) แต่ "ไม่ใช้เช็ค/merge"
  lot_id: number | null;

  // ✅ ตัวที่ใช้เช็คจริง: lot_serial (lot_name)
  lot_serial: string | null;

  expire_date: string | null; // เก็บ string เดิม (ถ้ามี)
  qty: number;
  barcode_text: string | null; // ✅ NEW
};

/**
 * ✅ normalize สำหรับ lot_serial / lot_name เพื่อใช้เป็น key (ไม่สน lot_id)
 */
export function normalizeLotText(v: any): string {
  return String(v ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function normalizeLotId(v: any): number | null {
  if (Array.isArray(v))
    return v.length > 0 && typeof v[0] === "number" ? v[0] : null;
  return typeof v === "number" ? v : null;
}

export function normalizeLotSerial(v: any): string | null {
  if (Array.isArray(v))
    return v.length > 0 && typeof v[0] === "string" ? v[0] : null;
  return typeof v === "string" ? v : null;
}

export function normalizeStr(v: any): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

export function normalizeExpireDateStr(item: any): string | null {
  const raw =
    item?.expire_date ??
    item?.expire_date ??
    item?.exp ??
    item?.expiry_date ??
    null;

  if (raw === null || raw === undefined) return null;

  const s = String(raw).trim();
  return s.length > 0 ? s : null;
}

export function normalizeBarcodeTextFromOdoo(item: any): string | null {
  // spec ใหม่: Odoo ส่ง barcodes: [{ barcode: "xxxxx" }]
  if (Array.isArray(item?.barcodes) && item.barcodes.length > 0) {
    const bc = item.barcodes[0]?.barcode;
    const t = typeof bc === "string" ? bc.trim() : "";
    return t.length > 0 ? t : null;
  }
  return null;
}

export function mergeInboundItems(items: any[]): NormalizedInboundItem[] {
  const map = new Map<string, NormalizedInboundItem>();

  items.forEach((item: any, index: number) => {
    const seq = item.sequence ?? index + 1;

    const product_id =
      typeof item.product_id === "number" ? item.product_id : null;
    const code = normalizeStr(item.code);
    const name = normalizeStr(item.name)?.trim() ?? null;
    const unit = normalizeStr(item.unit)?.trim() ?? null;
    const tracking = normalizeStr(item.tracking);

    // ✅ เก็บ lot_id ได้ แต่ "ไม่ใช้เช็ค"
    const lot_id = normalizeLotId(item.lot_id);

    // ✅ lot_serial (lot_name)
    const lot_serial = normalizeLotSerial(item.lot_serial);

    const expire_date = normalizeExpireDateStr(item);

    const qty =
      typeof item.qty === "number" && Number.isFinite(item.qty) ? item.qty : 0;

    const barcode_text = normalizeBarcodeTextFromOdoo(item);

    const key = buildItemKeyForMerge({
      product_id,
      code,
      name,
      unit,
      tracking,
      lot_serial, // ✅ ใช้ lot_serial
      expire_date,
      barcode_text,
    });

    const existing = map.get(key);
    if (existing) {
      existing.qty += qty;
    } else {
      map.set(key, {
        sequence: seq,
        product_id,
        code,
        name,
        unit,
        tracking,
        lot_id, // ✅ เก็บไว้เฉยๆ
        lot_serial,
        expire_date,
        qty,
        barcode_text,
      });
    }
  });

  return Array.from(map.values());
}

/**
 * แปลง "YYYY-MM-DD" หรือ ISO string ให้เป็น Date สำหรับเก็บลง timestamp
 * - ถ้าเป็น "YYYY-MM-DD" -> ปักเป็น 00:00:00Z เพื่อไม่ให้ timezone ทำให้วันเพี้ยน
 */
export function toExpDate(expStr: string | null): Date | undefined {
  if (!expStr) return undefined;

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(expStr)) {
    return new Date(`${expStr}T00:00:00.000Z`);
  }

  // ISO / other date strings
  const d = new Date(expStr);
  if (isNaN(d.getTime())) return undefined;

  return d;
}

export function toDateOnlyKey(d: Date | null | undefined): string | null {
  if (!d) return null;

  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return null;

  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

export function inferInTypeFromNumber(
  no: string | null | undefined,
): "TF" | "GR" | "BOR" | "RTC" | "PD" {
  const s = String(no ?? "").toUpperCase();
  if (!s) return "GR";

  const TYPES: Array<"TF" | "BOR" | "RTC" | "PD" | "GR"> = [
    "TF",
    "BOR",
    "RTC",
    "PD",
    "GR",
  ];

  for (const t of TYPES) {
    if (s.includes(t)) return t;
  }
  return "GR";
}

export function isTFNumber(no: string | null | undefined): boolean {
  const s = String(no ?? "")
    .trim()
    .toUpperCase();

  if (!s) return false;

  return s.startsWith("TF") || s.includes("/TF/");
}

export function isRTCNumber(no: string | null | undefined): boolean {
  const s = String(no ?? "")
    .trim()
    .toUpperCase();
  return s.startsWith("RTC");
}

// PD auto-process
export function isPDNumber(no: string | null | undefined): boolean {
  const s = String(no ?? "")
    .trim()
    .toUpperCase();

  return s.startsWith("PD") || s.includes("/PD");
}

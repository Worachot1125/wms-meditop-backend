import { normalizeLotText, toDateOnlyKey } from "./inbound.normalize.helper";

export function goodsInMatchKey(input: {
  product_id: number;
  lot_serial?: any;
}) {
  return `p:${input.product_id}|lot:${normalizeLotText(input.lot_serial)}`;
}

export function goodsInBarcodeReuseKey(input: {
  product_id: number | null;
  lot_id: number | null;
}) {
  return `p:${input.product_id ?? "null"}|lotId:${input.lot_id ?? "null"}`;
}

export function rtcAdjustmentMatchKey(input: {
  product_id: number | null;
  lot_id: number | null;
  lot_serial: string | null;
  exp: Date | null | undefined;
}) {
  return [
    `p:${input.product_id ?? "null"}`,
    `lotId:${input.lot_id ?? "null"}`,
    `lotSer:${normalizeLotText(input.lot_serial)}`,
    `exp:${toDateOnlyKey(input.exp ?? null) ?? "null"}`,
  ].join("|");
}

/**
 * ✅ KEY สำหรับ merge items:
 * - ใช้ product_id + lot_serial(lot_name) เป็นหลัก
 * - ❌ เอา lot_id ออกจาก key แล้ว
 * - ที่เหลือคงไว้ตามเดิม (กัน merge ข้ามของคนละตัว)
 */
export function buildItemKeyForMerge(input: {
  product_id: number | null;
  code: string | null;
  name: string | null;
  unit: string | null;
  tracking: string | null;
  lot_serial: string | null; // ✅ ใช้ตัวนี้
  expire_date: string | null;
  barcode_text: string | null;
}) {
  return [
    `p:${input.product_id ?? "null"}`,
    `c:${input.code ?? ""}`,
    `n:${input.name ?? ""}`,
    `u:${input.unit ?? ""}`,
    `t:${input.tracking ?? ""}`,
    `lotSer:${normalizeLotText(input.lot_serial)}`,
    `exp:${input.expire_date ?? ""}`,
    `bc:${input.barcode_text ?? ""}`,
  ].join("|");
}

/**
 * =========================
 * ✅ NEW helpers: input_number / zone_type map
 * ✅ เปลี่ยนการ "เช็ค/จับคู่" เป็น product_id + lot_serial(lot_name)
 * - แต่ยังใช้ lot_id ในการ query DB ได้ (เพื่อความแม่น/ไม่กระทบ flow เดิม)
 * =========================
 */
export type GoodsKey = string;

// ✅ key ใหม่ (ตาม requirement): product_id + lot_serial(lot_name)
export const goodsKeyByLotText = (
  product_id: number,
  lot_text: string,
): GoodsKey => `${product_id}__${lot_text}`;

// (คงไว้เพื่อ compatibility ภายใน: product_id + lot_id)
export const goodsKeyByLotId = (
  product_id: number,
  lot_id: number | null | undefined,
): GoodsKey => `${product_id}_${lot_id ?? "null"}`;

export function swapItemKey(input: {
  product_id: number | null;
  lot_serial: string | null;
}) {
  return `p:${input.product_id ?? "null"}|lot:${normalizeLotText(input.lot_serial)}`;
}

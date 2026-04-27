import { prisma } from "../../lib/prisma";
import { badRequest } from "../appError";

export const EXP_NULL_PLACEHOLDER = "999999";
export const LOT_NULL_PLACEHOLDER = "XXXXXX";

export type ResolvedScanResult = {
  raw_input: string;
  normalized_input: string;
  matched_by: "GS1_AI" | "FIXED_META" | "BASE_SUFFIX" | "MASTER_PREFIX";
  barcode_text: string | null;
  lot_serial: string | null;
  exp_text: string | null;
  exp: Date | null;
  master_barcode_id?: number | null;
};

export function normalizeScanText(v: unknown): string {
  return String(v ?? "")
    .trim()
    .replace(/\]\[C1/g, "")
    .replace(/\]\[d2/g, "")
    .replace(/[()]/g, "")
    .replace(/\s+/g, "")
    .toUpperCase();
}

export function normalizeBarcodeBaseForMatch(v: unknown): string {
  return normalizeScanText(v);
}

export function normalizeLot(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (s.toUpperCase() === LOT_NULL_PLACEHOLDER) return null;
  return s.toUpperCase();
}

export function normalizeExpInput(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (s === EXP_NULL_PLACEHOLDER) return null;
  return s;
}

export function toDateOnlyKey(
  d: Date | string | null | undefined,
): string | null {
  if (!d) return null;
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return null;
  return x.toISOString().slice(0, 10);
}

export function sameDateOnly(
  a: Date | string | null | undefined,
  b: Date | string | null | undefined,
): boolean {
  return toDateOnlyKey(a) === toDateOnlyKey(b);
}

export function sameExpDateOnly(
  a: Date | string | null | undefined,
  b: Date | string | null | undefined,
): boolean {
  const ak = toDateOnlyKey(a);
  const bk = toDateOnlyKey(b);
  if (!ak && !bk) return true;
  return ak === bk;
}

export function parseYYMMDDToDate(v: string | null | undefined): Date | null {
  const s = String(v ?? "").trim();
  if (!/^\d{6}$/.test(s) || s === EXP_NULL_PLACEHOLDER) return null;

  const yy = Number(s.slice(0, 2));
  const mm = Number(s.slice(2, 4));
  const dd = Number(s.slice(4, 6));

  if (mm < 1 || mm > 12) return null;
  if (dd < 1 || dd > 31) return null;

  const yyyy = yy >= 70 ? 1900 + yy : 2000 + yy;
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isPositiveIndex(v: unknown): v is number {
  return Number.isInteger(v) && Number(v) > 0;
}

export function isZeroLikeIndex(v: unknown): boolean {
  return Number(v ?? 0) === 0;
}

export function isNullLikeLot(v: unknown): boolean {
  const s = String(v ?? "")
    .trim()
    .toUpperCase();
  return !s || s === LOT_NULL_PLACEHOLDER;
}

export function isNullLikeExp(v: unknown): boolean {
  const s = String(v ?? "").trim();
  return !s || s === EXP_NULL_PLACEHOLDER;
}

export function safeSliceByOneBased(
  input: string,
  start?: number | null,
  stop?: number | null,
): string | null {
  if (!isPositiveIndex(start) || !isPositiveIndex(stop) || stop < start) {
    return null;
  }

  const zeroStart = start - 1;
  const zeroStopExclusive = stop;

  if (zeroStart >= input.length) return null;
  return input.slice(zeroStart, Math.min(zeroStopExclusive, input.length));
}

export function hasFixedLotExpMeta(
  meta?: {
    lot_start?: number | null;
    lot_stop?: number | null;
    exp_start?: number | null;
    exp_stop?: number | null;
  } | null,
): boolean {
  if (!meta) return false;

  return (
    isPositiveIndex(meta.lot_start) &&
    isPositiveIndex(meta.lot_stop) &&
    isPositiveIndex(meta.exp_start) &&
    isPositiveIndex(meta.exp_stop)
  );
}

/**
 * เก็บไว้เผื่อบาง flow อยากบังคับตาม master metadata
 * แต่สำหรับ ISO scan จริง เราจะไม่ใช้ตัวนี้เป็น gate หลักแล้ว
 */
export function canUseGS1AIByMaster(
  meta?: {
    lot_start?: number | null;
    lot_stop?: number | null;
    exp_start?: number | null;
    exp_stop?: number | null;
  } | null,
): boolean {
  if (!meta) return false;

  return (
    isPositiveIndex(meta.lot_start) &&
    isPositiveIndex(meta.lot_stop) &&
    isPositiveIndex(meta.exp_start) &&
    isPositiveIndex(meta.exp_stop)
  );
}

export function parseScannedBarcodeByBaseBarcode(
  scannedBarcode: string,
  baseBarcodeText: string,
): {
  barcode_text: string;
  lot_serial: string | null;
  exp_text: string;
  exp: Date | null;
  matched_by: "GS1_AI" | "BASE_SUFFIX";
} {
  const raw = normalizeScanText(scannedBarcode);
  const base = normalizeScanText(baseBarcodeText);

  // รองรับกรณี payload เป็น GS1 แล้ว master เป็น GTIN14
  if (raw.startsWith("01") && raw.slice(2, 16) === base) {
    const gs1 = parseGS1AIBarcode(raw);
    if (gs1?.barcode_text) {
      return {
        barcode_text: gs1.barcode_text,
        lot_serial: gs1.lot_serial,
        exp_text: gs1.exp_text,
        exp: gs1.exp,
        matched_by: "GS1_AI",
      };
    }
  }

  if (!raw.startsWith(base)) {
    return {
      barcode_text: base,
      lot_serial: null,
      exp_text: EXP_NULL_PLACEHOLDER,
      exp: null,
      matched_by: "BASE_SUFFIX",
    };
  }

  const remain = raw.slice(base.length);

  if (remain.length < 6) {
    return {
      barcode_text: base,
      lot_serial: remain || null,
      exp_text: EXP_NULL_PLACEHOLDER,
      exp: null,
      matched_by: "BASE_SUFFIX",
    };
  }

  const exp_text = remain.slice(-6);
  const lot_serial = remain.slice(0, -6) || null;

  return {
    barcode_text: base,
    lot_serial,
    exp_text,
    exp: parseYYMMDDToDate(exp_text),
    matched_by: "BASE_SUFFIX",
  };
}

export function parseScannedBarcodeByMasterMeta(input: {
  scannedBarcode: string;
  masterBarcode: string;
  lot_start?: number | null;
  lot_stop?: number | null;
  exp_start?: number | null;
  exp_stop?: number | null;
}): {
  barcode_text: string;
  lot_serial: string | null;
  exp_text: string;
  exp: Date | null;
  normalized_scan: string;
  matched_by: "GS1_AI" | "FIXED_META" | "BASE_SUFFIX";
} {
  const raw = normalizeScanText(input.scannedBarcode);
  const master = normalizeScanText(input.masterBarcode);

  const useFixedMeta = hasFixedLotExpMeta({
    lot_start: input.lot_start,
    lot_stop: input.lot_stop,
    exp_start: input.exp_start,
    exp_stop: input.exp_stop,
  });

  if (!useFixedMeta) {
    return {
      ...parseScannedBarcodeByBaseBarcode(raw, master),
      normalized_scan: raw,
      matched_by: "BASE_SUFFIX",
    };
  }

  /**
   * ✅ Case 1:
   * barcode จริงขึ้นต้นด้วย master ตรง ๆ
   * เช่น 0011223344MDT88261231
   */
  if (raw.startsWith(master)) {
    const lot_serial =
      safeSliceByOneBased(raw, input.lot_start, input.lot_stop) ?? null;

    const exp_text =
      safeSliceByOneBased(raw, input.exp_start, input.exp_stop) ??
      EXP_NULL_PLACEHOLDER;

    return {
      barcode_text: master,
      lot_serial,
      exp_text,
      exp: parseYYMMDDToDate(exp_text),
      normalized_scan: raw,
      matched_by: "FIXED_META",
    };
  }

  /**
   * ✅ Case 2:
   * barcode เป็นแบบ 01 + master
   * ค่อยเช็ค 01 ทีหลัง
   */
  if (raw.startsWith("01")) {
    const barcodeTextPart = raw.slice(2, master.length + 2);

    if (barcodeTextPart === master) {
      const lot_serial =
        safeSliceByOneBased(raw, input.lot_start, input.lot_stop) ?? null;

      const exp_text =
        safeSliceByOneBased(raw, input.exp_start, input.exp_stop) ??
        EXP_NULL_PLACEHOLDER;

      return {
        barcode_text: master,
        lot_serial,
        exp_text,
        exp: parseYYMMDDToDate(exp_text),
        normalized_scan: raw,
        matched_by: "FIXED_META",
      };
    }
  }

  return {
    ...parseScannedBarcodeByBaseBarcode(raw, master),
    normalized_scan: raw,
    matched_by: "BASE_SUFFIX",
  };
}

/**
 * GS1 parser:
 * - 01 = GTIN14
 * - 10 = LOT (variable)
 * - 17 = EXP YYMMDD
 */
export function parseGS1AIBarcode(scannedBarcode: string) {
  const raw = normalizeScanText(scannedBarcode);
  if (!raw.startsWith("01")) return null;
  if (raw.length < 16) return null;

  const barcode_text = raw.slice(2, 16);

  let cursor = 16;
  let lot_serial: string | null = null;
  let exp_text: string | null = null;

  while (cursor < raw.length) {
    const ai2 = raw.slice(cursor, cursor + 2);

    if (ai2 === "17") {
      const value = raw.slice(cursor + 2, cursor + 8);
      if (/^\d{6}$/.test(value)) {
        exp_text = value;
        cursor += 8;
        continue;
      }
      break;
    }

    if (ai2 === "10") {
      cursor += 2;
      let nextCursor = raw.length;

      const ai17Index = raw.indexOf("17", cursor);
      if (ai17Index !== -1) nextCursor = Math.min(nextCursor, ai17Index);

      const value = raw.slice(cursor, nextCursor);
      lot_serial = value || null;
      cursor = nextCursor;
      continue;
    }

    break;
  }

  return {
    barcode_text,
    lot_serial,
    exp_text: exp_text ?? EXP_NULL_PLACEHOLDER,
    exp: parseYYMMDDToDate(exp_text ?? EXP_NULL_PLACEHOLDER),
    normalized_scan: raw,
    matched_by: "GS1_AI" as const,
  };
}

export async function findMasterBarcodeForScan(scannedBarcode: string) {
  const raw = normalizeScanText(scannedBarcode);

  if (raw.startsWith("01") && raw.length >= 16) {
    const gtin14 = raw.slice(2, 16);

    const byGtin = await prisma.barcode.findFirst({
      where: {
        barcode: gtin14,
        deleted_at: null,
        active: true,
      },
      select: {
        id: true,
        barcode: true,
        lot_start: true,
        lot_stop: true,
        exp_start: true,
        exp_stop: true,
        barcode_length: true,
        product_id: true,
      },
    });

    if (byGtin) return byGtin;
  }

  const byDirect = await prisma.barcode.findFirst({
    where: {
      barcode: raw,
      deleted_at: null,
      active: true,
    },
    select: {
      id: true,
      barcode: true,
      lot_start: true,
      lot_stop: true,
      exp_start: true,
      exp_stop: true,
      barcode_length: true,
      product_id: true,
    },
  });

  return byDirect;
}
type ScanMatchedBy =
  | "GS1_AI"
  | "BASE_SUFFIX"
  | "FIXED_META"
  | "MASTER_PREFIX";

type ResolvedPayloadBarcode = {
  payload: string;
  barcode_text: string;
  lot_serial: string | null;
  exp_text: string;
  exp: Date | null;
  matched_by: ScanMatchedBy;
  master_barcode_id: number | null;
};

export async function resolveBarcodeTextLotExpFromPayload(
  payload: string,
): Promise<ResolvedPayloadBarcode> {
  const text = normalizeScanText(payload);
  if (!text) throw badRequest("กรุณาส่ง barcode");
  if (text.length < 7) throw badRequest(`barcode payload สั้นเกินไป: ${text}`);

  const masters = await prisma.barcode.findMany({
    where: { deleted_at: null, active: true },
    select: {
      id: true,
      barcode: true,
      lot_start: true,
      lot_stop: true,
      exp_start: true,
      exp_stop: true,
    },
  });

  let matchedMaster: (typeof masters)[number] | null = null;
  for (const m of masters) {
    const b = normalizeScanText(m.barcode);
    if (!b) continue;
    if (text.startsWith(b)) {
      if (
        !matchedMaster ||
        b.length > normalizeScanText(matchedMaster.barcode).length
      ) {
        matchedMaster = m;
      }
    }
  }

  if (!matchedMaster) {
    throw badRequest(`ไม่พบ barcode master ที่ match payload: ${text}`);
  }

  const parsed = hasFixedLotExpMeta(matchedMaster)
    ? parseScannedBarcodeByMasterMeta({
        scannedBarcode: text,
        masterBarcode: matchedMaster.barcode,
        lot_start: matchedMaster.lot_start,
        lot_stop: matchedMaster.lot_stop,
        exp_start: matchedMaster.exp_start,
        exp_stop: matchedMaster.exp_stop,
      })
    : parseScannedBarcodeByBaseBarcode(text, matchedMaster.barcode);

  return {
    payload: text,
    barcode_text: parsed.barcode_text,
    lot_serial: normalizeLot(parsed.lot_serial),
    exp_text: parsed.exp_text,
    exp: parsed.exp,
    matched_by:
      parsed.matched_by === "GS1_AI" ? "GS1_AI" : "MASTER_PREFIX",
    master_barcode_id: matchedMaster.id ?? null,
  };
}

/**
 * ตัวเดียวจบสำหรับทุก ctl
 * ลำดับใหม่:
 * 1) ถ้าเป็น GS1 (ขึ้นต้น 01) ให้ parse GS1 ก่อนเสมอ
 * 2) ถ้ามี master ให้ใช้ master ต่อ
 * 3) ถ้าไม่มี master ให้ fallback prefix เดิม
 */
export async function resolveBarcodeScan(
  scannedBarcode: string,
): Promise<ResolvedScanResult> {
  const raw = String(scannedBarcode ?? "").trim();
  const normalized = normalizeScanText(raw);

  if (!normalized) throw badRequest("กรุณาส่ง barcode");

  const masters = await prisma.barcode.findMany({
    where: {
      deleted_at: null,
      active: true,
    },
    select: {
      id: true,
      barcode: true,
      lot_start: true,
      lot_stop: true,
      exp_start: true,
      exp_stop: true,
      barcode_length: true,
      product_id: true,
    },
  });

  let matchedMaster: (typeof masters)[number] | null = null;

  for (const m of masters) {
    const b = normalizeScanText(m.barcode);
    if (!b) continue;

    /**
     * ✅ เช็ค master barcode ปกติก่อน
     * เช่น DB = 011122334455
     * scan = 011122334455MDT
     * ต้อง match ตัวนี้ก่อน ห้ามไปเข้า GS1
     */
    if (normalized.startsWith(b)) {
      if (
        !matchedMaster ||
        b.length > normalizeScanText(matchedMaster.barcode).length
      ) {
        matchedMaster = m;
      }
    }
  }

  /**
   * ✅ ถ้าเจอ master barcode แล้ว
   * ให้ดู meta ก่อนว่าเป็น fixed lot/exp จริงไหม
   */
  if (matchedMaster) {
    const hasMeta = hasFixedLotExpMeta({
      lot_start: matchedMaster.lot_start,
      lot_stop: matchedMaster.lot_stop,
      exp_start: matchedMaster.exp_start,
      exp_stop: matchedMaster.exp_stop,
    });

    /**
     * ✅ ถ้า meta ครบ และทุกตัว > 0
     * ใช้ FIXED_META
     */
    if (hasMeta) {
      const parsed = parseScannedBarcodeByMasterMeta({
        scannedBarcode: normalized,
        masterBarcode: String(matchedMaster.barcode ?? ""),
        lot_start: matchedMaster.lot_start,
        lot_stop: matchedMaster.lot_stop,
        exp_start: matchedMaster.exp_start,
        exp_stop: matchedMaster.exp_stop,
      });

      return {
        raw_input: raw,
        normalized_input: normalized,
        matched_by: "FIXED_META",
        barcode_text: parsed.barcode_text,
        lot_serial: normalizeLot(parsed.lot_serial),
        exp_text: parsed.exp_text,
        exp: parsed.exp,
        master_barcode_id: matchedMaster.id ?? null,
      };
    }

    /**
     * ✅ ถ้า meta ไม่ครบ / มี 0 / มี null
     * ถือว่าไม่ใช่ ISO/GS1
     * ใช้ BASE_SUFFIX เท่านั้น
     */
    const parsed = parseScannedBarcodeByBaseBarcode(
      normalized,
      String(matchedMaster.barcode ?? ""),
    );

    return {
      raw_input: raw,
      normalized_input: normalized,
      matched_by: "BASE_SUFFIX",
      barcode_text: parsed.barcode_text,
      lot_serial: normalizeLot(parsed.lot_serial),
      exp_text: parsed.exp_text,
      exp: parsed.exp,
      master_barcode_id: matchedMaster.id ?? null,
    };
  }

  /**
   * ✅ เช็ค 01 / GS1 ทีหลัง
   * ใช้เฉพาะกรณีหา master prefix ปกติไม่เจอ
   */
  if (normalized.startsWith("01")) {
    const gs1Parsed = parseGS1AIBarcode(normalized);

    if (gs1Parsed?.barcode_text) {
      const gtinMaster = await prisma.barcode.findFirst({
        where: {
          barcode: gs1Parsed.barcode_text,
          deleted_at: null,
          active: true,
        },
        select: {
          id: true,
          barcode: true,
          lot_start: true,
          lot_stop: true,
          exp_start: true,
          exp_stop: true,
          barcode_length: true,
          product_id: true,
        },
      });

      return {
        raw_input: raw,
        normalized_input: normalized,
        matched_by: "GS1_AI",
        barcode_text: gs1Parsed.barcode_text,
        lot_serial: normalizeLot(gs1Parsed.lot_serial),
        exp_text: gs1Parsed.exp_text,
        exp: gs1Parsed.exp,
        master_barcode_id: gtinMaster?.id ?? null,
      };
    }
  }

  const fallback = await resolveBarcodeTextLotExpFromPayload(normalized);

  return {
    raw_input: raw,
    normalized_input: normalized,
    barcode_text: fallback.barcode_text,
    matched_by: fallback.matched_by,
    lot_serial: fallback.lot_serial,
    exp_text: fallback.exp_text,
    exp: fallback.exp,
    master_barcode_id: fallback.master_barcode_id ?? null,
  };
}

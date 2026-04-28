import { badRequest } from "../appError";

export function isTFNumber(no: string | null | undefined): boolean {
  const s = String(no ?? "")
    .trim()
    .toUpperCase();

  if (!s) return false;

  return s.startsWith("TF") || s.includes("/TF/");
}

export function isExpNcrDest(value: unknown): boolean {
  return (
    String(value ?? "")
      .trim()
      .toUpperCase() === "WH/M_EXP&NCR"
  );
}

export function parseSearchDateRange(search: string): { gte: Date; lt: Date } | null {
  const raw = String(search ?? "").trim();
  if (!raw) return null;

  const normalized = raw
    .replace(/\s*,\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const dmyMatch = normalized.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );

  if (dmyMatch) {
    const dd = Number(dmyMatch[1]);
    const mm = Number(dmyMatch[2]);
    const yyyy = Number(dmyMatch[3]);
    const hh = dmyMatch[4] != null ? Number(dmyMatch[4]) : null;
    const mi = dmyMatch[5] != null ? Number(dmyMatch[5]) : null;
    const ss = dmyMatch[6] != null ? Number(dmyMatch[6]) : 0;

    if (
      !Number.isFinite(dd) ||
      !Number.isFinite(mm) ||
      !Number.isFinite(yyyy) ||
      dd < 1 ||
      dd > 31 ||
      mm < 1 ||
      mm > 12
    ) {
      return null;
    }

    if (hh != null && mi != null) {
      if (hh < 0 || hh > 23 || mi < 0 || mi > 59 || ss < 0 || ss > 59) {
        return null;
      }

      const start = new Date(Date.UTC(yyyy, mm - 1, dd, hh, mi, ss, 0));
      const end = new Date(start.getTime() + 60 * 1000);
      return { gte: start, lt: end };
    }

    return {
      gte: new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0, 0)),
      lt: new Date(Date.UTC(yyyy, mm - 1, dd + 1, 0, 0, 0, 0)),
    };
  }

  const ymdMatch = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );

  if (ymdMatch) {
    const yyyy = Number(ymdMatch[1]);
    const mm = Number(ymdMatch[2]);
    const dd = Number(ymdMatch[3]);
    const hh = ymdMatch[4] != null ? Number(ymdMatch[4]) : null;
    const mi = ymdMatch[5] != null ? Number(ymdMatch[5]) : null;
    const ss = ymdMatch[6] != null ? Number(ymdMatch[6]) : 0;

    if (
      !Number.isFinite(dd) ||
      !Number.isFinite(mm) ||
      !Number.isFinite(yyyy) ||
      dd < 1 ||
      dd > 31 ||
      mm < 1 ||
      mm > 12
    ) {
      return null;
    }

    if (hh != null && mi != null) {
      if (hh < 0 || hh > 23 || mi < 0 || mi > 59 || ss < 0 || ss > 59) {
        return null;
      }

      const start = new Date(Date.UTC(yyyy, mm - 1, dd, hh, mi, ss, 0));
      const end = new Date(start.getTime() + 60 * 1000);
      return { gte: start, lt: end };
    }

    return {
      gte: new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0, 0)),
      lt: new Date(Date.UTC(yyyy, mm - 1, dd + 1, 0, 0, 0, 0)),
    };
  }

  const maybeDate = new Date(raw);
  if (!Number.isNaN(maybeDate.getTime())) {
    const yyyy = maybeDate.getUTCFullYear();
    const mm = maybeDate.getUTCMonth();
    const dd = maybeDate.getUTCDate();

    return {
      gte: new Date(Date.UTC(yyyy, mm, dd, 0, 0, 0, 0)),
      lt: new Date(Date.UTC(yyyy, mm, dd + 1, 0, 0, 0, 0)),
    };
  }

  return null;
}

export function toExpDate(expStr: string | null): Date | undefined {
  if (!expStr) return undefined;

  if (/^\d{4}-\d{2}-\d{2}$/.test(expStr)) {
    return new Date(`${expStr}T00:00:00.000Z`);
  }

  const d = new Date(expStr);
  if (isNaN(d.getTime())) return undefined;

  return d;
}

export function normalizeExpDate(v: unknown): Date | null {
  if (!v) return null;

  if (v instanceof Date) {
    return isNaN(v.getTime()) ? null : v;
  }

  const s = String(v).trim();
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00.000Z`);
    return isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export function toDateOnlyKey(v: unknown): string | null {
  const d = normalizeExpDate(v);
  if (!d) return null;

  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function sameExpDate(a: unknown, b: unknown): boolean {
  return toDateOnlyKey(a) === toDateOnlyKey(b);
}

export function isNullishExp(v: unknown) {
  return toDateOnlyKey(v) == null;
}

export function normalizeOwnerText(v: any): string | null {
  if (v == null) return null;

  if (Array.isArray(v)) {
    const first = v.find((x) => typeof x === "string" && x.trim());
    return first ? String(first).trim() : null;
  }

  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

export function normalizeLotId(v: any): number | null {
  if (Array.isArray(v)) {
    return v.length > 0 && typeof v[0] === "number" ? v[0] : null;
  }

  return typeof v === "number" ? v : null;
}

export function normalizeLotSerial(v: any): string | null {
  if (Array.isArray(v)) {
    return v.length > 0 && typeof v[0] === "string" ? v[0] : null;
  }

  return typeof v === "string" ? v : null;
}

export function normalizeStr(v: any): string | null {
  if (v === null || v === undefined) return null;

  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

export function normalizeNullableText(v: any): string | null {
  if (v === null || v === undefined) return null;

  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

export function toNullableInt(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function normalizeBarcodeTextFromOdoo(item: any): string | null {
  if (Array.isArray(item?.barcodes) && item.barcodes.length > 0) {
    const bc = item.barcodes[0]?.barcode;
    const t = typeof bc === "string" ? bc.trim() : "";
    return t.length > 0 ? t : null;
  }

  return null;
}

export function resolveOutTypeFromNo(no: string | null | undefined): string {
  const s = String(no ?? "").toUpperCase();
  if (!s) return "DO";

  const TYPES = [
    "BOCR/DO",
    "BOA",
    "BOS",
    "CPD",
    "NCR",
    "EX",
    "SV",
    "GA",
    "TF",
    "BO",
    "INV",
    "BS",
    "DO",
  ];

  for (const t of TYPES) {
    if (s.includes(t)) return t;
  }

  return "DO";
}

export const buildKey = (x: {
  product_id: number | null;
  lot_serial: string | null;
  exp?: Date | null;
}) =>
  `p:${x.product_id ?? "null"}|lotSer:${x.lot_serial ?? ""}|exp:${
    toDateOnlyKey(x.exp ?? null) ?? "null"
  }`;

export function normalizeLot(v: unknown) {
  return String(v ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function firstStr(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : undefined;
  return undefined;
}

export function decodeNoParam(v: unknown): string {
  const s = Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
  if (!s) return "";
  return decodeURIComponent(s);
}

export function pickPositiveInt(v: unknown, field: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw badRequest(`${field} ต้องเป็นจำนวนเต็ม >= 0`);
  }
  return n;
}

export function normalizeLotSerialForMatch(v: unknown): string {
  return String(v ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

export function sameLotSerialForMatch(a: unknown, b: unknown): boolean {
  return normalizeLotSerialForMatch(a) === normalizeLotSerialForMatch(b);
}
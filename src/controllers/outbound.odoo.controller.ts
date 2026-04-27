import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { asyncHandler } from "../utils/asyncHandler";
import axios from "axios";
import { getUserId } from "../utils/auth.util";
import { badRequest, notFound } from "../utils/appError";
import {
  OdooOutboundRequest,
  OdooOutboundRequestParams,
} from "../types/outbound";
import { AuthRequest, buildDepartmentAccessWhere } from "../middleware/auth";
import { formatOdooOutbound } from "../utils/formatters/odoo_outbound.formatter";
import { io } from "../index";
import {
  resolveBarcodeScan,
  normalizeScanText,
} from "../utils/helper_scan/barcode";
import {
  buildQueuedOdooFragment,
  buildOdooItemsForSingleAdjustment,
  buildLotAdjustmentSignature,
} from "../utils/helper_scan/change_lot";

/**
 * ==============================
 * ✅ TF intercept helpers (เหมือน inbound)
 * ==============================
 */

function isTFNumber(no: string | null | undefined): boolean {
  const s = String(no ?? "")
    .trim()
    .toUpperCase();

  if (!s) return false;

  return s.startsWith("TF") || s.includes("/TF/");
}

function isExpNcrDest(value: unknown): boolean {
  return (
    String(value ?? "")
      .trim()
      .toUpperCase() === "WH/M_EXP&NCR"
  );
}
function parseSearchDateRange(search: string): { gte: Date; lt: Date } | null {
  const raw = String(search ?? "").trim();
  if (!raw) return null;

  const normalized = raw
    .replace(/\s*,\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // dd/MM/yyyy [HH:mm[:ss]]
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

  // yyyy-MM-dd [HH:mm[:ss]]
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

  // fallback เดิม
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

/**
 * แปลง "YYYY-MM-DD" หรือ ISO string ให้เป็น Date สำหรับเก็บลง timestamp
 * - ถ้าเป็น "YYYY-MM-DD" -> ปักเป็น 00:00:00Z เพื่อไม่ให้ timezone ทำให้วันเพี้ยน
 */
function toExpDate(expStr: string | null): Date | undefined {
  if (!expStr) return undefined;

  if (/^\d{4}-\d{2}-\d{2}$/.test(expStr)) {
    return new Date(`${expStr}T00:00:00.000Z`);
  }

  const d = new Date(expStr);
  if (isNaN(d.getTime())) return undefined;

  return d;
}

function normalizeExpDate(v: unknown): Date | null {
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

function toDateOnlyKey(v: unknown): string | null {
  const d = normalizeExpDate(v);
  if (!d) return null;

  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function sameExpDate(a: unknown, b: unknown): boolean {
  return toDateOnlyKey(a) === toDateOnlyKey(b);
}

/**
 * ==============================
 * ✅ Outbound existing policy (NEW)
 * match by: product_id + lot_serial(lot_name) + exp(date-only)
 * do NOT match by lot_id anymore
 * ==============================
 */
async function createCompletedAutoAdjustmentFromTransfer(
  tx: Prisma.TransactionClient,
  input: {
    no: string;
    picking_id?: number | null;
    location_id?: number | null;
    location?: string | null;
    location_dest_id?: number | null;
    location_dest?: string | null;
    location_owner?: string | null;
    location_owner_display?: string | null;
    location_dest_owner?: string | null;
    location_dest_owner_display?: string | null;
    department_id?: string | null;
    department?: string | null;
    reference?: string | null;
    origin?: string | null;
    type: string;
    items: Array<{
      sequence: number | null;
      product_id: number | null;
      code: string | null;
      name: string | null;
      unit: string | null;
      tracking: string | null;
      lot_id: number | null;
      lot_serial: string | null;
      qty: number;
      exp: Date | null;
      barcode_payload?: string | null;
    }>;
  },
) {
  const existing = await tx.adjustment.findFirst({
    where: { no: input.no, deleted_at: null },
    select: { id: true },
  });

  let adjustmentId: number;

  if (existing) {
    const updated = await tx.adjustment.update({
      where: { id: existing.id },
      data: {
        inventory_id: null,
        picking_id: input.picking_id ?? null,
        picking_no: input.no,
        department_id: input.department_id ?? null,
        department: input.department ?? "",
        reference: input.reference ?? null,
        origin: input.origin ?? null,
        level: "post-process",
        type: input.type,
        status: "completed",
        is_system_generated: true,
        date: new Date(),
        updated_at: new Date(),
      },
      select: { id: true },
    });

    adjustmentId = updated.id;

    await tx.adjustment_item.updateMany({
      where: {
        adjustment_id: adjustmentId,
        deleted_at: null,
      },
      data: {
        deleted_at: new Date(),
        updated_at: new Date(),
      } as any,
    });
  } else {
    const created = await tx.adjustment.create({
      data: {
        no: input.no,
        inventory_id: null,
        picking_id: input.picking_id ?? null,
        picking_no: input.no,
        department_id: input.department_id ?? null,
        department: input.department ?? "",
        reference: input.reference ?? null,
        origin: input.origin ?? null,
        level: "post-process",
        type: input.type,
        status: "completed",
        is_system_generated: true,
        date: new Date(),
      },
      select: { id: true },
    });

    adjustmentId = created.id;
  }

  if (input.items.length > 0) {
    await tx.adjustment_item.createMany({
      data: input.items.map((item) => ({
        adjustment_id: adjustmentId,
        sequence: item.sequence,
        product_id: item.product_id,
        code: item.code,
        name: item.name ?? "",
        unit: item.unit ?? "",
        location_id: input.location_id ?? null,
        location: input.location_owner ?? input.location ?? null,

        location_owner: input.location_owner ?? null,
        location_owner_display: input.location_owner_display ?? null,

        location_dest_id: input.location_dest_id ?? null,
        location_dest: input.location_dest ?? null,

        location_dest_owner: input.location_dest_owner ?? null,
        location_dest_owner_display: input.location_dest_owner_display ?? null,

        tracking: item.tracking ?? null,
        lot_id: item.lot_id ?? null,
        lot_serial: item.lot_serial ?? null,
        qty: item.qty,
        exp: item.exp ?? null,
        barcode_payload: item.barcode_payload ?? null,
        qty_pick: item.qty,
      })),
    });
  }
}

function normalizeOwnerText(v: any): string | null {
  if (v == null) return null;

  if (Array.isArray(v)) {
    const first = v.find((x) => typeof x === "string" && x.trim());
    return first ? String(first).trim() : null;
  }

  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

// ===== input_number helpers =====
type InputKey = string;
const keyOf = (
  product_id: number | null | undefined,
  lot_serial: string | null | undefined,
): InputKey => `p:${product_id ?? "null"}|lotSer:${(lot_serial ?? "").trim()}`;

async function buildInputNumberMapFromItems(
  items: Array<{
    product_id?: number | null;
    lot_serial?: string | null;
    lot_name?: string | null;
  }>,
) {
  const pids = Array.from(
    new Set(
      items
        .map((x) => (typeof x.product_id === "number" ? x.product_id : null))
        .filter((x): x is number => x != null),
    ),
  );

  const map = new Map<InputKey, boolean>();
  if (pids.length === 0) return map;

  const rows = await prisma.wms_mdt_goods.findMany({
    where: { product_id: { in: pids } },
    select: { id: true, product_id: true, input_number: true },
    orderBy: { id: "desc" },
  });

  for (const r of rows) {
    const k = keyOf(r.product_id, "");
    if (!map.has(k)) map.set(k, Boolean(r.input_number));
  }

  return map;
}

function resolveInputNumberFromMap(
  map: Map<InputKey, boolean>,
  product_id: number | null | undefined,
  lot_serial: string | null | undefined,
) {
  if (typeof product_id !== "number") return false;

  const exact = map.get(keyOf(product_id, (lot_serial ?? "").trim()));
  if (exact !== undefined) return exact;

  const fallback = map.get(keyOf(product_id, ""));
  if (fallback !== undefined) return fallback;

  return false;
}

// ========= helpers =========
function normalizeLotId(v: any): number | null {
  if (Array.isArray(v))
    return v.length > 0 && typeof v[0] === "number" ? v[0] : null;
  return typeof v === "number" ? v : null;
}

function normalizeLotSerial(v: any): string | null {
  if (Array.isArray(v))
    return v.length > 0 && typeof v[0] === "string" ? v[0] : null;
  return typeof v === "string" ? v : null;
}

function normalizeStr(v: any): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function normalizeNullableText(v: any): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function toNullableInt(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeBarcodeTextFromOdoo(item: any): string | null {
  if (Array.isArray(item?.barcodes) && item.barcodes.length > 0) {
    const bc = item.barcodes[0]?.barcode;
    const t = typeof bc === "string" ? bc.trim() : "";
    return t.length > 0 ? t : null;
  }
  return null;
}

function resolveOutTypeFromNo(no: string | null | undefined): string {
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

// =====================================================
// ✅ Deduct from bor_stocks/ser_stocks for GA/BOS/SV/BOCR/DO
// =====================================================
const BOR_SER_DEDUCT_TYPES = new Set(["GA", "BOS", "SV", "BOCR/DO"]);

function resolveBorSerTargetFromText(v: string | null | undefined) {
  const s = String(v ?? "").toUpperCase();
  if (s.includes("BOR")) return "BOR" as const;
  if (s.includes("SER")) return "SER" as const;
  return null;
}

async function resolveBorSerTargetFromDest(
  tx: Prisma.TransactionClient,
  transfer: { location_dest?: string | null; location_dest_id?: number | null },
) {
  const direct = resolveBorSerTargetFromText(transfer.location_dest);
  if (direct) return direct;

  if (typeof transfer.location_dest_id === "number") {
    const loc = await tx.location.findUnique({
      where: { id: transfer.location_dest_id },
      select: { full_name: true, deleted_at: true },
    });
    if (loc && !loc.deleted_at) {
      return resolveBorSerTargetFromText(loc.full_name);
    }
  }

  return null;
}

async function resolveBorSerTargetFromSource(
  tx: Prisma.TransactionClient,
  transfer: { location?: string | null; location_id?: number | null },
) {
  const direct = resolveBorSerTargetFromText(transfer.location);
  if (direct) return direct;

  if (typeof transfer.location_id === "number") {
    const loc = await tx.location.findUnique({
      where: { id: transfer.location_id },
      select: { full_name: true, deleted_at: true },
    });

    if (loc && !loc.deleted_at) {
      return resolveBorSerTargetFromText(loc.full_name);
    }
  }

  return null;
}

type DeductMergedItem = {
  product_id: number | null;
  lot_id: number | null;
  lot_serial: string | null;
  qty: number;
  exp: Date | null;
};

async function decrementBorSerStocksForGaBosSv(
  tx: Prisma.TransactionClient,
  args: {
    outType: string;
    transfer: {
      no: string;
      location_id?: number | null;
      location?: string | null;
      location_dest_id?: number | null;
      location_dest?: string | null;
    };
    mergedItems: DeductMergedItem[];
  },
) {
  const { outType, transfer, mergedItems } = args;

  const target =
    (await resolveBorSerTargetFromSource(tx, {
      location: transfer.location ?? null,
      location_id: transfer.location_id ?? null,
    })) ??
    (await resolveBorSerTargetFromDest(tx, {
      location_dest: transfer.location_dest ?? null,
      location_dest_id: transfer.location_dest_id ?? null,
    }));

  if (!target) {
    throw badRequest(
      `type (${outType}) ต้องมี BOR/SER ใน location หรือ location_dest (ตอนนี้ location=${transfer.location ?? "-"} location_id=${transfer.location_id ?? "null"} location_dest=${transfer.location_dest ?? "-"} location_dest_id=${transfer.location_dest_id ?? "null"})`,
    );
  }

  for (const it of mergedItems) {
    if (!it.product_id) continue;

    const qty = Math.floor(Number(it.qty ?? 0));
    if (!Number.isFinite(qty) || qty <= 0) continue;

    const effectiveExp = await resolveEffectiveExp(tx, {
      product_id: it.product_id,
      lot_id: it.lot_id ?? null,
      lot_serial: it.lot_serial ?? null,
      exp: it.exp ?? null,
    });

    const whereBase = buildBorSerWhereBase({
      product_id: it.product_id,
      lot_id: it.lot_id ?? null,
      lot_serial: it.lot_serial ?? null,
    });

    if (target === "SER") {
      const rows = await tx.ser_stock.findMany({
        where: whereBase,
        select: {
          id: true,
          quantity: true,
          expiration_date: true,
          lot_id: true,
          lot_name: true,
        },
        orderBy: { id: "desc" },
      });

      const row =
        rows.find((r) => sameExpDate(r.expiration_date, effectiveExp)) ?? null;

      if (!row) {
        throw badRequest(
          `ไม่พบ ser_stock สำหรับตัด (product_id=${it.product_id}, lot_id=${it.lot_id ?? "null"}, lot_serial=${it.lot_serial ?? "null"}, exp=${toDateOnlyKey(effectiveExp) ?? "null"})`,
        );
      }

      const current = Number(row.quantity ?? 0);
      if (current < qty) {
        throw badRequest(
          `ser_stock ไม่พอ (need=${qty}, have=${current}) product_id=${it.product_id} lot_id=${it.lot_id ?? "null"} lot_serial=${it.lot_serial ?? "null"} exp=${toDateOnlyKey(effectiveExp) ?? "null"}`,
        );
      }

      const remain = current - qty;
      if (remain <= 0) {
        await tx.ser_stock.delete({ where: { id: row.id } });
      } else {
        await tx.ser_stock.update({
          where: { id: row.id },
          data: {
            quantity: { decrement: new Prisma.Decimal(qty) },
            updated_at: new Date(),
          },
        });
      }
    } else {
      const rows = await tx.bor_stock.findMany({
        where: whereBase,
        select: {
          id: true,
          quantity: true,
          expiration_date: true,
          lot_id: true,
          lot_name: true,
        },
        orderBy: { id: "desc" },
      });

      const row =
        rows.find((r) => sameExpDate(r.expiration_date, effectiveExp)) ?? null;

      if (!row) {
        throw badRequest(
          `ไม่พบ bor_stock สำหรับตัด (product_id=${it.product_id}, lot_id=${it.lot_id ?? "null"}, lot_serial=${it.lot_serial ?? "null"}, exp=${toDateOnlyKey(effectiveExp) ?? "null"})`,
        );
      }

      const current = Number(row.quantity ?? 0);
      if (current < qty) {
        throw badRequest(
          `bor_stock ไม่พอ (need=${qty}, have=${current}) product_id=${it.product_id} lot_id=${it.lot_id ?? "null"} lot_serial=${it.lot_serial ?? "null"} exp=${toDateOnlyKey(effectiveExp) ?? "null"}`,
        );
      }

      const remain = current - qty;
      if (remain <= 0) {
        await tx.bor_stock.delete({ where: { id: row.id } });
      } else {
        await tx.bor_stock.update({
          where: { id: row.id },
          data: {
            quantity: { decrement: new Prisma.Decimal(qty) },
            updated_at: new Date(),
          },
        });
      }
    }
  }
}

// =====================================================
// ✅ Replace qty in bor_stocks/ser_stocks for EX/BOA
// =====================================================
const BOR_SER_REPLACE_TYPES = new Set(["EX", "BOA"]);

type ReplaceMergedItem = {
  product_id: number | null;
  lot_id: number | null;
  lot_serial: string | null;
  qty: number;
  code?: string | null;
  name?: string | null;
  unit?: string | null;
  exp: Date | null;
};

async function replaceBorSerStocksForExBoa(
  tx: Prisma.TransactionClient,
  args: {
    outType: string;
    transfer: {
      no: string;
      location_dest_id: number | null;
      location_dest: string | null;
      department_id?: string | null;
      department?: string | null;
      location_owner?: string | null;
      location_owner_display?: string | null;
      location_dest_owner?: string | null;
      location_dest_owner_display?: string | null;
    };
    mergedItems: ReplaceMergedItem[];
  },
) {
  const { outType, transfer, mergedItems } = args;

  const target = await resolveBorSerTargetFromDest(tx, {
    location_dest: transfer.location_dest,
    location_dest_id: transfer.location_dest_id,
  });

  if (!target) {
    throw badRequest(
      `type (${outType}) ต้องมี BOR/SER ใน location_dest หรือ location_dest_id (ตอนนี้ location_dest=${transfer.location_dest ?? "-"} location_dest_id=${transfer.location_dest_id ?? "null"})`,
    );
  }

  const now = new Date();

  for (const it of mergedItems) {
    if (!it.product_id) continue;

    const qty = Number(it.qty ?? 0);
    if (!Number.isFinite(qty)) continue;

    const finalQty = new Prisma.Decimal(qty);
    const shouldDelete = Number(qty) <= 0;

    const effectiveExp = await resolveEffectiveExp(tx, {
      product_id: it.product_id,
      lot_id: it.lot_id ?? null,
      lot_serial: it.lot_serial ?? null,
      exp: it.exp ?? null,
    });

    const whereBase = buildBorSerWhereBase({
      product_id: it.product_id,
      lot_id: it.lot_id ?? null,
      lot_serial: it.lot_serial ?? null,
    });

    if (target === "SER") {
      const rows = await tx.ser_stock.findMany({
        where: whereBase,
        select: {
          id: true,
          expiration_date: true,
          lot_id: true,
          lot_name: true,
        },
        orderBy: { id: "desc" },
      });

      const row =
        rows.find((r) => sameExpDate(r.expiration_date, effectiveExp)) ?? null;

      if (shouldDelete) {
        if (row?.id) await tx.ser_stock.delete({ where: { id: row.id } });
        continue;
      }

      if (row?.id) {
        await tx.ser_stock.update({
          where: { id: row.id },
          data: {
            snapshot_date: now,
            no: transfer.no ?? null,
            quantity: finalQty,
            updated_at: now as any,
            expiration_date: effectiveExp,
            department_id: transfer.department_id ?? null,
            department_name: transfer.department ?? null,
            location_owner: transfer.location_owner ?? null,
            location_owner_display: transfer.location_owner_display ?? null,
            location_dest_owner: transfer.location_dest_owner ?? null,
            location_dest_owner_dispalay:
              transfer.location_dest_owner_display ?? null,
          } as any,
        });
      } else {
        await tx.ser_stock.create({
          data: {
            snapshot_date: now,
            no: transfer.no ?? null,
            product_id: it.product_id,
            product_code: it.code ?? null,
            product_name: it.name ?? null,
            unit: it.unit ?? null,
            location_id: transfer.location_dest_id ?? null,
            location_name: transfer.location_dest ?? null,
            department_id: transfer.department_id ?? null,
            department_name: transfer.department ?? null,
            location_owner: transfer.location_owner ?? null,
            location_owner_display: transfer.location_owner_display ?? null,
            location_dest_owner: transfer.location_dest_owner ?? null,
            location_dest_owner_dispalay:
              transfer.location_dest_owner_display ?? null,
            lot_id: it.lot_id ?? null,
            lot_name: it.lot_serial ?? null,
            expiration_date: effectiveExp,
            product_last_modified_date: null,
            source: "wms",
            quantity: finalQty,
            active: true,
          } as any,
        });
      }
    } else {
      const rows = await tx.bor_stock.findMany({
        where: whereBase,
        select: {
          id: true,
          expiration_date: true,
          lot_id: true,
          lot_name: true,
        },
        orderBy: { id: "desc" },
      });

      const row =
        rows.find((r) => sameExpDate(r.expiration_date, effectiveExp)) ?? null;

      if (shouldDelete) {
        if (row?.id) await tx.bor_stock.delete({ where: { id: row.id } });
        continue;
      }

      if (row?.id) {
        await tx.bor_stock.update({
          where: { id: row.id },
          data: {
            snapshot_date: now,
            no: transfer.no ?? null,
            quantity: finalQty,
            updated_at: now as any,
            expiration_date: effectiveExp,
            department_id: transfer.department_id ?? null,
            department_name: transfer.department ?? null,
            location_owner: transfer.location_owner ?? null,
            location_owner_display: transfer.location_owner_display ?? null,
            location_dest_owner: transfer.location_dest_owner ?? null,
            location_dest_owner_dispalay:
              transfer.location_dest_owner_display ?? null,
          } as any,
        });
      } else {
        await tx.bor_stock.create({
          data: {
            snapshot_date: now,
            no: transfer.no ?? null,
            product_id: it.product_id,
            product_code: it.code ?? null,
            product_name: it.name ?? null,
            unit: it.unit ?? null,
            location_id: transfer.location_dest_id ?? null,
            location_name: transfer.location_dest ?? null,
            department_id: transfer.department_id ?? null,
            department_name: transfer.department ?? null,
            location_owner: transfer.location_owner ?? null,
            location_owner_display: transfer.location_owner_display ?? null,
            location_dest_owner: transfer.location_dest_owner ?? null,
            location_dest_owner_dispalay:
              transfer.location_dest_owner_display ?? null,
            lot_id: it.lot_id ?? null,
            lot_name: it.lot_serial ?? null,
            expiration_date: effectiveExp,
            product_last_modified_date: null,
            source: "wms",
            quantity: finalQty,
            active: true,
          } as any,
        });
      }
    }
  }
}

const buildKey = (x: {
  product_id: number | null;
  lot_serial: string | null;
  exp?: Date | null;
}) =>
  `p:${x.product_id ?? "null"}|lotSer:${x.lot_serial ?? ""}|exp:${
    toDateOnlyKey(x.exp ?? null) ?? "null"
  }`;

/**
 * ==============================
 * ✅ TF handler for OUTBOUND
 * ==============================
 */
function goodsInMatchKey(input: {
  product_id: number;
  lot_serial?: any;
  exp?: Date | string | null;
}) {
  return `p:${input.product_id}|lot:${normalizeLotSerial(
    input.lot_serial,
  )}|exp:${toDateOnlyKey(input.exp ?? null) ?? "null"}`;
}

type TFLine = {
  sequence: number | null;
  product_id: number | null;
  code: string | null;
  name: string | null;
  unit: string | null;
  tracking: string | null;
  lot_id: number | null;
  lot_serial: string | null;
  qty: number;
  barcode_text: string | null;
  expire_date?: string | null;
  exp?: Date | null;
};

async function handleTFTransferOutbound(input: {
  picking_id: any;
  number: string;
  location_id: any;
  location: any;
  location_dest_id: any;
  location_dest: any;
  department_id: any;
  department: any;
  reference: any;
  origin: any;
  mergedItems: TFLine[];
}) {
  const {
    picking_id,
    number,
    location_id,
    location,
    location_dest_id,
    location_dest,
    department_id,
    department,
    reference,
    origin,
    mergedItems,
  } = input;

  const convertedReference =
    typeof reference === "boolean"
      ? reference
        ? "true"
        : null
      : reference || null;

  const convertedOrigin =
    typeof origin === "string" ? origin : origin ? String(origin) : null;

  const header = await prisma.$transaction(async (tx) => {
    const existing = await tx.transfer_doc.findFirst({
      where: { no: number, deleted_at: null },
    });

    const doc = existing
      ? await tx.transfer_doc.update({
          where: { id: existing.id },
          data: {
            picking_id,
            location_id,
            location,
            location_dest_id,
            location_dest,
            department_id: department_id?.toString(),
            department,
            reference: convertedReference,
            origin: convertedOrigin,
            in_type: "TF",
            updated_at: new Date(),
          },
        })
      : await tx.transfer_doc.create({
          data: {
            no: number,
            picking_id,
            location_id,
            location,
            location_dest_id,
            location_dest,
            department_id: department_id?.toString(),
            department,
            reference: convertedReference,
            origin: convertedOrigin,
            date: new Date(),
            in_type: "TF",
          },
        });

    const existingLines = await tx.transfer_doc_item.findMany({
      where: { transfer_doc_id: doc.id, deleted_at: null },
      select: {
        id: true,
        sequence: true,
        product_id: true,
        lot_serial: true,
        in_process: true,
        quantity_receive: true,
        qty: true,
        exp: true,
      },
    });

    const openMap = new Map<string, (typeof existingLines)[number]>();
    for (const r of existingLines) {
      if (r.product_id == null) continue;
      if (r.in_process) continue;

      openMap.set(
        goodsInMatchKey({
          product_id: r.product_id,
          lot_serial: r.lot_serial,
          exp: r.exp ?? null,
        }),
        r,
      );
    }

    const maxSeq = existingLines.reduce(
      (m, x) => Math.max(m, Number(x.sequence ?? 0)),
      0,
    );
    let nextSeq = maxSeq + 1;

    for (let i = 0; i < mergedItems.length; i++) {
      const item = mergedItems[i];

      if (item.product_id == null) {
        throw badRequest(`Odoo item missing product_id (TF: ${number})`);
      }
      if (!item.name || !item.unit) {
        throw badRequest(
          `Odoo item missing name/unit (TF: ${number}, product_id: ${item.product_id})`,
        );
      }

      const exp = item.exp ?? toExpDate(item.expire_date ?? null) ?? null;
      const lotSerial = item.lot_serial ?? null;

      const key = goodsInMatchKey({
        product_id: item.product_id,
        lot_serial: lotSerial,
        exp,
      });

      const match = openMap.get(key);

      if (match) {
        const add = Number(item.qty ?? 0);
        if (!Number.isFinite(add) || add <= 0) continue;

        await tx.transfer_doc_item.update({
          where: { id: match.id },
          data: {
            qty: { increment: add },
            quantity_receive: { increment: add },
            updated_at: new Date(),
          } as any,
        });

        (match as any).qty = Number(match.qty ?? 0) + add;
        (match as any).quantity_receive =
          Number(match.quantity_receive ?? 0) + add;
        continue;
      }

      const finalSeq = item.sequence ?? nextSeq++;
      await tx.transfer_doc_item.create({
        data: {
          transfer_doc_id: doc.id,
          sequence: finalSeq,
          odoo_sequence: finalSeq,
          odoo_line_key: `${number}-${finalSeq}`,

          product_id: item.product_id,
          code: item.code ?? undefined,
          name: item.name!,
          unit: item.unit!,
          tracking: item.tracking ?? undefined,

          lot_id: item.lot_id ?? undefined,
          lot_serial: item.lot_serial ?? undefined,
          lot: item.lot_serial ?? undefined,

          qty: item.qty,
          quantity_receive: item.qty,
          quantity_count: 0,

          barcode_text: item.barcode_text ?? undefined,
          exp: exp ?? undefined,

          updated_at: new Date(),
        },
      });
    }

    return doc;
  });

  const fullDoc = await prisma.transfer_doc.findUnique({
    where: { id: header.id },
    include: {
      transfer_doc_items: {
        where: { deleted_at: null },
        orderBy: { sequence: "asc" },
      },
    },
  });

  return fullDoc;
}

/**
 * ==============================
 * ✅ Virtual BOR/BOS location helpers
 * ==============================
 */
function extractVirtualLockFromLocationDest(value: any): "BOR" | "BOS" | null {
  const s = String(value ?? "")
    .trim()
    .toUpperCase();

  const m = s.match(/^WH\/X?(BOR|BOS)(?:\/|$)/i);
  if (!m) return null;

  const code = String(m[1] ?? "").toUpperCase();
  return code === "BOR" || code === "BOS" ? code : null;
}

function isVirtualBorrowDest(value: any): boolean {
  return extractVirtualLockFromLocationDest(value) !== null;
}

async function findOrCreateVirtualBuildingAndZone(
  tx: Prisma.TransactionClient,
) {
  let building = await tx.building.findFirst({
    where: {
      OR: [{ short_name: "BOR/BOS" }, { full_name: "Borrow" }],
    },
    select: { id: true, full_name: true, short_name: true },
  });

  if (!building) {
    building = await tx.building.create({
      data: {
        full_name: "Borrow",
        short_name: "BOR/BOS",
        remark: "Auto created virtual building for BOR/BOS location",
      },
      select: { id: true, full_name: true, short_name: true },
    });
  }

  let zone = await tx.zone.findFirst({
    where: {
      building_id: building.id,
      OR: [{ short_name: "F01" }, { full_name: "F01" }],
    },
    select: { id: true, full_name: true, short_name: true },
  });

  if (!zone) {
    let zoneType = await tx.zone_type.findFirst({
      where: {
        OR: [{ short_name: "NORMAL" }, { full_name: "NORMAL" }],
      },
      select: { id: true },
    });

    if (!zoneType) {
      zoneType = await tx.zone_type.create({
        data: {
          full_name: "NORMAL",
          short_name: "NORMAL",
          remark: "Auto created zone_type for virtual BOR/BOS location",
        },
        select: { id: true },
      });
    }

    zone = await tx.zone.create({
      data: {
        full_name: "F01",
        short_name: "F01",
        building_id: building.id,
        zone_type_id: zoneType.id,
        remark: "Auto created virtual zone for BOR/BOS location",
      },
      select: { id: true, full_name: true, short_name: true },
    });
  }

  return {
    building_id: building.id,
    zone_id: zone.id,
  };
}

async function upsertVirtualLocationFromOdoo(
  tx: Prisma.TransactionClient,
  input: {
    location_dest_id: any;
    location_dest: any;
    location_dest_owner: any;
    location_dest_owner_display?: any;
  },
) {
  const odooLocationId = toNullableInt(input.location_dest_id);
  if (!odooLocationId) {
    throw badRequest("virtual location ต้องมี location_dest_id");
  }

  const lockNo = extractVirtualLockFromLocationDest(input.location_dest);
  if (!lockNo) return null;

  const fullName = normalizeNullableText(input.location_dest_owner);
  if (!fullName) {
    throw badRequest("virtual location ต้องมี location_dest_owner");
  }

  const { building_id, zone_id } = await findOrCreateVirtualBuildingAndZone(tx);

  const remarkParts = [
    "AUTO-VIRTUAL-LOCATION",
    "Managed by Odoo only",
    normalizeNullableText(input.location_dest),
    normalizeNullableText(input.location_dest_owner_display),
  ].filter(Boolean);

  const existingByOdoo = await tx.location.findFirst({
    where: { odoo_id: odooLocationId },
    select: {
      id: true,
      full_name: true,
      odoo_id: true,
    },
  });

  if (existingByOdoo) {
    return tx.location.update({
      where: { id: existingByOdoo.id },
      data: {
        full_name: fullName,
        building_id,
        zone_id,
        lock_no: lockNo,
        location_code: normalizeNullableText(input.location_dest),
        status: "Activate",
        remark: remarkParts.join(" | "),
        ncr_check: false,
        deleted_at: null,
        updated_at: new Date(),
      },
      select: {
        id: true,
        odoo_id: true,
        full_name: true,
        lock_no: true,
        building_id: true,
        zone_id: true,
      },
    });
  }

  const existingByName = await tx.location.findFirst({
    where: {
      full_name: fullName,
      deleted_at: null,
    },
    select: {
      id: true,
      odoo_id: true,
    },
  });

  if (existingByName) {
    return tx.location.update({
      where: { id: existingByName.id },
      data: {
        odoo_id: existingByName.odoo_id ?? odooLocationId,
        full_name: fullName,
        building_id,
        zone_id,
        lock_no: lockNo,
        location_code: normalizeNullableText(input.location_dest),
        status: "Activate",
        remark: remarkParts.join(" | "),
        ncr_check: false,
        deleted_at: null,
        updated_at: new Date(),
      },
      select: {
        id: true,
        odoo_id: true,
        full_name: true,
        lock_no: true,
        building_id: true,
        zone_id: true,
      },
    });
  }

  return tx.location.create({
    data: {
      odoo_id: odooLocationId,
      full_name: fullName,
      building_id,
      zone_id,
      lock_no: lockNo,
      location_code: normalizeNullableText(input.location_dest),
      status: "Activate",
      remark: remarkParts.join(" | "),
      ncr_check: false,
    },
    select: {
      id: true,
      odoo_id: true,
      full_name: true,
      lock_no: true,
      building_id: true,
      zone_id: true,
    },
  });
}

async function upsertSwapBorSerLocationByName(
  tx: Prisma.TransactionClient,
  input: {
    full_name: string | null | undefined;
    lock: "BOR" | "BOS" | "SER";
    location_code?: string | null | undefined;
  },
) {
  const fullName = normalizeNullableText(input.full_name);
  if (!fullName) return null;

  const { building_id, zone_id } = await findOrCreateVirtualBuildingAndZone(tx);

  const existing = await tx.location.findFirst({
    where: {
      full_name: fullName,
    },
    select: {
      id: true,
      full_name: true,
      deleted_at: true,
    },
  });

  if (existing) {
    return tx.location.update({
      where: { id: existing.id },
      data: {
        full_name: fullName,
        building_id,
        zone_id,
        lock_no: input.lock,
        location_code: normalizeNullableText(input.location_code),
        status: "Activate",
        remark: [
          "AUTO-SWAP-LOCATION",
          "Managed by swap auto create",
          normalizeNullableText(input.location_code),
        ]
          .filter(Boolean)
          .join(" | "),
        ncr_check: false,
        deleted_at: null,
        updated_at: new Date(),
      },
      select: {
        id: true,
        full_name: true,
        lock_no: true,
        building_id: true,
        zone_id: true,
      },
    });
  }

  return tx.location.create({
    data: {
      full_name: fullName,
      building_id,
      zone_id,
      lock_no: input.lock,
      location_code: normalizeNullableText(input.location_code),
      status: "Activate",
      remark: [
        "AUTO-SWAP-LOCATION",
        "Managed by swap auto create",
        normalizeNullableText(input.location_code),
      ]
        .filter(Boolean)
        .join(" | "),
      ncr_check: false,
    },
    select: {
      id: true,
      full_name: true,
      lock_no: true,
      building_id: true,
      zone_id: true,
    },
  });
}

/**
 * ==============================
 * ✅ swap helpers
 * ==============================
 */

async function decrementSourceBorSerStockByLocationId(
  tx: Prisma.TransactionClient,
  args: {
    table: "BOR" | "SER";
    location_id: number | null;
    location_name: string;
    item: BorSerInternalLine;
  },
) {
  const { table, location_id, location_name, item } = args;

  if (!item.product_id) {
    throw badRequest("item.product_id is required");
  }

  const needQty = Math.max(0, Math.floor(Number(item.qty ?? 0)));
  if (needQty <= 0) return;

  // ✅ สำคัญ: ถ้า payload จาก Odoo ไม่ส่ง exp มา
  // ให้ resolve exp จาก wms_mdt_goods ด้วย product_id + lot_id ก่อน
  const effectiveExp = await resolveEffectiveExp(tx, {
    product_id: item.product_id,
    lot_id: item.lot_id ?? null,
    lot_serial: item.lot_serial ?? null,
    exp: item.exp ?? null,
  });

  const baseWhere: any = {
    product_id: item.product_id,
    lot_id: item.lot_id ?? null,
  };

  // ✅ ตาม req ล่าสุด: ให้ตัด stock จาก location_name ของ swap/source
  baseWhere.location_name = location_name;

  if (table === "SER") {
    const rows = await tx.ser_stock.findMany({
      where: baseWhere,
      select: {
        id: true,
        quantity: true,
        expiration_date: true,
        lot_id: true,
        location_name: true,
      },
      orderBy: { id: "desc" },
    });

    const row =
      rows.find((x) => sameExpDate(x.expiration_date, effectiveExp)) ?? null;

    if (!row) {
      throw badRequest(
        `ไม่พบ ser_stock ต้นทาง (location_name=${location_name}, product_id=${item.product_id}, lot_id=${item.lot_id ?? "null"}, exp=${toDateOnlyKey(effectiveExp) ?? "null"})`,
      );
    }

    const currentQty = Number(row.quantity ?? 0);
    if (currentQty < needQty) {
      throw badRequest(
        `ser_stock ต้นทางไม่พอ (location_name=${location_name}, product_id=${item.product_id}, lot_id=${item.lot_id ?? "null"}, need=${needQty}, have=${currentQty}, exp=${toDateOnlyKey(effectiveExp) ?? "null"})`,
      );
    }

    const remain = currentQty - needQty;
    if (remain <= 0) {
      await tx.ser_stock.delete({ where: { id: row.id } });
    } else {
      await tx.ser_stock.update({
        where: { id: row.id },
        data: {
          quantity: { decrement: new Prisma.Decimal(needQty) },
          updated_at: new Date(),
        } as any,
      });
    }

    return;
  }

  const rows = await tx.bor_stock.findMany({
    where: baseWhere,
    select: {
      id: true,
      quantity: true,
      expiration_date: true,
      lot_id: true,
      location_name: true,
    },
    orderBy: { id: "desc" },
  });

  const row =
    rows.find((x) => sameExpDate(x.expiration_date, effectiveExp)) ?? null;

  if (!row) {
    throw badRequest(
      `ไม่พบ bor_stock ต้นทาง (location_name=${location_name}, product_id=${item.product_id}, lot_id=${item.lot_id ?? "null"}, exp=${toDateOnlyKey(effectiveExp) ?? "null"})`,
    );
  }

  const currentQty = Number(row.quantity ?? 0);
  if (currentQty < needQty) {
    throw badRequest(
      `bor_stock ต้นทางไม่พอ (location_name=${location_name}, product_id=${item.product_id}, lot_id=${item.lot_id ?? "null"}, need=${needQty}, have=${currentQty}, exp=${toDateOnlyKey(effectiveExp) ?? "null"})`,
    );
  }

  const remain = currentQty - needQty;
  if (remain <= 0) {
    await tx.bor_stock.delete({ where: { id: row.id } });
  } else {
    await tx.bor_stock.update({
      where: { id: row.id },
      data: {
        quantity: { decrement: new Prisma.Decimal(needQty) },
        updated_at: new Date(),
      } as any,
    });
  }
}

async function incrementDestBorSerStockByLocationId(
  tx: Prisma.TransactionClient,
  args: {
    table: "BOR" | "SER";
    no: string;
    location_id: number | null;
    location_name: string;
    department_id?: string | null;
    department?: string | null;
    location_owner?: string | null;
    location_owner_display?: string | null;
    location_dest_owner?: string | null;
    location_dest_owner_display?: string | null;
    item: BorSerInternalLine;
  },
) {
  const {
    table,
    no,
    location_id,
    location_name,
    department_id,
    department,
    location_owner,
    location_owner_display,
    location_dest_owner,
    location_dest_owner_display,
    item,
  } = args;

  if (!item.product_id) {
    throw badRequest("item.product_id is required");
  }

  const addQty = Math.max(0, Math.floor(Number(item.qty ?? 0)));
  if (addQty <= 0) return;

  const now = new Date();

  // ✅ resolve exp จาก payload/wms_mdt_goods ก่อนเสมอ
  const effectiveExp = await resolveEffectiveExp(tx, {
    product_id: item.product_id,
    lot_id: item.lot_id ?? null,
    lot_serial: item.lot_serial ?? null,
    exp: item.exp ?? null,
  });

  const baseWhere: any = {
    product_id: item.product_id,
    lot_id: item.lot_id ?? null,
    location_name,
  };

  if (table === "SER") {
    const rows = await tx.ser_stock.findMany({
      where: baseWhere,
      select: {
        id: true,
        expiration_date: true,
      },
      orderBy: { id: "desc" },
    });

    const row =
      rows.find((x) => sameExpDate(x.expiration_date, effectiveExp)) ?? null;

    if (row?.id) {
      await tx.ser_stock.update({
        where: { id: row.id },
        data: {
          no,
          location_id,
          location_name,
          department_id: department_id ?? null,
          department_name: department ?? null,

          location_owner: location_owner ?? null,
          location_owner_display: location_owner_display ?? null,
          location_dest_owner: location_dest_owner ?? null,
          location_dest_owner_dispalay: location_dest_owner_display ?? null,

          quantity: { increment: new Prisma.Decimal(addQty) },
          expiration_date: effectiveExp,
          updated_at: now,
        } as any,
      });
      return;
    }

    await tx.ser_stock.create({
      data: {
        snapshot_date: now,
        no,
        product_id: item.product_id,
        product_code: item.code ?? null,
        product_name: item.name ?? null,
        unit: item.unit ?? null,
        location_id,
        location_name,
        department_id: department_id ?? null,
        department_name: department ?? null,

        location_owner: location_owner ?? null,
        location_owner_display: location_owner_display ?? null,
        location_dest_owner: location_dest_owner ?? null,
        location_dest_owner_dispalay: location_dest_owner_display ?? null,

        lot_id: item.lot_id ?? null,
        lot_name: item.lot_serial ?? null,
        expiration_date: effectiveExp,
        product_last_modified_date: null,
        source: "wms",
        quantity: new Prisma.Decimal(addQty),
        active: true,
      } as any,
    });
    return;
  }

  const rows = await tx.bor_stock.findMany({
    where: baseWhere,
    select: {
      id: true,
      expiration_date: true,
    },
    orderBy: { id: "desc" },
  });

  const row =
    rows.find((x) => sameExpDate(x.expiration_date, effectiveExp)) ?? null;

  if (row?.id) {
    await tx.bor_stock.update({
      where: { id: row.id },
      data: {
        no,
        location_id,
        location_name,
        department_id: department_id ?? null,
        department_name: department ?? null,

        location_owner: location_owner ?? null,
        location_owner_display: location_owner_display ?? null,
        location_dest_owner: location_dest_owner ?? null,
        location_dest_owner_dispalay: location_dest_owner_display ?? null,

        quantity: { increment: new Prisma.Decimal(addQty) },
        expiration_date: effectiveExp,
        updated_at: now,
      } as any,
    });
    return;
  }

  await tx.bor_stock.create({
    data: {
      snapshot_date: now,
      no,
      product_id: item.product_id,
      product_code: item.code ?? null,
      product_name: item.name ?? null,
      unit: item.unit ?? null,
      location_id,
      location_name,
      department_id: department_id ?? null,
      department_name: department ?? null,

      location_owner: location_owner ?? null,
      location_owner_display: location_owner_display ?? null,
      location_dest_owner: location_dest_owner ?? null,
      location_dest_owner_dispalay: location_dest_owner_display ?? null,

      lot_id: item.lot_id ?? null,
      lot_name: item.lot_serial ?? null,
      expiration_date: effectiveExp,
      product_last_modified_date: null,
      source: "wms",
      quantity: new Prisma.Decimal(addQty),
      active: true,
    } as any,
  });
}

function extractBorSerLockFromLocation(
  value: any,
): "BOR" | "BOS" | "SER" | null {
  const s = String(value ?? "")
    .trim()
    .toUpperCase();

  const m = s.match(/^WH\/X?(BOR|BOS|SER)(?:\/|$)/i);
  if (!m) return null;

  const code = String(m[1] ?? "").toUpperCase();
  if (code === "BOR" || code === "BOS" || code === "SER") return code;
  return null;
}

function resolveBorSerTableFromLock(lock: "BOR" | "BOS" | "SER") {
  return lock === "SER" ? "SER" : "BOR";
}

function isBorSerInternalTransferLike(input: {
  location?: any;
  location_dest?: any;
  location_owner?: any;
  location_dest_owner?: any;
}) {
  const srcLock = extractBorSerLockFromLocation(input.location);
  const destLock = extractBorSerLockFromLocation(input.location_dest);
  const srcOwner = String(input.location_owner ?? "").trim();
  const destOwner = String(input.location_dest_owner ?? "").trim();

  return Boolean(srcLock && destLock && srcOwner && destOwner);
}

type BorSerInternalLine = {
  sequence: number | null;
  product_id: number | null;
  code: string | null;
  name: string | null;
  unit: string | null;
  tracking: string | null;
  lot_id: number | null;
  lot_serial: string | null;
  qty: number;
  barcode_text: string | null;
  exp: Date | null;
};

async function decrementSourceBorSerStock(
  tx: Prisma.TransactionClient,
  args: {
    table: "BOR" | "SER";
    location_name: string;
    item: BorSerInternalLine;
  },
) {
  const { table, location_name, item } = args;

  if (!item.product_id) {
    throw badRequest("item.product_id is required");
  }

  const needQty = Math.max(0, Math.floor(Number(item.qty ?? 0)));
  if (needQty <= 0) return;

  const effectiveExp = await resolveEffectiveExp(tx, {
    product_id: item.product_id,
    lot_id: item.lot_id ?? null,
    lot_serial: item.lot_serial ?? null,
    exp: item.exp ?? null,
  });

  if (table === "SER") {
    const rows = await tx.ser_stock.findMany({
      where: {
        product_id: item.product_id,
        location_name,
        lot_name: item.lot_serial ?? null,
      } as any,
      select: {
        id: true,
        quantity: true,
        expiration_date: true,
      },
      orderBy: { id: "desc" },
    });

    const row =
      rows.find((x) => sameExpDate(x.expiration_date, effectiveExp)) ?? null;

    if (!row) {
      throw badRequest(
        `ไม่พบ ser_stock ต้นทาง (location_name=${location_name}, product_id=${item.product_id}, lot=${item.lot_serial ?? "null"}, exp=${toDateOnlyKey(effectiveExp) ?? "null"})`,
      );
    }

    const currentQty = Number(row.quantity ?? 0);
    if (currentQty < needQty) {
      throw badRequest(
        `ser_stock ต้นทางไม่พอ (location_name=${location_name}, product_id=${item.product_id}, lot=${item.lot_serial ?? "null"}, need=${needQty}, have=${currentQty}, exp=${toDateOnlyKey(effectiveExp) ?? "null"})`,
      );
    }

    const remain = currentQty - needQty;
    if (remain <= 0) {
      await tx.ser_stock.delete({ where: { id: row.id } });
    } else {
      await tx.ser_stock.update({
        where: { id: row.id },
        data: {
          quantity: { decrement: new Prisma.Decimal(needQty) },
          updated_at: new Date(),
        } as any,
      });
    }

    return;
  }

  const rows = await tx.bor_stock.findMany({
    where: {
      product_id: item.product_id,
      location_name,
      lot_name: item.lot_serial ?? null,
    } as any,
    select: {
      id: true,
      quantity: true,
      expiration_date: true,
    },
    orderBy: { id: "desc" },
  });

  const row =
    rows.find((x) => sameExpDate(x.expiration_date, effectiveExp)) ?? null;

  if (!row) {
    throw badRequest(
      `ไม่พบ bor_stock ต้นทาง (location_name=${location_name}, product_id=${item.product_id}, lot=${item.lot_serial ?? "null"}, exp=${toDateOnlyKey(effectiveExp) ?? "null"})`,
    );
  }

  const currentQty = Number(row.quantity ?? 0);
  if (currentQty < needQty) {
    throw badRequest(
      `bor_stock ต้นทางไม่พอ (location_name=${location_name}, product_id=${item.product_id}, lot=${item.lot_serial ?? "null"}, need=${needQty}, have=${currentQty}, exp=${toDateOnlyKey(effectiveExp) ?? "null"})`,
    );
  }

  const remain = currentQty - needQty;
  if (remain <= 0) {
    await tx.bor_stock.delete({ where: { id: row.id } });
  } else {
    await tx.bor_stock.update({
      where: { id: row.id },
      data: {
        quantity: { decrement: new Prisma.Decimal(needQty) },
        updated_at: new Date(),
      } as any,
    });
  }
}

async function incrementDestBorSerStock(
  tx: Prisma.TransactionClient,
  args: {
    table: "BOR" | "SER";
    no: string;
    location_id?: number | null;
    location_name: string;
    department_id?: string | null;
    department?: string | null;

    location_owner?: string | null;
    location_owner_display?: string | null;
    location_dest_owner?: string | null;
    location_dest_owner_display?: string | null;

    item: BorSerInternalLine;
  },
) {
  const {
    table,
    no,
    location_id,
    location_name,
    department_id,
    department,
    location_owner,
    location_owner_display,
    location_dest_owner,
    location_dest_owner_display,
    item,
  } = args;

  if (!item.product_id) {
    throw badRequest("item.product_id is required");
  }

  const addQty = Math.max(0, Math.floor(Number(item.qty ?? 0)));
  if (addQty <= 0) return;

  const now = new Date();

  const effectiveExp = await resolveEffectiveExp(tx, {
    product_id: item.product_id,
    lot_id: item.lot_id ?? null,
    lot_serial: item.lot_serial ?? null,
    exp: item.exp ?? null,
  });

  if (table === "SER") {
    const rows = await tx.ser_stock.findMany({
      where: {
        product_id: item.product_id,
        location_name,
        lot_name: item.lot_serial ?? null,
      } as any,
      select: {
        id: true,
        expiration_date: true,
      },
      orderBy: { id: "desc" },
    });

    const row =
      rows.find((x) => sameExpDate(x.expiration_date, effectiveExp)) ?? null;

    if (row?.id) {
      await tx.ser_stock.update({
        where: { id: row.id },
        data: {
          no,
          location_id,
          location_name,
          department_id: department_id ?? null,
          department_name: department ?? null,

          location_owner: location_owner ?? null,
          location_owner_display: location_owner_display ?? null,
          location_dest_owner: location_dest_owner ?? null,
          location_dest_owner_dispalay: location_dest_owner_display ?? null,

          quantity: { increment: new Prisma.Decimal(addQty) },
          expiration_date: effectiveExp,
          updated_at: now,
        } as any,
      });
      return;
    }

    await tx.ser_stock.create({
      data: {
        snapshot_date: now,
        no,
        product_id: item.product_id,
        product_code: item.code ?? null,
        product_name: item.name ?? null,
        unit: item.unit ?? null,
        location_id,
        location_name,
        department_id: department_id ?? null,
        department_name: department ?? null,

        location_owner: location_owner ?? null,
        location_owner_display: location_owner_display ?? null,
        location_dest_owner: location_dest_owner ?? null,
        location_dest_owner_dispalay: location_dest_owner_display ?? null,

        lot_id: item.lot_id ?? null,
        lot_name: item.lot_serial ?? null,
        expiration_date: effectiveExp,
        product_last_modified_date: null,
        source: "wms",
        quantity: new Prisma.Decimal(addQty),
        active: true,
      } as any,
    });
    return;
  }

  const rows = await tx.bor_stock.findMany({
    where: {
      product_id: item.product_id,
      location_name,
      lot_name: item.lot_serial ?? null,
    } as any,
    select: {
      id: true,
      expiration_date: true,
    },
    orderBy: { id: "desc" },
  });

  const row =
    rows.find((x) => sameExpDate(x.expiration_date, effectiveExp)) ?? null;

  if (row?.id) {
    await tx.bor_stock.update({
      where: { id: row.id },
      data: {
        no,
        location_id,
        location_name,
        department_id: department_id ?? null,
        department_name: department ?? null,

        location_owner: location_owner ?? null,
        location_owner_display: location_owner_display ?? null,
        location_dest_owner: location_dest_owner ?? null,
        location_dest_owner_dispalay: location_dest_owner_display ?? null,

        quantity: { increment: new Prisma.Decimal(addQty) },
        expiration_date: effectiveExp,
        updated_at: now,
      } as any,
    });
    return;
  }

  await tx.bor_stock.create({
    data: {
      snapshot_date: now,
      no,
      product_id: item.product_id,
      product_code: item.code ?? null,
      product_name: item.name ?? null,
      unit: item.unit ?? null,
      location_id,
      location_name,
      department_id: department_id ?? null,
      department_name: department ?? null,

      location_owner: location_owner ?? null,
      location_owner_display: location_owner_display ?? null,
      location_dest_owner: location_dest_owner ?? null,
      location_dest_owner_dispalay: location_dest_owner_display ?? null,

      lot_id: item.lot_id ?? null,
      lot_name: item.lot_serial ?? null,
      expiration_date: effectiveExp,
      product_last_modified_date: null,
      source: "wms",
      quantity: new Prisma.Decimal(addQty),
      active: true,
    } as any,
  });
}

async function handleBorSerInternalTransferOutbound(input: {
  no: string;
  picking_id?: any;

  location_id?: any;
  location: any;
  location_dest_id?: any;
  location_dest: any;

  location_owner: any;
  location_owner_display?: any;
  location_dest_owner: any;
  location_dest_owner_display?: any;

  department_id?: any;
  department?: any;
  reference?: any;
  origin?: any;

  mergedItems: BorSerInternalLine[];
}) {
  const {
    no,
    picking_id,

    location_id,
    location,
    location_dest_id,
    location_dest,

    location_owner,
    location_owner_display,
    location_dest_owner,
    location_dest_owner_display,

    department_id,
    department,
    reference,
    origin,

    mergedItems,
  } = input;

  const sourceLock = extractBorSerLockFromLocation(location);
  const destLock = extractBorSerLockFromLocation(location_dest);

  if (!sourceLock || !destLock) {
    throw badRequest("location / location_dest ต้องเป็น BOR/BOS/SER");
  }

  const sourceOwner = normalizeNullableText(location_owner);
  const destOwner = normalizeNullableText(location_dest_owner);

  if (!sourceOwner) throw badRequest("กรุณาส่ง location_owner");
  if (!destOwner) throw badRequest("กรุณาส่ง location_dest_owner");

  const convertedReference =
    typeof reference === "boolean"
      ? reference
        ? "true"
        : null
      : normalizeNullableText(reference);

  const convertedOrigin =
    typeof origin === "boolean"
      ? origin
        ? "true"
        : null
      : normalizeNullableText(origin);

  const odooSourceLocationId = toNullableInt(location_id);
  const odooDestLocationId = toNullableInt(location_dest_id);
  const numericPickingId = toNullableInt(picking_id);
  const numericDepartmentId = toNullableInt(department_id);

  const result = await prisma.$transaction(async (tx) => {
    // source local master location
    let existingSourceLoc =
      (await resolveActiveLocationById(tx, odooSourceLocationId)) ??
      (await resolveLocationByFullNameExact(tx, sourceOwner));

    // dest local master location
    let existingDestLoc =
      (await resolveActiveLocationById(tx, odooDestLocationId)) ??
      (await resolveLocationByFullNameExact(tx, destOwner));

    if (!existingDestLoc && destLock) {
      existingDestLoc = await upsertSwapBorSerLocationByName(tx, {
        full_name: destOwner,
        lock: destLock,
        location_code: normalizeNullableText(location_dest),
      });
    }

    const existingSwap = await tx.swap.findFirst({
      where: {
        no,
        deleted_at: null,
      },
      select: { id: true },
    });

    const swapPayload = {
      name: no,
      no,
      picking_id: numericPickingId,

      // source จาก Odoo
      odoo_location_id: odooSourceLocationId,
      source_location_id: odooSourceLocationId,
      source_location: normalizeNullableText(location),

      // source local master
      location_id: existingSourceLoc?.id ?? null,
      location_name: sourceOwner,

      // dest จาก Odoo
      odoo_location_dest_id: odooDestLocationId,
      dest_location_id: odooDestLocationId,
      dest_location: normalizeNullableText(location_dest),

      // dest local master
      location_dest_id: existingDestLoc?.id ?? null,
      location_dest_name: destOwner,

      department_id: numericDepartmentId,
      origin: convertedOrigin,
      reference: convertedReference,

      status: "pending",
      deleted_at: null,
      updated_at: new Date(),
    };

    const swapDoc = existingSwap
      ? await tx.swap.update({
          where: { id: existingSwap.id },
          data: swapPayload,
        })
      : await tx.swap.create({
          data: {
            ...swapPayload,
            created_at: new Date(),
          },
        });

    await tx.swap_item.updateMany({
      where: {
        swap_id: swapDoc.id,
        deleted_at: null,
      },
      data: {
        deleted_at: new Date(),
        updated_at: new Date(),
      },
    });

    if (mergedItems.length > 0) {
      await tx.swap_item.createMany({
        data: mergedItems.map((item, index) => ({
          swap_id: swapDoc.id,
          source_sequence: item.sequence ?? index + 1,
          odoo_line_key: `${no}-${item.sequence ?? index + 1}`,

          product_id: item.product_id ?? null,
          code: item.code ?? null,
          name: item.name ?? null,
          unit: item.unit ?? null,
          tracking: item.tracking ?? null,

          lot_id: item.lot_id ?? null,
          lot_serial: item.lot_serial ?? null,
          barcode_text: item.barcode_text ?? null,
          expiration_date: item.exp ?? null,

          system_qty: Math.max(0, Math.floor(Number(item.qty ?? 0))),
          executed_qty: 0,
        })),
      });
    }

    const applyResult = await applyPendingSwapStockMove(tx, swapDoc.id);

    const finalSwap = await tx.swap.findUnique({
      where: { id: swapDoc.id },
      include: {
        swapItems: {
          where: { deleted_at: null },
          orderBy: { id: "asc" },
        },
      },
    });

    return {
      swap_id: swapDoc.id,
      no,
      source_location_name: sourceOwner,
      dest_location_name: destOwner,
      apply_result: applyResult,
      swap: finalSwap,
    };
  });

  return result;
}

type MasterLocationLite = {
  id: number;
  full_name: string;
};

async function resolveActiveLocationById(
  tx: Prisma.TransactionClient,
  id: number | null | undefined,
): Promise<MasterLocationLite | null> {
  if (typeof id !== "number") return null;

  const row = await tx.location.findUnique({
    where: { id },
    select: {
      id: true,
      full_name: true,
      deleted_at: true,
    },
  });

  if (!row || row.deleted_at) return null;

  return {
    id: row.id,
    full_name: row.full_name,
  };
}

async function resolveLocationByFullNameExact(
  tx: Prisma.TransactionClient,
  fullName: string | null | undefined,
): Promise<MasterLocationLite | null> {
  const exact = String(fullName ?? "").trim();
  if (!exact) return null;

  const row = await tx.location.findFirst({
    where: {
      deleted_at: null,
      full_name: exact,
    },
    select: {
      id: true,
      full_name: true,
    },
  });

  if (!row) return null;

  return {
    id: row.id,
    full_name: row.full_name,
  };
}

async function resolveDepartmentShortNameByOdooId(
  tx: Prisma.TransactionClient,
  departmentOdooId: number | null | undefined,
) {
  if (typeof departmentOdooId !== "number") return null;

  const row = await tx.department.findFirst({
    where: { odoo_id: departmentOdooId },
    select: { short_name: true },
  });

  return row?.short_name ?? null;
}

/**
 * ✅ ใช้กับ SWAP ที่ค้างอยู่ / หรือเพิ่ง receive มา
 * - ถ้า location_dest ยังไม่มีใน master -> status = error และยังไม่ตัด stock
 * - ถ้าพร้อมแล้ว -> ตัด/เพิ่ม stock แบบเดิม แล้ว status = done
 */
async function applyPendingSwapStockMove(
  tx: Prisma.TransactionClient,
  swapId: number,
) {
  const swapDoc = await tx.swap.findUnique({
    where: { id: swapId },
    include: {
      swapItems: {
        where: { deleted_at: null },
        orderBy: { id: "asc" },
      },
    },
  });

  if (!swapDoc || swapDoc.deleted_at) {
    throw notFound(`ไม่พบ swap: ${swapId}`);
  }

  const sourceLock = extractBorSerLockFromLocation(swapDoc.source_location);
  const destLock = extractBorSerLockFromLocation(swapDoc.dest_location);

  if (!sourceLock || !destLock) {
    throw badRequest("SWAP ต้องมี source/dest lock เป็น BOR/BOS/SER");
  }

  const sourceTable = resolveBorSerTableFromLock(sourceLock);
  const destTable = resolveBorSerTableFromLock(destLock);

  // ✅ req ล่าสุด: ให้เช็คปลายทางจาก swap.location_dest_name == locations.full_name
  let existingDestLoc =
    (await resolveActiveLocationById(tx, swapDoc.location_dest_id ?? null)) ??
    (await resolveLocationByFullNameExact(
      tx,
      normalizeNullableText(swapDoc.location_dest_name),
    ));

  // ✅ ถ้า BOR/BOS/SER ปลายทางยังไม่มีใน master ให้สร้างอัตโนมัติ
  if (!existingDestLoc && destLock) {
    existingDestLoc = await upsertSwapBorSerLocationByName(tx, {
      full_name: normalizeNullableText(swapDoc.location_dest_name),
      lock: destLock,
      location_code: normalizeNullableText(swapDoc.dest_location),
    });
  }

  if (!existingDestLoc) {
    await tx.swap.update({
      where: { id: swapDoc.id },
      data: {
        status: "error",
        updated_at: new Date(),
      } as any,
    });

    return {
      processed: false,
      reason: "DEST_LOCATION_NOT_FOUND",
    };
  }

  const sourceLocationName = normalizeNullableText(swapDoc.location_name);
  if (!sourceLocationName) {
    throw badRequest("swap.location_name is required");
  }

  const departmentShortName = await resolveDepartmentShortNameByOdooId(
    tx,
    swapDoc.department_id ?? null,
  );

  const mergedSwapItems: BorSerInternalLine[] = (swapDoc.swapItems ?? []).map(
    (item) => ({
      sequence: item.source_sequence ?? null,
      product_id: item.product_id ?? null,
      code: item.code ?? null,
      name: item.name ?? null,
      unit: item.unit ?? null,
      tracking: item.tracking ?? null,
      lot_id: item.lot_id ?? null,
      lot_serial: item.lot_serial ?? null,
      qty: Math.max(0, Math.floor(Number(item.system_qty ?? 0))),
      barcode_text: item.barcode_text ?? null,
      exp: item.expiration_date ?? null,
    }),
  );

  for (const item of mergedSwapItems) {
    if (!item.product_id) continue;
    if (Number(item.qty ?? 0) <= 0) continue;

    // ✅ ตัดจาก bor_stock/ser_stock โดยดู location_name ของ swap + product_id + lot_id
    await decrementSourceBorSerStockByLocationId(tx, {
      table: sourceTable,
      location_id: null,
      location_name: sourceLocationName,
      item,
    });

    await incrementDestBorSerStockByLocationId(tx, {
      table: destTable,
      no: String(swapDoc.no ?? ""),
      location_id: existingDestLoc.id,
      location_name: existingDestLoc.full_name,
      department_id:
        swapDoc.department_id != null ? String(swapDoc.department_id) : null,
      department: departmentShortName,

      location_owner: normalizeNullableText(swapDoc.location_name),
      location_owner_display: null,
      location_dest_owner: normalizeNullableText(swapDoc.location_dest_name),
      location_dest_owner_display: null,

      item,
    });
  }

  await tx.swap.update({
    where: { id: swapDoc.id },
    data: {
      status: "done",
      location_dest_id: existingDestLoc.id,
      location_dest_name: existingDestLoc.full_name,
      updated_at: new Date(),
    } as any,
  });

  return {
    processed: true,
    reason: null,
  };
}

export async function retryPendingSwapsByDestFullName(fullName: string) {
  const exact = String(fullName ?? "").trim();
  if (!exact) return;

  const pendingSwaps = await prisma.swap.findMany({
    where: {
      deleted_at: null,
      status: "error",
      location_dest_name: exact,
    },
    select: {
      id: true,
    },
    orderBy: { id: "asc" },
  });

  for (const row of pendingSwaps) {
    await prisma.$transaction(async (tx) => {
      await applyPendingSwapStockMove(tx, row.id);
    });
  }
}

type SwapLine = {
  source_sequence: number | null;
  odoo_line_key: string | null;

  product_id: number | null;
  code: string | null;
  name: string | null;
  unit: string | null;
  tracking: string | null;

  lot_id: number | null;
  lot_serial: string | null;
  barcode_text: string | null;
  expiration_date: Date | null;

  system_qty: number;
  executed_qty: number;
};

function isSwapTransferLike(input: {
  location?: any;
  location_dest?: any;
  location_owner?: any;
  location_dest_owner?: any;
}) {
  const srcLock = extractBorSerLockFromLocation(input.location);
  const destLock = extractBorSerLockFromLocation(input.location_dest);
  const srcOwner = String(input.location_owner ?? "").trim();
  const destOwner = String(input.location_dest_owner ?? "").trim();

  return Boolean(srcLock && destLock && srcOwner && destOwner);
}

async function hydrateOutboundItemsBarcodeTextFromBarcodeMaster<
  T extends { product_id: number | null; barcode_text?: string | null },
>(tx: Prisma.TransactionClient, items: T[]) {
  const productIds = Array.from(
    new Set(
      items
        .filter((x) => !String(x.barcode_text ?? "").trim())
        .map((x) => x.product_id)
        .filter((x): x is number => typeof x === "number"),
    ),
  );

  if (productIds.length === 0) return items;

  const barcodeRows = await tx.barcode.findMany({
    where: {
      product_id: { in: productIds },
      deleted_at: null,
      active: true,
    },
    select: {
      product_id: true,
      barcode: true,
    },
    orderBy: { id: "desc" },
  });

  const map = new Map<number, string>();

  for (const row of barcodeRows) {
    const bc = String(row.barcode ?? "").trim();
    if (!bc) continue;

    if (!map.has(row.product_id!)) {
      map.set(row.product_id!, bc);
    }
  }

  return items.map((item) => {
    const current = String(item.barcode_text ?? "").trim();
    if (current) return item;

    const fallback = map.get(item.product_id ?? -1);
    if (!fallback) {
      return {
        ...item,
        barcode_text: null,
      };
    }

    return {
      ...item,
      barcode_text: fallback,
    };
  });
}

// ================================
// ✅ RECEIVE OUTBOUND FROM ODOO
// ================================
export const receiveOutboundFromOdoo = asyncHandler(
  async (req: Request<{}, {}, any>, res: Response) => {
    let logId: number | null = null;

    try {
      const requestLog = await prisma.odoo_request_log.create({
        data: {
          endpoint: "/api/Outbound",
          method: "POST",
          request_body: JSON.stringify(req.body),
          ip_address: req.ip || req.socket.remoteAddress || null,
          user_agent: req.headers["user-agent"] || null,
        },
      });
      logId = requestLog.id;
    } catch {}

    const getTransfers = (body: any) => {
      if (body?.params?.transfers) return body.params.transfers;
      if (body?.transfers) return body.transfers;
      return null;
    };

    const transfers = getTransfers(req.body as any);

    if (!transfers) throw badRequest("ไม่พบข้อมูล 'transfers' ใน request body");
    if (!Array.isArray(transfers)) {
      throw badRequest("'transfers' ต้องเป็น Array");
    }
    if (transfers.length === 0) {
      throw badRequest("'transfers' ต้องมีข้อมูลอย่างน้อย 1 รายการ");
    }

    try {
      const results: any[] = [];

      type MergedItem = {
        product_id: number | null;
        lot_id: number | null;
        lot_serial: string | null;
        code: string | null;
        name: string | null;
        unit: string | null;
        tracking: string | null;
        qty: number;
        barcode_text: string | null;
        exp: Date | null;
      };

      for (const transfer of transfers) {
        const {
          picking_id,
          no,
          location_id,
          location,
          location_owner,
          location_owner_display,
          location_dest_id,
          location_dest,
          location_dest_owner,
          location_dest_owner_display,
          department_id,
          department,
          reference,
          origin,
          items,
          invoice,
        } = transfer as any;

        if (!no) throw badRequest("ไม่พบเลข no ใน transfer");
        if (!items || !Array.isArray(items) || items.length === 0) {
          throw badRequest(`Transfer ${no} ไม่มี items`);
        }

        // =========================
        // ✅ TF intercept
        // =========================
        if (isTFNumber(no)) {
          const mergedMap = new Map<string, TFLine>();

          for (let i = 0; i < items.length; i++) {
            const raw = items[i];

            const product_id =
              typeof raw.product_id === "number" ? raw.product_id : null;

            const lot_id = normalizeLotId(raw.lot_id);
            const lot_serial = normalizeLotSerial(raw.lot_serial);
            const exp =
              normalizeExpDate(raw.exp) ??
              normalizeExpDate(raw.expire_date) ??
              null;

            const qty =
              typeof raw.qty === "number" ? raw.qty : Number(raw.qty ?? 0) || 0;

            const key = buildKey({ product_id, lot_serial, exp });

            const code = normalizeStr(raw.code);
            const name = normalizeStr(raw.name);
            const unit = normalizeStr(raw.unit);
            const tracking = normalizeStr(raw.tracking);
            const barcode_text = normalizeBarcodeTextFromOdoo(raw);

            const seq = typeof raw.sequence === "number" ? raw.sequence : i + 1;

            const existed = mergedMap.get(key);
            if (existed) {
              existed.qty += qty;
              existed.code = code ?? existed.code;
              existed.name = name ?? existed.name;
              existed.unit = unit ?? existed.unit;
              existed.tracking = tracking ?? existed.tracking;
              existed.barcode_text = barcode_text ?? existed.barcode_text;
              existed.lot_id = lot_id ?? existed.lot_id;
              existed.exp = existed.exp ?? exp;
            } else {
              mergedMap.set(key, {
                sequence: seq,
                product_id,
                code,
                name,
                unit,
                tracking,
                lot_id,
                lot_serial,
                qty,
                barcode_text,
                exp,
                expire_date: toDateOnlyKey(exp),
              });
            }
          }

          const mergedItemsRaw = Array.from(mergedMap.values());

          const mergedItems = await prisma.$transaction(async (tx) => {
            return hydrateOutboundItemsBarcodeTextFromBarcodeMaster(
              tx,
              mergedItemsRaw,
            );
          });

          // ✅ TF + ปลายทางเป็น EXP&NCR
          // ให้ยังเข้า transfer แต่ mark ประเภทเป็น EXP&NCR/NCR ตามที่ FE ใช้แยกเมนู
          if (isExpNcrDest(location_dest)) {
            const doc = await prisma.$transaction(async (tx) => {
              const convertedReference =
                typeof reference === "boolean"
                  ? reference
                    ? "true"
                    : null
                  : reference || null;

              const convertedOrigin =
                typeof origin === "string"
                  ? origin
                  : origin
                    ? String(origin)
                    : null;

              const existing = await tx.transfer_doc.findFirst({
                where: { no: String(no), deleted_at: null },
              });

              const saved = existing
                ? await tx.transfer_doc.update({
                    where: { id: existing.id },
                    data: {
                      picking_id,
                      location_id,
                      location,
                      location_dest_id,
                      location_dest,
                      department_id: department_id?.toString(),
                      department,
                      reference: convertedReference,
                      origin: convertedOrigin,
                      in_type: "NCR",
                      updated_at: new Date(),
                    },
                  })
                : await tx.transfer_doc.create({
                    data: {
                      no: String(no),
                      picking_id,
                      location_id,
                      location,
                      location_dest_id,
                      location_dest,
                      department_id: department_id?.toString(),
                      department,
                      reference: convertedReference,
                      origin: convertedOrigin,
                      date: new Date(),
                      in_type: "NCR",
                    },
                  });

              const existingLines = await tx.transfer_doc_item.findMany({
                where: { transfer_doc_id: saved.id, deleted_at: null },
                select: {
                  id: true,
                  sequence: true,
                  product_id: true,
                  lot_serial: true,
                  in_process: true,
                  quantity_receive: true,
                  qty: true,
                  exp: true,
                },
              });

              const openMap = new Map<string, (typeof existingLines)[number]>();
              for (const r of existingLines) {
                if (r.product_id == null) continue;
                if (r.in_process) continue;

                openMap.set(
                  goodsInMatchKey({
                    product_id: r.product_id,
                    lot_serial: r.lot_serial,
                    exp: r.exp ?? null,
                  }),
                  r,
                );
              }

              const maxSeq = existingLines.reduce(
                (m, x) => Math.max(m, Number(x.sequence ?? 0)),
                0,
              );
              let nextSeq = maxSeq + 1;

              for (let i = 0; i < mergedItems.length; i++) {
                const item = mergedItems[i];

                if (item.product_id == null) {
                  throw badRequest(
                    `Odoo item missing product_id (TF-EXP&NCR: ${no})`,
                  );
                }
                if (!item.name || !item.unit) {
                  throw badRequest(
                    `Odoo item missing name/unit (TF-EXP&NCR: ${no}, product_id: ${item.product_id})`,
                  );
                }

                const exp =
                  item.exp ?? toExpDate(item.expire_date ?? null) ?? null;
                const lotSerial = item.lot_serial ?? null;

                const key = goodsInMatchKey({
                  product_id: item.product_id,
                  lot_serial: lotSerial,
                  exp,
                });

                const match = openMap.get(key);

                if (match) {
                  const add = Number(item.qty ?? 0);
                  if (!Number.isFinite(add) || add <= 0) continue;

                  await tx.transfer_doc_item.update({
                    where: { id: match.id },
                    data: {
                      qty: { increment: add },
                      quantity_receive: { increment: add },
                      updated_at: new Date(),
                    } as any,
                  });

                  continue;
                }

                const finalSeq = item.sequence ?? nextSeq++;
                await tx.transfer_doc_item.create({
                  data: {
                    transfer_doc_id: saved.id,
                    sequence: finalSeq,
                    odoo_sequence: finalSeq,
                    odoo_line_key: `${no}-${finalSeq}`,

                    product_id: item.product_id,
                    code: item.code ?? undefined,
                    name: item.name!,
                    unit: item.unit!,
                    tracking: item.tracking ?? undefined,

                    lot_id: item.lot_id ?? undefined,
                    lot_serial: item.lot_serial ?? undefined,
                    lot: item.lot_serial ?? undefined,

                    qty: item.qty,
                    quantity_receive: item.qty,
                    quantity_count: 0,

                    barcode_text: item.barcode_text ?? undefined,
                    exp: exp ?? undefined,

                    updated_at: new Date(),
                  },
                });
              }

              return tx.transfer_doc.findUnique({
                where: { id: saved.id },
                include: {
                  transfer_doc_items: {
                    where: { deleted_at: null },
                    orderBy: { sequence: "asc" },
                  },
                },
              });
            });

            results.push(doc);
            continue;
          }

          const doc = await handleTFTransferOutbound({
            picking_id,
            number: String(no),
            location_id,
            location,
            location_dest_id,
            location_dest,
            department_id,
            department,
            reference,
            origin,
            mergedItems,
          });

          results.push(doc);
          continue;
        }

        // =========================
        // ✅ BOR/SER/BOS internal transfer
        // =========================
        if (
          isBorSerInternalTransferLike({
            location,
            location_dest,
            location_owner,
            location_dest_owner,
          })
        ) {
          const mergedMap = new Map<string, BorSerInternalLine>();

          for (let i = 0; i < items.length; i++) {
            const raw = items[i];

            const product_id =
              typeof raw.product_id === "number" ? raw.product_id : null;

            const lot_id = normalizeLotId(raw.lot_id);
            const lot_serial = normalizeLotSerial(raw.lot_serial);
            const exp =
              normalizeExpDate(raw.exp) ??
              normalizeExpDate(raw.expire_date) ??
              null;

            const qty =
              typeof raw.qty === "number" ? raw.qty : Number(raw.qty ?? 0) || 0;

            const key = buildKey({ product_id, lot_serial, exp });

            const code = normalizeStr(raw.code);
            const name = normalizeStr(raw.name);
            const unit = normalizeStr(raw.unit);
            const tracking = normalizeStr(raw.tracking);
            const barcode_text = normalizeBarcodeTextFromOdoo(raw);

            const seq = typeof raw.sequence === "number" ? raw.sequence : i + 1;

            const existed = mergedMap.get(key);
            if (existed) {
              existed.qty += qty;
              existed.code = code ?? existed.code;
              existed.name = name ?? existed.name;
              existed.unit = unit ?? existed.unit;
              existed.tracking = tracking ?? existed.tracking;
              existed.barcode_text = barcode_text ?? existed.barcode_text;
              existed.lot_id = lot_id ?? existed.lot_id;
              existed.exp = existed.exp ?? exp;
            } else {
              mergedMap.set(key, {
                sequence: seq,
                product_id,
                code,
                name,
                unit,
                tracking,
                lot_id,
                lot_serial,
                qty,
                barcode_text,
                exp,
              });
            }
          }

          const mergedItemsRaw = Array.from(mergedMap.values());

          const mergedItems = await prisma.$transaction(async (tx) => {
            return hydrateOutboundItemsBarcodeTextFromBarcodeMaster(
              tx,
              mergedItemsRaw,
            );
          });

          const moved = await handleBorSerInternalTransferOutbound({
            no: String(no),
            picking_id,

            location_id,
            location,
            location_dest_id,
            location_dest,

            location_owner,
            location_owner_display,
            location_dest_owner,
            location_dest_owner_display,

            department_id,
            department,
            reference,
            origin,

            mergedItems,
          });

          results.push(moved);
          continue;
        }

        const outType = resolveOutTypeFromNo(no);
        const autoProcess = BOR_SER_DEDUCT_TYPES.has(outType);

        const convertedReference =
          typeof reference === "boolean"
            ? reference
              ? "true"
              : null
            : reference || null;

        const convertedOrigin =
          typeof origin === "boolean"
            ? origin
              ? "true"
              : null
            : typeof origin === "string"
              ? origin
              : origin
                ? String(origin)
                : null;

        const convertedInvoice =
          invoice === false ? null : (normalizeStr(invoice) ?? null);

        // =========================
        // ✅ EXP&NCR intercept
        // - ไม่ให้ไปทำ pick/pack ที่ outbound
        // =========================
        if (isExpNcrDest(location_dest)) {
          const savedExpNcr = await prisma.$transaction(async (tx) => {
            const existing = await tx.outbound.findFirst({
              where: { no, deleted_at: null },
              select: { id: true },
            });

            const outbound = existing
              ? await tx.outbound.update({
                  where: { id: existing.id },
                  data: {
                    picking_id,
                    location_id,
                    location,
                    location_dest_id:
                      typeof location_dest_id === "number"
                        ? location_dest_id
                        : null,
                    location_dest,
                    department_id: department_id?.toString(),
                    department: department?.toString() || "",
                    reference: convertedReference,
                    origin: convertedOrigin,
                    invoice: convertedInvoice,
                    out_type: "NCR",
                    in_process: false,
                    updated_at: new Date(),
                  },
                })
              : await tx.outbound.create({
                  data: {
                    no,
                    picking_id,
                    location_id,
                    location,
                    location_dest_id:
                      typeof location_dest_id === "number"
                        ? location_dest_id
                        : null,
                    location_dest,
                    department_id: department_id?.toString(),
                    department: department?.toString() || "",
                    reference: convertedReference,
                    origin: convertedOrigin,
                    invoice: convertedInvoice,
                    date: new Date(),
                    out_type: "NCR",
                    outbound_barcode: no,
                    in_process: false,
                  },
                });

            const mergedMap = new Map<string, MergedItem>();

            for (const raw of items) {
              const product_id =
                typeof raw.product_id === "number" ? raw.product_id : null;

              const lot_id = normalizeLotId(raw.lot_id);
              const lot_serial = normalizeLotSerial(raw.lot_serial);
              const exp =
                normalizeExpDate(raw.exp) ??
                normalizeExpDate(raw.expire_date) ??
                null;

              const qty =
                typeof raw.qty === "number"
                  ? raw.qty
                  : Number(raw.qty ?? 0) || 0;

              const key = buildKey({ product_id, lot_serial, exp });

              const code = normalizeStr(raw.code);
              const name = normalizeStr(raw.name);
              const unit = normalizeStr(raw.unit);
              const tracking = normalizeStr(raw.tracking);
              const barcode_text = normalizeBarcodeTextFromOdoo(raw);

              const existed = mergedMap.get(key);
              if (existed) {
                existed.qty += qty;
                existed.code = code ?? existed.code;
                existed.name = name ?? existed.name;
                existed.unit = unit ?? existed.unit;
                existed.tracking = tracking ?? existed.tracking;
                existed.barcode_text = barcode_text ?? existed.barcode_text;
                existed.lot_id = lot_id ?? existed.lot_id;
                existed.exp = existed.exp ?? exp;
              } else {
                mergedMap.set(key, {
                  product_id,
                  lot_id,
                  lot_serial,
                  code,
                  name,
                  unit,
                  tracking,
                  qty,
                  barcode_text,
                  exp,
                });
              }
            }

            const mergedItemsRaw = Array.from(mergedMap.values());

            const mergedItems =
              await hydrateOutboundItemsBarcodeTextFromBarcodeMaster(
                tx,
                mergedItemsRaw,
              );

            const existingRows = await tx.goods_out_item.findMany({
              where: { outbound_id: outbound.id, deleted_at: null },
              select: {
                id: true,
                sequence: true,
                product_id: true,
                lot_serial: true,
              },
            });

            const openMap = new Map<string, (typeof existingRows)[number]>();
            for (const r of existingRows) {
              const k = `p:${r.product_id ?? "null"}|lotSer:${r.lot_serial ?? ""}`;
              openMap.set(k, r);
            }

            const maxSeq = existingRows.reduce(
              (m, x) => Math.max(m, Number(x.sequence ?? 0)),
              0,
            );
            let nextSeq = maxSeq + 1;

            for (const it of mergedItems) {
              const nameText = (it.name ?? "-").trim() || "-";
              const unitText = (it.unit ?? "-").trim() || "-";

              const openKey = `p:${it.product_id ?? "null"}|lotSer:${it.lot_serial ?? ""}`;
              const open = openMap.get(openKey);

              if (open?.id) {
                await tx.goods_out_item.update({
                  where: { id: open.id },
                  data: {
                    code: it.code ?? undefined,
                    name: nameText,
                    unit: unitText,
                    tracking: it.tracking ?? undefined,
                    lot_id: it.lot_id ?? null,
                    lot_serial: it.lot_serial,
                    barcode_text: it.barcode_text ?? null,
                    qty: it.qty,
                    in_process: false,
                    updated_at: new Date(),
                  } as any,
                });
              } else {
                const seq = nextSeq++;

                await tx.goods_out_item.create({
                  data: {
                    outbound_id: outbound.id,
                    sequence: seq,
                    product_id: it.product_id,
                    code: it.code ?? undefined,
                    name: nameText,
                    unit: unitText,
                    tracking: it.tracking ?? undefined,
                    lot_id: it.lot_id ?? null,
                    lot_serial: it.lot_serial,
                    qty: it.qty,
                    sku: it.code ?? undefined,
                    barcode_text: it.barcode_text ?? null,
                    in_process: false,
                    updated_at: new Date(),
                  } as any,
                });
              }
            }

            return tx.outbound.findUnique({
              where: { no },
              include: {
                goods_outs: {
                  where: { deleted_at: null },
                  orderBy: { sequence: "asc" },
                },
              },
            });
          });

          results.push(savedExpNcr);
          continue;
        }

        const shouldAutoVirtualLocation =
          !isTFNumber(no) &&
          !isBorSerInternalTransferLike({
            location,
            location_dest,
            location_owner,
            location_dest_owner,
          }) &&
          !isSwapTransferLike({
            location,
            location_dest,
            location_owner,
            location_dest_owner,
          }) &&
          isVirtualBorrowDest(location_dest) &&
          normalizeNullableText(location_dest_owner) !== null;

        let createdVirtualLocationFullName: string | null = null;

        const saved = await prisma.$transaction(async (tx) => {
          let mappedVirtualLocationId: number | null =
            typeof location_dest_id === "number" ? location_dest_id : null;

          if (shouldAutoVirtualLocation) {
            const virtualLoc = await upsertVirtualLocationFromOdoo(tx, {
              location_dest_id,
              location_dest,
              location_dest_owner,
              location_dest_owner_display,
            });

            if (virtualLoc?.id) {
              mappedVirtualLocationId = virtualLoc.id;
              createdVirtualLocationFullName = virtualLoc.full_name ?? null;
            }
          }

          const existing = await tx.outbound.findFirst({
            where: { no, deleted_at: null },
            select: { id: true },
          });

          const outbound = existing
            ? await tx.outbound.update({
                where: { id: existing.id },
                data: {
                  picking_id,
                  location_id,
                  location,
                  location_dest_id: mappedVirtualLocationId,
                  location_dest,
                  department_id: department_id?.toString(),
                  department: department?.toString() || "",
                  reference: convertedReference,
                  origin: convertedOrigin,
                  invoice: convertedInvoice,
                  out_type: outType,
                  ...(autoProcess ? { in_process: true } : {}),
                  updated_at: new Date(),
                },
              })
            : await tx.outbound.create({
                data: {
                  no,
                  picking_id,
                  location_id,
                  location,
                  location_dest_id: mappedVirtualLocationId,
                  location_dest,
                  department_id: department_id?.toString(),
                  department: department?.toString() || "",
                  reference: convertedReference,
                  origin: convertedOrigin,
                  invoice: convertedInvoice,
                  date: new Date(),
                  out_type: outType,
                  outbound_barcode: no,
                  ...(autoProcess ? { in_process: true } : {}),
                },
              });

          const mergedMap = new Map<string, MergedItem>();

          for (const raw of items) {
            const product_id =
              typeof raw.product_id === "number" ? raw.product_id : null;

            const lot_id = normalizeLotId(raw.lot_id);
            const lot_serial = normalizeLotSerial(raw.lot_serial);
            const exp =
              normalizeExpDate(raw.exp) ??
              normalizeExpDate(raw.expire_date) ??
              null;

            const qty =
              typeof raw.qty === "number" ? raw.qty : Number(raw.qty ?? 0) || 0;

            const key = buildKey({ product_id, lot_serial, exp });

            const code = normalizeStr(raw.code);
            const name = normalizeStr(raw.name);
            const unit = normalizeStr(raw.unit);
            const tracking = normalizeStr(raw.tracking);
            const barcode_text = normalizeBarcodeTextFromOdoo(raw);

            const existed = mergedMap.get(key);
            if (existed) {
              existed.qty += qty;
              existed.code = code ?? existed.code;
              existed.name = name ?? existed.name;
              existed.unit = unit ?? existed.unit;
              existed.tracking = tracking ?? existed.tracking;
              existed.barcode_text = barcode_text ?? existed.barcode_text;
              existed.lot_id = lot_id ?? existed.lot_id;
              existed.exp = existed.exp ?? exp;
            } else {
              mergedMap.set(key, {
                product_id,
                lot_id,
                lot_serial,
                code,
                name,
                unit,
                tracking,
                qty,
                barcode_text,
                exp,
              });
            }
          }

          const mergedItemsRaw = Array.from(mergedMap.values());

          const mergedItems =
            await hydrateOutboundItemsBarcodeTextFromBarcodeMaster(
              tx,
              mergedItemsRaw,
            );

          const existingRows = await tx.goods_out_item.findMany({
            where: { outbound_id: outbound.id, deleted_at: null },
            select: {
              id: true,
              sequence: true,
              product_id: true,
              lot_serial: true,
              in_process: true,
            },
          });

          const openMap = new Map<string, (typeof existingRows)[number]>();
          for (const r of existingRows) {
            const k = `p:${r.product_id ?? "null"}|lotSer:${r.lot_serial ?? ""}`;
            if (!r.in_process) openMap.set(k, r);
          }

          const maxSeq = existingRows.reduce(
            (m, x) => Math.max(m, Number(x.sequence ?? 0)),
            0,
          );
          let nextSeq = maxSeq + 1;

          for (let i = 0; i < mergedItems.length; i++) {
            const it = mergedItems[i];

            const nameText = (it.name ?? "-").trim() || "-";
            const unitText = (it.unit ?? "-").trim() || "-";

            const openKey = `p:${it.product_id ?? "null"}|lotSer:${it.lot_serial ?? ""}`;
            const open = openMap.get(openKey);

            if (open?.id) {
              const now = new Date();

              await tx.goods_out_item.update({
                where: { id: open.id },
                data: {
                  code: it.code ?? undefined,
                  name: nameText,
                  unit: unitText,
                  tracking: it.tracking ?? undefined,
                  lot_id: it.lot_id ?? null,
                  lot_serial: it.lot_serial,
                  barcode_text: it.barcode_text ?? null,
                  qty: { increment: it.qty },
                  ...(autoProcess
                    ? {
                        pick: { increment: it.qty },
                        confirmed_pick: { increment: it.qty },
                        in_process: true,
                      }
                    : {}),
                  updated_at: now,
                } as any,
              });

              continue;
            }

            const seq = nextSeq++;
            const now = new Date();

            await tx.goods_out_item.create({
              data: {
                outbound_id: outbound.id,
                sequence: seq,
                product_id: it.product_id,
                code: it.code ?? undefined,
                name: nameText,
                unit: unitText,
                tracking: it.tracking ?? undefined,
                lot_id: it.lot_id ?? null,
                lot_serial: it.lot_serial,
                qty: it.qty,
                sku: it.code ?? undefined,
                barcode_text: it.barcode_text ?? null,
                ...(autoProcess
                  ? {
                      pick: it.qty,
                      confirmed_pick: it.qty,
                      in_process: true,
                    }
                  : {}),
                updated_at: now,
              } as any,
            });
          }

          if (BOR_SER_DEDUCT_TYPES.has(outType)) {
            await decrementBorSerStocksForGaBosSv(tx, {
              outType,
              transfer: {
                no,
                location_id:
                  typeof location_id === "number" ? location_id : null,
                location: typeof location === "string" ? location : null,
                location_dest_id:
                  typeof location_dest_id === "number"
                    ? location_dest_id
                    : null,
                location_dest:
                  typeof location_dest === "string" ? location_dest : null,
              },
              mergedItems: mergedItems.map((x) => ({
                product_id: x.product_id,
                lot_id: x.lot_id,
                lot_serial: x.lot_serial,
                qty: x.qty,
                exp: x.exp ?? null,
              })),
            });
          }

          if (BOR_SER_REPLACE_TYPES.has(outType)) {
            await replaceBorSerStocksForExBoa(tx, {
              outType,
              transfer: {
                no,
                location_dest_id:
                  typeof location_dest_id === "number"
                    ? location_dest_id
                    : null,
                location_dest:
                  typeof location_dest === "string" ? location_dest : null,
                department_id:
                  department_id != null ? String(department_id) : null,
                department: department != null ? String(department) : null,

                location_owner: normalizeOwnerText(location_owner),
                location_owner_display: normalizeOwnerText(
                  location_owner_display,
                ),
                location_dest_owner: normalizeOwnerText(location_dest_owner),
                location_dest_owner_display: normalizeOwnerText(
                  location_dest_owner_display,
                ),
              },
              mergedItems: mergedItems.map((x) => ({
                product_id: x.product_id,
                lot_id: x.lot_id,
                lot_serial: x.lot_serial,
                qty: x.qty,
                code: x.code ?? null,
                name: x.name ?? null,
                unit: x.unit ?? null,
                exp: x.exp ?? null,
              })),
            });
          }

          // ✅ สร้าง completed adjust auto สำหรับ SV / GA / BOS
          if (["SV", "GA", "BOS"].includes(outType)) {
            await createCompletedAutoAdjustmentFromTransfer(tx, {
              no,
              picking_id: typeof picking_id === "number" ? picking_id : null,
              location_id: typeof location_id === "number" ? location_id : null,
              location: typeof location === "string" ? location : null,
              location_dest_id:
                typeof location_dest_id === "number" ? location_dest_id : null,
              location_dest:
                typeof location_dest === "string" ? location_dest : null,
              location_owner: normalizeOwnerText(location_owner),
              location_owner_display: normalizeOwnerText(
                location_owner_display,
              ),
              location_dest_owner: normalizeOwnerText(location_dest_owner),
              location_dest_owner_display: normalizeOwnerText(
                location_dest_owner_display,
              ),
              department_id:
                department_id != null ? String(department_id) : null,
              department: department != null ? String(department) : null,
              reference: convertedReference,
              origin: convertedOrigin,
              type: outType,
              items: mergedItems.map((x, idx) => ({
                sequence: idx + 1,
                product_id: x.product_id,
                code: x.code ?? null,
                name: x.name ?? null,
                unit: x.unit ?? null,
                tracking: x.tracking ?? null,
                lot_id: x.lot_id,
                lot_serial: x.lot_serial,
                qty: x.qty,
                exp: x.exp ?? null,
                barcode_payload: null,
              })),
            });
          }

          if (autoProcess) {
            const now = new Date();

            await tx.outbound.update({
              where: { id: outbound.id },
              data: { in_process: true, updated_at: now },
            });

            await tx.goods_out_item.updateMany({
              where: { outbound_id: outbound.id, deleted_at: null },
              data: {
                in_process: true,
                updated_at: now,
              } as any,
            });

            const allItems = await tx.goods_out_item.findMany({
              where: { outbound_id: outbound.id, deleted_at: null },
              select: { id: true, qty: true },
            });

            for (const it of allItems) {
              const q = Math.max(0, Math.floor(Number(it.qty ?? 0)));

              await tx.goods_out_item.update({
                where: { id: it.id },
                data: {
                  pick: q,
                  confirmed_pick: q,
                  in_process: true,
                  updated_at: now,
                } as any,
              });
            }
          }

          return tx.outbound.findUnique({
            where: { no },
            include: {
              goods_outs: {
                where: { deleted_at: null },
                orderBy: { sequence: "asc" },
              },
            },
          });
        });

        if (createdVirtualLocationFullName) {
          await retryPendingSwapsByDestFullName(createdVirtualLocationFullName);
        }

        results.push(saved);
      }

      const responseData = {
        message: `สร้าง/อัพเดท ${results.length} transfers สำเร็จ`,
        data: results,
      };

      if (logId) {
        try {
          await prisma.odoo_request_log.update({
            where: { id: logId },
            data: {
              response_status: 201,
              response_body: JSON.stringify(responseData),
              error_message: null,
            },
          });
        } catch {}
      }

      return res.status(201).json(responseData);
    } catch (error) {
      if (logId) {
        const msg = error instanceof Error ? error.message : String(error);
        try {
          await prisma.odoo_request_log.update({
            where: { id: logId },
            data: {
              response_status: (error as any)?.statusCode || 500,
              response_body: JSON.stringify({ error: msg }),
              error_message: msg,
            },
          });
        } catch {}
      }
      throw error;
    }
  },
);

// ===== lock_no helpers =====
type LockKey = string;

// ✅ lock key: product_id + lot_name only (ตัด lot_id)
const lockKeyOf = (
  product_id: number | null | undefined,
  lot_name: string | null | undefined,
) => `p:${product_id ?? "null"}|lot_name:${(lot_name ?? "").trim()}`;

type LockLocRow = {
  location_id: number | null;
  location_name: string;
  qty: number;
};

export async function buildLockNoMapFromItems(
  items: Array<{
    product_id?: number | null;
    lot_name?: string | null; // == lot_serial
  }>,
) {
  const keys = items
    .map((x) => lockKeyOf(x.product_id ?? null, x.lot_name ?? null))
    .filter(Boolean);

  const uniqueKeys = Array.from(new Set(keys));
  const map = new Map<LockKey, LockLocRow[]>();
  if (uniqueKeys.length === 0) return map;

  const pids = Array.from(
    new Set(
      items
        .map((x) => (typeof x.product_id === "number" ? x.product_id : null))
        .filter((x): x is number => x != null),
    ),
  );
  if (pids.length === 0) return map;

  // ✅ IMPORTANT: select location_id เพิ่ม เพื่อเอาไป query exp จาก stock
  const rows = await prisma.stock.findMany({
    where: {
      source: "wms",
      product_id: { in: pids },
    } as any,
    select: {
      product_id: true,
      lot_name: true,
      location_id: true,
      location_name: true,
      quantity: true,
      expiration_date: true, // เผื่อคุณอยากใช้ในอนาคต (ตอนนี้ map แยก)
    } as any,
    orderBy: [{ product_id: "asc" }, { location_name: "asc" }],
  });

  // รวม qty ต่อ key ต่อ location_id (กันซ้ำ)
  const temp = new Map<
    LockKey,
    Map<number, { location_id: number; location_name: string; qty: number }>
  >();

  for (const r of rows as any[]) {
    const k = lockKeyOf(r.product_id, r.lot_name ?? null);
    if (!uniqueKeys.includes(k)) continue;

    const locId = Number(r.location_id ?? 0);
    if (!Number.isFinite(locId) || locId <= 0) continue;

    const locName = String(r.location_name ?? "").trim();
    if (!locName) continue;

    const qty = Number(r.quantity ?? 0);
    if (!Number.isFinite(qty)) continue;

    if (!temp.has(k)) temp.set(k, new Map());
    const byLoc = temp.get(k)!;

    const prev = byLoc.get(locId);
    if (prev) {
      prev.qty += qty;
    } else {
      byLoc.set(locId, { location_id: locId, location_name: locName, qty });
    }
  }

  for (const [k, byLoc] of temp.entries()) {
    const arr: LockLocRow[] = Array.from(byLoc.values())
      .filter((x) => x.qty !== 0)
      .sort((a, b) => b.qty - a.qty);

    map.set(k, arr);
  }

  // กัน key ที่ไม่มี stock ให้คืนเป็น []
  for (const k of uniqueKeys) {
    if (!map.has(k)) map.set(k, []);
  }

  return map;
}

export function resolveLockLocationsFromMap(
  map: Map<LockKey, LockLocRow[]>,
  product_id: number | null | undefined,
  lot_name: string | null | undefined,
) {
  const k = lockKeyOf(product_id ?? null, lot_name ?? null);
  return map.get(k) ?? [];
}

export function resolveLockNoFromMap(
  map: Map<LockKey, LockLocRow[]>,
  product_id: number | null | undefined,
  lot_name: string | null | undefined,
) {
  const locs = resolveLockLocationsFromMap(map, product_id, lot_name);
  return locs.map((x) => `${x.location_name} (จำนวน ${x.qty})`);
}

// =====================================================
// ✅ Expiration_date from STOCKS (REBUILD: match lot_serial <-> lot_name แบบ robust)
// - byLoc: priority เมื่อมี location_id
// - byNoLoc: fallback เมื่อไม่มี location_id (หรือ lock_locations ว่าง)
// =====================================================
function normalizeLot(v: unknown) {
  return String(v ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

type ExpKeyLoc = string;
type ExpKeyNoLoc = string;

const expKeyLocOf = (
  product_id: number | null,
  lot_serial: string | null,
  location_id: number | null,
) =>
  `p:${product_id ?? 0}|lot:${normalizeLot(lot_serial)}|loc:${location_id ?? 0}`;

const expKeyNoLocOf = (product_id: number | null, lot_serial: string | null) =>
  `p:${product_id ?? 0}|lot:${normalizeLot(lot_serial)}`;

async function buildExpirationMapsFromStocks(args: {
  items: Array<{
    product_id: number | null;
    lot_serial: string | null; // from goods_out_item
    location_ids?: number[]; // optional
  }>;
}) {
  const { items } = args;

  const pids = Array.from(
    new Set(
      items
        .map((x) => x.product_id)
        .filter(
          (x): x is number => typeof x === "number" && Number.isFinite(x),
        ),
    ),
  );

  const byLoc = new Map<ExpKeyLoc, Date | null>();
  const byNoLoc = new Map<ExpKeyNoLoc, Date | null>();
  if (pids.length === 0) return { byLoc, byNoLoc };

  const locIds = Array.from(
    new Set(
      items
        .flatMap((x) => x.location_ids ?? [])
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  );

  // ✅ ดึง stock ทีเดียว (ไม่กรอง lot_name ใน where เพื่อกัน mismatch format)
  const rows = await prisma.stock.findMany({
    where: {
      source: "wms",
      product_id: { in: pids },
      ...(locIds.length ? { location_id: { in: locIds } } : {}),
    } as any,
    select: {
      product_id: true,
      lot_name: true,
      location_id: true,
      expiration_date: true,
    } as any,
    orderBy: [{ expiration_date: "asc" }] as any, // เลือก exp ที่ "เร็วสุด" เป็นตัวแรก
  });

  for (const r of rows as any[]) {
    const pid = typeof r.product_id === "number" ? r.product_id : null;
    const lotNorm = normalizeLot(r.lot_name);
    const locId = typeof r.location_id === "number" ? r.location_id : null;
    const exp = (r.expiration_date ?? null) as Date | null;

    const kNoLoc: ExpKeyNoLoc = `p:${pid ?? 0}|lot:${lotNorm}`;
    if (!byNoLoc.has(kNoLoc)) byNoLoc.set(kNoLoc, exp);

    if (locId != null) {
      const kLoc: ExpKeyLoc = `p:${pid ?? 0}|lot:${lotNorm}|loc:${locId ?? 0}`;
      if (!byLoc.has(kLoc)) byLoc.set(kLoc, exp);
    }
  }

  return { byLoc, byNoLoc };
}

function firstLocId(lockLocations: LockLocRow[]): number | null {
  if (!Array.isArray(lockLocations) || lockLocations.length === 0) return null;
  const id = lockLocations[0]?.location_id;
  return typeof id === "number" && Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * =========================================
 * Department helpers (ไม่กระทบฟังก์ชันเดิม)
 * =========================================
 */
type DeptMap = Map<number, string>;

function parseDeptOdooId(raw: unknown): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || Number.isNaN(n)) return null;
  return n;
}

async function buildDepartmentCodeMapFromOutbounds(
  outbounds: Array<{ department?: any }>,
): Promise<DeptMap> {
  const ids = Array.from(
    new Set(
      outbounds
        .map((o) => parseDeptOdooId((o as any).department))
        .filter((x): x is number => x != null),
    ),
  );

  const map: DeptMap = new Map();
  if (ids.length === 0) return map;

  const rows = await prisma.department.findMany({
    where: {
      deleted_at: null,
      odoo_id: { in: ids },
    } as any,
    select: {
      odoo_id: true,
      department_code: true,
    },
  });

  for (const r of rows as any[]) {
    const odooId = Number(r.odoo_id);
    const code = String(r.department_code ?? "").trim();
    if (Number.isFinite(odooId) && code) map.set(odooId, code);
  }

  return map;
}

function resolveDepartmentCodeForOutbound(deptMap: DeptMap, outbound: any) {
  const odooId = parseDeptOdooId(outbound?.department);
  if (odooId == null) return null;
  return deptMap.get(odooId) ?? null;
}

/**
 * GET /api/outbounds/odoo/transfers
 */
export const getOdooOutbounds = asyncHandler(
  async (req: Request, res: Response) => {
    const outbounds = await prisma.outbound.findMany({
      where: { deleted_at: null, picking_id: { not: null } },
      include: {
        goods_outs: {
          where: { deleted_at: null },
          include: {
            barcode_ref: { where: { deleted_at: null } },
            boxes: { where: { deleted_at: null }, include: { box: true } },
          },
          orderBy: { sequence: "asc" },
        },
      },
      orderBy: { created_at: "desc" },
    });

    const deptMap = await buildDepartmentCodeMapFromOutbounds(outbounds as any);

    const data = await Promise.all(
      outbounds.map(async (outbound) => {
        const formatted: any = formatOdooOutbound(outbound as any);

        formatted.department_code = resolveDepartmentCodeForOutbound(
          deptMap,
          outbound as any,
        );

        const itemsKey = (outbound.goods_outs || []).map((it: any) => ({
          product_id: it.product_id,
          lot_serial: it.lot_serial,
          lot_name: it.lot_serial,
        }));

        const inputMap = await buildInputNumberMapFromItems(itemsKey);

        const lockNoMap = await buildLockNoMapFromItems(
          itemsKey.map((x) => ({
            product_id: x.product_id,
            lot_name: x.lot_name,
          })),
        );

        formatted.items = (outbound.goods_outs || []).map((gi: any) => {
          const lockLocations = resolveLockLocationsFromMap(
            lockNoMap,
            gi.product_id,
            gi.lot_serial,
          );

          return {
            id: gi.id,
            outbound_id: gi.outbound_id,
            sequence: gi.sequence,
            product_id: gi.product_id,
            code: gi.code,
            name: gi.name,
            unit: gi.unit,
            tracking: gi.tracking,
            lot_id: gi.lot_id, // keep compat
            lot_serial: gi.lot_serial,
            qty: gi.qty,
            pick: gi.pick,
            pack: gi.pack,
            status: gi.status,
            barcode_id: gi.barcode_id,
            user_pick: gi.user_pick,
            user_pack: gi.user_pack,
            barcode_text: gi.barcode_text ?? null,

            input_number: resolveInputNumberFromMap(
              inputMap,
              gi.product_id,
              gi.lot_serial,
            ),

            lock_no: lockLocations.map(
              (x) => `${x.location_name} (จำนวน ${x.qty})`,
            ),
            lock_locations: lockLocations,

            barcode: gi.barcode_ref
              ? {
                  barcode: gi.barcode_ref.barcode,
                  lot_start: gi.barcode_ref.lot_start,
                  lot_stop: gi.barcode_ref.lot_stop,
                  exp_start: gi.barcode_ref.exp_start,
                  exp_stop: gi.barcode_ref.exp_stop,
                  barcode_length: gi.barcode_ref.barcode_length,
                }
              : null,

            boxes:
              gi.boxes
                ?.filter((ib: any) => !ib.deleted_at)
                .map((ib: any) => ({
                  id: ib.box.id,
                  box_code: ib.box.box_code,
                  box_name: ib.box.box_name,
                  quantity: ib.quantity ?? null,
                })) ?? [],
          };
        });

        return formatted;
      }),
    );

    return res.json({ total: data.length, data });
  },
);

type DeptShortMap = Map<number, string>;

function parseDeptIdToInt(raw: unknown): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

async function buildDepartmentShortNameMapFromOutbounds(
  outbounds: Array<{ department_id?: any }>,
): Promise<DeptShortMap> {
  const ids = Array.from(
    new Set(
      outbounds
        .map((o) => parseDeptIdToInt((o as any).department_id))
        .filter((x): x is number => x != null),
    ),
  );

  const map: DeptShortMap = new Map();
  if (ids.length === 0) return map;

  const rows = await prisma.department.findMany({
    where: { deleted_at: null, odoo_id: { in: ids } } as any,
    select: { odoo_id: true, short_name: true },
  });

  for (const r of rows as any[]) {
    const odooId = Number(r.odoo_id);
    const short = String(r.short_name ?? "").trim();
    if (Number.isFinite(odooId) && short) map.set(odooId, short);
  }

  return map;
}

function resolveDepartmentShortNameForOutbound(
  map: DeptShortMap,
  outbound: any,
): string | null {
  const id = parseDeptIdToInt(outbound?.department_id);
  if (id == null) return null;
  return map.get(id) ?? null;
}

function parseSpecialOutboundSearchColumns(raw: unknown) {
  if (typeof raw !== "string") return [];

  const allowed = new Set([
    "date",
    "no",
    "department",
    "status",
    "user_ref",
    "out_type",
  ]);

  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => allowed.has(s));
}

function buildSpecialOutboundSearchWhere(search: string, columns: string[]) {
  const baseWhere: Prisma.outboundWhereInput = {
    deleted_at: null,
    out_type: { in: ["BO", "SV", "GA", "EX", "BOA"] },
    in_process: true,
  };

  if (!search) return baseWhere;

  const orConditions: Prisma.outboundWhereInput[] = [];

  if (columns.includes("date")) {
    const maybeDate = new Date(search);
    if (!Number.isNaN(maybeDate.getTime())) {
      const yyyy = maybeDate.getUTCFullYear();
      const mm = String(maybeDate.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(maybeDate.getUTCDate()).padStart(2, "0");

      orConditions.push({
        date: {
          gte: new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`),
          lt: new Date(`${yyyy}-${mm}-${dd}T23:59:59.999Z`),
        },
      } as any);
    }
  }

  if (columns.includes("no")) {
    orConditions.push({
      no: { contains: search, mode: "insensitive" },
    });
  }

  if (columns.includes("department")) {
    orConditions.push({
      department: { contains: search, mode: "insensitive" },
    } as any);
  }

  if (columns.includes("user_ref")) {
    orConditions.push({
      user_ref: { contains: search, mode: "insensitive" },
    } as any);
  }

  if (columns.includes("in_process")) {
    orConditions.push({
      in_process: { contains: search, mode: "insensitive" },
    } as any);
  }

  if (columns.includes("out_type")) {
    orConditions.push({
      out_type: { contains: search, mode: "insensitive" },
    });
  }

  if (orConditions.length === 0) {
    return {
      AND: [baseWhere, { id: -1 }],
    } as Prisma.outboundWhereInput;
  }

  return {
    AND: [baseWhere, { OR: orConditions }],
  } as Prisma.outboundWhereInput;
}

// GET /api/outbounds/adjust
export const getSpecialOutbounds = asyncHandler(
  async (req: Request, res: Response) => {
    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";
    const selectedColumns = parseSpecialOutboundSearchColumns(
      req.query.columns,
    );

    const where = buildSpecialOutboundSearchWhere(search, selectedColumns);

    const outbounds = await prisma.outbound.findMany({
      where,
      include: {
        goods_outs: {
          where: { deleted_at: null },
          include: {
            barcode_ref: { where: { deleted_at: null } },
            boxes: { where: { deleted_at: null }, include: { box: true } },
          },
          orderBy: { sequence: "asc" },
        },
      },
      orderBy: { created_at: "desc" },
    });

    const deptShortMap = await buildDepartmentShortNameMapFromOutbounds(
      outbounds as any,
    );

    const data = await Promise.all(
      outbounds.map(async (outbound) => {
        const formatted: any = formatOdooOutbound(outbound as any);

        const shortName = resolveDepartmentShortNameForOutbound(
          deptShortMap,
          outbound as any,
        );
        if (shortName) formatted.department = shortName;

        const itemsKey = (outbound.goods_outs || []).map((it: any) => ({
          product_id: it.product_id,
          lot_serial: it.lot_serial,
          lot_name: it.lot_serial,
        }));

        const inputMap = await buildInputNumberMapFromItems(itemsKey);

        const lockNoMap = await buildLockNoMapFromItems(
          itemsKey.map((x: any) => ({
            product_id: x.product_id,
            lot_name: x.lot_name,
          })),
        );

        formatted.items = (outbound.goods_outs || []).map((gi: any) => {
          const lockLocations = resolveLockLocationsFromMap(
            lockNoMap,
            gi.product_id,
            gi.lot_serial,
          );

          return {
            id: gi.id,
            outbound_id: gi.outbound_id,
            sequence: gi.sequence,
            product_id: gi.product_id,
            code: gi.code,
            name: gi.name,
            unit: gi.unit,
            tracking: gi.tracking,
            lot_id: gi.lot_id,
            lot_serial: gi.lot_serial,
            qty: gi.qty,
            pick: gi.pick,
            pack: gi.pack,
            status: gi.status,
            barcode_id: gi.barcode_id,
            user_pick: gi.user_pick,
            user_pack: gi.user_pack,
            barcode_text: gi.barcode_text ?? null,

            input_number: resolveInputNumberFromMap(
              inputMap,
              gi.product_id,
              gi.lot_serial,
            ),

            lock_no: lockLocations.map(
              (x: any) => `${x.location_name} (จำนวน ${x.qty})`,
            ),
            lock_locations: lockLocations,

            barcode: gi.barcode_ref
              ? {
                  barcode: gi.barcode_ref.barcode,
                  lot_start: gi.barcode_ref.lot_start,
                  lot_stop: gi.barcode_ref.lot_stop,
                  exp_start: gi.barcode_ref.exp_start,
                  exp_stop: gi.barcode_ref.exp_stop,
                  barcode_length: gi.barcode_ref.barcode_length,
                }
              : null,

            boxes:
              gi.boxes
                ?.filter((ib: any) => !ib.deleted_at)
                .map((ib: any) => ({
                  id: ib.box.id,
                  box_code: ib.box.box_code,
                  box_name: ib.box.box_name,
                  quantity: ib.quantity ?? null,
                })) ?? [],
          };
        });

        return formatted;
      }),
    );

    return res.json({ total: data.length, data });
  },
);

// GET /api/outbounds/adjust/:id
export const getSpecialOutboundById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const TYPES = ["BO", "SV", "GA", "EX", "BOA"] as const;

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) throw badRequest("id ต้องเป็นตัวเลข");

    const outbound = await prisma.outbound.findFirst({
      where: {
        id,
        deleted_at: null,
        out_type: { in: [...TYPES] },
        in_process: true,
      },
      include: {
        goods_outs: {
          where: { deleted_at: null },
          include: {
            barcode_ref: { where: { deleted_at: null } },
            boxes: { where: { deleted_at: null }, include: { box: true } },
          },
          orderBy: { sequence: "asc" },
        },
      },
    });

    if (!outbound) throw notFound("ไม่พบ Special Outbound นี้");

    // ✅ NEW: map หา short_name แล้ว override department
    const deptShortMap = await buildDepartmentShortNameMapFromOutbounds([
      outbound as any,
    ]);
    const shortName = resolveDepartmentShortNameForOutbound(
      deptShortMap,
      outbound as any,
    );

    const formatted: any = formatOdooOutbound(outbound as any);
    if (shortName) formatted.department = shortName;

    const itemsKey = (outbound.goods_outs || []).map((it: any) => ({
      product_id: it.product_id,
      lot_serial: it.lot_serial,
      lot_name: it.lot_serial,
    }));

    const inputMap = await buildInputNumberMapFromItems(itemsKey);

    const lockNoMap = await buildLockNoMapFromItems(
      itemsKey.map((x: any) => ({
        product_id: x.product_id,
        lot_name: x.lot_name,
      })),
    );

    // ✅ NEW: ดึง exp จาก wms_mdt_goods โดยเช็ค product_id + lot_id
    const goodsRows =
      (outbound.goods_outs || []).filter(
        (it: any) => it.product_id != null && it.lot_id != null,
      ).length > 0
        ? await prisma.wms_mdt_goods.findMany({
            where: {
              OR: (outbound.goods_outs || [])
                .filter((it: any) => it.product_id != null && it.lot_id != null)
                .map((it: any) => ({
                  product_id: Number(it.product_id),
                  lot_id: Number(it.lot_id),
                })),
            },
            select: {
              id: true,
              product_id: true,
              lot_id: true,
              lot_name: true,
              expiration_date: true,
            },
            orderBy: [{ id: "desc" }],
          })
        : [];

    const goodsRowByProductLot = new Map<string, any>();
    for (const g of goodsRows as any[]) {
      const pid = g?.product_id;
      const lid = g?.lot_id;
      if (pid == null || lid == null) continue;

      const key = `${Number(pid)}__${Number(lid)}`;
      if (!goodsRowByProductLot.has(key)) {
        goodsRowByProductLot.set(key, g);
      }
    }

    formatted.items = (outbound.goods_outs || []).map((gi: any) => {
      const lockLocations = resolveLockLocationsFromMap(
        lockNoMap,
        gi.product_id,
        gi.lot_serial,
      );

      const goodsRef =
        gi.product_id != null && gi.lot_id != null
          ? goodsRowByProductLot.get(
              `${Number(gi.product_id)}__${Number(gi.lot_id)}`,
            )
          : null;

      return {
        id: gi.id,
        outbound_id: gi.outbound_id,
        sequence: gi.sequence,
        product_id: gi.product_id,
        code: gi.code,
        name: gi.name,
        unit: gi.unit,
        tracking: gi.tracking,
        lot_id: gi.lot_id,
        lot_serial: gi.lot_serial,
        qty: gi.qty,
        pick: gi.pick,
        pack: gi.pack,
        status: gi.status,
        barcode_id: gi.barcode_id,
        user_pick: gi.user_pick,
        user_pack: gi.user_pack,
        barcode_text: gi.barcode_text ?? null,

        // ✅ NEW
        exp: goodsRef?.expiration_date ?? null,

        input_number: resolveInputNumberFromMap(
          inputMap,
          gi.product_id,
          gi.lot_serial,
        ),

        lock_no: lockLocations.map(
          (x: any) => `${x.location_name} (จำนวน ${x.qty})`,
        ),
        lock_locations: lockLocations,

        barcode: gi.barcode_ref
          ? {
              barcode: gi.barcode_ref.barcode,
              lot_start: gi.barcode_ref.lot_start,
              lot_stop: gi.barcode_ref.lot_stop,
              exp_start: gi.barcode_ref.exp_start,
              exp_stop: gi.barcode_ref.exp_stop,
              barcode_length: gi.barcode_ref.barcode_length,
            }
          : null,

        boxes:
          gi.boxes
            ?.filter((ib: any) => !ib.deleted_at)
            .map((ib: any) => ({
              id: ib.box.id,
              box_code: ib.box.box_code,
              box_name: ib.box.box_name,
              quantity: ib.quantity ?? null,
            })) ?? [],
      };
    });

    return res.json(formatted);
  },
);

function isNullishExp(v: unknown) {
  return toDateOnlyKey(v) == null;
}

async function resolveExpFromWmsMdtGoods(
  tx: Prisma.TransactionClient,
  input: {
    product_id: number | null | undefined;
    lot_id?: number | null | undefined;
    lot_serial?: string | null | undefined;
    exp?: Date | null | undefined;
  },
): Promise<Date | null> {
  const inputExp = normalizeExpDate(input.exp ?? null);
  if (inputExp) return inputExp;

  if (typeof input.product_id !== "number") return null;

  // 1) แม่นสุด: product_id + lot_id
  if (typeof input.lot_id === "number") {
    const row = await tx.wms_mdt_goods.findFirst({
      where: {
        product_id: input.product_id,
        lot_id: input.lot_id,
      },
      select: {
        expiration_date: true,
      },
      orderBy: { lot_id: "desc" },
    });

    const resolved = normalizeExpDate(row?.expiration_date ?? null);
    if (resolved) return resolved;
  }

  // 2) fallback: product_id + lot_name(= lot_serial)
  const lotName = String(input.lot_serial ?? "").trim();
  if (lotName) {
    const row = await tx.wms_mdt_goods.findFirst({
      where: {
        product_id: input.product_id,
        lot_name: lotName,
      },
      select: {
        expiration_date: true,
      },
      orderBy: { lot_id: "desc" },
    });

    const resolved = normalizeExpDate(row?.expiration_date ?? null);
    if (resolved) return resolved;
  }

  return null;
}

async function resolveEffectiveExp(
  tx: Prisma.TransactionClient,
  input: {
    product_id: number | null | undefined;
    lot_id?: number | null | undefined;
    lot_serial?: string | null | undefined;
    exp?: Date | null | undefined;
  },
): Promise<Date | null> {
  return (
    normalizeExpDate(input.exp ?? null) ??
    (await resolveExpFromWmsMdtGoods(tx, input)) ??
    null
  );
}

function buildBorSerWhereBase(input: {
  product_id: number | null | undefined;
  lot_id?: number | null | undefined;
  lot_serial?: string | null | undefined;
  location_name?: string | null | undefined;
}) {
  const where: any = {
    product_id: input.product_id ?? null,
    lot_name: input.lot_serial ?? null,
  };

  if (typeof input.lot_id === "number") {
    where.lot_id = input.lot_id;
  }

  if (input.location_name != null) {
    where.location_name = input.location_name;
  }

  return where;
}

/**
 * GET /api/outbounds/odoo/transfers/available
 * - เหมือน /odoo/transfers เดิม
 * - แต่ไม่แสดง Outbound ที่มีอยู่ใน batch_outbounds (ไม่สน status)
 */
function parseDepartmentIdsAsNumbers(input: unknown): number[] {
  if (Array.isArray(input)) {
    return input
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x) && x > 0);
  }

  if (typeof input === "string") {
    return input
      .split(",")
      .map((x) => Number(x.trim()))
      .filter((x) => Number.isFinite(x) && x > 0);
  }

  return [];
}

export const getOdooOutboundsAvailable = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;

    if (isNaN(page) || page < 1) {
      throw badRequest("page ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");
    }

    if (isNaN(limit) || limit < 1) {
      throw badRequest("limit ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");
    }

    const skip = (page - 1) * limit;

    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    const accessWhere = buildDepartmentAccessWhere(
      req,
    ) as Prisma.outboundWhereInput;

    const allowedDepartmentFilter = accessWhere.department_id;

    const requestedLocalDepartmentIds = parseDepartmentIdsAsNumbers(
      req.query.department_ids ?? req.query.department_id,
    );

    let selectedDepartmentWhere: Prisma.outboundWhereInput = {};

    if (requestedLocalDepartmentIds.length > 0) {
      const deptRows = await prisma.department.findMany({
        where: {
          id: { in: requestedLocalDepartmentIds },
          deleted_at: null,
        },
        select: {
          id: true,
          odoo_id: true,
        },
      });

      const requestedOdooDepartmentIds = deptRows
        .map((d) => d.odoo_id)
        .filter((v): v is number => v !== null && v !== undefined)
        .map((v) => String(v));

      if (typeof allowedDepartmentFilter === "string") {
        selectedDepartmentWhere = requestedOdooDepartmentIds.includes(
          allowedDepartmentFilter,
        )
          ? { department_id: allowedDepartmentFilter }
          : { department_id: { in: [] } };
      } else if (
        allowedDepartmentFilter &&
        typeof allowedDepartmentFilter === "object" &&
        "in" in allowedDepartmentFilter
      ) {
        const allowed = (allowedDepartmentFilter.in as (string | number)[]).map(
          (v) => String(v),
        );

        const selected = requestedOdooDepartmentIds.filter((id) =>
          allowed.includes(id),
        );

        selectedDepartmentWhere = {
          department_id: { in: selected },
        };
      } else {
        selectedDepartmentWhere = {
          department_id: { in: requestedOdooDepartmentIds },
        };
      }
    } else {
      if (typeof allowedDepartmentFilter === "string") {
        selectedDepartmentWhere = { department_id: allowedDepartmentFilter };
      } else if (
        allowedDepartmentFilter &&
        typeof allowedDepartmentFilter === "object" &&
        "in" in allowedDepartmentFilter
      ) {
        selectedDepartmentWhere = {
          department_id: {
            in: (allowedDepartmentFilter.in as (string | number)[]).map((v) =>
              String(v),
            ),
          },
        };
      } else {
        selectedDepartmentWhere = {};
      }
    }

    const baseWhere: Prisma.outboundWhereInput = {
      deleted_at: null,
      batch_lock: null,
      in_process: false,
      ...selectedDepartmentWhere,
    };

    let where: Prisma.outboundWhereInput = baseWhere;

    if (search) {
      const deptIdsFromShortName: string[] = [];

      const deptRows = await prisma.department.findMany({
        where: {
          short_name: { contains: search, mode: "insensitive" },
        },
        select: { odoo_id: true },
        take: 200,
      });

      for (const d of deptRows) {
        if (d.odoo_id != null && Number.isFinite(Number(d.odoo_id))) {
          deptIdsFromShortName.push(String(d.odoo_id));
        }
      }

      const dateRange = parseSearchDateRange(search);

      const searchCondition: Prisma.outboundWhereInput = {
        OR: [
          { no: { contains: search, mode: "insensitive" } },
          { department: { contains: search, mode: "insensitive" } },
          { reference: { contains: search, mode: "insensitive" } },
          { origin: { contains: search, mode: "insensitive" } },
          { invoice: { contains: search, mode: "insensitive" } },

          ...(deptIdsFromShortName.length > 0
            ? [{ department_id: { in: deptIdsFromShortName } }]
            : []),

          ...(dateRange
            ? [
                {
                  date: {
                    gte: dateRange.gte,
                    lt: dateRange.lt,
                  },
                },
                {
                  created_at: {
                    gte: dateRange.gte,
                    lt: dateRange.lt,
                  },
                },
                {
                  updated_at: {
                    gte: dateRange.gte,
                    lt: dateRange.lt,
                  },
                },
              ]
            : []),

          {
            goods_outs: {
              some: {
                deleted_at: null,
                OR: [
                  { code: { contains: search, mode: "insensitive" } },
                  { name: { contains: search, mode: "insensitive" } },
                  { sku: { contains: search, mode: "insensitive" } },
                ],
              },
            },
          },
        ],
      };

      where = {
        AND: [baseWhere, searchCondition],
      };
    }

    const [outbounds, total] = await Promise.all([
      prisma.outbound.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: "desc" },
        include: {
          goods_outs: {
            where: { deleted_at: null },
          },
        },
      }),
      prisma.outbound.count({ where }),
    ]);

    const departmentIds = [
      ...new Set(
        outbounds
          .map((ob) =>
            typeof ob.department_id === "string" ? ob.department_id.trim() : "",
          )
          .filter((s) => s !== "")
          .map((s) => parseInt(s, 10))
          .filter((num) => Number.isFinite(num)),
      ),
    ];

    const deptMap = new Map<number, string>();

    if (departmentIds.length > 0) {
      const departments = await prisma.department.findMany({
        where: {
          odoo_id: { in: departmentIds },
          deleted_at: null,
        },
        select: { odoo_id: true, short_name: true },
      });

      for (const d of departments) {
        if (d.odoo_id != null && d.short_name) {
          deptMap.set(Number(d.odoo_id), d.short_name);
        }
      }
    }

    const formattedOutbounds = outbounds.map((outbound) => {
      const deptIdNum =
        outbound.department_id && String(outbound.department_id).trim() !== ""
          ? parseInt(String(outbound.department_id), 10)
          : NaN;

      const shortName = Number.isFinite(deptIdNum)
        ? deptMap.get(deptIdNum)
        : undefined;

      return {
        id: outbound.id,
        picking_id: outbound.picking_id,
        no: outbound.no,
        location_id: outbound.location_id,
        location: outbound.location,
        location_dest_id: outbound.location_dest_id,
        location_dest: outbound.location_dest,
        department_id: outbound.department_id,
        department: shortName ?? outbound.department,
        reference: outbound.reference,
        origin: outbound.origin,
        invoice: outbound.invoice ?? null,
        date: outbound.date,
        out_type: outbound.out_type,
        in_process: outbound.in_process,
        outbound_barcode: outbound.outbound_barcode ?? null,
        created_at: outbound.created_at,
        updated_at: outbound.updated_at,
        items: outbound.goods_outs.map((gi) => ({
          id: gi.id,
          outbound_id: gi.outbound_id,
          sequence: gi.sequence,
          product_id: gi.product_id,
          code: gi.code,
          name: gi.name,
          unit: gi.unit,
          tracking: gi.tracking,
          lot_id: gi.lot_id,
          lot_serial: gi.lot_serial,
          qty: gi.qty,
          pick: gi.pick,
          pack: gi.pack,
          status: gi.status,
          confirmed_pick: gi.confirmed_pick,
          in_process: gi.in_process,
          user_pick: gi.user_pick ?? null,
          user_pack: gi.user_pack ?? null,
          pick_time: gi.pick_time ?? null,
          pack_time: gi.pack_time ?? null,
          lock_no: gi.lock_no ?? null,
          lock_name: gi.lock_name ?? null,
          barcode_id: gi.barcode_id ?? null,
          barcode: gi.barcode ?? null,
          barcode_text: gi.barcode_text ?? null,
          created_at: gi.created_at,
          updated_at: gi.updated_at,
        })),
      };
    });

    return res.json({
      data: formattedOutbounds,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  },
);

/**
 * GET /api/outbounds/odoo/transfers/:no
 */
export const getOdooOutboundByNo = asyncHandler(
  async (req: Request<{ no: string }>, res: Response) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;
    if (!no) throw badRequest("กรุณาระบุเลข Transfer No");

    const outbound = await prisma.outbound.findUnique({
      where: { no },
      include: {
        goods_outs: {
          where: { deleted_at: null },
          include: {
            barcode_ref: { where: { deleted_at: null } },
            boxes: { where: { deleted_at: null }, include: { box: true } },
          },
          orderBy: { sequence: "asc" },
        },
      },
    });

    if (!outbound) throw notFound(`ไม่พบ Outbound: ${no}`);
    if (outbound.deleted_at) throw badRequest("Outbound นี้ถูกลบไปแล้ว");

    const formatted: any = formatOdooOutbound(outbound as any);

    const deptMap = await buildDepartmentCodeMapFromOutbounds([
      outbound as any,
    ]);
    formatted.department_code = resolveDepartmentCodeForOutbound(
      deptMap,
      outbound as any,
    );

    const itemsKey = (outbound.goods_outs || []).map((it: any) => ({
      product_id: it.product_id,
      lot_serial: it.lot_serial,
      lot_name: it.lot_serial,
    }));

    const inputMap = await buildInputNumberMapFromItems(itemsKey);

    const lockNoMap = await buildLockNoMapFromItems(
      itemsKey.map((x) => ({ product_id: x.product_id, lot_name: x.lot_name })),
    );

    formatted.items = (outbound.goods_outs || []).map((gi: any) => {
      const lockLocations = resolveLockLocationsFromMap(
        lockNoMap,
        gi.product_id,
        gi.lot_serial,
      );

      return {
        id: gi.id,
        outbound_id: gi.outbound_id,
        sequence: gi.sequence,
        product_id: gi.product_id,
        code: gi.code,
        name: gi.name,
        unit: gi.unit,
        tracking: gi.tracking,
        lot_id: gi.lot_id,
        lot_serial: gi.lot_serial,
        qty: gi.qty,
        pick: gi.pick,
        pack: gi.pack,
        status: gi.status,
        barcode_id: gi.barcode_id,
        user_pick: gi.user_pick,
        user_pack: gi.user_pack,
        barcode_text: gi.barcode_text ?? null,

        input_number: resolveInputNumberFromMap(
          inputMap,
          gi.product_id,
          gi.lot_serial,
        ),

        lock_no: lockLocations.map(
          (x) => `${x.location_name} (จำนวน ${x.qty})`,
        ),
        lock_locations: lockLocations,

        barcode: gi.barcode_ref
          ? {
              barcode: gi.barcode_ref.barcode,
              lot_start: gi.barcode_ref.lot_start,
              lot_stop: gi.barcode_ref.lot_stop,
              exp_start: gi.barcode_ref.exp_start,
              exp_stop: gi.barcode_ref.exp_stop,
              barcode_length: gi.barcode_ref.barcode_length,
            }
          : null,

        boxes:
          gi.boxes
            ?.filter((ib: any) => !ib.deleted_at)
            .map((ib: any) => ({
              id: ib.box.id,
              box_code: ib.box.box_code,
              box_name: ib.box.box_name,
              quantity: ib.quantity ?? null,
            })) ?? [],
      };
    });

    return res.json(formatted);
  },
);

type LockRow = {
  outbound_id: number;
  name: string | null;
  created_at: Date;
};

const outboundInclude = Prisma.validator<Prisma.outboundInclude>()({
  goods_outs: {
    where: { deleted_at: null },
    include: {
      barcode_ref: { where: { deleted_at: null } },
      boxes: { where: { deleted_at: null }, include: { box: true } },
    },
    orderBy: { sequence: "asc" },
  },
});

export const getOdooOutboundsByMyBatch = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!Number.isFinite(userId)) throw badRequest("ไม่พบ user ใน token");

    const page = Math.max(1, Number(req.query.page ?? 1));
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 200)));
    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";
    const skip = (page - 1) * limit;

    const locks = await prisma.batch_outbound.findMany({
      where: { user_id: userId, status: "process" },
      select: { outbound_id: true, name: true, created_at: true },
    });

    if (locks.length === 0) {
      return res.json({ total: 0, page, limit, data: [] });
    }

    const outboundIds = locks.map((x) => x.outbound_id);

    const batchMap = new Map<
      number,
      { name: string | null; created_at: Date }
    >();
    for (const l of locks) {
      batchMap.set(l.outbound_id, {
        name: l.name ?? null,
        created_at: l.created_at,
      });
    }

    const where: Prisma.outboundWhereInput = {
      id: { in: outboundIds },
      deleted_at: null,
      picking_id: { not: null },
      ...(search
        ? {
            OR: [
              { no: { contains: search, mode: "insensitive" } },
              { outbound_barcode: { contains: search, mode: "insensitive" } },
              { out_type: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [total, outbounds] = await prisma.$transaction([
      prisma.outbound.count({ where }),
      prisma.outbound.findMany({
        where,
        include: {
          goods_outs: {
            where: { deleted_at: null },
            include: {
              barcode_ref: { where: { deleted_at: null } },
              boxes: { where: { deleted_at: null }, include: { box: true } },

              // ✅ NEW: pick แยก location
              goodsOutItemLocationPicks: {
                include: {
                  location: {
                    select: {
                      id: true,
                      full_name: true,
                    },
                  },
                },
              },
            },
            orderBy: { sequence: "asc" },
          },
        },
        skip,
        take: limit,
      }),
    ]);

    const deptMap = await buildDepartmentCodeMapFromOutbounds(outbounds as any);

    const data = await Promise.all(
      outbounds.map(async (outbound) => {
        const formatted: any = formatOdooOutbound(outbound as any);

        const batchInfo = batchMap.get(outbound.id);
        formatted.batch_name = batchInfo?.name ?? null;
        formatted.created_at = (
          batchInfo?.created_at ?? outbound.created_at
        ).toISOString();

        formatted.department_code = resolveDepartmentCodeForOutbound(
          deptMap,
          outbound as any,
        );

        const itemsKey = (outbound.goods_outs || []).map((it: any) => ({
          product_id: it.product_id,
          lot_serial: it.lot_serial,
          lot_name: it.lot_serial,
        }));

        const inputMap = await buildInputNumberMapFromItems(itemsKey);

        const lockNoMap = await buildLockNoMapFromItems(
          itemsKey.map((x: any) => ({
            product_id: x.product_id,
            lot_name: x.lot_name,
          })),
        );

        const expInput = (outbound.goods_outs || []).map((it: any) => {
          const locks = resolveLockLocationsFromMap(
            lockNoMap,
            it.product_id,
            it.lot_serial,
          );

          const location_ids = Array.isArray(locks)
            ? locks
                .map((x) => x.location_id)
                .filter(
                  (n): n is number =>
                    typeof n === "number" && Number.isFinite(n) && n > 0,
                )
            : [];

          return {
            product_id: it.product_id ?? null,
            lot_serial: it.lot_serial ?? null,
            location_ids,
          };
        });

        const { byLoc: expByLoc, byNoLoc: expByNoLoc } =
          await buildExpirationMapsFromStocks({ items: expInput });

        formatted.items = (outbound.goods_outs || []).map((gi: any) => {
          const locks = resolveLockLocationsFromMap(
            lockNoMap,
            gi.product_id,
            gi.lot_serial,
          );

          const locId = firstLocId(locks);
          const exp =
            gi.product_id != null
              ? ((locId != null
                  ? expByLoc.get(
                      expKeyLocOf(gi.product_id, gi.lot_serial, locId),
                    )
                  : undefined) ??
                expByNoLoc.get(expKeyNoLocOf(gi.product_id, gi.lot_serial)) ??
                null)
              : null;

          const location_picks = Array.isArray(gi.goodsOutItemLocationPicks)
            ? gi.goodsOutItemLocationPicks.map((lp: any) => ({
                location_id: Number(lp.location_id ?? lp.location?.id ?? 0),
                location_name: String(lp.location?.full_name ?? ""),
                qty_pick: Number(lp.qty_pick ?? 0),
              }))
            : [];

          return {
            id: gi.id,
            outbound_id: gi.outbound_id,
            sequence: gi.sequence,
            product_id: gi.product_id,
            code: gi.code,
            name: gi.name,
            unit: gi.unit,
            tracking: gi.tracking,
            lot_id: gi.lot_id,
            lot_serial: gi.lot_serial,

            exp: exp ? new Date(exp).toISOString() : null,

            qty: gi.qty,
            pick: gi.pick,
            pack: gi.pack,
            status: gi.status,
            barcode_id: gi.barcode_id,
            user_pick: gi.user_pick,
            user_pack: gi.user_pack,
            barcode_text: gi.barcode_text ?? null,

            input_number: resolveInputNumberFromMap(
              inputMap,
              gi.product_id,
              gi.lot_serial,
            ),

            lock_no: (locks || []).map(
              (x) => `${x.location_name} (จำนวน ${x.qty})`,
            ),
            lock_locations: locks,

            // ✅ NEW
            location_picks,

            barcode: gi.barcode_ref
              ? {
                  barcode: gi.barcode_ref.barcode,
                  lot_start: gi.barcode_ref.lot_start,
                  lot_stop: gi.barcode_ref.lot_stop,
                  exp_start: gi.barcode_ref.exp_start,
                  exp_stop: gi.barcode_ref.exp_stop,
                  barcode_length: gi.barcode_ref.barcode_length,
                }
              : null,

            boxes:
              gi.boxes
                ?.filter((ib: any) => !ib.deleted_at)
                .map((ib: any) => ({
                  id: ib.box.id,
                  box_code: ib.box.box_code,
                  box_name: ib.box.box_name,
                  quantity: ib.quantity ?? null,
                })) ?? [],
          };
        });

        return formatted;
      }),
    );

    return res.json({ total, page, limit, data });
  },
);

export const getOdooOutboundsByBatchName = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const userId = getUserId(req);
    if (!Number.isFinite(userId)) throw badRequest("ไม่พบ user ใน token");

    if (!req.departmentAccess) {
      throw badRequest(
        "กรุณาเรียก attachDepartmentAccess middleware ก่อนใช้งาน endpoint นี้",
      );
    }

    const rawName = Array.isArray(req.params.name)
      ? req.params.name[0]
      : req.params.name;
    const name = decodeURIComponent(String(rawName ?? "")).trim();
    if (!name) throw badRequest("กรุณาระบุ batch name");

    const page = Math.max(1, Number(req.query.page ?? 1));
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 200)));
    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";
    const code =
      typeof req.query.code === "string" ? req.query.code.trim() : "";
    const product_id =
      typeof req.query.product_id === "string"
        ? req.query.product_id.trim()
        : "";
    const parsedProductId = product_id ? Number(product_id) : null;

    if (product_id && !Number.isFinite(parsedProductId)) {
      throw badRequest("product_id ต้องเป็นตัวเลข");
    }

    const skip = (page - 1) * limit;

    const departmentWhere: Prisma.outboundWhereInput = req.departmentAccess
      .isPrivileged
      ? {}
      : Array.isArray(req.departmentAccess.allowedDepartmentIds) &&
          req.departmentAccess.allowedDepartmentIds.length > 0
        ? {
            department_id: {
              in: req.departmentAccess.allowedDepartmentIds,
            },
          }
        : {
            department_id: "__NO_ACCESS__",
          };

    const allUserLocks = await prisma.batch_outbound.findMany({
      where: { name },
      select: {
        outbound_id: true,
        name: true,
        created_at: true,
        id: true,
        status: true,
        user_id: true,
      },
      orderBy: { id: "asc" },
    });

    if (allUserLocks.length === 0) {
      throw notFound(`ไม่พบ batch name: ${name}`);
    }

    const locks = allUserLocks;
    const outboundIds = locks.map((l) => l.outbound_id);

    const batchMap = new Map<
      number,
      { name: string | null; created_at: Date; status: string | null }
    >();

    for (const l of locks) {
      batchMap.set(l.outbound_id, {
        name: l.name ?? null,
        created_at: l.created_at,
        status: l.status ?? null,
      });
    }

    const itemFilterEnabled = Boolean(code) || Number.isFinite(parsedProductId);

    const goodsOutItemWhere: Prisma.goods_out_itemWhereInput = {
      deleted_at: null,
      ...(code ? { code: { contains: code, mode: "insensitive" } } : {}),
      ...(Number.isFinite(parsedProductId)
        ? { product_id: parsedProductId as number }
        : {}),
    };

    const where: Prisma.outboundWhereInput = {
      id: { in: outboundIds },
      deleted_at: null,
      picking_id: { not: null },
      ...departmentWhere,
      ...(search
        ? {
            OR: [
              { no: { contains: search, mode: "insensitive" } },
              { invoice: { contains: search, mode: "insensitive" } },
              { outbound_barcode: { contains: search, mode: "insensitive" } },
              { out_type: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
      ...(itemFilterEnabled
        ? {
            goods_outs: {
              some: goodsOutItemWhere,
            },
          }
        : {}),
    };

    const [total, outboundsRaw] = await prisma.$transaction([
      prisma.outbound.count({ where }),
      prisma.outbound.findMany({
        where,
        include: {
          goods_outs: {
            where: itemFilterEnabled ? goodsOutItemWhere : { deleted_at: null },
            include: {
              barcode_ref: { where: { deleted_at: null } },
              boxes: { where: { deleted_at: null }, include: { box: true } },

              goodsOutItemLocationPicks: {
                include: {
                  location: {
                    select: {
                      id: true,
                      full_name: true,
                    },
                  },
                },
              },

              location_confirms: {
                include: {
                  location: {
                    select: {
                      id: true,
                      full_name: true,
                    },
                  },
                },
              },

              // ✅ NEW: return by location
              goodsOutItemLocationReturns: {
                include: {
                  location: {
                    select: {
                      id: true,
                      full_name: true,
                    },
                  },
                },
              },

              lot_adjustment: {
                select: {
                  id: true,
                  status: true,
                },
              },
              source_item: {
                select: {
                  id: true,
                },
              },
              split_children: {
                where: { deleted_at: null },
                select: {
                  id: true,
                },
              },
            },
            orderBy: [{ sequence: "asc" }, { id: "asc" }],
          },
          outboundLotAdjustments: {
            where: { deleted_at: null },
            select: {
              id: true,
              goods_out_item_id: true,
              status: true,
              original_lot_serial: true,
              original_qty: true,
              created_at: true,
              lines: {
                where: { deleted_at: null },
                select: {
                  id: true,
                  lot_id: true,
                  lot_serial: true,
                  qty: true,
                  is_original_lot: true,
                },
                orderBy: { id: "asc" },
              },
            },
            orderBy: { id: "asc" },
          },
        },
        skip,
        take: limit,
      }),
    ]);

    const allowedOutboundIdSet = new Set(outboundsRaw.map((x) => x.id));

    const orderIndex = new Map<number, number>();
    locks.forEach((l, idx) => {
      if (allowedOutboundIdSet.has(l.outbound_id)) {
        orderIndex.set(l.outbound_id, idx);
      }
    });

    const outbounds = [...outboundsRaw].sort((a, b) => {
      const ia = orderIndex.get(a.id) ?? 999999;
      const ib = orderIndex.get(b.id) ?? 999999;
      return ia - ib;
    });

    const deptMap = await buildDepartmentCodeMapFromOutbounds(outbounds as any);

    const data = await Promise.all(
      outbounds.map(async (outbound) => {
        const formatted: any = formatOdooOutbound(outbound as any);

        const batchInfo = batchMap.get(outbound.id);
        formatted.batch_name = batchInfo?.name ?? null;
        formatted.batch_status = batchInfo?.status ?? null;
        formatted.created_at = (
          batchInfo?.created_at ?? outbound.created_at
        ).toISOString();

        formatted.department_code = resolveDepartmentCodeForOutbound(
          deptMap,
          outbound as any,
        );

        const visibleGoodsOuts = Array.isArray(outbound.goods_outs)
          ? outbound.goods_outs.filter((it: any) => !it.deleted_at)
          : [];

        const itemsKey = visibleGoodsOuts.map((it: any) => ({
          product_id: it.product_id,
          lot_serial: it.lot_serial,
          lot_name: it.lot_serial,
        }));

        const inputMap = await buildInputNumberMapFromItems(itemsKey);

        const lockNoMap = await buildLockNoMapFromItems(
          itemsKey.map((x: any) => ({
            product_id: x.product_id,
            lot_name: x.lot_name,
          })),
        );

        const expInput = visibleGoodsOuts.map((it: any) => {
          const locks = resolveLockLocationsFromMap(
            lockNoMap,
            it.product_id,
            it.lot_serial,
          );

          const location_ids = Array.isArray(locks)
            ? locks
                .map((x) => x.location_id)
                .filter(
                  (n): n is number =>
                    typeof n === "number" && Number.isFinite(n) && n > 0,
                )
            : [];

          return {
            product_id: it.product_id ?? null,
            lot_serial: it.lot_serial ?? null,
            location_ids,
          };
        });

        const { byLoc: expByLoc, byNoLoc: expByNoLoc } =
          await buildExpirationMapsFromStocks({ items: expInput });

        formatted.items = visibleGoodsOuts.map((gi: any) => {
          const locks = resolveLockLocationsFromMap(
            lockNoMap,
            gi.product_id,
            gi.lot_serial,
          );

          const locId = firstLocId(locks);

          const exp =
            gi.product_id != null
              ? ((locId != null
                  ? expByLoc.get(
                      expKeyLocOf(gi.product_id, gi.lot_serial, locId),
                    )
                  : undefined) ??
                expByNoLoc.get(expKeyNoLocOf(gi.product_id, gi.lot_serial)) ??
                null)
              : null;

          const location_picks = Array.isArray(gi.goodsOutItemLocationPicks)
            ? gi.goodsOutItemLocationPicks.map((lp: any) => ({
                location_id: Number(lp.location_id ?? lp.location?.id ?? 0),
                location_name: String(lp.location?.full_name ?? ""),
                qty_pick: Number(lp.qty_pick ?? 0),
              }))
            : [];

          const location_confirms = Array.isArray(gi.location_confirms)
            ? gi.location_confirms.map((lc: any) => ({
                location_id: Number(lc.location_id ?? lc.location?.id ?? 0),
                location_name: String(lc.location?.full_name ?? ""),
                confirmed_pick: Number(lc.confirmed_pick ?? 0),
              }))
            : [];

          // ✅ NEW: return by location
          const return_locations = Array.isArray(
            gi.goodsOutItemLocationReturns,
          )
            ? gi.goodsOutItemLocationReturns.map((lr: any) => ({
                location_id: Number(lr.location_id ?? lr.location?.id ?? 0),
                location_name: String(lr.location?.full_name ?? ""),
                return: Number(lr.return ?? 0),
              }))
            : [];

          return {
            id: gi.id,
            outbound_id: gi.outbound_id,
            sequence: gi.sequence,
            product_id: gi.product_id,
            code: gi.code,
            name: gi.name,
            unit: gi.unit,
            tracking: gi.tracking,
            lot_id: gi.lot_id,
            lot_serial: gi.lot_serial,
            lot_adjustment_id: gi.lot_adjustment_id ?? null,
            exp: exp ? new Date(exp).toISOString() : null,
            qty: gi.qty,
            pick: gi.pick,
            confirmed_pick: Number(gi.confirmed_pick ?? 0),
            pack: gi.pack,
            rtc: gi.rtc ?? null,
            rtc_check: Boolean(gi.rtc_check),
            return: Number(gi.return ?? 0),
            return_check: Boolean(gi.return_check),
            status: gi.status,
            barcode_id: gi.barcode_id,
            user_pick: gi.user_pick,
            user_pack: gi.user_pack,
            barcode_text: gi.barcode_text ?? null,
            input_number: resolveInputNumberFromMap(
              inputMap,
              gi.product_id,
              gi.lot_serial,
            ),
            lock_no: (locks || []).map(
              (x) => `${x.location_name} (จำนวน ${x.qty})`,
            ),
            lock_locations: locks,
            location_picks,
            location_confirms,
            return_locations,
            barcode: gi.barcode_ref
              ? {
                  barcode: gi.barcode_ref.barcode,
                  lot_start: gi.barcode_ref.lot_start,
                  lot_stop: gi.barcode_ref.lot_stop,
                  exp_start: gi.barcode_ref.exp_start,
                  exp_stop: gi.barcode_ref.exp_stop,
                  barcode_length: gi.barcode_ref.barcode_length,
                }
              : null,
            boxes:
              gi.boxes
                ?.filter((ib: any) => !ib.deleted_at)
                .map((ib: any) => ({
                  id: ib.box.id,
                  box_code: ib.box.box_code,
                  box_name: ib.box.box_name,
                  quantity: ib.quantity ?? null,
                })) ?? [],
          };
        });

        return formatted;
      }),
    );

    res.set("Cache-Control", "no-store");

    return res.json({
      batch_name: name,
      total,
      page,
      limit,
      search_criteria: {
        search: search || null,
        code: code || null,
        product_id: Number.isFinite(parsedProductId) ? parsedProductId : null,
      },
      data,
    });
  },
);

/**
 * PATCH /api/outbounds/odoo/transfers/:no
 */
export const updateOdooOutbound = asyncHandler(
  async (req: Request<{ no: string }>, res: Response) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;
    const updateData = req.body;

    if (!no) throw badRequest("กรุณาระบุเลข Transfer No");

    const existing = await prisma.outbound.findUnique({ where: { no } });
    if (!existing) throw notFound(`ไม่พบ Outbound: ${no}`);
    if (existing.deleted_at)
      throw badRequest("ไม่สามารถแก้ไข Outbound ที่ถูกลบแล้ว");

    const updated = await prisma.outbound.update({
      where: { no },
      data: {
        picking_id: updateData.picking_id ?? undefined,
        location_id: updateData.location_id ?? undefined,
        location: updateData.location ?? undefined,
        location_dest_id: updateData.location_dest_id ?? undefined,
        location_dest: updateData.location_dest ?? undefined,
        department_id: updateData.department_id?.toString() ?? undefined,
        department: updateData.department ?? undefined,
        reference: updateData.reference ?? undefined,
        invoice: updateData.invoice ?? undefined,
        origin: updateData.origin ?? undefined,
        updated_at: new Date(),
      },
      include: {
        goods_outs: {
          where: { deleted_at: null },
          orderBy: { sequence: "asc" },
        },
      },
    });

    return res.json({
      message: "อัพเดท Outbound สำเร็จ",
      data: formatOdooOutbound(updated),
    });
  },
);

/**
 * DELETE /api/outbounds/odoo/transfers/:no
 */
export const deleteOdooOutbound = asyncHandler(
  async (req: Request<{ no: string }>, res: Response) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;

    if (!no) throw badRequest("กรุณาระบุเลข Transfer No");

    const existing = await prisma.outbound.findUnique({
      where: { no },
      include: { goods_outs: true },
    });

    if (!existing) throw notFound(`ไม่พบ Outbound: ${no}`);
    if (existing.deleted_at) throw badRequest("Outbound นี้ถูกลบไปแล้ว");

    await prisma.outbound.update({
      where: { no },
      data: { deleted_at: new Date(), updated_at: new Date() },
    });

    if (existing.goods_outs.length > 0) {
      await prisma.goods_out_item.updateMany({
        where: { outbound_id: existing.id, deleted_at: null },
        data: { deleted_at: new Date(), updated_at: new Date() },
      });
    }

    return res.json({
      message: `ลบ Outbound ${no} และ ${existing.goods_outs.length} items สำเร็จ`,
    });
  },
);

/**
 * POST /api/outbounds/bulk-delete
 */
export const bulkDeleteOutbounds = asyncHandler(
  async (req: Request<{}, {}, { outbound_nos: string[] }>, res: Response) => {
    const { outbound_nos } = req.body;

    if (
      !outbound_nos ||
      !Array.isArray(outbound_nos) ||
      outbound_nos.length === 0
    )
      throw badRequest("กรุณาระบุ outbound_nos เป็น array");

    const outbounds = await prisma.outbound.findMany({
      where: { no: { in: outbound_nos }, deleted_at: null },
      include: { goods_outs: { where: { deleted_at: null } } },
    });

    if (outbounds.length === 0) throw notFound("ไม่พบ Outbound ที่ต้องการลบ");

    await prisma.outbound.updateMany({
      where: { no: { in: outbounds.map((o) => o.no) } },
      data: { deleted_at: new Date(), updated_at: new Date() },
    });

    const outboundIds = outbounds.map((o) => o.id);
    const deletedItems = await prisma.goods_out_item.updateMany({
      where: { outbound_id: { in: outboundIds }, deleted_at: null },
      data: { deleted_at: new Date(), updated_at: new Date() },
    });

    return res.json({
      message: `ลบ ${outbounds.length} Outbounds สำเร็จ`,
      deleted_outbounds: outbounds.length,
      deleted_items: deletedItems.count,
      outbound_nos: outbounds.map((o) => o.no),
    });
  },
);

/**
 * POST /api/outbounds/odoo/transfers/:no/items/:itemId/barcode
 */
export const createOrUpdateOutboundItemBarcode = asyncHandler(
  async (
    req: Request<{ no: string; itemId: string }, {}, { barcode_id: number }>,
    res: Response,
  ) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;
    const itemIdStr = Array.isArray(req.params.itemId)
      ? req.params.itemId[0]
      : req.params.itemId;
    const itemId = parseInt(itemIdStr, 10);
    const { barcode_id } = req.body;

    if (!no) throw badRequest("กรุณาระบุเลข Transfer No");
    if (isNaN(itemId)) throw badRequest("Item ID ต้องเป็นตัวเลข");
    if (!barcode_id) throw badRequest("กรุณาระบุ barcode_id");

    const outbound = await prisma.outbound.findUnique({ where: { no } });
    if (!outbound) throw notFound(`ไม่พบ Outbound: ${no}`);
    if (outbound.deleted_at) throw badRequest("Outbound นี้ถูกลบไปแล้ว");

    const item = await prisma.goods_out_item.findUnique({
      where: { id: itemId },
    });
    if (!item) throw notFound(`ไม่พบ Item: ${itemId}`);
    if (item.outbound_id !== outbound.id)
      throw badRequest("Item ไม่ตรงกับ Outbound ที่ระบุ");
    if (item.deleted_at) throw badRequest("Item นี้ถูกลบไปแล้ว");

    const barcode = await prisma.barcode.findUnique({
      where: { id: barcode_id },
    });
    if (!barcode) throw notFound(`ไม่พบ Barcode ID: ${barcode_id}`);
    if (barcode.deleted_at) throw badRequest("Barcode นี้ถูกลบไปแล้ว");

    const updatedItem = await prisma.goods_out_item.update({
      where: { id: itemId },
      data: { barcode_id, updated_at: new Date() },
      include: {
        barcode_ref: true,
        boxes: { where: { deleted_at: null }, include: { box: true } },
      },
    });

    return res.json({
      message: "เชื่อม Barcode สำเร็จ",
      data: {
        id: updatedItem.id,
        outbound_id: updatedItem.outbound_id,
        pick: updatedItem.pick,
        pack: updatedItem.pack,
        barcode_id: updatedItem.barcode_id,
        barcode: updatedItem.barcode_ref
          ? {
              barcode: updatedItem.barcode_ref.barcode,
              lot_start: updatedItem.barcode_ref.lot_start,
              lot_stop: updatedItem.barcode_ref.lot_stop,
              exp_start: updatedItem.barcode_ref.exp_start,
              exp_stop: updatedItem.barcode_ref.exp_stop,
              barcode_length: updatedItem.barcode_ref.barcode_length,
            }
          : null,
      },
    });
  },
);

/**
 * DELETE /api/outbounds/odoo/transfers/:no/items/:itemId/barcode
 */
export const removeOutboundItemBarcode = asyncHandler(
  async (req: Request<{ no: string; itemId: string }>, res: Response) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;
    const itemIdStr = Array.isArray(req.params.itemId)
      ? req.params.itemId[0]
      : req.params.itemId;
    const itemId = parseInt(itemIdStr, 10);

    if (!no) throw badRequest("กรุณาระบุเลข Transfer No");
    if (isNaN(itemId)) throw badRequest("Item ID ต้องเป็นตัวเลข");

    const item = await prisma.goods_out_item.findUnique({
      where: { id: itemId },
    });
    if (!item) throw notFound(`ไม่พบ Item: ${itemId}`);

    const outbound = await prisma.outbound.findUnique({ where: { no } });
    if (!outbound || item.outbound_id !== outbound.id)
      throw badRequest("Item ไม่ตรงกับ Outbound ที่ระบุ");
    if (item.deleted_at) throw badRequest("Item นี้ถูกลบไปแล้ว");

    await prisma.goods_out_item.update({
      where: { id: itemId },
      data: { barcode_id: null, updated_at: new Date() },
    });

    return res.json({ message: "ลบ Barcode สำเร็จ" });
  },
);

/**
 * POST /api/outbounds/odoo/transfers/:no/barcode
 */
export const createOrUpdateOutboundBarcode = asyncHandler(
  async (
    req: Request<{ no: string }, {}, { outbound_barcode: string }>,
    res: Response,
  ) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;
    const { outbound_barcode } = req.body;

    if (!no) throw badRequest("กรุณาระบุเลข Transfer No");
    if (!outbound_barcode) throw badRequest("กรุณาระบุ outbound_barcode");

    const outbound = await prisma.outbound.findUnique({ where: { no } });
    if (!outbound) throw notFound(`ไม่พบ Outbound: ${no}`);
    if (outbound.deleted_at) throw badRequest("Outbound นี้ถูกลบไปแล้ว");

    if (outbound_barcode !== outbound.outbound_barcode) {
      const existing = await prisma.outbound.findUnique({
        where: { outbound_barcode },
      });
      if (existing && existing.no !== no)
        throw badRequest(`Barcode ${outbound_barcode} ถูกใช้ไปแล้ว`);
    }

    const updated = await prisma.outbound.update({
      where: { no },
      data: { outbound_barcode, updated_at: new Date() },
      include: {
        goods_outs: {
          where: { deleted_at: null },
          include: {
            barcode_ref: { where: { deleted_at: null } },
            boxes: { where: { deleted_at: null }, include: { box: true } },
          },
          orderBy: { sequence: "asc" },
        },
      },
    });

    return res.json({
      message: "สร้าง/อัพเดท Barcode สำเร็จ",
      data: formatOdooOutbound(updated),
    });
  },
);

function decodeNoParam(v: unknown): string {
  const s = Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
  if (!s) return "";
  return decodeURIComponent(s);
}

// ==============================
// ✅ Expiration helpers (stock.lot_name)
// ==============================

type ExpKey = string;
const expKeyOf = (
  product_id: number | null,
  lot_serial: string | null,
): ExpKey => `p:${product_id ?? 0}|lot:${normalizeLot(lot_serial)}`;

async function buildExpirationDateMapForGoodsOutItems(
  items: Array<{ product_id: number | null; lot_serial: string | null }>,
) {
  const map = new Map<ExpKey, Date | null>();

  const pids = Array.from(
    new Set(
      items
        .map((x) => x.product_id)
        .filter(
          (x): x is number => typeof x === "number" && Number.isFinite(x),
        ),
    ),
  );

  const lotNorms = Array.from(
    new Set(
      items.map((x) => normalizeLot(x.lot_serial)).filter((s) => s.length > 0),
    ),
  );

  if (pids.length === 0 || lotNorms.length === 0) return map;

  // ✅ ดึง stock ทีเดียว แล้วค่อย normalize เทียบในโค้ด (กัน format mismatch)
  const rows = await prisma.stock.findMany({
    where: {
      source: "wms",
      product_id: { in: pids },
      // ถ้าตาราง stock ของคุณมี deleted_at ให้เปิดบรรทัดนี้
      // deleted_at: null,
    } as any,
    select: {
      product_id: true,
      lot_name: true,
      expiration_date: true,
    } as any,
    orderBy: [{ expiration_date: "asc" }] as any, // เลือก exp เร็วสุดก่อน
  });

  for (const r of rows as any[]) {
    const pid = typeof r.product_id === "number" ? r.product_id : null;
    const lotNorm = normalizeLot(r.lot_name);
    if (!lotNorm) continue;
    if (!lotNorms.includes(lotNorm)) continue;

    const k = `p:${pid ?? 0}|lot:${lotNorm}`;
    if (!map.has(k)) map.set(k, (r.expiration_date ?? null) as Date | null);
  }

  return map;
}

/**
 * GET /api/outbounds/odoo/barcode/:barcode
 */
export const getOutboundByBarcode = asyncHandler(
  async (req: Request<{ barcode: string }>, res: Response) => {
    const keyword = decodeNoParam((req.params as any).barcode).trim();
    if (!keyword) throw badRequest("กรุณาระบุ Barcode หรือ Transfer No");

    const outbound = await prisma.outbound.findFirst({
      where: {
        deleted_at: null,
        OR: [{ outbound_barcode: keyword }, { no: keyword }],
      },
      include: {
        goods_outs: {
          where: { deleted_at: null },
          include: {
            barcode_ref: { where: { deleted_at: null } },
            boxes: { where: { deleted_at: null }, include: { box: true } },
          },
          orderBy: { sequence: "asc" },
        },
      },
    });

    if (!outbound) throw notFound(`ไม่พบ Outbound: ${keyword}`);

    const inputMap = await buildInputNumberMapFromItems(
      (outbound.goods_outs || []).map((x: any) => ({
        product_id: x.product_id,
        lot_serial: x.lot_serial,
        lot_name: x.lot_serial,
      })),
    );

    // ✅ NEW: build expMap from STOCK (match lot_serial -> stock.lot_name)
    const expMap = await buildExpirationDateMapForGoodsOutItems(
      (outbound.goods_outs || []).map((x: any) => ({
        product_id: x.product_id ?? null,
        lot_serial: x.lot_serial ?? null,
      })),
    );

    const texts = Array.from(
      new Set(
        (outbound.goods_outs || [])
          .map((x: any) => (x.barcode_text ?? "").trim())
          .filter((t: string) => t.length > 0),
      ),
    );

    const barcodeMap = new Map<
      string,
      {
        barcode: string;
        lot_start: number | null;
        lot_stop: number | null;
        exp_start: number | null;
        exp_stop: number | null;
        barcode_length: number | null;
      }
    >();

    if (texts.length > 0) {
      const barcodeRows = await prisma.barcode.findMany({
        where: { barcode: { in: texts }, deleted_at: null },
        select: {
          barcode: true,
          lot_start: true,
          lot_stop: true,
          exp_start: true,
          exp_stop: true,
          barcode_length: true,
        },
      });
      barcodeRows.forEach((b) => barcodeMap.set(b.barcode, b));
    }

    const formatted: any = formatOdooOutbound(outbound as any);

    const items = (outbound.goods_outs || []).map((gi: any) => {
      const t = (gi.barcode_text ?? "").trim();
      const b = t ? barcodeMap.get(t) : null;

      const exp =
        gi.product_id != null
          ? (expMap.get(expKeyOf(gi.product_id, gi.lot_serial)) ?? null)
          : null;

      return {
        id: gi.id,
        outbound_id: gi.outbound_id,
        sequence: gi.sequence,
        product_id: gi.product_id,
        code: gi.code,
        name: gi.name,
        unit: gi.unit,
        tracking: gi.tracking,
        lot_id: gi.lot_id, // keep compat
        lot_serial: gi.lot_serial,

        // ✅ NEW: expiration_date from STOCK
        exp: exp ? new Date(exp).toISOString() : null,

        qty: gi.qty,
        pick: gi.pick,
        pack: gi.pack,
        status: gi.status,
        barcode_id: gi.barcode_id,

        input_number: resolveInputNumberFromMap(
          inputMap,
          gi.product_id,
          gi.lot_serial,
        ),

        barcode_text: gi.barcode_text ?? null,

        barcode: b
          ? {
              barcode: b.barcode,
              lot_start: b.lot_start ?? null,
              lot_stop: b.lot_stop ?? null,
              exp_start: b.exp_start ?? null,
              exp_stop: b.exp_stop ?? null,
              barcode_length: b.barcode_length ?? null,
            }
          : gi.barcode_ref
            ? {
                barcode: gi.barcode_ref.barcode,
                lot_start: gi.barcode_ref.lot_start,
                lot_stop: gi.barcode_ref.lot_stop,
                exp_start: gi.barcode_ref.exp_start,
                exp_stop: gi.barcode_ref.exp_stop,
                barcode_length: gi.barcode_ref.barcode_length,
              }
            : null,

        boxes:
          gi.boxes
            ?.filter((ib: any) => !ib.deleted_at)
            .map((ib: any) => ({
              id: ib.box.id,
              box_code: ib.box.box_code,
              box_name: ib.box.box_name,
              quantity: ib.quantity ?? null,
            })) ?? [],
      };
    });

    return res.json({
      ...(formatted as any),
      items,
    });
  },
);

/**
 * POST /api/outbounds/:no/items
 */
export const addItemToOutbound = asyncHandler(
  async (
    req: Request<
      { no: string },
      {},
      {
        product_id: number;
        code: string;
        name: string;
        unit: string;
        tracking?: string;
        lot_id?: number;
        lot_serial?: string;
        qty: number;
        pick?: number;
        pack?: number;
        box_id?: string;
        status?: string;
      }
    >,
    res: Response,
  ) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;
    const {
      product_id,
      code,
      name,
      unit,
      tracking,
      lot_id,
      lot_serial,
      qty,
      pick,
      pack,
      box_id,
      status,
    } = req.body;

    if (!no) throw badRequest("กรุณาระบุเลข Outbound");
    if (!product_id || !code || !name || !unit || !qty)
      throw badRequest("กรุณาระบุข้อมูล product_id, code, name, unit และ qty");

    const outbound = await prisma.outbound.findUnique({
      where: { no },
      include: {
        goods_outs: {
          where: { deleted_at: null },
          orderBy: { sequence: "desc" },
          take: 1,
        },
      },
    });

    if (!outbound) throw notFound("ไม่พบ Outbound");
    if (outbound.deleted_at) throw badRequest("Outbound นี้ถูกลบไปแล้ว");

    const lastSequence =
      outbound.goods_outs.length > 0 ? outbound.goods_outs[0].sequence : 0;
    const newSequence = (lastSequence ?? 0) + 1;

    const newItem = await prisma.goods_out_item.create({
      data: {
        outbound_id: outbound.id,
        sequence: newSequence,
        product_id,
        code,
        name,
        unit,
        tracking: tracking || "none",
        lot_id: lot_id || null, // keep compat
        lot_serial: lot_serial || null,
        qty,
        sku: code,
        pick: pick || 0,
        pack: pack || 0,
        status: status || "DRAFT",
      },
      include: {
        barcode_ref: { where: { deleted_at: null } },
        boxes: { where: { deleted_at: null }, include: { box: true } },
      },
    });

    const formattedBoxes =
      newItem.boxes
        ?.filter((ib) => !ib.deleted_at)
        .map((ib) => ({
          id: ib.box.id,
          box_code: ib.box.box_code,
          box_name: ib.box.box_name,
          quantity: ib.quantity ?? null,
        })) ?? [];

    return res.status(201).json({
      message: "เพิ่ม item สำเร็จ",
      data: {
        id: newItem.id,
        outbound_id: newItem.outbound_id,
        sequence: newItem.sequence,
        product_id: newItem.product_id,
        code: newItem.code,
        name: newItem.name,
        unit: newItem.unit,
        qty: newItem.qty,
        pick: newItem.pick,
        pack: newItem.pack,
        status: newItem.status,
        boxes: formattedBoxes,
        barcode_id: newItem.barcode_id,
        barcode: newItem.barcode_ref
          ? {
              barcode: newItem.barcode_ref.barcode,
              lot_start: newItem.barcode_ref.lot_start,
              lot_stop: newItem.barcode_ref.lot_stop,
              exp_start: newItem.barcode_ref.exp_start,
              exp_stop: newItem.barcode_ref.exp_stop,
              barcode_length: newItem.barcode_ref.barcode_length,
            }
          : null,
      },
    });
  },
);

function firstStr(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : undefined;
  return undefined;
}

/**
 * PATCH /api/outbounds/:no/items/:itemId
 * ✅ คง flow เดิมของ WMS ทั้งหมด
 * ✅ ปรับเฉพาะ payload ที่ส่งกลับ Odoo
 *    - เปลี่ยนจาก transfers/items[1]
 *    - เป็น adjusts/items[2] แบบ "คู่ lot เดิม + lot ใหม่"
 * ✅ location/location_dest อ้างจาก outbound
 * ✅ ไม่ throw ถ้า Odoo sync fail (best effort เหมือนเดิม)
 */
export const updateOutboundItem = asyncHandler(
  async (req: Request, res: Response) => {
    const no = firstStr((req.params as any).no);
    const itemId = Number((req.params as any).itemId);

    if (!no) throw badRequest("กรุณาระบุเลข Outbound");
    if (Number.isNaN(itemId)) throw badRequest("Item ID ต้องเป็นตัวเลข");

    console.log(
      "[updateOutboundItem] request body =>",
      JSON.stringify(req.body, null, 2),
    );

    const outbound = await prisma.outbound.findUnique({
      where: { no },
      select: {
        id: true,
        no: true,
        picking_id: true,
        outbound_barcode: true,
        deleted_at: true,
        origin: true,
        location_id: true,
        location: true,
        location_dest_id: true,
        location_dest: true,
      },
    });

    if (!outbound) throw notFound(`ไม่พบ Outbound: ${no}`);
    if (outbound.deleted_at) throw badRequest("Outbound นี้ถูกลบไปแล้ว");

    const item = await prisma.goods_out_item.findUnique({
      where: { id: itemId },
      include: {
        barcode_ref: { where: { deleted_at: null } },
        boxes: { where: { deleted_at: null }, include: { box: true } },
      },
    });

    if (!item) throw notFound(`ไม่พบ Item: ${itemId}`);
    if (item.outbound_id !== outbound.id) {
      throw badRequest("Item ไม่ตรงกับ Outbound ที่ระบุ");
    }
    if (item.deleted_at) throw badRequest("Item นี้ถูกลบไปแล้ว");

    console.log(
      "[updateOutboundItem] old item =>",
      JSON.stringify(
        {
          id: item.id,
          product_id: item.product_id,
          lot_serial: item.lot_serial,
          qty: item.qty,
          barcode_text: item.barcode_text,
        },
        null,
        2,
      ),
    );

    const oldLot = item.lot_serial ?? null;
    const oldQty = Number(item.qty ?? 0);

    const newQty =
      req.body.qty !== undefined
        ? req.body.qty === null
          ? null
          : Number(req.body.qty)
        : undefined;

    if (newQty !== undefined && newQty !== null && newQty < 0) {
      throw badRequest("qty ต้องไม่ติดลบ");
    }

    const lotWasProvided =
      req.body.lot !== undefined ||
      req.body.lot_serial !== undefined ||
      req.body.lot_id !== undefined;

    let normalizedLot: string | null | undefined = undefined;

    if (lotWasProvided) {
      const lotRaw =
        req.body.lot ??
        req.body.lot_serial ??
        (req.body.lot_id != null ? String(req.body.lot_id) : null);

      normalizedLot = lotRaw === null ? null : String(lotRaw).trim() || null;
    }

    const userPackRaw =
      req.body.user_ref ?? req.body.user_pack ?? req.body.changed_by ?? null;

    const userPack =
      userPackRaw == null ? null : String(userPackRaw).trim() || null;

    const userPackWasProvided =
      req.body.user_ref !== undefined ||
      req.body.user_pack !== undefined ||
      req.body.changed_by !== undefined;

    const now = new Date();
    const data: any = { updated_at: now };

    if (lotWasProvided) data.lot_serial = normalizedLot;
    if (req.body.qty !== undefined) data.qty = newQty;
    if (req.body.pick !== undefined) data.pick = req.body.pick;
    if (req.body.pack !== undefined) data.pack = req.body.pack;
    if (req.body.status !== undefined) data.status = req.body.status;
    if (userPackWasProvided) data.user_pack = userPack;

    const packProvided = req.body.pack !== undefined;
    const statusProvided = req.body.status !== undefined;

    const packValue =
      req.body.pack !== undefined && req.body.pack !== null
        ? Number(req.body.pack)
        : null;

    const isPackingAction =
      (packProvided &&
        packValue !== null &&
        Number.isFinite(packValue) &&
        packValue > 0) ||
      (statusProvided &&
        String(req.body.status ?? "").toLowerCase() === "packed");

    if (isPackingAction) data.pack_time = now;

    const updatedItem = await prisma.goods_out_item.update({
      where: { id: itemId },
      data,
      include: {
        barcode_ref: { where: { deleted_at: null } },
        boxes: { where: { deleted_at: null }, include: { box: true } },
      },
    });

    console.log(
      "[updateOutboundItem] updated item =>",
      JSON.stringify(
        {
          id: updatedItem.id,
          product_id: updatedItem.product_id,
          lot_serial: updatedItem.lot_serial,
          qty: updatedItem.qty,
          barcode_text: updatedItem.barcode_text,
        },
        null,
        2,
      ),
    );

    const finalLot = updatedItem.lot_serial ?? null;
    const finalQty = Number(updatedItem.qty ?? 0);

    const oldBarcodes = item.barcode_ref
      ? [
          {
            barcode_id: item.barcode_ref.id,
            barcode: item.barcode_ref.barcode,
          },
        ]
      : item.barcode_text
        ? [
            {
              barcode_id: null,
              barcode: item.barcode_text,
            },
          ]
        : [];

    const newBarcodes = updatedItem.barcode_ref
      ? [
          {
            barcode_id: updatedItem.barcode_ref.id,
            barcode: updatedItem.barcode_ref.barcode,
          },
        ]
      : updatedItem.barcode_text
        ? [
            {
              barcode_id: null,
              barcode: updatedItem.barcode_text,
            },
          ]
        : [];

    const oldItemForOdoo = {
      sequence: item.sequence ?? null,
      product_id: item.product_id ?? null,
      code: item.code ?? null,
      name: item.name ?? null,
      unit: item.unit ?? null,

      location_id: outbound.location_id ?? null,
      location: outbound.location ?? null,
      location_dest_id: outbound.location_dest_id ?? null,
      location_dest: outbound.location_dest ?? null,

      tracking: item.tracking ?? null,
      lot_id: item.lot_id ?? null,
      lot_serial: oldLot,
      qty: oldQty,
      reference: req.body.reason ?? "Adjustment lot",
      barcodes: oldBarcodes,
    };

    const newItemForOdoo = {
      sequence: updatedItem.sequence ?? null,
      product_id: updatedItem.product_id ?? null,
      code: updatedItem.code ?? null,
      name: updatedItem.name ?? null,
      unit: updatedItem.unit ?? null,

      location_id: outbound.location_id ?? null,
      location: outbound.location ?? null,
      location_dest_id: outbound.location_dest_id ?? null,
      location_dest: outbound.location_dest ?? null,

      tracking: updatedItem.tracking ?? null,
      lot_id: updatedItem.lot_id ?? null,
      lot_serial: finalLot,
      qty: finalQty,
      reference: req.body.reason ?? "Adjustment lot",
      barcodes: newBarcodes,
    };

    const odooPayload = {
      params: {
        adjusts: [
          {
            no: outbound.no,
            origin: outbound.origin ?? outbound.no,
            items: [oldItemForOdoo, newItemForOdoo],
          },
        ],
      },
      jsonrpc: "2.0",
    };

    console.log(
      "[updateOutboundItem] Odoo payload =>",
      JSON.stringify(odooPayload, null, 2),
    );

    const ODOO_BASE_URL = String(process.env.ODOO_BASE_URL ?? "").trim();
    const ODOO_OUTBOUND_UPDATE_PATH = String(
      process.env.ODOO_OUTBOUND_UPDATE_PATH ?? "",
    ).trim();
    const ODOO_API_KEY = String(process.env.ODOO_API_KEY ?? "").trim();

    // ❗ strict check
    if (!ODOO_BASE_URL) {
      throw badRequest("ODOO_BASE_URL is not set");
    }

    if (!ODOO_OUTBOUND_UPDATE_PATH) {
      throw badRequest("ODOO_OUTBOUND_UPDATE_PATH is not set");
    }

    if (!ODOO_API_KEY) {
      throw badRequest("ODOO_API_KEY is not set");
    }

    // ✅ build URL แบบปลอดภัย
    const ODOO_URL = `${ODOO_BASE_URL.replace(/\/+$/, "")}/${ODOO_OUTBOUND_UPDATE_PATH.replace(
      /^\/+/,
      "",
    )}`;

    let odooSync = {
      success: false,
      error: null as string | null,
    };

    let syncLogId: number | null = null;
    const syncStartedAt = new Date();

    try {
      const log = await prisma.adjust_lot_log.create({
        data: {
          outbound_id: outbound.id,
          goods_out_item_id: updatedItem.id,
          outbound_no: outbound.no,
          event_name: "update_item_lot",
          request_path: "/api/outbounds/:no/items/:itemId",
          odoo_url: ODOO_URL || null,
          request_body: odooPayload as any,
          success: false,
          started_at: syncStartedAt,
        },
      });
      syncLogId = log.id;
    } catch (logErr) {
      console.error("[updateOutboundItem] create sync log failed =>", logErr);
    }

    if (ODOO_URL) {
      try {
        const response = await axios.post(ODOO_URL, odooPayload, {
          timeout: 20000,
          headers: {
            "api-key": ODOO_API_KEY,
            "content-type": "application/json",
          },
        });

        odooSync.success = true;

        if (syncLogId) {
          try {
            await prisma.adjust_lot_log.update({
              where: { id: syncLogId },
              data: {
                success: true,
                response_status: response.status,
                response_body: response.data ?? null,
                error_message: null,
                completed_at: new Date(),
                updated_at: new Date(),
              },
            });
          } catch (logErr) {
            console.error(
              "[updateOutboundItem] update sync log success failed =>",
              logErr,
            );
          }
        }
      } catch (e: any) {
        odooSync.error = e instanceof Error ? e.message : String(e);

        const responseStatus =
          typeof e?.response?.status === "number" ? e.response.status : null;
        const responseBody =
          e?.response?.data !== undefined ? e.response.data : null;

        if (syncLogId) {
          try {
            await prisma.adjust_lot_log.update({
              where: { id: syncLogId },
              data: {
                success: false,
                response_status: responseStatus,
                response_body: responseBody,
                error_message: odooSync.error,
                completed_at: new Date(),
                updated_at: new Date(),
              },
            });
          } catch (logErr) {
            console.error(
              "[updateOutboundItem] update sync log error failed =>",
              logErr,
            );
          }
        }
      }
    } else {
      const noUrlError = "ODOO_URL is empty";

      odooSync.error = noUrlError;

      if (syncLogId) {
        try {
          await prisma.adjust_lot_log.update({
            where: { id: syncLogId },
            data: {
              success: false,
              response_status: null,
              response_body: Prisma.JsonNull,
              error_message: noUrlError,
              completed_at: new Date(),
              updated_at: new Date(),
            },
          });
        } catch (logErr) {
          console.error(
            "[updateOutboundItem] update sync log no-url failed =>",
            logErr,
          );
        }
      }
    }

    return res.json({
      message: "แก้ไข item สำเร็จ",
      data: updatedItem,
      odoo_sync: odooSync,
      odoo_sync_log_id: syncLogId,
    });
  },
);

function lotMatchedNullable(
  itemLot: string | null | undefined,
  scannedLot: string | null | undefined,
) {
  const itemNull = !String(itemLot ?? "").trim();
  const scanNull = !String(scannedLot ?? "").trim();

  if (itemNull && scanNull) return true;
  if (itemNull !== scanNull) return false;

  return (
    normalizeScanText(itemLot ?? "") === normalizeScanText(scannedLot ?? "")
  );
}

export const scanOutboundItemCheckBarcode = asyncHandler(
  async (
    req: Request<{ no: string; itemId: string }, {}, { barcode: string }>,
    res: Response,
  ) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;
    const itemIdStr = Array.isArray(req.params.itemId)
      ? req.params.itemId[0]
      : req.params.itemId;

    const itemId = parseInt(itemIdStr, 10);
    const barcodeRaw = String(req.body.barcode ?? "").trim();

    if (!no) throw badRequest("กรุณาระบุเลข Outbound No");
    if (isNaN(itemId)) throw badRequest("Item ID ต้องเป็นตัวเลข");
    if (!barcodeRaw) throw badRequest("กรุณาส่ง barcode");

    const outbound = await prisma.outbound.findUnique({
      where: { no },
      select: { id: true, no: true, deleted_at: true },
    });
    if (!outbound) throw notFound(`ไม่พบ Outbound: ${no}`);
    if (outbound.deleted_at) throw badRequest("Outbound นี้ถูกลบไปแล้ว");

    const item = await prisma.goods_out_item.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        outbound_id: true,
        deleted_at: true,
        barcode_id: true,
        barcode_text: true,
        lot_serial: true,
        product_id: true,
      },
    });

    if (!item) throw notFound(`ไม่พบ Item: ${itemId}`);
    if (item.outbound_id !== outbound.id) {
      throw badRequest("Item ไม่ตรงกับ Outbound ที่ระบุ");
    }
    if (item.deleted_at) throw badRequest("Item นี้ถูกลบไปแล้ว");

    let masterBarcode: {
      id: number;
      barcode: string;
      lot_start: number | null;
      lot_stop: number | null;
      exp_start: number | null;
      exp_stop: number | null;
      barcode_length: number | null;
    } | null = null;

    if (item.barcode_id) {
      masterBarcode = await prisma.barcode.findUnique({
        where: { id: item.barcode_id },
        select: {
          id: true,
          barcode: true,
          lot_start: true,
          lot_stop: true,
          exp_start: true,
          exp_stop: true,
          barcode_length: true,
        },
      });
    }

    const parsed = await resolveBarcodeScan(barcodeRaw);

    const expectedBarcodeText = String(
      masterBarcode?.barcode ?? item.barcode_text ?? "",
    ).trim();

    const parsedBarcodeText = String(parsed.barcode_text ?? "").trim();

    const barcodeMatched =
      !!expectedBarcodeText &&
      normalizeScanText(parsedBarcodeText) ===
        normalizeScanText(expectedBarcodeText);

    const lotMatched = lotMatchedNullable(item.lot_serial, parsed.lot_serial);

    const normalized_scan = `${parsed.barcode_text ?? ""}${parsed.lot_serial ?? ""}${parsed.exp_text ?? ""}`;

    return res.json({
      message: "แปลง barcode สำเร็จ",
      data: {
        raw_input: parsed.raw_input,
        normalized_input: parsed.normalized_input,
        barcode_text: parsed.barcode_text,
        lot_serial: parsed.lot_serial,
        exp_text: parsed.exp_text,
        exp: parsed.exp ? parsed.exp.toISOString() : null,
        normalized_scan,
        matched_by: parsed.matched_by,
        matched: barcodeMatched && lotMatched,
        checks: {
          barcode_matched: barcodeMatched,
          lot_matched: lotMatched,
        },
        item: {
          id: item.id,
          barcode_id: item.barcode_id,
          barcode_text: item.barcode_text,
          lot_serial: item.lot_serial,
          exp: null,
        },
        barcode_meta: masterBarcode
          ? {
              id: masterBarcode.id,
              barcode: masterBarcode.barcode,
              lot_start: masterBarcode.lot_start,
              lot_stop: masterBarcode.lot_stop,
              exp_start: masterBarcode.exp_start,
              exp_stop: masterBarcode.exp_stop,
              barcode_length: masterBarcode.barcode_length,
            }
          : null,
      },
    });
  },
);

type RawLotAdjustmentLine = {
  lot_id?: number | string | null;
  lot_serial?: string | null;
  qty?: number | string | null;
};

type NormalizedLotAdjustmentLine = {
  lot_id: number | null;
  lot_serial: string | null;
  qty: number;
};

type GoodsOutItemRowForAdjustment = {
  id: number;
  outbound_id: number;
  sequence: number | null;
  product_id: number | null;
  code: string | null;
  name: string | null;
  unit: string | null;
  tracking: string | null;
  lot_id: number | null;
  lot_serial: string | null;
  qty: number | null;
  pick: number | null;
  pack: number | null;
  status: string | null;
  barcode_text: string | null;
  source_item_id: number | null;
  lot_adjustment_id: number | null;
  is_split_generated: boolean | null;
  updated_at: Date | null;
};

function normalizeLotSerialForMatch(v: unknown): string {
  return String(v ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function sameLotSerialForMatch(a: unknown, b: unknown): boolean {
  return normalizeLotSerialForMatch(a) === normalizeLotSerialForMatch(b);
}

async function enrichLotLinesWithResolvedLotId(args: {
  product_id: number | null | undefined;
  lines: Array<{
    lot_id: number | null;
    lot_serial: string | null;
    qty: number;
  }>;
}) {
  const productId =
    typeof args.product_id === "number" ? args.product_id : null;

  if (!productId) {
    return args.lines;
  }

  const missingLotSerials = Array.from(
    new Set(
      args.lines
        .filter((line) => line.lot_id == null && line.lot_serial)
        .map((line) => String(line.lot_serial).trim())
        .filter(Boolean),
    ),
  );

  if (missingLotSerials.length === 0) {
    return args.lines;
  }

  const goodsRows = await prisma.wms_mdt_goods.findMany({
    where: {
      product_id: productId,
      lot_name: { in: missingLotSerials },
    },
    select: {
      id: true,
      lot_id: true,
      lot_name: true,
      product_id: true,
    },
    orderBy: { id: "desc" },
  });

  const lotIdByLotName = new Map<string, number | null>();
  for (const row of goodsRows) {
    const key = String(row.lot_name ?? "").trim();
    if (!key) continue;
    if (!lotIdByLotName.has(key)) {
      lotIdByLotName.set(key, row.lot_id ?? null);
    }
  }

  return args.lines.map((line) => {
    if (line.lot_id != null) return line;

    const lotSerial = String(line.lot_serial ?? "").trim();
    const resolvedLotId = lotIdByLotName.get(lotSerial) ?? null;

    return {
      ...line,
      lot_id: resolvedLotId,
    };
  });
}

export const createOutboundLotAdjustment = asyncHandler(
  async (req: Request, res: Response) => {
    const no = firstStr((req.params as any).no);
    const itemId = Number((req.params as any).itemId);

    if (!no) throw badRequest("กรุณาระบุเลข Outbound");
    if (Number.isNaN(itemId)) throw badRequest("Item ID ต้องเป็นตัวเลข");

    const lines: RawLotAdjustmentLine[] = Array.isArray(req.body?.lines)
      ? (req.body.lines as RawLotAdjustmentLine[])
      : [];

    if (lines.length === 0) throw badRequest("กรุณาระบุ lines");

    const reason = firstStr(req.body?.reason) || "Partial lot adjustment";
    const userRef =
      firstStr(req.body?.user_ref) ||
      firstStr(req.body?.user_pack) ||
      firstStr(req.body?.changed_by) ||
      null;

    const outbound = await prisma.outbound.findUnique({
      where: { no },
      select: {
        id: true,
        no: true,
        picking_id: true,
        origin: true,
        deleted_at: true,
        location_id: true,
        location: true,
        location_dest_id: true,
        location_dest: true,
      },
    });

    if (!outbound) throw notFound(`ไม่พบ Outbound: ${no}`);
    if (outbound.deleted_at) throw badRequest("Outbound นี้ถูกลบไปแล้ว");

    const item = await prisma.goods_out_item.findFirst({
      where: {
        id: itemId,
        outbound_id: outbound.id,
        deleted_at: null,
      },
      select: {
        id: true,
        outbound_id: true,
        sequence: true,
        product_id: true,
        code: true,
        name: true,
        unit: true,
        tracking: true,
        lot_id: true,
        lot_serial: true,
        qty: true,
        pick: true,
        pack: true,
        status: true,
        barcode_text: true,
        source_item_id: true,
        lot_adjustment_id: true,
        is_split_generated: true,
        updated_at: true,
        deleted_at: true,
      },
    });

    if (!item) {
      throw notFound(`ไม่พบ goods_out_item: ${itemId}`);
    }

    const currentQty = Math.max(0, Math.floor(Number(item.qty ?? 0)));
    const currentPack = Math.max(0, Math.floor(Number(item.pack ?? 0)));

    if (currentPack > 0) {
      throw badRequest("มีการ pack แล้ว ห้ามเปลี่ยน lot");
    }

    const siblingRows = await prisma.goods_out_item.findMany({
      where: {
        outbound_id: outbound.id,
        deleted_at: null,
        product_id: item.product_id,
      },
      select: {
        id: true,
        lot_id: true,
        lot_serial: true,
      },
    });

    const rawNormalizedLines = lines.map((line) => {
      const rawLotId =
        line.lot_id == null || line.lot_id === "" ? null : Number(line.lot_id);

      if (line.lot_id != null && line.lot_id !== "" && Number.isNaN(rawLotId)) {
        throw badRequest("lot_id ต้องเป็นตัวเลข");
      }

      const lot_serial = firstStr(line.lot_serial) || null;
      const qty = Math.max(0, Math.floor(Number(line.qty ?? 0)));

      const matchedSibling =
        siblingRows.find((row) =>
          sameLotSerialForMatch(row.lot_serial, lot_serial),
        ) ?? null;

      return {
        lot_id: rawLotId ?? matchedSibling?.lot_id ?? null,
        lot_serial,
        qty,
      };
    });

    const normalizedLines: NormalizedLotAdjustmentLine[] =
      await enrichLotLinesWithResolvedLotId({
        product_id: item.product_id,
        lines: rawNormalizedLines,
      });

    if (normalizedLines.length === 0) {
      throw badRequest("กรุณาระบุ lines");
    }

    const totalQty = normalizedLines.reduce(
      (sum, line) => sum + Math.max(0, Number(line.qty ?? 0)),
      0,
    );

    if (totalQty !== currentQty) {
      throw badRequest(
        `ผลรวม qty ใหม่ (${totalQty}) ต้องเท่ากับ qty เดิม (${currentQty})`,
      );
    }

    const duplicateCheckSet = new Set<string>();
    for (const line of normalizedLines) {
      const dupKey = [
        item.product_id ?? "null",
        normalizeLotSerialForMatch(line.lot_serial),
      ].join("|");

      if (duplicateCheckSet.has(dupKey)) {
        throw badRequest(
          `พบ lot ซ้ำใน payload (${line.lot_serial ?? "null"}) กรุณารวม qty มาก่อนส่ง`,
        );
      }
      duplicateCheckSet.add(dupKey);
    }

    const newSignature = buildLotAdjustmentSignature(normalizedLines);

    const originalLineIndex = normalizedLines.findIndex((line) =>
      sameLotSerialForMatch(line.lot_serial, item.lot_serial),
    );

    const originalLine =
      originalLineIndex >= 0 ? normalizedLines[originalLineIndex] : null;

    const result = await prisma.$transaction(async (tx) => {
      const now = new Date();

      const pendingSameItem = await tx.outbound_lot_adjustment.findMany({
        where: {
          outbound_id: outbound.id,
          goods_out_item_id: item.id,
          status: "pending",
          deleted_at: null,
        },
        select: {
          id: true,
          queue_no: true,
          outbound_id: true,
          goods_out_item_id: true,
          status: true,
          original_lot_serial: true,
          original_lot_id: true,
          original_qty: true,
          created_at: true,
          lines: {
            where: { deleted_at: null },
            select: {
              lot_id: true,
              lot_serial: true,
              qty: true,
            },
            orderBy: { id: "asc" },
          },
        },
        orderBy: [{ queue_no: "asc" }, { id: "asc" }],
      });

      const duplicatedPending =
        pendingSameItem.find((adj) => {
          const oldSignature = buildLotAdjustmentSignature(adj.lines);
          return oldSignature === newSignature;
        }) ?? null;

      if (duplicatedPending) {
        const adjustment = await tx.outbound_lot_adjustment.update({
          where: { id: duplicatedPending.id },
          data: {
            reason,
            status: "pending",
            updated_by: userRef,
            updated_at: now,
            sent_at: null,
            send_error: null,
          } as any,
          select: {
            id: true,
            outbound_id: true,
            goods_out_item_id: true,
            status: true,
            original_lot_serial: true,
            original_lot_id: true,
            original_qty: true,
            queue_no: true,
            created_at: true,
          },
        });

        const linkedLines = await tx.outbound_lot_adjustment_line.findMany({
          where: {
            adjustment_id: adjustment.id,
            deleted_at: null,
          },
          select: {
            id: true,
            lot_id: true,
            lot_serial: true,
            qty: true,
            is_original_lot: true,
            goods_out_item_id: true,
          },
          orderBy: { id: "asc" },
        });

        return {
          mode: "update_existing_pending" as const,
          adjustment,
          updatedRootItem: item,
          affectedChildItems: [],
          linkedLines,
        };
      }

      const adjustment = await tx.outbound_lot_adjustment.create({
        data: {
          outbound_id: outbound.id,
          goods_out_item_id: item.id,
          reason,
          status: "pending",
          created_by: userRef,
          updated_by: userRef,
          original_lot_serial: item.lot_serial,
          original_lot_id: item.lot_id,
          original_qty: currentQty,
        },
        select: {
          id: true,
          outbound_id: true,
          goods_out_item_id: true,
          status: true,
          original_lot_serial: true,
          original_lot_id: true,
          original_qty: true,
          queue_no: true,
          created_at: true,
        },
      });

      const createdAdjustmentLines =
        await tx.outbound_lot_adjustment_line.createManyAndReturn({
          data: normalizedLines.map((line) => ({
            adjustment_id: adjustment.id,
            lot_id: line.lot_id,
            lot_serial: line.lot_serial,
            qty: line.qty,
            pick: 0,
            is_original_lot: sameLotSerialForMatch(
              line.lot_serial,
              item.lot_serial,
            ),
          })),
          select: {
            id: true,
            adjustment_id: true,
            lot_id: true,
            lot_serial: true,
            qty: true,
            pick: true,
            is_original_lot: true,
            goods_out_item_id: true,
          },
        });

      const getAdjustmentLineByIndex = (index: number) =>
        createdAdjustmentLines[index] ?? null;

      let updatedRootItem: GoodsOutItemRowForAdjustment & {
        deleted_at?: Date | null;
      };
      let rootSourceLineIndex = -1;

      if (originalLine && originalLine.qty > 0) {
        updatedRootItem = await tx.goods_out_item.update({
          where: { id: item.id },
          data: {
            lot_id: originalLine.lot_id,
            lot_serial: originalLine.lot_serial,
            qty: originalLine.qty,
            lot_adjustment_id: adjustment.id,
            updated_at: now,
          },
          select: {
            id: true,
            outbound_id: true,
            sequence: true,
            product_id: true,
            code: true,
            name: true,
            unit: true,
            tracking: true,
            lot_id: true,
            lot_serial: true,
            qty: true,
            pick: true,
            pack: true,
            status: true,
            barcode_text: true,
            source_item_id: true,
            lot_adjustment_id: true,
            is_split_generated: true,
            updated_at: true,
            deleted_at: true,
          },
        });

        rootSourceLineIndex = originalLineIndex;
      } else {
        updatedRootItem = await tx.goods_out_item.update({
          where: { id: item.id },
          data: {
            qty: 0,
            lot_adjustment_id: adjustment.id,
            deleted_at: now,
            updated_at: now,
          },
          select: {
            id: true,
            outbound_id: true,
            sequence: true,
            product_id: true,
            code: true,
            name: true,
            unit: true,
            tracking: true,
            lot_id: true,
            lot_serial: true,
            qty: true,
            pick: true,
            pack: true,
            status: true,
            barcode_text: true,
            source_item_id: true,
            lot_adjustment_id: true,
            is_split_generated: true,
            updated_at: true,
            deleted_at: true,
          },
        });

        rootSourceLineIndex = -1;
      }

      const rootAdjustmentLine =
        rootSourceLineIndex >= 0
          ? getAdjustmentLineByIndex(rootSourceLineIndex)
          : null;

      if (rootAdjustmentLine) {
        await tx.outbound_lot_adjustment_line.update({
          where: { id: rootAdjustmentLine.id },
          data: {
            goods_out_item_id: updatedRootItem.id,
            updated_at: now,
          },
        });
      }

      const affectedChildItems: Array<
        GoodsOutItemRowForAdjustment & { deleted_at?: Date | null }
      > = [];

      const childLineEntries = normalizedLines
        .map((line, index) => ({ line, index }))
        .filter(
          ({ index, line }) => index !== rootSourceLineIndex && line.qty > 0,
        );

      for (const { line, index } of childLineEntries) {
        const candidateRows = await tx.goods_out_item.findMany({
          where: {
            outbound_id: item.outbound_id,
            deleted_at: null,
            id: { not: item.id },
            product_id: item.product_id,
          },
          select: {
            id: true,
            outbound_id: true,
            sequence: true,
            product_id: true,
            code: true,
            name: true,
            unit: true,
            tracking: true,
            lot_id: true,
            lot_serial: true,
            qty: true,
            pick: true,
            pack: true,
            status: true,
            barcode_text: true,
            source_item_id: true,
            lot_adjustment_id: true,
            is_split_generated: true,
            updated_at: true,
            deleted_at: true,
          },
          orderBy: [{ id: "asc" }],
        });

        const existingSameLot =
          candidateRows.find((row) => {
            const lotIdMatched =
              line.lot_id != null &&
              row.lot_id != null &&
              Number(line.lot_id) === Number(row.lot_id);

            const lotSerialMatched = sameLotSerialForMatch(
              row.lot_serial,
              line.lot_serial,
            );

            return lotIdMatched || lotSerialMatched;
          }) ?? null;

        let linkedItem: GoodsOutItemRowForAdjustment & {
          deleted_at?: Date | null;
        };

        if (existingSameLot) {
          linkedItem = await tx.goods_out_item.update({
            where: { id: existingSameLot.id },
            data: {
              qty: { increment: line.qty },
              lot_id:
                existingSameLot.lot_id == null
                  ? line.lot_id
                  : existingSameLot.lot_id,
              lot_serial:
                firstStr(existingSameLot.lot_serial) || line.lot_serial,
              updated_at: now,
            },
            select: {
              id: true,
              outbound_id: true,
              sequence: true,
              product_id: true,
              code: true,
              name: true,
              unit: true,
              tracking: true,
              lot_id: true,
              lot_serial: true,
              qty: true,
              pick: true,
              pack: true,
              status: true,
              barcode_text: true,
              source_item_id: true,
              lot_adjustment_id: true,
              is_split_generated: true,
              updated_at: true,
              deleted_at: true,
            },
          });
        } else {
          linkedItem = await tx.goods_out_item.create({
            data: {
              outbound_id: item.outbound_id,
              sequence: item.sequence,
              product_id: item.product_id,
              code: item.code,
              name: item.name,
              unit: item.unit,
              tracking: item.tracking,
              lot_id: line.lot_id,
              lot_serial: line.lot_serial,
              qty: line.qty,
              pick: 0,
              pack: 0,
              status: item.status,
              barcode_text: item.barcode_text,
              source_item_id: item.id,
              lot_adjustment_id: adjustment.id,
              is_split_generated: true,
              user_pack: userRef,
              updated_at: now,
            },
            select: {
              id: true,
              outbound_id: true,
              sequence: true,
              product_id: true,
              code: true,
              name: true,
              unit: true,
              tracking: true,
              lot_id: true,
              lot_serial: true,
              qty: true,
              pick: true,
              pack: true,
              status: true,
              barcode_text: true,
              source_item_id: true,
              lot_adjustment_id: true,
              is_split_generated: true,
              updated_at: true,
              deleted_at: true,
            },
          });
        }

        const childAdjustmentLine = getAdjustmentLineByIndex(index);

        if (childAdjustmentLine) {
          await tx.outbound_lot_adjustment_line.update({
            where: { id: childAdjustmentLine.id },
            data: {
              goods_out_item_id: linkedItem.id,
              updated_at: now,
            },
          });
        }

        affectedChildItems.push(linkedItem);
      }

      const linkedLines = await tx.outbound_lot_adjustment_line.findMany({
        where: { adjustment_id: adjustment.id },
        select: {
          id: true,
          lot_id: true,
          lot_serial: true,
          qty: true,
          is_original_lot: true,
          goods_out_item_id: true,
        },
        orderBy: { id: "asc" },
      });

      return {
        mode: "create_new_pending" as const,
        adjustment,
        updatedRootItem,
        affectedChildItems,
        linkedLines,
      };
    });

    const allActiveItems = await prisma.goods_out_item.findMany({
      where: {
        outbound_id: outbound.id,
        deleted_at: null,
      },
      select: {
        id: true,
        outbound_id: true,
        sequence: true,
        product_id: true,
        code: true,
        name: true,
        unit: true,
        tracking: true,
        lot_id: true,
        lot_serial: true,
        qty: true,
        pick: true,
        pack: true,
        status: true,
        barcode_text: true,
        source_item_id: true,
        lot_adjustment_id: true,
        is_split_generated: true,
        updated_at: true,
        deleted_at: true,
      },
      orderBy: [{ sequence: "asc" }, { id: "asc" }],
    });

    const itemsForResponse = allActiveItems.filter(
      (row) => Math.max(0, Math.floor(Number(row.qty ?? 0))) > 0,
    );

    let queuedFragment: any = null;

    if (outbound.picking_id) {
      const itemsForOdoo = buildOdooItemsForSingleAdjustment({
        item: {
          code: item.code,
          name: item.name,
          unit: item.unit,
          product_id: item.product_id,
          tracking: item.tracking,
          sequence: item.sequence,
          barcode_text: item.barcode_text,
          lot_id: item.lot_id,
          lot_serial: item.lot_serial,
          qty: item.qty,
        },
        outbound: {
          location: outbound.location,
          location_id: outbound.location_id,
          location_dest: outbound.location_dest,
          location_dest_id: outbound.location_dest_id,
        },
        reference: reason,
        linkedLines: result.linkedLines,
      });

      const totalOdooQty = itemsForOdoo.reduce(
        (sum: number, row: any) =>
          sum + Math.max(0, Math.floor(Number(row.qty ?? 0))),
        0,
      );

      if (totalOdooQty !== currentQty) {
        throw badRequest(
          `Odoo payload qty ไม่ตรงกับ qty เดิมของ item (${totalOdooQty}/${currentQty})`,
        );
      }

      queuedFragment = buildQueuedOdooFragment({
        outbound,
        reason,
        itemsForOdoo,
      });

      let nextQueueNo = result.adjustment.queue_no;

      if (!nextQueueNo) {
        const maxQueue = await prisma.outbound_lot_adjustment.aggregate({
          where: {
            outbound_id: outbound.id,
            deleted_at: null,
          },
          _max: {
            queue_no: true,
          },
        });

        nextQueueNo = Number(maxQueue._max.queue_no ?? 0) + 1;
      }

      await prisma.outbound_lot_adjustment.update({
        where: { id: result.adjustment.id },
        data: {
          status: "pending",
          queue_no: nextQueueNo,
          odoo_payload_fragment: queuedFragment,
          sent_at: null,
          send_error: null,
          updated_by: userRef,
        } as any,
      });
    }

    return res.status(201).json({
      message:
        result.mode === "update_existing_pending"
          ? "อัปเดต outbound lot adjustment pending เดิมสำเร็จ"
          : "สร้าง outbound lot adjustment สำเร็จ",
      data: {
        mode: result.mode,
        adjustment: {
          ...result.adjustment,
          status: outbound.picking_id ? "pending" : result.adjustment.status,
        },
        items: itemsForResponse,
        linked_lines: result.linkedLines,
        adjust_lot_log_id: null,
        odoo_payload: queuedFragment,
        odoo: {
          success: false,
          queued: !!queuedFragment,
          sent: false,
          response: null,
          error: outbound.picking_id
            ? {
                message:
                  result.mode === "update_existing_pending"
                    ? "อัปเดต Queue payload เดิมแล้ว รอส่งตอน confirm pick"
                    : "Queue payload ไว้แล้ว รอส่งตอน confirm pick",
              }
            : {
                message: "Skip queue เพราะ outbound ไม่มี picking_id",
              },
        },
      },
    });
  },
);

export const revertOutboundLotAdjustment = asyncHandler(
  async (req: Request, res: Response) => {
    const no = firstStr((req.params as any).no);
    const itemId = Number((req.params as any).itemId);
    const adjustmentId = Number((req.params as any).adjustmentId);

    if (!no) throw badRequest("กรุณาระบุเลข Outbound");
    if (Number.isNaN(itemId)) throw badRequest("Item ID ต้องเป็นตัวเลข");
    if (Number.isNaN(adjustmentId)) {
      throw badRequest("Adjustment ID ต้องเป็นตัวเลข");
    }

    const outbound = await prisma.outbound.findUnique({
      where: { no },
      select: {
        id: true,
        no: true,
        picking_id: true,
        origin: true,
        deleted_at: true,
        location_id: true,
        location: true,
        location_dest_id: true,
        location_dest: true,
      },
    });

    if (!outbound) throw notFound(`ไม่พบ Outbound: ${no}`);
    if (outbound.deleted_at) throw badRequest("Outbound นี้ถูกลบไปแล้ว");
    if (outbound.picking_id == null) {
      throw badRequest(`Outbound ${outbound.no} ไม่มี picking_id`);
    }

    const requestItem = await prisma.goods_out_item.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        outbound_id: true,
        source_item_id: true,
        lot_adjustment_id: true,
        is_split_generated: true,
        sequence: true,
        product_id: true,
        code: true,
        name: true,
        unit: true,
        tracking: true,
        lot_id: true,
        lot_serial: true,
        qty: true,
        barcode_text: true,
        barcode_ref: true,
      },
    });

    if (!requestItem) throw notFound(`ไม่พบ Item: ${itemId}`);
    if (requestItem.outbound_id !== outbound.id) {
      throw badRequest("Item ไม่ตรงกับ Outbound ที่ระบุ");
    }

    const adjustment = await prisma.outbound_lot_adjustment.findFirst({
      where: {
        id: adjustmentId,
        outbound_id: outbound.id,
        status: "active",
        deleted_at: null,
      },
      select: {
        id: true,
        goods_out_item_id: true,
        original_lot_id: true,
        original_lot_serial: true,
        original_qty: true,
      },
    });

    if (!adjustment) {
      throw notFound("ไม่พบ adjustment ที่ active");
    }

    const rootItem = await prisma.goods_out_item.findUnique({
      where: { id: adjustment.goods_out_item_id },
      select: {
        id: true,
        outbound_id: true,
        sequence: true,
        product_id: true,
        code: true,
        name: true,
        unit: true,
        tracking: true,
        lot_id: true,
        lot_serial: true,
        qty: true,
        lot_adjustment_id: true,
        barcode_text: true,
        barcode_ref: true,
      },
    });

    if (!rootItem) {
      throw notFound(`ไม่พบ root item ของ adjustment: ${adjustment.id}`);
    }

    const childItems = await prisma.goods_out_item.findMany({
      where: {
        source_item_id: rootItem.id,
        lot_adjustment_id: adjustment.id,
        is_split_generated: true,
        deleted_at: null,
      },
      select: {
        id: true,
        sequence: true,
        product_id: true,
        code: true,
        name: true,
        unit: true,
        tracking: true,
        lot_id: true,
        lot_serial: true,
        qty: true,
        barcode_text: true,
        barcode_ref: true,
      },
      orderBy: { id: "asc" },
    });

    const now = new Date();

    const txResult = await prisma.$transaction(async (tx) => {
      const deletedChildren = await tx.goods_out_item.updateMany({
        where: {
          source_item_id: rootItem.id,
          lot_adjustment_id: adjustment.id,
          is_split_generated: true,
          deleted_at: null,
        },
        data: {
          deleted_at: now,
          updated_at: now,
        },
      });

      const restoredRoot = await tx.goods_out_item.update({
        where: { id: rootItem.id },
        data: {
          lot_id: adjustment.original_lot_id,
          lot_serial: adjustment.original_lot_serial,
          qty: adjustment.original_qty,
          lot_adjustment_id: null,
          updated_at: now,
        },
        select: {
          id: true,
          sequence: true,
          product_id: true,
          code: true,
          name: true,
          unit: true,
          tracking: true,
          lot_id: true,
          lot_serial: true,
          qty: true,
          lot_adjustment_id: true,
          barcode_text: true,
          updated_at: true,
        },
      });

      await tx.outbound_lot_adjustment.update({
        where: { id: adjustment.id },
        data: {
          status: "reverted",
          updated_at: now,
        },
      });

      await tx.outbound_lot_adjustment_line.updateMany({
        where: {
          adjustment_id: adjustment.id,
        },
        data: {
          updated_at: now,
        },
      });

      return {
        deletedChildrenCount: deletedChildren.count,
        restoredRoot,
      };
    });

    const restoredBarcodes = txResult.restoredRoot.barcode_text
      ? [{ barcode_id: null, barcode: txResult.restoredRoot.barcode_text }]
      : [];

    // ✅ revert แล้วส่งกลับ Odoo เฉพาะสถานะล่าสุดหลัง revert = item เดิม 1 รายการ
    const restoredItemForOdoo = {
      sequence: txResult.restoredRoot.sequence ?? null,
      product_id: txResult.restoredRoot.product_id ?? null,
      code: txResult.restoredRoot.code ?? null,
      name: txResult.restoredRoot.name ?? null,
      unit: txResult.restoredRoot.unit ?? null,

      location_id: outbound.location_id ?? null,
      location: outbound.location ?? null,
      location_dest_id: outbound.location_dest_id ?? null,
      location_dest: outbound.location_dest ?? null,

      tracking: txResult.restoredRoot.tracking ?? null,
      lot_id: txResult.restoredRoot.lot_id ?? null,
      lot_serial: txResult.restoredRoot.lot_serial ?? null,
      qty: Number(txResult.restoredRoot.qty ?? 0),
      reference: "Revert lot adjustment",
      barcodes: restoredBarcodes,
    };

    const odooPayload = {
      params: {
        adjusts: [
          {
            no: outbound.no,
            picking_id: outbound.picking_id,
            origin: outbound.origin ?? outbound.no,
            items: [restoredItemForOdoo],
          },
        ],
      },
      jsonrpc: "2.0",
    };

    console.log(
      "[revertOutboundLotAdjustment] result =>",
      JSON.stringify(
        {
          deletedChildrenCount: txResult.deletedChildrenCount,
          restoredRoot: txResult.restoredRoot,
          removedChildIds: childItems.map((x) => x.id),
        },
        null,
        2,
      ),
    );

    console.log(
      "[revertOutboundLotAdjustment] Odoo payload =>",
      JSON.stringify(odooPayload, null, 2),
    );

    return res.json({
      message: "revert lot adjustment สำเร็จ",
      data: {
        adjustment_id: adjustment.id,
        root_item_id: rootItem.id,
        deleted_children_count: txResult.deletedChildrenCount,
        deleted_child_item_ids: childItems.map((x) => x.id),
        restored_root: txResult.restoredRoot,
      },
      odoo_payload: odooPayload,
    });
  },
);

/**
 * GET /api/outbounds/:no/items/:itemId
 */
export const getOutboundItem = asyncHandler(
  async (req: Request<{ no: string; itemId: string }>, res: Response) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;
    const itemIdStr = Array.isArray(req.params.itemId)
      ? req.params.itemId[0]
      : req.params.itemId;
    const itemId = parseInt(itemIdStr, 10);

    if (!no) throw badRequest("กรุณาระบุเลข Outbound");
    if (isNaN(itemId)) throw badRequest("Item ID ต้องเป็นตัวเลข");

    const outbound = await prisma.outbound.findUnique({ where: { no } });
    if (!outbound) throw notFound(`ไม่พบ Outbound: ${no}`);
    if (outbound.deleted_at) throw badRequest("Outbound นี้ถูกลบไปแล้ว");

    const item = await prisma.goods_out_item.findUnique({
      where: { id: itemId },
      include: {
        barcode_ref: { where: { deleted_at: null } },
        boxes: { where: { deleted_at: null }, include: { box: true } },
        outbound: {
          select: { id: true, no: true, outbound_barcode: true, invoice: true },
        },
      },
    });

    if (!item) throw notFound(`ไม่พบ Item: ${itemId}`);
    if (item.outbound_id !== outbound.id)
      throw badRequest("Item ไม่ตรงกับ Outbound ที่ระบุ");
    if (item.deleted_at) throw badRequest("Item นี้ถูกลบไปแล้ว");

    const inputMap = await buildInputNumberMapFromItems([
      {
        product_id: item.product_id,
        lot_serial: item.lot_serial,
        lot_name: item.lot_serial,
      },
    ]);

    const input_number = resolveInputNumberFromMap(
      inputMap,
      item.product_id,
      item.lot_serial,
    );

    const formattedBoxes =
      item.boxes
        ?.filter((ib) => !ib.deleted_at)
        .map((ib) => ({
          id: ib.box.id,
          box_code: ib.box.box_code,
          box_name: ib.box.box_name,
          quantity: ib.quantity ?? null,
        })) ?? [];

    return res.json({
      id: item.id,
      outbound_id: item.outbound_id,
      outbound_no: item.outbound.no,
      invoice: item.outbound.invoice ?? null,
      outbound_barcode: item.outbound.outbound_barcode ?? null, // (แนะนำเพิ่มแยกไว้ชัดๆ)
      sequence: item.sequence,
      product_id: item.product_id,
      code: item.code,
      sku: item.sku,
      name: item.name,
      unit: item.unit,
      lot_id: item.lot_id,
      lot_serial: item.lot_serial,
      qty: item.qty,
      pick: item.pick,
      pack: item.pack,
      status: item.status,
      input_number,
      boxes: formattedBoxes,
      barcode_text: item.barcode_text ?? null,
      barcode_id: item.barcode_id,
      barcode: item.barcode_ref
        ? {
            barcode: item.barcode_ref.barcode,
            lot_start: item.barcode_ref.lot_start,
            lot_stop: item.barcode_ref.lot_stop,
            exp_start: item.barcode_ref.exp_start,
            exp_stop: item.barcode_ref.exp_stop,
            barcode_length: item.barcode_ref.barcode_length,
          }
        : null,
    });
  },
);

/**
 * GET /api/outbounds/search?product_id=123
 * GET /api/outbounds/search?code=PROD-123
 */
export const searchOutboundsByItem = asyncHandler(
  async (
    req: Request<{}, {}, {}, { product_id?: string; code?: string }>,
    res: Response,
  ) => {
    const { product_id, code } = req.query;

    console.log("✅ searchOutboundsByItem called", req.query);

    if (!product_id && !code) {
      throw badRequest("กรุณาระบุ product_id หรือ code");
    }

    const parsedProductId = product_id ? parseInt(product_id, 10) : undefined;

    const goodsOutWhere: any = {
      deleted_at: null,
      ...(parsedProductId ? { product_id: parsedProductId } : {}),
      ...(code ? { code } : {}),
    };

    const batches = await prisma.batch_outbound.findMany({
      where: {
        outbound: {
          deleted_at: null,
          goods_outs: {
            some: goodsOutWhere,
          },
        },
      },
      include: {
        outbound: {
          include: {
            goods_outs: {
              where: goodsOutWhere,
              include: {
                barcode_ref: { where: { deleted_at: null } },
                boxes: {
                  where: { deleted_at: null },
                  include: { box: true },
                },
              },
              orderBy: { sequence: "asc" },
            },
          },
        },
        user: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            username: true,
          },
        },
      },
      orderBy: { created_at: "desc" },
    });

    const data = await Promise.all(
      batches.map(async (batch) => {
        const formatted: any = formatOdooOutbound(batch.outbound as any);

        const inputMap = await buildInputNumberMapFromItems(
          (formatted.items || []).map((it: any) => ({
            product_id: it.product_id,
            lot_serial: it.lot_serial,
            lot_name: it.lot_serial,
          })),
        );

        formatted.items = (formatted.items || []).map((it: any) => ({
          ...it,
          input_number: resolveInputNumberFromMap(
            inputMap,
            it.product_id,
            it.lot_serial,
          ),
        }));

        formatted.batch_outbound = {
          id: batch.id,
          name: batch.name,
          status: batch.status,
          remark: batch.remark,
          created_at: batch.created_at,
          updated_at: batch.updated_at,
          released_at: batch.released_at,
          user: batch.user,
        };

        return formatted;
      }),
    );

    res.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");

    return res.json({
      total: data.length,
      search_criteria: { product_id, code },
      data,
    });
  },
);

/**
 * GET /api/outbounds/packed-items
 */
export const getPackedOutboundItems = asyncHandler(
  async (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const wherePacked = {
      pack: { not: 0 },
      boxes: { some: { deleted_at: null } },
      deleted_at: null,
    } as const;

    const [items, total] = await Promise.all([
      prisma.goods_out_item.findMany({
        where: wherePacked,
        include: {
          outbound: {
            select: {
              no: true,
              date: true,
              out_type: true,
              department: true,
              invoice: true,
            },
          },
          boxes: {
            where: { deleted_at: null },
            include: { box: true },
          },
        },
        orderBy: [{ outbound: { date: "desc" } }, { sequence: "asc" }],
        skip,
        take: limit,
      }),
      prisma.goods_out_item.count({ where: wherePacked }),
    ]);

    const inputMap = await buildInputNumberMapFromItems(
      items.map((it: any) => ({
        product_id: it.product_id,
        lot_serial: it.lot_serial,
        lot_name: it.lot_serial,
      })),
    );

    const formattedItems = items.map((item: any, index: number) => {
      const boxText =
        item.boxes
          ?.map((b: any) => b.box?.box_code || b.box?.box_name)
          .filter(Boolean)
          .join(", ") || "-";

      return {
        no: skip + index + 1,
        outbound_no: item.outbound?.no ?? null,
        out_type: item.outbound?.out_type ?? null,
        department: item.outbound?.department ?? null,
        date: item.outbound?.date ?? null,
        box: boxText,

        input_number: resolveInputNumberFromMap(
          inputMap,
          item.product_id,
          item.lot_serial,
        ),

        sequence: item.sequence ?? null,
        product_id: item.product_id ?? null,
        code: item.code ?? null,
        name: item.name ?? null,
        unit: item.unit ?? null,
        tracking: item.tracking ?? null,
        lot_id: item.lot_id ?? null,
        lot_serial: item.lot_serial ?? null,
        qty: item.qty ?? null,
        sku: item.sku ?? null,
        lock_no: item.lock_no ?? null,
        lock_name: item.lock_name ?? null,
        barcode: item.barcode ?? null,
        created_at: item.created_at ?? null,
        updated_at: item.updated_at ?? null,
        deleted_at: item.deleted_at ?? null,
        barcode_id: item.barcode_id ?? null,
        outbound_id: item.outbound_id ?? null,
        id: item.id ?? null,
        pack: item.pack ?? 0,
        pick: item.pick ?? 0,
        status: item.status ?? null,
        confirmed_pick: item.confirmed_pick ?? 0,
        barcode_text: item.barcode_text ?? null,

        qty_required: item.qty ?? 0,
        qty_packed: item.pack ?? 0,
        item_id: item.id,

        boxes:
          item.boxes?.map((ib: any) => ({
            id: ib.box?.id ?? null,
            box_code: ib.box?.box_code ?? null,
            box_name: ib.box?.box_name ?? null,
            quantity: ib.quantity ?? null,
          })) ?? [],
      };
    });

    return res.json({
      data: formattedItems,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  },
);

type UpdateGoodsOutItemRtcBody = {
  rtc: number;
};

function pickPositiveInt(v: unknown, field: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw badRequest(`${field} ต้องเป็นจำนวนเต็ม >= 0`);
  }
  return n;
}

export const updateGoodsOutItemRtc = asyncHandler(
  async (
    req: Request<{ id: string }, {}, UpdateGoodsOutItemRtcBody>,
    res: Response,
  ) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      throw badRequest("id ต้องเป็นตัวเลขจำนวนเต็มบวก");
    }

    const rtc = pickPositiveInt(req.body?.rtc, "rtc");

    const result = await prisma.$transaction(async (tx) => {
      const row = await tx.goods_out_item.findUnique({
        where: { id },
        select: {
          id: true,
          outbound_id: true,
          qty: true,
          rtc: true,
          deleted_at: true,
          outbound: {
            select: {
              id: true,
              no: true,
            },
          },
        },
      });

      if (!row || row.deleted_at) {
        throw notFound(`ไม่พบ goods_out_item: ${id}`);
      }

      const currentQty = Math.max(0, Math.floor(Number(row.qty ?? 0)));
      const currentRtc = Math.max(0, Math.floor(Number(row.rtc ?? 0)));

      // rtc ที่ส่งมาเป็น "ค่าที่จะใช้แทนทั้งหมด"
      // qty ใหม่ = qty เดิม + rtc เดิม - rtc ใหม่
      const restoredQty = currentQty + currentRtc;
      const nextQty = restoredQty - rtc;

      if (nextQty < 0) {
        throw badRequest(
          `rtc มากกว่าจำนวนที่มีอยู่ได้ (restored_qty=${restoredQty}, rtc=${rtc})`,
        );
      }

      const updated = await tx.goods_out_item.update({
        where: { id: row.id },
        data: {
          rtc,
          qty: nextQty,
          updated_at: new Date(),
        },
        select: {
          id: true,
          outbound_id: true,
          qty: true,
          rtc: true,
          updated_at: true,
        },
      });

      return {
        ...updated,
        outbound_no: row.outbound?.no ?? null,
      };
    });

    const payload = {
      source: "goods_out_item_rtc_update",
      goods_out_item_id: result.id,
      outbound_id: result.outbound_id,
      outbound_no: result.outbound_no,
      data: result,
    };

    try {
      if (result.outbound_no) {
        io.to(`outbound:${result.outbound_no}`).emit(
          "outbound:item_rtc_updated",
          payload,
        );
      }

      io.to(`outbound-id:${result.outbound_id}`).emit(
        "outbound:item_rtc_updated",
        payload,
      );

      io.emit("outbound:item_rtc_updated", payload);
    } catch {}

    return res.json({
      message: "อัปเดต rtc สำเร็จ",
      data: result,
    });
  },
);

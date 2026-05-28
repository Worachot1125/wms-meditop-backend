import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest } from "../utils/appError";
import { Prisma } from "@prisma/client";
import { formatOdooOutbound } from "../utils/formatters/odoo_outbound.formatter";
import {
  resolveBarcodeScan,
  normalizeScanText,
  sameExpDateOnly,
} from "../utils/helper_scan/barcode";

import {
  resolveLocationByFullNameWithZone,
  handleScanLocationCommon,
} from "../utils/helper_scan/location";
import { io } from "../index";

type AutoStockTarget = "bor" | "ser";
type DeptShortMap = Map<number, string>;
type InputKey = string;
type LockKey = string;

type LockLocRow = {
  location_id: number | null;
  location_name: string;
  qty: number;
};

type AdjustmentBorLine = {
  sequence: number | null;
  product_id: number | null;
  code: string | null;
  name: string | null;
  unit: string | null;

  location_id: number | null;
  location: string | null;

  lot_id: number | null;
  lot_serial: string | null;
  tracking: string | null;

  qty: number;
  exp: Date | null;

  barcode_id: number | null;
  barcode_text: string | null;
  barcode_payload: string | null;

  location_owner: string | null;
  location_owner_display: string | null;

  location_dest_id: number | null;
  location_dest: string | null;
  location_dest_owner: string | null;
  location_dest_owner_display: string | null;
};

function isNewLotSerial(lotSerial: string | null | undefined): boolean {
  return String(lotSerial ?? "")
    .trim()
    .startsWith("#");
}

function one(v: unknown): string {
  if (Array.isArray(v)) return String(v[0] ?? "");
  if (typeof v === "string") return v;
  return String(v ?? "");
}

function normalize(v: unknown): string {
  return one(v)
    .replace(/\s|\r|\n|\t/g, "")
    .trim();
}

function normalizeText(v: unknown): string {
  return one(v).trim().replace(/\s+/g, " ");
}

function safeString(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function safeInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function stringifyIfNeeded(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    return s.length ? s : null;
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function normalizeOwnerOrLocationText(v: unknown): string | null {
  if (v == null) return null;

  if (Array.isArray(v)) {
    const first = v.find((x) => typeof x === "string" && x.trim());
    return first ? String(first).trim() : null;
  }

  const s = String(v).trim();
  return s.length ? s : null;
}

export function normalizeAdjustmentExp(v: unknown): Date | null {
  if (!v) return null;

  if (v instanceof Date) {
    return isNaN(v.getTime()) ? null : v;
  }

  const s = String(v).trim();
  if (!s || s === "false") return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00.000Z`);
    return isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function toAdjustmentDateOnlyKey(v: unknown): string | null {
  const d = normalizeAdjustmentExp(v);
  if (!d) return null;

  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function sameAdjustmentExpDate(a: unknown, b: unknown): boolean {
  return toAdjustmentDateOnlyKey(a) === toAdjustmentDateOnlyKey(b);
}

function formatYYMMDD(d: Date | null | undefined): string {
  if (!d) return "999999";
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

function buildAdjustmentBarcodePayload(input: {
  barcode: string;
  lot_serial: string | null | undefined;
  exp: Date | null | undefined;
}) {
  const barcode = String(input.barcode ?? "")
    .trim()
    .replace(/\s+/g, "");
  if (!barcode) return "";

  const lotPart = input.lot_serial
    ? String(input.lot_serial).trim().replace(/\s+/g, "")
    : "XXXXXX";

  const expPart = formatYYMMDD(input.exp);
  return `${barcode}${lotPart}${expPart}`;
}

function buildBarcodePayload(barcodes: unknown): string | null {
  if (!Array.isArray(barcodes) || !barcodes.length) return null;

  const list = barcodes
    .map((b: any) => safeString(b?.barcode))
    .filter((x): x is string => !!x);

  if (!list.length) return null;

  return JSON.stringify(list);
}

function pickAdjusts(body: any): any[] {
  if (Array.isArray(body?.params?.adjusts)) return body.params.adjusts;
  if (Array.isArray(body?.adjusts)) return body.adjusts;
  return [];
}

function inferAdjustmentTypeFromReference(
  no?: string | null,
  origin?: string | null,
  reference?: string | null,
): string {
  const ref = String(reference ?? "").toUpperCase();
  const s = `${String(no ?? "").toUpperCase()} ${String(origin ?? "").toUpperCase()} ${ref}`;

  if (ref.includes("[BOA]") || s.includes("BOA")) return "BOA";
  if (s.includes("BOR")) return "BOR";
  if (s.includes("ADJ")) return "ADJ";
  return "ADJ";
}

function normalizeAutoDepartments(departments: any) {
  let department_id: string | null = null;
  let department = "";

  if (Array.isArray(departments) && departments.length > 0) {
    const firstId = departments.find(
      (d) => d?.department_id != null,
    )?.department_id;

    const names = departments
      .map((d) => (typeof d?.department === "string" ? d.department : null))
      .filter(Boolean);

    department_id = firstId != null ? String(firstId) : null;
    department = names.join(", ");

    return { department_id, department };
  }

  if (typeof departments === "string") {
    return {
      department_id: null,
      department: departments.trim(),
    };
  }

  if (typeof departments === "object" && departments !== null) {
    if ((departments as any).department_id != null) {
      department_id = String((departments as any).department_id);
    }
    if (typeof (departments as any).department === "string") {
      department = (departments as any).department;
    }
  }

  return { department_id, department };
}

function resolveAutoDepartmentSource(adjust: any) {
  if (Array.isArray(adjust?.departments) && adjust.departments.length > 0) {
    return adjust.departments;
  }

  if (Array.isArray(adjust?.department) && adjust.department.length > 0) {
    return adjust.department;
  }

  if (adjust?.departments != null) return adjust.departments;
  if (adjust?.department != null) return adjust.department;

  return null;
}

function getOldBusinessLocationName(item: AdjustmentBorLine): string | null {
  return (
    normalizeOwnerOrLocationText(item.location_owner) ??
    normalizeOwnerOrLocationText(item.location)
  );
}

function getNewBusinessLocationName(item: AdjustmentBorLine): string | null {
  return (
    normalizeOwnerOrLocationText(item.location_dest_owner) ??
    normalizeOwnerOrLocationText(item.location_dest)
  );
}

function buildAutoReplaceOldPairKey(item: AdjustmentBorLine): string {
  return [
    `p:${item.product_id ?? "null"}`,
    `qty:${item.qty ?? 0}`,
    `exp:${toAdjustmentDateOnlyKey(item.exp) ?? "null"}`,
    `biz:${getOldBusinessLocationName(item) ?? ""}`,
    `code:${item.code ?? ""}`,
  ].join("|");
}

function buildAutoReplaceNewPairKey(item: AdjustmentBorLine): string {
  return [
    `p:${item.product_id ?? "null"}`,
    `qty:${item.qty ?? 0}`,
    `exp:${toAdjustmentDateOnlyKey(item.exp) ?? "null"}`,
    `biz:${getNewBusinessLocationName(item) ?? ""}`,
    `code:${item.code ?? ""}`,
  ].join("|");
}

async function softDeleteOldStock(
  tx: Prisma.TransactionClient,
  target: AutoStockTarget,
  item: AdjustmentBorLine,
  adjustmentNo: string,
  departmentId?: string | null,
  departmentName?: string | null,
) {
  const locationName = getOldBusinessLocationName(item);

  if (!locationName) {
    throw badRequest(
      `ไม่พบ business location สำหรับลบ stock เดิม product=${item.product_id ?? "null"} lot=${item.lot_serial ?? "-"}`,
    );
  }

  const activeWhere = {
    product_id: item.product_id ?? undefined,
    location_name: locationName,
    deleted_at: null,
    active: true,
  } as any;

  const activeRows =
    target === "bor"
      ? await tx.bor_stock.findMany({
          where: activeWhere,
          orderBy: { id: "desc" },
        })
      : await tx.ser_stock.findMany({
          where: activeWhere,
          orderBy: { id: "desc" },
        });

  const activeMatched =
    activeRows.find((r: any) => {
      const sameLot =
        String(r.lot_name ?? "").trim() ===
        String(item.lot_serial ?? "").trim();
      const sameLotId =
        item.lot_id != null
          ? Number(r.lot_id ?? 0) === Number(item.lot_id)
          : true;
      const sameExp = sameAdjustmentExpDate(r.expiration_date, item.exp);
      return sameLot && sameLotId && sameExp;
    }) ??
    activeRows.find((r: any) => {
      const sameLot =
        String(r.lot_name ?? "").trim() ===
        String(item.lot_serial ?? "").trim();
      const sameLotId =
        item.lot_id != null
          ? Number(r.lot_id ?? 0) === Number(item.lot_id)
          : true;
      return sameLot && sameLotId;
    }) ??
    null;

  if (activeMatched) {
    const data = {
      no: adjustmentNo,
      department_id: departmentId ?? null,
      department_name: departmentName ?? null,
      deleted_at: new Date(),
      active: false,
      updated_at: new Date(),
    } as any;

    if (target === "bor") {
      await tx.bor_stock.update({
        where: { id: activeMatched.id },
        data,
      });
    } else {
      await tx.ser_stock.update({
        where: { id: activeMatched.id },
        data,
      });
    }

    return {
      ...activeMatched,
      no: adjustmentNo,
      department_id: departmentId ?? null,
      department_name: departmentName ?? null,
    };
  }

  const deletedWhere = {
    product_id: item.product_id ?? undefined,
    location_name: locationName,
    lot_name: item.lot_serial ?? undefined,
    no: adjustmentNo,
  } as any;

  const deletedRow =
    target === "bor"
      ? await tx.bor_stock.findFirst({
          where: {
            ...deletedWhere,
            deleted_at: { not: null },
          },
          orderBy: { id: "desc" },
        })
      : await tx.ser_stock.findFirst({
          where: {
            ...deletedWhere,
            deleted_at: { not: null },
          },
          orderBy: { id: "desc" },
        });

  if (deletedRow) {
    return deletedRow;
  }

  throw badRequest(
    `ไม่พบ stock เดิมสำหรับลบออก product=${item.product_id ?? "null"} lot=${item.lot_serial ?? "-"} location=${locationName}`,
  );
}

async function decreaseOldStockQty(
  tx: Prisma.TransactionClient,
  target: AutoStockTarget,
  item: AdjustmentBorLine,
  adjustmentNo: string,
  departmentId?: string | null,
  departmentName?: string | null,
) {
  const locationName = getOldBusinessLocationName(item);
  const qty = Math.max(0, Math.floor(Number(item.qty ?? 0)));

  if (qty <= 0) {
    throw badRequest(`qty สำหรับลด stock ต้องมากกว่า 0`);
  }

  if (!locationName) {
    throw badRequest(
      `ไม่พบ business location สำหรับลด stock เดิม product=${item.product_id ?? "null"} lot=${item.lot_serial ?? "-"}`,
    );
  }

  const activeWhere = {
    product_id: item.product_id ?? undefined,
    location_name: locationName,
    deleted_at: null,
    active: true,
  } as any;

  const rows =
    target === "bor"
      ? await tx.bor_stock.findMany({
          where: activeWhere,
          orderBy: { id: "desc" },
        })
      : await tx.ser_stock.findMany({
          where: activeWhere,
          orderBy: { id: "desc" },
        });

  const matched =
    rows.find((r: any) => {
      const sameLot =
        String(r.lot_name ?? "").trim() ===
        String(item.lot_serial ?? "").trim();

      const sameLotId =
        item.lot_id != null
          ? Number(r.lot_id ?? 0) === Number(item.lot_id)
          : true;

      const sameExp = sameAdjustmentExpDate(r.expiration_date, item.exp);

      return sameLot && sameLotId && sameExp;
    }) ??
    rows.find((r: any) => {
      const sameLot =
        String(r.lot_name ?? "").trim() ===
        String(item.lot_serial ?? "").trim();

      const sameLotId =
        item.lot_id != null
          ? Number(r.lot_id ?? 0) === Number(item.lot_id)
          : true;

      return sameLot && sameLotId;
    }) ??
    null;

  if (!matched) {
    throw badRequest(
      `ไม่พบ stock เดิมสำหรับลดจำนวน product=${item.product_id ?? "null"} lot=${item.lot_serial ?? "-"} location=${locationName}`,
    );
  }

  const currentQty = Number(matched.quantity ?? 0);

  if (currentQty < qty) {
    throw badRequest(
      `stock เดิมไม่พอสำหรับลดจำนวน product=${item.product_id ?? "null"} lot=${item.lot_serial ?? "-"} location=${locationName} need=${qty} have=${currentQty}`,
    );
  }

  const remain = currentQty - qty;

  const updateData = {
    no: adjustmentNo,
    quantity: new Prisma.Decimal(remain),
    count: Math.max(0, Math.floor(remain)),
    department_id: departmentId ?? matched.department_id ?? null,
    department_name: departmentName ?? matched.department_name ?? null,
    updated_at: new Date(),
  } as any;

  if (target === "bor") {
    return tx.bor_stock.update({
      where: { id: matched.id },
      data: updateData,
    });
  }

  return tx.ser_stock.update({
    where: { id: matched.id },
    data: updateData,
  });
}

async function increaseNewLotStockFromOldLocation(
  tx: Prisma.TransactionClient,
  target: AutoStockTarget,
  oldRow: any,
  newItem: AdjustmentBorLine,
  args: {
    no: string;
    department_id?: string | null;
    department?: string | null;
  },
) {
  const qty = Math.max(0, Math.floor(Number(newItem.qty ?? 0)));

  if (qty <= 0) {
    throw badRequest(`qty สำหรับเพิ่ม lot ใหม่ต้องมากกว่า 0`);
  }

  const existingWhere = {
    product_id: oldRow.product_id,
    location_name: oldRow.location_name,
    lot_name: newItem.lot_serial ?? undefined,
    deleted_at: null,
    active: true,
  } as any;

  const existing =
    target === "bor"
      ? await tx.bor_stock.findFirst({ where: existingWhere })
      : await tx.ser_stock.findFirst({ where: existingWhere });

  if (existing) {
    const updateData = {
      no: args.no,
      lot_id: newItem.lot_id ?? existing.lot_id ?? null,
      lot_name: newItem.lot_serial ?? existing.lot_name ?? null,
      expiration_date: newItem.exp ?? existing.expiration_date ?? null,
      department_id: args.department_id ?? existing.department_id ?? null,
      department_name: args.department ?? existing.department_name ?? null,
      quantity: { increment: new Prisma.Decimal(qty) },
      count: { increment: qty },
      active: true,
      deleted_at: null,
      updated_at: new Date(),
    } as any;

    if (target === "bor") {
      return tx.bor_stock.update({
        where: { id: existing.id },
        data: updateData,
      });
    }

    return tx.ser_stock.update({
      where: { id: existing.id },
      data: updateData,
    });
  }

  const createData = {
    snapshot_date: new Date(),
    no: args.no,

    product_id: oldRow.product_id,
    product_code: oldRow.product_code ?? newItem.code ?? null,
    product_name: oldRow.product_name ?? newItem.name ?? null,
    unit: oldRow.unit ?? newItem.unit ?? null,

    location_id: oldRow.location_id ?? null,
    location_name: oldRow.location_name ?? null,

    location_owner: oldRow.location_owner ?? null,
    location_owner_display: oldRow.location_owner_display ?? null,
    location_dest_owner: oldRow.location_dest_owner ?? null,
    location_dest_owner_dispalay: oldRow.location_dest_owner_dispalay ?? null,

    lot_id: newItem.lot_id ?? null,
    lot_name: newItem.lot_serial ?? null,
    expiration_date: newItem.exp ?? oldRow.expiration_date ?? null,

    department_id: args.department_id ?? oldRow.department_id ?? null,
    department_name: args.department ?? oldRow.department_name ?? null,

    product_last_modified_date: oldRow.product_last_modified_date ?? null,
    source: oldRow.source ?? "wms",
    quantity: new Prisma.Decimal(qty),
    count: qty,
    active: true,
    deleted_at: null,
    user_pick: null,
  } as any;

  if (target === "bor") {
    return tx.bor_stock.create({ data: createData });
  }

  return tx.ser_stock.create({ data: createData });
}

async function createNewStockFromOld(
  tx: Prisma.TransactionClient,
  target: AutoStockTarget,
  oldRow: any,
  newItem: AdjustmentBorLine,
  args: {
    no: string;
    department_id?: string | null;
    department?: string | null;
  },
) {
  const existingWhere = {
    product_id: oldRow.product_id,
    location_name: oldRow.location_name,
    lot_name: newItem.lot_serial ?? undefined,
    deleted_at: null,
    active: true,
  } as any;

  const existing =
    target === "bor"
      ? await tx.bor_stock.findFirst({ where: existingWhere })
      : await tx.ser_stock.findFirst({ where: existingWhere });

  const newQty = Math.max(0, Number(newItem.qty ?? 0));
  const newCount = Math.max(0, Math.floor(Number(newItem.qty ?? 0)));

  if (existing) {
    if (target === "bor") {
      return tx.bor_stock.update({
        where: { id: existing.id },
        data: {
          no: args.no,
          lot_id: newItem.lot_id ?? existing.lot_id ?? null,
          lot_name: newItem.lot_serial ?? existing.lot_name ?? null,
          expiration_date: newItem.exp ?? existing.expiration_date ?? null,
          department_id: args.department_id ?? existing.department_id ?? null,
          department_name: args.department ?? existing.department_name ?? null,
          quantity: new Prisma.Decimal(newQty),
          count: newCount,
          active: true,
          deleted_at: null,
          updated_at: new Date(),
        } as any,
      });
    }

    return tx.ser_stock.update({
      where: { id: existing.id },
      data: {
        no: args.no,
        lot_id: newItem.lot_id ?? existing.lot_id ?? null,
        lot_name: newItem.lot_serial ?? existing.lot_name ?? null,
        expiration_date: newItem.exp ?? existing.expiration_date ?? null,
        department_id: args.department_id ?? existing.department_id ?? null,
        department_name: args.department ?? existing.department_name ?? null,
        quantity: new Prisma.Decimal(newQty),
        count: newCount,
        active: true,
        deleted_at: null,
        updated_at: new Date(),
      } as any,
    });
  }

  const data = {
    snapshot_date: new Date(),
    no: args.no,

    product_id: oldRow.product_id,
    product_code: oldRow.product_code ?? newItem.code ?? null,
    product_name: oldRow.product_name ?? newItem.name ?? null,
    unit: oldRow.unit ?? newItem.unit ?? null,

    location_id: oldRow.location_id ?? null,
    location_name: oldRow.location_name ?? null,

    location_owner: oldRow.location_owner ?? null,
    location_owner_display: oldRow.location_owner_display ?? null,
    location_dest_owner: oldRow.location_dest_owner ?? null,
    location_dest_owner_dispalay: oldRow.location_dest_owner_dispalay ?? null,

    lot_id: newItem.lot_id ?? oldRow.lot_id ?? null,
    lot_name: newItem.lot_serial ?? null,
    expiration_date: newItem.exp ?? oldRow.expiration_date ?? null,

    department_id: args.department_id ?? oldRow.department_id ?? null,
    department_name: args.department ?? oldRow.department_name ?? null,

    product_last_modified_date: oldRow.product_last_modified_date ?? null,
    source: oldRow.source ?? "wms",
    quantity: new Prisma.Decimal(newQty),
    count: newCount,
    active: true,
    deleted_at: null,
    user_pick: null,
  } as any;

  if (target === "bor") {
    return tx.bor_stock.create({ data });
  }

  return tx.ser_stock.create({ data });
}

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
    "in_process",
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
      in_process: search.toLowerCase() === "true",
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

const lockKeyOf = (
  product_id: number | null | undefined,
  lot_name: string | null | undefined,
) => `p:${product_id ?? "null"}|lot_name:${(lot_name ?? "").trim()}`;

async function buildLockNoMapFromItems(
  items: Array<{
    product_id?: number | null;
    lot_name?: string | null;
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
      expiration_date: true,
    } as any,
    orderBy: [{ product_id: "asc" }, { location_name: "asc" }],
  });

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
    if (prev) prev.qty += qty;
    else byLoc.set(locId, { location_id: locId, location_name: locName, qty });
  }

  for (const [k, byLoc] of temp.entries()) {
    const arr: LockLocRow[] = Array.from(byLoc.values())
      .filter((x) => x.qty !== 0)
      .sort((a, b) => b.qty - a.qty);

    map.set(k, arr);
  }

  for (const k of uniqueKeys) {
    if (!map.has(k)) map.set(k, []);
  }

  return map;
}

function resolveLockLocationsFromMap(
  map: Map<LockKey, LockLocRow[]>,
  product_id: number | null | undefined,
  lot_name: string | null | undefined,
) {
  const k = lockKeyOf(product_id ?? null, lot_name ?? null);
  return map.get(k) ?? [];
}

function parseQtyInt(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return NaN;
  // qty ใน schema เป็น Int -> บังคับเป็นจำนวนเต็ม
  return Math.round(n);
}

function parseAdjustmentSearchColumns(raw: unknown) {
  if (typeof raw !== "string") return [];

  const allowed = new Set([
    "date",
    "no",
    "origin",
    "reference",
    "picking_no",
    "department",
    "type",
    "status",
    "level",
    "location",
  ]);

  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => allowed.has(s));
}

function splitSearchTokens(search: string): string[] {
  const raw = String(search ?? "").trim();
  if (!raw) return [];

  const baseTokens = raw
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const expanded = new Set<string>();

  for (const token of baseTokens) {
    expanded.add(token);

    const stripped = token.replace(/[()]/g, "").trim();
    if (stripped) expanded.add(stripped);

    const alnum = token.replace(/[^a-zA-Z0-9+-]/g, "").trim();
    if (alnum) expanded.add(alnum);

    const numeric = token.replace(/[^0-9]/g, "").trim();
    if (numeric) expanded.add(numeric);
  }

  return Array.from(expanded).filter(Boolean);
}

function buildContainsAllTokens(field: string, tokens: string[]) {
  if (tokens.length === 0) return null;

  return {
    AND: tokens.map((token) => ({
      [field]: {
        contains: token,
        mode: "insensitive",
      },
    })),
  };
}

function buildLocationSomeAllTokens(tokens: string[]) {
  if (tokens.length === 0) return null;

  return {
    AND: tokens.map((token) => ({
      items: {
        some: {
          deleted_at: null,
          location: {
            contains: token,
            mode: "insensitive",
          },
        },
      },
    })),
  };
}

function buildAdjustmentSearchWhere(search: string, columns: string[]) {
  const baseWhere: any = { deleted_at: null };

  if (!search) return baseWhere;

  const rawSearch = String(search ?? "").trim();
  const tokens = splitSearchTokens(rawSearch);

  const orConditions: any[] = [];

  if (columns.includes("date")) {
    const maybeDate = new Date(rawSearch);
    if (!Number.isNaN(maybeDate.getTime())) {
      const yyyy = maybeDate.getUTCFullYear();
      const mm = String(maybeDate.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(maybeDate.getUTCDate()).padStart(2, "0");

      orConditions.push({
        date: {
          gte: new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`),
          lt: new Date(`${yyyy}-${mm}-${dd}T23:59:59.999Z`),
        },
      });
    }
  }

  if (columns.includes("no")) {
    orConditions.push({
      no: { contains: rawSearch, mode: "insensitive" },
    });

    const noTokenCond = buildContainsAllTokens("no", tokens);
    if (noTokenCond) orConditions.push(noTokenCond);
  }

  if (columns.includes("reference")) {
    orConditions.push({
      origin: { contains: rawSearch, mode: "insensitive" },
    });

    const refTokenCond = buildContainsAllTokens("origin", tokens);
    if (refTokenCond) orConditions.push(refTokenCond);
  }

  if (columns.includes("type")) {
    orConditions.push({
      type: { contains: rawSearch, mode: "insensitive" },
    });

    const typeTokenCond = buildContainsAllTokens("type", tokens);
    if (typeTokenCond) orConditions.push(typeTokenCond);
  }

  if (columns.includes("status")) {
    orConditions.push({
      status: { contains: rawSearch, mode: "insensitive" },
    });

    const statusTokenCond = buildContainsAllTokens("status", tokens);
    if (statusTokenCond) orConditions.push(statusTokenCond);
  }

  if (columns.includes("location")) {
    orConditions.push({
      items: {
        some: {
          deleted_at: null,
          location: { contains: rawSearch, mode: "insensitive" },
        },
      },
    });

    const locTokenCond = buildLocationSomeAllTokens(tokens);
    if (locTokenCond) orConditions.push(locTokenCond);
  }

  if (orConditions.length === 0) {
    return {
      AND: [baseWhere, { id: -1 }],
    };
  }

  return {
    AND: [baseWhere, { OR: orConditions }],
  };
}

/**
 * POST /api/Adjust/odoo
 * รับข้อมูลปรับยอดจาก Odoo และเก็บ log
 */

function inferAdjustmentType(
  no?: string | null,
  origin?: string | null,
): string {
  const s = String(no || origin || "").toUpperCase();

  if (s.includes("BOR")) return "BOR";
  if (s.includes("BOA")) return "BOA";
  if (s.includes("ADJ")) return "ADJ";
  return "ADJ";
}

function buildAdjustmentMergeKey(input: {
  product_id: number | null;
  lot_id: number | null;
  exp: Date | null;
  location_owner?: string | null;
  location_dest?: string | null;
}) {
  return [
    `p:${input.product_id ?? "null"}`,
    `lot:${input.lot_id ?? "null"}`,
    `exp:${toAdjustmentDateOnlyKey(input.exp) ?? "null"}`,
    `locOwner:${input.location_owner ?? ""}`,
    `locDest:${input.location_dest ?? ""}`,
  ].join("|");
}

async function findBorStockRowForAdjustment(
  tx: Prisma.TransactionClient,
  input: {
    product_id: number;
    lot_id: number | null;
    exp: Date | null;
    location_owner: string | null;
    location_dest: string | null;
  },
) {
  const candidateNames = [
    normalizeOwnerOrLocationText(input.location_owner),
    normalizeOwnerOrLocationText(input.location_dest),
  ].filter((x): x is string => !!x);

  for (const locationName of candidateNames) {
    const rows = await tx.bor_stock.findMany({
      where: {
        product_id: input.product_id,
        lot_id: input.lot_id ?? null,
        location_name: locationName,
      } as any,
      select: {
        id: true,
        quantity: true,
        expiration_date: true,
        location_name: true,
        lot_id: true,
      },
      orderBy: { id: "desc" },
    });

    const matched =
      rows.find((r) => sameAdjustmentExpDate(r.expiration_date, input.exp)) ??
      rows[0] ??
      null;

    if (matched) return matched;
  }

  return null;
}

async function applyBoaAdjustmentToBorStock(
  tx: Prisma.TransactionClient,
  args: {
    no: string;
    department_id?: string | null;
    department?: string | null;
    items: AdjustmentBorLine[];
  },
) {
  const now = new Date();

  for (const item of args.items) {
    if (!item.product_id) continue;

    const qty = Math.max(0, Math.floor(Number(item.qty ?? 0)));
    if (qty <= 0) continue;

    const locationOwner = normalizeOwnerOrLocationText(item.location_owner);
    const locationDest = normalizeOwnerOrLocationText(item.location_dest);

    const isInventoryAdjustment =
      String(locationDest ?? "")
        .trim()
        .toLowerCase() === "inventory adjustment".toLowerCase();

    const existing = await findBorStockRowForAdjustment(tx, {
      product_id: item.product_id,
      lot_id: item.lot_id ?? null,
      exp: item.exp ?? null,
      location_owner: locationOwner,
      location_dest: locationDest,
    });

    if (isInventoryAdjustment) {
      if (!existing) {
        throw badRequest(
          `ไม่พบ bor_stock สำหรับตัดออก (product_id=${item.product_id}, lot_id=${item.lot_id ?? "null"}, location_owner=${locationOwner ?? "null"}, location_dest=${locationDest ?? "null"})`,
        );
      }

      const current = Number(existing.quantity ?? 0);
      if (current < qty) {
        throw badRequest(
          `bor_stock ไม่พอสำหรับ BOA (product_id=${item.product_id}, lot_id=${item.lot_id ?? "null"}, need=${qty}, have=${current}, location=${existing.location_name ?? "-"})`,
        );
      }

      const remain = current - qty;

      if (remain <= 0) {
        await tx.bor_stock.delete({
          where: { id: existing.id },
        });
      } else {
        await tx.bor_stock.update({
          where: { id: existing.id },
          data: {
            no: args.no,
            quantity: new Prisma.Decimal(remain),
            updated_at: now,
            department_id: args.department_id ?? null,
            department_name: args.department ?? null,
            location_owner: item.location_owner ?? null,
            location_owner_display: item.location_owner_display ?? null,
            location_dest_owner: item.location_dest_owner ?? null,
            location_dest_owner_dispalay:
              item.location_dest_owner_display ?? null,
          } as any,
        });
      }

      continue;
    }

    // ปลายทางไม่ใช่ Inventory adjustment => บวกเข้า stock
    const targetLocationName = locationDest;
    if (!targetLocationName) {
      throw badRequest(
        `BOA แบบบวก stock ต้องมี location_dest ที่เป็น location_name ปลายทาง`,
      );
    }

    const rows = await tx.bor_stock.findMany({
      where: {
        product_id: item.product_id,
        lot_id: item.lot_id ?? null,
        location_name: targetLocationName,
      } as any,
      select: {
        id: true,
        quantity: true,
        expiration_date: true,
      },
      orderBy: { id: "desc" },
    });

    const row =
      rows.find((r) => sameAdjustmentExpDate(r.expiration_date, item.exp)) ??
      null;

    if (row?.id) {
      await tx.bor_stock.update({
        where: { id: row.id },
        data: {
          no: args.no,
          quantity: { increment: new Prisma.Decimal(qty) },
          updated_at: now,
          expiration_date: item.exp ?? null,
          department_id: args.department_id ?? null,
          department_name: args.department ?? null,
          location_owner: item.location_owner ?? null,
          location_owner_display: item.location_owner_display ?? null,
          location_dest_owner: item.location_dest_owner ?? null,
          location_dest_owner_dispalay:
            item.location_dest_owner_display ?? null,
        } as any,
      });
    } else {
      await tx.bor_stock.create({
        data: {
          snapshot_date: now,
          no: args.no,
          product_id: item.product_id,
          product_code: item.code ?? null,
          product_name: item.name ?? null,
          unit: item.unit ?? null,

          location_id: item.location_dest_id ?? null,
          location_name: targetLocationName,

          location_owner: item.location_owner ?? null,
          location_owner_display: item.location_owner_display ?? null,
          location_dest_owner: item.location_dest_owner ?? null,
          location_dest_owner_dispalay:
            item.location_dest_owner_display ?? null,

          lot_id: item.lot_id ?? null,
          lot_name: item.lot_serial ?? null,
          expiration_date: item.exp ?? null,

          department_id: args.department_id ?? null,
          department_name: args.department ?? null,

          product_last_modified_date: null,
          source: "wms",
          quantity: new Prisma.Decimal(qty),
          active: true,
        } as any,
      });
    }
  }
}

async function softDeleteOldBorStockOnly(
  tx: Prisma.TransactionClient,
  item: AdjustmentBorLine,
  adjustmentNo: string,
  departmentId?: string | null,
  departmentName?: string | null,
) {
  const locationName = getOldBusinessLocationName(item);

  if (!locationName) {
    throw badRequest(
      `ไม่พบ business location สำหรับลบ bor_stock เดิม product=${item.product_id ?? "null"} lot=${item.lot_serial ?? "-"}`,
    );
  }

  const activeRows = await tx.bor_stock.findMany({
    where: {
      product_id: item.product_id ?? undefined,
      location_name: locationName,
      deleted_at: null,
      active: true,
    } as any,
    orderBy: { id: "desc" },
  });

  const activeMatched =
    activeRows.find((r: any) => {
      const sameLot =
        String(r.lot_name ?? "").trim() ===
        String(item.lot_serial ?? "").trim();

      const sameLotId =
        item.lot_id != null
          ? Number(r.lot_id ?? 0) === Number(item.lot_id)
          : true;

      const sameExp = sameAdjustmentExpDate(r.expiration_date, item.exp);
      return sameLot && sameLotId && sameExp;
    }) ??
    activeRows.find((r: any) => {
      const sameLot =
        String(r.lot_name ?? "").trim() ===
        String(item.lot_serial ?? "").trim();

      const sameLotId =
        item.lot_id != null
          ? Number(r.lot_id ?? 0) === Number(item.lot_id)
          : true;

      return sameLot && sameLotId;
    }) ??
    null;

  if (activeMatched) {
    await tx.bor_stock.update({
      where: { id: activeMatched.id },
      data: {
        no: adjustmentNo,
        department_id: departmentId ?? null,
        department_name: departmentName ?? null,
        deleted_at: new Date(),
        active: false,
        updated_at: new Date(),
      } as any,
    });

    return {
      ...activeMatched,
      no: adjustmentNo,
      department_id: departmentId ?? null,
      department_name: departmentName ?? null,
    };
  }

  const deletedRow = await tx.bor_stock.findFirst({
    where: {
      product_id: item.product_id ?? undefined,
      location_name: locationName,
      lot_name: item.lot_serial ?? undefined,
      no: adjustmentNo,
      deleted_at: { not: null },
    } as any,
    orderBy: { id: "desc" },
  });

  if (deletedRow) {
    return deletedRow;
  }

  throw badRequest(
    `ไม่พบ bor_stock เดิมสำหรับลบออก product=${item.product_id ?? "null"} lot=${item.lot_serial ?? "-"} location=${locationName}`,
  );
}

function normalizeDescription(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

async function applySystemGeneratedLotReplacementBorOnly(
  tx: Prisma.TransactionClient,
  args: {
    no: string;
    department_id?: string | null;
    department?: string | null;
    items: AdjustmentBorLine[];
  },
) {
  const stockTarget: AutoStockTarget = "bor";

  const oldItems = args.items.filter((it) => !isNewLotSerial(it.lot_serial));
  const newItems = args.items.filter((it) => isNewLotSerial(it.lot_serial));

  if (oldItems.length === 0 && newItems.length === 0) return;

  if (oldItems.length === 0) {
    throw badRequest("auto adjust นี้ไม่มี old lot สำหรับลดจำนวน");
  }

  if (newItems.length === 0) {
    throw badRequest("auto adjust นี้ไม่มี new lot (#) สำหรับเพิ่มจำนวน");
  }

  const decreasedMap = new Map<string, any[]>();

  for (const oldItem of oldItems) {
    const oldRowAfterDecrease = await decreaseOldStockQty(
      tx,
      stockTarget,
      oldItem,
      args.no,
      args.department_id,
      args.department,
    );

    const key = buildAutoReplaceOldPairKey(oldItem);
    const arr = decreasedMap.get(key) ?? [];
    arr.push(oldRowAfterDecrease);
    decreasedMap.set(key, arr);
  }

  for (const newItem of newItems) {
    const key = buildAutoReplaceNewPairKey(newItem);
    const arr = decreasedMap.get(key) ?? [];

    if (arr.length === 0) {
      throw badRequest(
        `ไม่พบ old lot ที่ match กับ new lot ${newItem.lot_serial ?? "-"} (product_id=${newItem.product_id ?? "null"})`,
      );
    }

    const oldRow = arr.shift();
    decreasedMap.set(key, arr);

    await increaseNewLotStockFromOldLocation(tx, stockTarget, oldRow, newItem, {
      no: args.no,
      department_id: args.department_id,
      department: args.department,
    });
  }
}

function isInventoryAdjustment(v: unknown) {
  return normalizeText(v).toLowerCase() === "inventory adjustment";
}

// Helper socket scan
function emitAdjustmentRealtime(
  no: string,
  event: string,
  payload: any,
  adjustmentId?: number | null,
) {
  try {
    const adjNo = String(no ?? "").trim();

    if (adjNo) io.to(`adjustment:${adjNo}`).emit(event, payload);

    const id = Number(adjustmentId ?? NaN);
    if (Number.isFinite(id) && id > 0) {
      io.to(`adjustment-id:${id}`).emit(event, payload);
    }
  } catch {}
}

function matchAdjustmentBarcodePayload(
  storedPayload: unknown,
  scanned: string,
) {
  const raw = normalizeLot(scanned);
  const stored = String(storedPayload ?? "").trim();

  if (!raw || !stored) return false;

  if (normalizeLot(stored) === raw) return true;

  try {
    const arr = JSON.parse(stored);
    if (Array.isArray(arr)) {
      return arr.some((x) => normalizeLot(x) === raw);
    }
  } catch {}

  return false;
}

async function buildAdjustmentDetail(adjustmentId: number, no: string) {
  const adj = await prisma.adjustment.findFirst({
    where: { id: adjustmentId, deleted_at: null },
    include: {
      items: {
        where: { deleted_at: null },
        orderBy: [{ sequence: "asc" }, { id: "asc" }],
      },
      adjustLocationConfirms: {
        where: { deleted_at: null },
        orderBy: [{ location_name: "asc" }, { id: "asc" }],
      } as any,
    } as any,
  });

  if (!adj) return null;

  const confirms = ((adj as any).adjustLocationConfirms ?? []) as any[];

  const confirmMap = new Map<number, any[]>();
  for (const c of confirms) {
    const arr = confirmMap.get(c.adjustment_item_id) ?? [];
    arr.push(c);
    confirmMap.set(c.adjustment_item_id, arr);
  }

  const items = (adj.items ?? []).map((it: any) => {
    const itemConfirms = confirmMap.get(it.id) ?? [];
    const confirmed_qty = itemConfirms.reduce(
      (sum, c) => sum + Number(c.confirmed_qty ?? 0),
      0,
    );
    const qty = Number(it.qty ?? 0);
    const qty_pick = Number(it.qty_pick ?? 0);

    return {
      ...it,
      qty,
      qty_pick,
      confirmed_qty,
      remaining: Math.max(0, qty - qty_pick),
      completed: qty > 0 ? qty_pick >= qty : false,
      location_confirms: itemConfirms.map((c) => ({
        id: c.id,
        location_id: c.location_id,
        location_name: c.location_name,
        confirmed_qty: c.confirmed_qty,
        user_ref: c.user_ref,
      })),
    };
  });

  return {
    adjustment_no: no,
    id: adj.id,
    no: adj.no,
    status: adj.status,
    type: adj.type,
    department: adj.department,
    department_id: adj.department_id,
    reference: adj.reference,
    origin: adj.origin,
    date: adj.date,
    total_items: items.length,
    completed: items.length > 0 && items.every((x) => x.completed),
    items,
    lines: items,
  };
}

function firstPayloadBarcodeId(barcodes: unknown): number | null {
  if (!Array.isArray(barcodes) || !barcodes.length) return null;

  const first = barcodes.find((x: any) => x?.barcode_id != null);
  if (!first) return null;

  const n = Number((first as any).barcode_id);
  return Number.isFinite(n) ? n : null;
}

function firstPayloadBarcodeText(barcodes: unknown): string | null {
  if (!Array.isArray(barcodes) || !barcodes.length) return null;

  const first = barcodes.find((x: any) => safeString(x?.barcode));
  return first ? safeString((first as any).barcode) : null;
}

async function hydrateAdjustmentItemsBarcodeTextFromBarcodeMaster(
  tx: Prisma.TransactionClient,
  items: AdjustmentBorLine[],
) {
  const productIds = Array.from(
    new Set(
      items
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
      id: true,
      product_id: true,
      barcode: true,
    },
    orderBy: [{ id: "desc" }],
  });

  const barcodeByProductId = new Map<number, { id: number; barcode: string }>();

  for (const row of barcodeRows) {
    const pid = Number(row.product_id);
    const bc = String(row.barcode ?? "").trim();

    if (!Number.isFinite(pid) || !bc) continue;
    if (!barcodeByProductId.has(pid)) {
      barcodeByProductId.set(pid, {
        id: row.id,
        barcode: bc,
      });
    }
  }

  return items.map((item) => {
    const currentText = String(item.barcode_text ?? "").trim();
    if (currentText) return item;

    const master =
      item.product_id != null
        ? barcodeByProductId.get(Number(item.product_id))
        : null;

    if (!master) return item;

    return {
      ...item,
      barcode_id: master.id,
      barcode_text: master.barcode,
      barcode_payload:
        item.barcode_payload ??
        buildAdjustmentBarcodePayload({
          barcode: master.barcode,
          lot_serial: item.lot_serial ?? null,
          exp: item.exp ?? null,
        }),
    };
  });
}

export const receiveOdooAdjustments = asyncHandler(
  async (req: Request, res: Response) => {
    let logId: number | null = null;

    try {
      const requestLog = await prisma.odoo_request_log.create({
        data: {
          endpoint: "/api/Adjust",
          method: "POST",
          request_body: JSON.stringify(req.body),
          ip_address: req.ip || req.socket.remoteAddress || null,
          user_agent: req.headers["user-agent"] || null,
        },
      });

      logId = requestLog.id;

      const adjusts = pickAdjusts(req.body);

      if (!adjusts.length) {
        throw badRequest("ไม่พบข้อมูล adjusts ใน request body");
      }

      const results: Array<{
        no: string | null;
        id: number;
        created: boolean;
        item_count: number;
        type: string | null;
        status: string;
        is_system_generated: boolean;
      }> = [];

      for (const adj of adjusts) {
        const no = safeString(adj?.no);
        const origin = safeString(adj?.origin);
        const inventoryId = safeInt(adj?.inventory_id);
        const rawItems = Array.isArray(adj?.items) ? adj.items : [];
        const isSystemGenerated = adj?.is_system_generated === true;
        const initialStatus = isSystemGenerated ? "completed" : "pending";

        const depSource = resolveAutoDepartmentSource(adj);
        const dep = normalizeAutoDepartments(depSource);
        const headerDescription = normalizeDescription(adj?.description);

        if (!no) {
          throw badRequest("adjustment ต้องมี no");
        }

        if (!rawItems.length) {
          throw badRequest(`Adjustment ${no} ไม่มี items`);
        }

        const headerReference =
          safeString(adj?.reference) ??
          safeString(rawItems[0]?.reference) ??
          null;

        const adjustmentType = inferAdjustmentTypeFromReference(
          no,
          origin,
          headerReference,
        );

        const mergedMap = new Map<string, AdjustmentBorLine>();

        for (let i = 0; i < rawItems.length; i++) {
          const item = rawItems[i];

          const product_id = safeInt(item?.product_id);
          const lot_id = safeInt(item?.lot_id);

          const exp =
            normalizeAdjustmentExp(item?.exp) ??
            normalizeAdjustmentExp(item?.expire_date) ??
            null;

          const qty = safeInt(item?.qty) ?? 0;

          const location = safeString(item?.location);

          const location_owner = normalizeOwnerOrLocationText(
            item?.location_owner,
          );

          const location_dest = safeString(item?.location_dest);

          const payloadBarcodeId = firstPayloadBarcodeId(item?.barcodes);
          const payloadBarcodeText = firstPayloadBarcodeText(item?.barcodes);

          const key = buildAdjustmentMergeKey({
            product_id,
            lot_id,
            exp,
            location_owner,
            location_dest,
          });

          const existed = mergedMap.get(key);

          const payload: AdjustmentBorLine = {
            sequence: safeInt(item?.sequence),
            product_id,
            code: safeString(item?.code),
            name: safeString(item?.name),
            unit: safeString(item?.unit),

            location_id: safeInt(item?.location_id),
            location: location ?? location_owner ?? null,

            lot_id,
            lot_serial: safeString(item?.lot_serial),
            tracking: safeString(item?.tracking),

            qty,
            exp,

            barcode_id: payloadBarcodeId,
            barcode_text: payloadBarcodeText,
            barcode_payload: buildBarcodePayload(item?.barcodes),

            location_owner,
            location_owner_display: stringifyIfNeeded(
              item?.location_owner_display,
            ),

            location_dest_id: safeInt(item?.location_dest_id),
            location_dest,
            location_dest_owner: stringifyIfNeeded(item?.location_dest_owner),
            location_dest_owner_display: stringifyIfNeeded(
              item?.location_dest_owner_display,
            ),
          };

          if (existed) {
            existed.qty += qty;
            existed.code = payload.code ?? existed.code;
            existed.name = payload.name ?? existed.name;
            existed.unit = payload.unit ?? existed.unit;
            existed.lot_serial = payload.lot_serial ?? existed.lot_serial;

            existed.barcode_id = payload.barcode_id ?? existed.barcode_id;
            existed.barcode_text = payload.barcode_text ?? existed.barcode_text;
            existed.barcode_payload =
              payload.barcode_payload ?? existed.barcode_payload;

            existed.location_owner =
              payload.location_owner ?? existed.location_owner;
            existed.location_owner_display =
              payload.location_owner_display ?? existed.location_owner_display;
            existed.location_dest_id =
              payload.location_dest_id ?? existed.location_dest_id;
            existed.location_dest =
              payload.location_dest ?? existed.location_dest;
            existed.location_dest_owner =
              payload.location_dest_owner ?? existed.location_dest_owner;
            existed.location_dest_owner_display =
              payload.location_dest_owner_display ??
              existed.location_dest_owner_display;
          } else {
            mergedMap.set(key, payload);
          }
        }

        const mergedItems = Array.from(mergedMap.values());

        const saved = await prisma.$transaction(async (tx) => {
          const existing = await tx.adjustment.findFirst({
            where: {
              no,
              deleted_at: null,
            },
            select: {
              id: true,
              no: true,
              inventory_id: true,
            },
          });

          let adjustmentId: number;

          if (existing) {
            const updated = await tx.adjustment.update({
              where: { id: existing.id },
              data: {
                inventory_id: inventoryId,
                picking_id: null,
                picking_no: null,
                department_id: dep.department_id,
                department: dep.department || "",
                reference: headerReference,
                origin,
                description: headerDescription,
                level: "post-process",
                type: adjustmentType,
                status: initialStatus,
                is_system_generated: isSystemGenerated,
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
                no,
                inventory_id: inventoryId,
                picking_id: null,
                picking_no: null,
                department_id: dep.department_id,
                department: dep.department || "",
                reference: headerReference,
                origin,
                description: headerDescription,
                level: "post-process",
                type: adjustmentType,
                status: initialStatus,
                is_system_generated: isSystemGenerated,
                date: new Date(),
              },
              select: { id: true },
            });

            adjustmentId = created.id;
          }

          const hydratedItems =
            await hydrateAdjustmentItemsBarcodeTextFromBarcodeMaster(
              tx,
              mergedItems,
            );
          if (hydratedItems.length > 0) {
            await tx.adjustment_item.createMany({
              data: hydratedItems.map((item) => ({
                adjustment_id: adjustmentId,
                sequence: item.sequence,
                product_id: item.product_id,
                code: item.code,
                name: item.name ?? "",
                unit: item.unit ?? "",

                location_id: item.location_id ?? null,
                location: item.location ?? item.location_owner ?? null,

                location_owner: item.location_owner ?? null,
                location_owner_display: item.location_owner_display ?? null,

                location_dest_id: item.location_dest_id ?? null,
                location_dest: item.location_dest ?? null,

                location_dest_owner: item.location_dest_owner ?? null,
                location_dest_owner_display:
                  item.location_dest_owner_display ?? null,

                tracking: item.tracking ?? null,
                lot_id: item.lot_id ?? null,
                lot_serial: item.lot_serial ?? null,
                qty: item.qty,
                exp: item.exp ?? null,

                barcode_id: item.barcode_id ?? null,
                barcode_text: item.barcode_text ?? null,
                barcode_payload:
                  item.barcode_payload ??
                  (item.barcode_text
                    ? buildAdjustmentBarcodePayload({
                        barcode: item.barcode_text,
                        lot_serial: item.lot_serial ?? null,
                        exp: item.exp ?? null,
                      })
                    : null),

                qty_pick: 0,
              })),
            });
          }

          if (isSystemGenerated) {
            await applySystemGeneratedLotReplacementBorOnly(tx, {
              no,
              department_id: dep.department_id,
              department: dep.department || "",
              items: hydratedItems,
            });
          } else if (adjustmentType === "BOA") {
            await applyBoaAdjustmentToBorStock(tx, {
              no,
              department_id: dep.department_id,
              department: dep.department || "",
              items: hydratedItems,
            });
          }

          const full = await tx.adjustment.findUnique({
            where: { id: adjustmentId },
            include: {
              items: {
                where: { deleted_at: null },
                orderBy: { sequence: "asc" },
              },
            },
          });

          return full;
        });

        results.push({
          no: saved?.no ?? no,
          id: saved?.id ?? 0,
          created: true,
          item_count: saved?.items?.length ?? mergedItems.length,
          type: saved?.type ?? adjustmentType,
          status: saved?.status ?? initialStatus,
          is_system_generated: isSystemGenerated,
        });
      }

      const responseBody = {
        success: true,
        message: "รับข้อมูลปรับยอดจาก Odoo สำเร็จ",
        total_received: adjusts.length,
        total_created: results.length,
        total_skipped: 0,
        results,
      };

      if (logId) {
        await prisma.odoo_request_log.update({
          where: { id: logId },
          data: {
            response_status: 200,
            response_body: JSON.stringify(responseBody),
            error_message: null,
          },
        });
      }

      return res.json(responseBody);
    } catch (err) {
      if (logId) {
        await prisma.odoo_request_log.update({
          where: { id: logId },
          data: {
            response_status: 500,
            response_body: JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
            error_message: err instanceof Error ? err.message : String(err),
          },
        });
      }

      throw err;
    }
  },
);

function computeLocationDisplay(locations: (string | null | undefined)[]) {
  const uniq = Array.from(new Set(locations.filter(Boolean))) as string[];
  if (uniq.length === 0) return null;
  return uniq[0];
}

async function buildDepartmentShortNameMapFromAdjustments(
  adjustments: Array<{ department_id?: any }>,
): Promise<Map<number, string>> {
  const ids = Array.from(
    new Set(
      adjustments
        .map((a) => {
          const n = Number(a?.department_id);
          return Number.isFinite(n) ? n : null;
        })
        .filter((x): x is number => x != null),
    ),
  );

  const map = new Map<number, string>();
  if (!ids.length) return map;

  const rows = await prisma.department.findMany({
    where: {
      deleted_at: null,
      odoo_id: { in: ids },
    },
    select: {
      odoo_id: true,
      short_name: true,
    },
  });

  for (const r of rows) {
    const id = Number(r.odoo_id);
    const short = String(r.short_name ?? "").trim();
    if (Number.isFinite(id) && short) {
      map.set(id, short);
    }
  }

  return map;
}

function hasSVInNo(no: unknown): boolean {
  return String(no ?? "")
    .toUpperCase()
    .includes("SV");
}

function resolveReportTypeFromNo(
  no: unknown,
  fallback: string | null | undefined,
): string {
  if (hasSVInNo(no)) return "SV";
  return fallback ?? "";
}

const parseDepartmentNames = (value: unknown): string[] => {
  if (typeof value !== "string") return [];

  return value
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
};

const buildCombinedAdjustmentSearchWhere = (
  search: string,
  selectedAdjustmentColumns: string[],
  selectedOutboundColumns: string[],
) => {
  const terms = search
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  const searchTerms = terms.length > 0 ? terms : [search];

  const adjustmentOr: any[] = [];
  const outboundOr: any[] = [];

  for (const term of searchTerms) {
    adjustmentOr.push(
      buildAdjustmentSearchWhere(term, selectedAdjustmentColumns),
    );

    outboundOr.push(
      buildSpecialOutboundSearchWhere(term, selectedOutboundColumns),
    );
  }

  return {
    adjustmentWhere:
      adjustmentOr.length > 0
        ? {
            OR: adjustmentOr,
          }
        : {},

    outboundWhere:
      outboundOr.length > 0
        ? {
            OR: outboundOr,
          }
        : {},
  };
};

// ============================================================
// Helpers: Adjustment location attach
// ============================================================

const toDateKey = (value: any) => {
  if (!value) return "NOEXP";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "NOEXP";
  return d.toISOString().slice(0, 10);
};

const buildAdjustLocationKey = (x: {
  product_id?: number | null;
  lot_id?: number | null;
  expiration_date?: Date | string | null;
}) => {
  return [
    x.product_id ?? "NULL",
    x.lot_id ?? "NULL",
    toDateKey(x.expiration_date),
  ].join("|");
};

const buildProductLotKey = (productId?: number | null, lotId?: number | null) =>
  `${productId ?? "NULL"}|${lotId ?? "NULL"}`;

const getAdjustmentItemsFromRow = (row: any) => {
  if (Array.isArray(row?.adjustment_items)) return row.adjustment_items;
  if (Array.isArray(row?.items)) return row.items;
  return [];
};

const attachAdjustmentLocations = async <T extends any>(rowsInput: T[]) => {
  const rows = Array.isArray(rowsInput) ? rowsInput : [];

  const sortLocationRowsAsc = <R extends any>(list: R[]) => {
    return [...(list || [])].sort((a: any, b: any) =>
      String(a.location_name ?? a.full_name ?? "").localeCompare(
        String(b.location_name ?? b.full_name ?? ""),
        "en",
        {
          sensitivity: "base",
          numeric: true,
        },
      ),
    );
  };

  const allItems = rows.flatMap((row: any) =>
    getAdjustmentItemsFromRow(row).map((item: any) => ({
      adjustment_id: row.id,
      ...item,
    })),
  );

  if (allItems.length === 0) return rows;

  const productIds = Array.from(
    new Set(
      allItems
        .map((item: any) => Number(item.product_id))
        .filter((id) => Number.isFinite(id) && id > 0),
    ),
  );

  const wmsRows =
    productIds.length > 0
      ? await prisma.wms_mdt_goods.findMany({
          where: {
            product_id: {
              in: productIds,
            },
          },
          select: {
            product_id: true,
            lot_id: true,
            expiration_date: true,
            zone_type: true,
          },
          orderBy: [{ id: "desc" }],
        })
      : [];

  const wmsExpMap = new Map<string, Date | null>();
  const wmsZoneMap = new Map<string, string | null>();
  const wmsZoneByProductMap = new Map<number, string | null>();

  for (const row of wmsRows) {
    const productId = Number(row.product_id);
    const productLotKey = buildProductLotKey(row.product_id, row.lot_id);

    wmsExpMap.set(productLotKey, row.expiration_date ?? null);
    wmsZoneMap.set(productLotKey, row.zone_type ?? null);

    if (Number.isFinite(productId) && !wmsZoneByProductMap.has(productId)) {
      wmsZoneByProductMap.set(productId, row.zone_type ?? null);
    }
  }

  const itemKeyMap = new Map<number, string>();

  for (const item of allItems) {
    const itemId = Number(item.id ?? 0);
    if (!itemId) continue;

    const productLotKey = buildProductLotKey(item.product_id, item.lot_id);

    const expValue =
      item.expiration_date ??
      item.exp ??
      item.expired_date ??
      item.expiry_date ??
      (item.product_id != null && item.lot_id != null
        ? (wmsExpMap.get(productLotKey) ?? null)
        : null);

    const key = buildAdjustLocationKey({
      product_id: item.product_id,
      lot_id: item.lot_id,
      expiration_date: expValue,
    });

    itemKeyMap.set(itemId, key);
  }

  const stockWherePairs = Array.from(itemKeyMap.values()).map((key) => {
    const [productId, lotId, expKey] = key.split("|");

    return {
      product_id: Number(productId),
      lot_id: lotId === "NULL" ? null : Number(lotId),
      expKey,
    };
  });

  const stockRows =
    stockWherePairs.length > 0
      ? await prisma.stock.findMany({
          where: {
            quantity: {
              gt: 0,
            },
            OR: stockWherePairs.map((x) => ({
              product_id: x.product_id,
              ...(x.lot_id != null ? { lot_id: x.lot_id } : {}),
            })),
          },
          select: {
            product_id: true,
            lot_id: true,
            expiration_date: true,
            location_id: true,
            location_name: true,
            quantity: true,
          },
          orderBy: [
            { location_name: "asc" },
            { product_id: "asc" },
            { lot_id: "asc" },
          ],
        })
      : [];

  const stockMap = new Map<
    string,
    Array<{
      location_id: number | null;
      location_name: string;
      qty: number;
    }>
  >();

  for (const stock of stockRows) {
    const key = buildAdjustLocationKey({
      product_id: stock.product_id,
      lot_id: stock.lot_id,
      expiration_date: stock.expiration_date,
    });

    const locationName = String(stock.location_name ?? "").trim();
    if (!locationName) continue;

    if (!stockMap.has(key)) stockMap.set(key, []);

    const list = stockMap.get(key)!;
    const found = list.find((x) => x.location_name === locationName);

    if (found) {
      found.qty += Number(stock.quantity ?? 0);
    } else {
      list.push({
        location_id: stock.location_id ?? null,
        location_name: locationName,
        qty: Number(stock.quantity ?? 0),
      });
    }
  }

  for (const [key, list] of stockMap.entries()) {
    stockMap.set(key, sortLocationRowsAsc(list));
  }

  const adjustmentIds = rows
    .map((row: any) => Number(row.id ?? 0))
    .filter((id) => id > 0);

  const confirmRows =
    adjustmentIds.length > 0
      ? await prisma.adjust_location_confirm.findMany({
          where: {
            adjustment_id: {
              in: adjustmentIds,
            },
            deleted_at: null,
          },
          select: {
            adjustment_id: true,
            adjustment_item_id: true,
            location_id: true,
            location_name: true,
            confirmed_qty: true,
            user_ref: true,
            created_at: true,
            updated_at: true,
          },
          orderBy: [{ location_name: "asc" }, { id: "asc" }],
        })
      : [];

  const confirmMap = new Map<
    number,
    Array<{
      location_id: number | null;
      location_name: string;
      confirmed_qty: number;
      user_ref: string | null;
      created_at: Date | null;
      updated_at: Date | null;
    }>
  >();

  for (const row of confirmRows) {
    const itemId = Number(row.adjustment_item_id ?? 0);
    if (!itemId) continue;

    if (!confirmMap.has(itemId)) confirmMap.set(itemId, []);

    confirmMap.get(itemId)!.push({
      location_id: row.location_id ?? null,
      location_name: row.location_name,
      confirmed_qty: Number(row.confirmed_qty ?? 0),
      user_ref: row.user_ref ?? null,
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
    });
  }

  for (const [key, list] of confirmMap.entries()) {
    confirmMap.set(key, sortLocationRowsAsc(list));
  }

  return rows.map((row: any) => {
    const originalItems = getAdjustmentItemsFromRow(row);

    const nextItems = originalItems.map((item: any) => {
      const itemId = Number(item.id ?? 0);
      const key = itemKeyMap.get(itemId);

      const productId = Number(item.product_id);
      const productLotKey = buildProductLotKey(item.product_id, item.lot_id);

      const zoneType =
        wmsZoneMap.get(productLotKey) ??
        (Number.isFinite(productId)
          ? wmsZoneByProductMap.get(productId)
          : null) ??
        null;

      const locationNames = key ? (stockMap.get(key) ?? []) : [];
      const confirmedLocations = confirmMap.get(itemId) ?? [];

      return {
        ...item,
        zone_type: zoneType,
        location_names: sortLocationRowsAsc(locationNames),
        confirmed_locations: sortLocationRowsAsc(confirmedLocations),
      };
    });

    return {
      ...row,
      adjustment_items: Array.isArray(row.adjustment_items)
        ? nextItems
        : row.adjustment_items,
      items: Array.isArray(row.items) ? nextItems : row.items,
    };
  });
};

/**
 * GET /api/Adjust
 */
export const listCombinedAdjustments = asyncHandler(
  async (req: Request, res: Response) => {
    const page = Math.max(1, Number(req.query.page ?? 1));

    const rawLimit = req.query.limit ?? req.query.pageSize ?? 20;
    const limit = Math.min(300, Math.max(1, Number(rawLimit)));

    const search = String(req.query.search ?? "").trim();

    const statusCsv = String(req.query.status ?? "").trim();
    const statuses = statusCsv
      ? statusCsv
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      : [];

    const allowedStatuses = ["pending", "completed", "waiting"] as const;

    if (
      statuses.length > 0 &&
      statuses.some(
        (s) => !allowedStatuses.includes(s as (typeof allowedStatuses)[number]),
      )
    ) {
      throw badRequest("status ต้องเป็น pending, waiting หรือ completed");
    }

    const mode = String(req.query.level ?? req.query.mode ?? "")
      .trim()
      .toLowerCase();

    const allowedModes = ["manual", "auto"] as const;

    if (mode && !allowedModes.includes(mode as (typeof allowedModes)[number])) {
      throw badRequest("level ต้องเป็น manual หรือ auto");
    }

    const selectedAdjustmentColumns = parseAdjustmentSearchColumns(
      req.query.columns,
    );

    const selectedOutboundColumns = parseSpecialOutboundSearchColumns(
      req.query.columns,
    );

    const adjustmentWhere: any = {
      deleted_at: null,
      ...buildAdjustmentSearchWhere(search, selectedAdjustmentColumns),
    };

    const outboundWhere = buildSpecialOutboundSearchWhere(
      search,
      selectedOutboundColumns,
    );

    const [adjustmentRowsRaw, outboundRows] = await Promise.all([
      prisma.adjustment.findMany({
        where: adjustmentWhere,
        include: {
          items: {
            where: {
              deleted_at: null,
            },
            orderBy: [{ id: "asc" }],
          },
        },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
      }),

      prisma.outbound.findMany({
        where: outboundWhere,
        include: {
          goods_outs: {
            where: { deleted_at: null },
            include: {
              barcode_ref: { where: { deleted_at: null } },
            },
            orderBy: [{ sequence: "asc" }, { id: "asc" }],
          },
        },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
      }),
    ]);

    const adjustmentRows = await attachAdjustmentLocations(adjustmentRowsRaw);

    const deptShortMapAdjust = await buildDepartmentShortNameMapFromAdjustments(
      adjustmentRows as any,
    );

    const formattedAdjustments = adjustmentRows
      .filter((r: any) => !hasSVInNo(r.no))
      .map((r: any) => {
        let department = r.department;

        const deptId = Number(r.department_id);
        if (Number.isFinite(deptId)) {
          const short = deptShortMapAdjust.get(deptId);
          if (short) department = short;
        }

        const isSystemGenerated = Boolean(r.is_system_generated);
        const adjustmentMode = isSystemGenerated ? "auto" : "manual";

        return {
          ...r,
          department,
          source: "adjust",

          mode: adjustmentMode,
          adjustment_level: r.level ?? null,
          is_system_generated: isSystemGenerated,

          status: String(r.status ?? "").toLowerCase(),
          type: r.type ?? null,
          out_type: null,
          date: r.date ?? r.created_at,
        };
      });

    const deptShortMap = await buildDepartmentShortNameMapFromOutbounds(
      outboundRows as any,
    );

    const formattedOutbounds = await Promise.all(
      outboundRows.map(async (outbound: any) => {
        const formatted: any = formatOdooOutbound(outbound);

        const shortName = resolveDepartmentShortNameForOutbound(
          deptShortMap,
          outbound,
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

        const resolvedType = resolveReportTypeFromNo(
          formatted.no,
          formatted.out_type ?? null,
        );

        return {
          ...formatted,
          source: "outbound",

          mode: "auto",
          is_system_generated: true,
          status: "completed",
          in_process: outbound.in_process,

          type: resolvedType,
          out_type: resolvedType,
          date: formatted.date ?? formatted.created_at ?? outbound.created_at,
        };
      }),
    );

    const getCombinedMode = (row: any): "manual" | "auto" | "" => {
      if (row.source === "adjust") {
        return row.is_system_generated === true ? "auto" : "manual";
      }

      if (row.source === "outbound") {
        return "auto";
      }

      return "";
    };

    const getCombinedStatus = (
      row: any,
    ): "pending" | "waiting" | "completed" | "" => {
      if (row.source === "adjust") {
        const st = String(row.status ?? "").toLowerCase();

        if (st === "completed") return "completed";
        if (st === "waiting") return "waiting";

        return "pending";
      }

      if (row.source === "outbound") {
        return "completed";
      }

      return "";
    };

    let mergedAll = [...formattedAdjustments, ...formattedOutbounds];

    if (mode) {
      mergedAll = mergedAll.filter((row: any) => getCombinedMode(row) === mode);
    }

    const statusCounts = {
      manual: {
        pending: 0,
        waiting: 0,
        completed: 0,
      },
      auto: {
        pending: 0,
        waiting: 0,
        completed: 0,
      },
    };

    mergedAll.forEach((row: any) => {
      const currentMode = getCombinedMode(row);
      const currentStatus = getCombinedStatus(row);

      if (!currentMode || !currentStatus) return;

      statusCounts[currentMode][currentStatus]++;
    });

    let merged = mergedAll;

    if (statuses.length) {
      merged = merged.filter((row: any) =>
        statuses.includes(getCombinedStatus(row)),
      );
    }

    merged.sort((a: any, b: any) => {
      const da = new Date(a?.date ?? a?.created_at ?? 0).getTime();
      const db = new Date(b?.date ?? b?.created_at ?? 0).getTime();

      if (db !== da) return db - da;

      return Number(b?.id ?? 0) - Number(a?.id ?? 0);
    });

    const total = merged.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const start = (page - 1) * limit;
    const data = merged.slice(start, start + limit);

    return res.json({
      data,
      meta: {
        page,
        limit,
        total,
        total_page: totalPages,
        totalPages,
        statusCounts,
      },
    });
  },
);

/**
 * GET /api/Adjust/:id
 */
export const getAdjustmentDetail = asyncHandler(
  async (req: Request, res: Response) => {
    const rawNo = String(
      req.params.no ??
        req.params.id ??
        req.query.no ??
        req.query.id ??
        req.body?.no ??
        req.body?.id ??
        "",
    ).trim();

    if (!rawNo) {
      throw badRequest("ไม่พบเลข Adjustment");
    }

    const decoded = decodeURIComponent(rawNo).trim();
    const numericId = Number(decoded);

    const row = await prisma.adjustment.findFirst({
      where: {
        deleted_at: null,
        OR: [
          { no: decoded },
          ...(Number.isFinite(numericId) ? [{ id: numericId }] : []),
        ],
      },
      include: {
        items: {
          where: {
            deleted_at: null,
          },
          orderBy: [{ id: "asc" }],
        },
      },
    });

    if (!row) {
      throw badRequest(`ไม่พบ Adjustment: ${decoded}`);
    }

    const sortByLocationNameAsc = (rows: any[]) => {
      return [...(rows || [])].sort((a: any, b: any) =>
        String(a.location_name ?? a.full_name ?? "").localeCompare(
          String(b.location_name ?? b.full_name ?? ""),
          "en",
          {
            sensitivity: "base",
            numeric: true,
          },
        ),
      );
    };

    const [attached] = await attachAdjustmentLocations([row]);
    const data: any = attached;

    data.items = Array.isArray(data.items)
      ? data.items.map((item: any) => {
          const rawLocations =
            item.lock_locations ?? item.locations ?? item.location_list ?? [];

          const sortedLocations = Array.isArray(rawLocations)
            ? sortByLocationNameAsc(rawLocations)
            : [];

          const lockNo = sortedLocations.map(
            (x: any) =>
              `${x.location_name ?? x.full_name ?? "-"} (จำนวน ${
                x.qty ?? x.quantity ?? 0
              })`,
          );

          return {
            ...item,
            lock_no: lockNo,
            location_name: lockNo,
            lock_locations: sortedLocations,
            locations: sortedLocations,
          };
        })
      : data.items;

    return res.json({
      data,
    });
  },
);

/**
 * POST /api/Adjust/:id/process
 * ✅ pending -> in-progress เท่านั้น
 */
export const processAdjustment = asyncHandler(
  async (req: Request, res: Response) => {
    let logId: number | null = null;
    try {
      const requestLog = await prisma.odoo_request_log.create({
        data: {
          endpoint: `/api/Adjust/${req.params.id}/process`,
          method: "POST",
          request_body: JSON.stringify(req.body),
          ip_address: req.ip || req.socket.remoteAddress || null,
          user_agent: req.headers["user-agent"] || null,
        },
      });
      logId = requestLog.id;

      const id = Number(req.params.id);
      if (!id) throw badRequest("Invalid id");

      const data = await prisma.$transaction(async (tx) => {
        const adj = await tx.adjustment.findFirst({
          where: { id, deleted_at: null },
        });
        if (!adj) throw badRequest("Adjustment not found");

        if (adj.status !== "pending") {
          throw badRequest(
            `Transition not allowed: ${adj.status} -> in-progress`,
          );
        }

        return tx.adjustment.update({
          where: { id },
          data: { status: "in-progress", updated_at: new Date() },
        });
      });

      const responseBody = { success: true, data };
      await prisma.odoo_request_log.update({
        where: { id: logId },
        data: {
          response_status: 200,
          response_body: JSON.stringify(responseBody),
        },
      });
      res.json(responseBody);
    } catch (err) {
      if (logId) {
        await prisma.odoo_request_log.update({
          where: { id: logId },
          data: {
            response_status: 500,
            response_body: JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          },
        });
      }
      throw err;
    }
  },
);

/**
 * POST /api/Adjust/:id/confirm
 * ✅ in-progress -> completed เท่านั้น
 */
export const confirmAdjustment = asyncHandler(
  async (req: Request, res: Response) => {
    let logId: number | null = null;
    try {
      const requestLog = await prisma.odoo_request_log.create({
        data: {
          endpoint: `/api/Adjust/${req.params.id}/confirm`,
          method: "POST",
          request_body: JSON.stringify(req.body),
          ip_address: req.ip || req.socket.remoteAddress || null,
          user_agent: req.headers["user-agent"] || null,
        },
      });
      logId = requestLog.id;

      const id = Number(req.params.id);
      if (!id) throw badRequest("Invalid id");

      const data = await prisma.$transaction(async (tx) => {
        const adj = await tx.adjustment.findFirst({
          where: { id, deleted_at: null },
        });
        if (!adj) throw badRequest("Adjustment not found");

        if (adj.status !== "in-progress") {
          throw badRequest(
            `Transition not allowed: ${adj.status} -> completed`,
          );
        }

        return tx.adjustment.update({
          where: { id },
          data: { status: "completed", updated_at: new Date() },
        });
      });

      const responseBody = { success: true, data };
      await prisma.odoo_request_log.update({
        where: { id: logId },
        data: {
          response_status: 200,
          response_body: JSON.stringify(responseBody),
        },
      });
      res.json(responseBody);
    } catch (err) {
      if (logId) {
        await prisma.odoo_request_log.update({
          where: { id: logId },
          data: {
            response_status: 500,
            response_body: JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          },
        });
      }
      throw err;
    }
  },
);

/**
 * POST /api/Adjust/:id/cancel
 * ✅ pending -> cancelled OR in-progress -> cancelled
 */
export const cancelAdjustment = asyncHandler(
  async (req: Request, res: Response) => {
    let logId: number | null = null;
    try {
      const requestLog = await prisma.odoo_request_log.create({
        data: {
          endpoint: `/api/Adjust/${req.params.id}/cancel`,
          method: "POST",
          request_body: JSON.stringify(req.body),
          ip_address: req.ip || req.socket.remoteAddress || null,
          user_agent: req.headers["user-agent"] || null,
        },
      });
      logId = requestLog.id;

      const id = Number(req.params.id);
      if (!id) throw badRequest("Invalid id");

      const data = await prisma.$transaction(async (tx) => {
        const adj = await tx.adjustment.findFirst({
          where: { id, deleted_at: null },
        });
        if (!adj) throw badRequest("Adjustment not found");

        if (adj.status !== "pending" && adj.status !== "in-progress") {
          throw badRequest(
            `Transition not allowed: ${adj.status} -> cancelled`,
          );
        }

        return tx.adjustment.update({
          where: { id },
          data: { status: "cancelled", updated_at: new Date() },
        });
      });

      const responseBody = { success: true, data };
      await prisma.odoo_request_log.update({
        where: { id: logId },
        data: {
          response_status: 200,
          response_body: JSON.stringify(responseBody),
        },
      });
      res.json(responseBody);
    } catch (err) {
      if (logId) {
        await prisma.odoo_request_log.update({
          where: { id: logId },
          data: {
            response_status: 500,
            response_body: JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          },
        });
      }
      throw err;
    }
  },
);

function decodeNoParam(v: unknown): string {
  const s = Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
  if (!s) return "";
  // Express decode รอบแรกแล้ว → เหลือ %2F → decode อีกรอบให้เป็น /
  return decodeURIComponent(s);
}

function normalizeForCompare(v: unknown): string {
  return String(v ?? "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}

function isSameNullableLot(a: unknown, b: unknown): boolean {
  const aa = normalizeForCompare(a);
  const bb = normalizeForCompare(b);

  if (!aa && !bb) return true;
  if (aa === "XXXXXX" && !bb) return true;
  if (!aa && bb === "XXXXXX") return true;

  return aa === bb;
}

function itemMatchesResolvedScan(item: any, resolved: any): boolean {
  const itemBarcode = normalizeScanText(item.barcode_text);
  const scanBarcode = normalizeScanText(resolved.barcode_text);

  if (!itemBarcode || itemBarcode !== scanBarcode) return false;

  const itemLot = normalizeScanText(item.lot_serial);
  const scanLot = normalizeScanText(resolved.lot_serial);

  if (scanLot && itemLot !== scanLot) return false;

  // ✅ 999999 คือไม่ต้องเช็ค exp
  if (!resolved.exp || resolved.exp_text === "999999") return true;

  return sameExpDateOnly(item.exp, resolved.exp);
}

export const scanAdjustmentLocation = asyncHandler(
  async (req: Request, res: Response) => {
    const no = decodeNoParam((req.params as any).no);
    const location_full_name = normalizeText(req.body?.location_full_name);
    const user_ref = normalizeText(req.body?.user_ref) || null;
    const client_id = normalizeText(req.body?.client_id) || null;

    if (!no) throw badRequest("Invalid no");

    const payload = await handleScanLocationCommon({
      docNo: no,
      locationFullName: location_full_name,

      loadDocument: () =>
        prisma.adjustment.findFirst({
          where: { no, deleted_at: null },
          select: {
            id: true,
            no: true,
            deleted_at: true,
          },
        }) as any,

      resolveLocation: resolveLocationByFullNameWithZone,

      beforeBuildDetail: async ({ doc, location }) => {
        const adj = await prisma.adjustment.findFirst({
          where: { id: doc.id, deleted_at: null },
          select: { id: true, status: true },
        });

        if (!adj) throw badRequest(`Adjustment not found: ${no}`);

        if (adj.status !== "pending" && adj.status !== "in-progress") {
          throw badRequest(
            `Scan allowed only when status is pending/in-progress (current: ${adj.status})`,
          );
        }

        await prisma.$transaction(async (tx) => {
          await tx.adjustment.update({
            where: { id: doc.id },
            data: {
              status: adj.status === "pending" ? "in-progress" : adj.status,
              updated_at: new Date(),
            },
          });

          const items = await tx.adjustment_item.findMany({
            where: {
              adjustment_id: doc.id,
              deleted_at: null,
            },
            select: {
              id: true,
            },
          });

          for (const it of items) {
            const existed = await tx.adjust_location_confirm.findFirst({
              where: {
                adjustment_id: doc.id,
                adjustment_item_id: it.id,
                location_name: location.full_name,
                deleted_at: null,
              },
              select: { id: true },
            });

            if (!existed) {
              await tx.adjust_location_confirm.create({
                data: {
                  adjustment_id: doc.id,
                  adjustment_item_id: it.id,
                  location_id: location.id,
                  location_name: location.full_name,
                  confirmed_qty: 0,
                  user_ref,
                  created_at: new Date(),
                  updated_at: new Date(),
                },
              });
            }
          }
        });
      },

      buildDetail: async ({ doc }) => {
        return buildAdjustmentDetail(doc.id, no);
      },

      buildPayload: ({ doc, location, detail }) => {
        return {
          ...(detail as any),
          scanned: {
            location_full_name: location.full_name,
            user_ref,
            client_id,
          },
          impact: (detail as any)?.items ?? [],
          location: {
            location_id: location.id,
            location_name: location.full_name,
            ignore: Boolean((location as any).ignore),
            zone_short_name: (location as any).zone?.short_name ?? null,
            zone_type_short_name:
              (location as any).zone?.zone_type?.short_name ?? null,
          },
        };
      },

      emitRealtime: (payload, doc) => {
        emitAdjustmentRealtime(no, "adjustment:scan_location", payload, doc.id);
      },

      notFoundMessage: `Adjustment not found: ${no}`,
    });

    return res.json(payload);
  },
);

export const saveAdjustmentDraft = asyncHandler(
  async (req: Request, res: Response) => {
    const no = decodeNoParam((req.params as any).no);
    if (!no) throw badRequest("Invalid no");

    const impact_lines = Array.isArray(req.body?.impact_lines)
      ? req.body.impact_lines
      : [];
    if (impact_lines.length === 0)
      throw badRequest("impact_lines ต้องมีอย่างน้อย 1 รายการ");

    const adj = await prisma.adjustment.findFirst({
      where: { no, deleted_at: null },
      select: { id: true, status: true },
    });
    if (!adj) throw badRequest(`Adjustment not found: ${no}`);

    // ✅ Save ได้เฉพาะ in-progress (ตาม 3 สถานะ)
    if (adj.status !== "in-progress") {
      throw badRequest(
        `Save draft allowed only when status is in-progress (current: ${adj.status})`,
      );
    }

    await prisma.$transaction(async (tx) => {
      for (const line of impact_lines) {
        const key = Number(line?.key);
        if (!key) throw badRequest("impact_lines.key ไม่ถูกต้อง");

        const locDest = normalize(line?.location_full_name);
        const lot = normalize(line?.lot_serial);
        const qty = parseQtyInt(line?.qty);

        if (!locDest) throw badRequest("location_full_name ห้ามว่าง");
        if (!lot) throw badRequest("lot_serial ห้ามว่าง");
        if (!Number.isFinite(qty) || qty <= 0)
          throw badRequest("qty ต้องมากกว่า 0");

        const updated = await tx.adjustment_item.updateMany({
          where: { id: key, adjustment_id: adj.id, deleted_at: null },
          data: {
            location_dest: locDest,
            lot_serial: lot,
            qty,
            updated_at: new Date(),
          },
        });

        if (updated.count === 0)
          throw badRequest(`ไม่พบ item key=${key} ใน adjustment ${no}`);
      }

      // ✅ optional: แตะ updated_at ของ header เฉย ๆ (ไม่เปลี่ยน status)
      await tx.adjustment.update({
        where: { id: adj.id },
        data: { updated_at: new Date() },
      });
    });

    return res.json({ success: true, message: "Saved (in-progress)", no });
  },
);

// POST /api/Adjust/:no/scan/barcode
export const scanAdjustmentBarcode = asyncHandler(
  async (req: Request, res: Response) => {
    const no = decodeNoParam((req.params as any).no);

    const barcodeRaw = String(
      req.body?.barcode_payload ?? req.body?.barcode ?? "",
    ).trim();

    const location_full_name = normalizeText(req.body?.location_full_name);
    const user_ref = normalizeText(req.body?.user_ref) || null;

    if (!no) throw badRequest("Invalid no");
    if (!barcodeRaw) throw badRequest("กรุณาส่ง barcode");
    if (!location_full_name) throw badRequest("กรุณาส่ง location_full_name");

    const adj = await prisma.adjustment.findFirst({
      where: { no, deleted_at: null },
      select: { id: true, no: true, status: true },
    });

    if (!adj) throw badRequest(`Adjustment not found: ${no}`);

    if (adj.status !== "pending" && adj.status !== "in-progress") {
      throw badRequest(
        `Scan allowed only when status is pending/in-progress (current: ${adj.status})`,
      );
    }

    const loc = await resolveLocationByFullNameWithZone(location_full_name);
    const resolved = await resolveBarcodeScan(barcodeRaw);

    let updatedItem: any = null;
    let beforePick = 0;
    let afterPick = 0;
    let beforeLoc = 0;
    let afterLoc = 0;

    await prisma.$transaction(async (tx) => {
      const candidates = await tx.adjustment_item.findMany({
        where: {
          adjustment_id: adj.id,
          deleted_at: null,
        },
        select: {
          id: true,
          code: true,
          name: true,
          qty: true,
          qty_pick: true,
          lot_serial: true,
          exp: true,
          barcode_text: true,
        },
        orderBy: [{ sequence: "asc" }, { id: "asc" }],
      });

      const matched = candidates.filter((it) =>
        itemMatchesResolvedScan(it, resolved),
      );

      if (matched.length === 0) {
        throw badRequest(
          `ไม่พบ barcode นี้ในเอกสาร (barcode=${resolved.barcode_text ?? "-"}, lot=${resolved.lot_serial ?? "-"}, exp=${resolved.exp_text ?? "-"})`,
        );
      }

      const target =
        matched.find((it) => Number(it.qty_pick ?? 0) < Number(it.qty ?? 0)) ??
        matched[0];

      const maxQty = Number(target.qty ?? 0);
      beforePick = Number(target.qty_pick ?? 0);

      if (beforePick >= maxQty) {
        throw badRequest("รายการนี้สแกนครบจำนวนแล้ว");
      }

      afterPick = beforePick + 1;

      if (afterPick > maxQty) {
        throw badRequest(
          `จำนวนสแกนเกิน qty (qty=${maxQty}, current=${beforePick}, add=1)`,
        );
      }

      const existingConfirm = await tx.adjust_location_confirm.findFirst({
        where: {
          adjustment_id: adj.id,
          adjustment_item_id: target.id,
          location_name: location_full_name,
          deleted_at: null,
        },
        select: {
          id: true,
          confirmed_qty: true,
        },
      });

      beforeLoc = Number(existingConfirm?.confirmed_qty ?? 0);
      afterLoc = beforeLoc + 1;

      updatedItem = await tx.adjustment_item.update({
        where: { id: target.id },
        data: {
          qty_pick: { increment: 1 },
          updated_at: new Date(),
        },
      });

      if (existingConfirm) {
        await tx.adjust_location_confirm.update({
          where: { id: existingConfirm.id },
          data: {
            confirmed_qty: { increment: 1 },
            user_ref,
            updated_at: new Date(),
          },
        });
      } else {
        await tx.adjust_location_confirm.create({
          data: {
            adjustment_id: adj.id,
            adjustment_item_id: target.id,
            location_id: loc.id,
            location_name: location_full_name,
            confirmed_qty: 1,
            user_ref,
            created_at: new Date(),
            updated_at: new Date(),
          },
        });
      }

      await tx.adjustment.update({
        where: { id: adj.id },
        data: {
          status: adj.status === "pending" ? "in-progress" : adj.status,
          updated_at: new Date(),
        },
      });
    });

    const detail = await buildAdjustmentDetail(adj.id, no);

    const matchedLine =
      detail?.items?.find?.(
        (x: any) => Number(x.id) === Number(updatedItem?.id),
      ) ?? null;

    const payload = {
      ...detail,
      location: {
        location_id: loc.id,
        location_name: loc.full_name,
        ignore: Boolean((loc as any).ignore),
        zone_short_name: (loc as any).zone?.short_name ?? null,
        zone_type_short_name: (loc as any).zone?.zone_type?.short_name ?? null,
      },
      scanned: {
        barcode: barcodeRaw,
        normalized_input: resolved.normalized_input,
        matched_by: resolved.matched_by,
        barcode_text: resolved.barcode_text,
        lot_serial: resolved.lot_serial,
        exp_text: resolved.exp_text,
        exp: resolved.exp,
        location_full_name,
      },
      addQty: 1,
      matchedLine,
      qty_before: beforePick,
      qty_after: afterPick,
      loc_qty_before: beforeLoc,
      loc_qty_after: afterLoc,
    };

    emitAdjustmentRealtime(no, "adjustment:scan_barcode", payload, adj.id);

    return res.json(payload);
  },
);

function buildAdjustmentStockBucketKey(input: {
  source: string;
  product_id: number | null;
  product_code?: string | null;
  lot_id?: number | null;
  location_id?: number | null;
}) {
  return [
    input.source,
    `p:${input.product_id ?? 0}`,
    `code:${input.product_code ?? ""}`,
    `lot:${input.lot_id ?? 0}`,
    `loc:${input.location_id ?? 0}`,
  ].join("|");
}

export const confirmAdjustmentByLocation = asyncHandler(
  async (req: Request, res: Response) => {
    const no = decodeNoParam((req.params as any).no);

    const adj = await prisma.adjustment.findFirst({
      where: { no, deleted_at: null },
    });

    if (!adj) throw badRequest("ไม่พบเอกสาร");

    const result = await prisma.$transaction(async (tx) => {
      const confirms = await tx.adjust_location_confirm.findMany({
        where: {
          adjustment_id: adj.id,
          deleted_at: null,
          confirmed_qty: { gt: 0 },
        },
        include: {
          adjustment_item: true,
        },
        orderBy: [{ id: "asc" }],
      });

      if (confirms.length === 0) {
        throw badRequest("ยังไม่มีรายการ scan สำหรับ confirm");
      }

      let increase = 0;
      let decrease = 0;

      for (const c of confirms as any[]) {
        const item = c.adjustment_item;
        if (!item || item.deleted_at) continue;

        const qty = Math.max(0, Math.floor(Number(c.confirmed_qty ?? 0)));
        if (qty <= 0) continue;

        const fromInv = isInventoryAdjustment(item.location);
        const toInv = isInventoryAdjustment(item.location_dest);

        const locationName = normalizeText(c.location_name);
        const locationId =
          c.location_id == null || Number.isNaN(Number(c.location_id))
            ? null
            : Number(c.location_id);

        const existing = await tx.stock.findFirst({
          where: {
            product_id: item.product_id,
            lot_name: item.lot_serial ?? null,
            location_name: locationName,
            source: "wms",
          } as any,
          orderBy: { id: "desc" },
        });

        if (fromInv && !toInv) {
          if (existing) {
            await tx.stock.update({
              where: { id: existing.id },
              data: {
                quantity: { increment: new Prisma.Decimal(qty) },
                count: { increment: qty },
                updated_at: new Date(),
              } as any,
            });
          } else {
            await tx.stock.create({
              data: {
                bucket_key: buildAdjustmentStockBucketKey({
                  source: "wms",
                  product_id: item.product_id,
                  product_code: item.code ?? null,
                  lot_id: item.lot_id ?? null,
                  location_id: locationId,
                }),

                product_id: item.product_id,
                product_code: item.code ?? null,
                product_name: item.name ?? null,
                unit: item.unit ?? null,

                location_id: locationId,
                location_name: locationName,

                lot_id: item.lot_id ?? null,
                lot_name: item.lot_serial ?? null,
                expiration_date: item.exp ?? null,

                source: "wms",
                quantity: new Prisma.Decimal(qty),
                count: qty,
              } as any,
            });
          }

          increase += qty;
          continue;
        }

        if (!fromInv && toInv) {
          if (!existing) {
            throw badRequest(
              `stock ไม่มี product=${item.product_id ?? "-"} lot=${item.lot_serial ?? "-"} location=${locationName}`,
            );
          }

          const remain = Number(existing.quantity ?? 0) - qty;

          if (remain < 0) {
            throw badRequest(
              `stock ไม่พอ product=${item.product_id ?? "-"} lot=${item.lot_serial ?? "-"} location=${locationName} need=${qty} have=${Number(existing.quantity ?? 0)}`,
            );
          }

          await tx.stock.update({
            where: { id: existing.id },
            data: {
              quantity: new Prisma.Decimal(remain),
              count: Math.max(0, Math.floor(remain)),
              updated_at: new Date(),
            } as any,
          });

          decrease += qty;
          continue;
        }

        throw badRequest(
          `ไม่รองรับ adjustment flow location=${item.location ?? "-"} location_dest=${item.location_dest ?? "-"}`,
        );
      }

      await tx.adjustment.update({
        where: { id: adj.id },
        data: {
          status: "completed",
          updated_at: new Date(),
        },
      });

      return { increase, decrease };
    });

    const detail = await buildAdjustmentDetail(adj.id, no);

    emitAdjustmentRealtime(
      no,
      "adjustment:confirm",
      {
        ...detail,
        confirmed: result,
      },
      adj.id,
    );

    emitAdjustmentRealtime(
      no,
      "adjustment:confirmed",
      {
        no,
        confirmed_by: req.body?.user_ref ?? null,
        confirmed: result,
      },
      adj.id,
    );

    return res.json({
      success: true,
      no,
      data: {
        ...detail,
        confirmed: result,
      },
    });
  },
);

function parseIntSafe(v: unknown, def = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.floor(n);
}

type MinusImpactLockInput = {
  location_id?: number | null;
  location_name?: string | null;
  qty?: number | string | null;
};

type MinusImpactLineInput = {
  adjustment_item_id?: number | string | null;
  qty?: number | string | null;
  locks?: MinusImpactLockInput[];
};

function pickMinusImpactLines(body: any): MinusImpactLineInput[] {
  return Array.isArray(body?.minus_impact_lines) ? body.minus_impact_lines : [];
}

export const saveMinusLockPick = asyncHandler(
  async (req: Request, res: Response) => {
    const no = decodeNoParam((req.params as any).no);
    if (!no) throw badRequest("Invalid no");

    const itemId = Number(req.body?.adjustment_item_id);
    const totalQty = Math.max(0, Math.floor(Number(req.body?.qty ?? 0)));
    const locks = Array.isArray(req.body?.locks) ? req.body.locks : [];
    const userRef = normalizeText(req.body?.user_ref) || null;
    const userApprove = normalizeText(req.body?.user_approve) || null;

    if (!Number.isFinite(itemId) || itemId <= 0) {
      throw badRequest("adjustment_item_id ไม่ถูกต้อง");
    }

    if (!userApprove) {
      throw badRequest("กรุณายืนยัน PIN ผู้อนุมัติก่อน");
    }

    if (totalQty <= 0) {
      throw badRequest("qty ต้องมากกว่า 0");
    }

    if (!locks.length) {
      throw badRequest("กรุณาเลือก Lock No. ที่ตัด");
    }

    const result = await prisma.$transaction(async (tx) => {
      const adj = await tx.adjustment.findFirst({
        where: { no, deleted_at: null },
        select: { id: true, no: true, status: true },
      });

      if (!adj) throw badRequest(`Adjustment not found: ${no}`);

      if (adj.status !== "pending" && adj.status !== "in-progress") {
        throw badRequest(
          `แก้ไข QTY ได้เฉพาะ pending/in-progress เท่านั้น current=${adj.status}`,
        );
      }

      const item = await tx.adjustment_item.findFirst({
        where: {
          id: itemId,
          adjustment_id: adj.id,
          deleted_at: null,
        },
      });

      if (!item) {
        throw badRequest(`ไม่พบ adjustment_item id=${itemId}`);
      }

      const fromInv = isInventoryAdjustment(item.location);
      const toInv = isInventoryAdjustment(item.location_dest);

      if (fromInv || !toInv) {
        throw badRequest("เลือก Lock No. ใช้ได้เฉพาะ Impact - เท่านั้น");
      }

      const impactQty = Math.abs(Number(item.qty ?? 0));

      const normalizedLocks = locks
        .map((lock: any) => {
          const qty = Math.max(0, Math.floor(Number(lock?.qty ?? 0)));
          const locationName = normalizeText(lock?.location_name);
          const locationId = safeInt(lock?.location_id);

          return {
            location_id: locationId,
            location_name: locationName,
            confirmed_qty: qty,
          };
        })
        .filter(
          (x: {
            location_id: number | null;
            location_name: string;
            confirmed_qty: number;
          }) => x.confirmed_qty > 0,
        );

      const sumLockQty = normalizedLocks.reduce(
        (sum: number, x: { confirmed_qty: number }) => sum + x.confirmed_qty,
        0,
      );

      if (sumLockQty <= 0) {
        throw badRequest("กรุณาเลือกจำนวน");
      }

      if (sumLockQty !== totalQty) {
        throw badRequest("จำนวนรวม Lock No. ไม่ตรงกับ qty");
      }

      if (sumLockQty > impactQty) {
        throw badRequest(`จำนวนรวมต้องไม่เกิน Impact ${impactQty}`);
      }

      for (const lock of normalizedLocks) {
        if (!lock.location_name) {
          throw badRequest("location_name ของ Lock No. ห้ามว่าง");
        }

        const stock = await tx.stock.findFirst({
          where: {
            source: "wms",
            product_id: item.product_id,
            lot_name: item.lot_serial ?? null,
            ...(lock.location_id ? { location_id: lock.location_id } : {}),
            location_name: lock.location_name,
          } as any,
          orderBy: { id: "desc" },
        });

        if (!stock) {
          throw badRequest(
            `stock ไม่มี product=${item.product_id ?? "-"} lot=${item.lot_serial ?? "-"} location=${lock.location_name}`,
          );
        }

        const stockQty = Number(stock.quantity ?? 0);

        if (stockQty < lock.confirmed_qty) {
          throw badRequest(
            `stock ไม่พอ location=${lock.location_name} need=${lock.confirmed_qty} have=${stockQty}`,
          );
        }
      }

      await tx.adjust_location_confirm.updateMany({
        where: {
          adjustment_id: adj.id,
          adjustment_item_id: item.id,
          deleted_at: null,
        },
        data: {
          deleted_at: new Date(),
          updated_at: new Date(),
        },
      });

      for (const lock of normalizedLocks) {
        await tx.adjust_location_confirm.create({
          data: {
            adjustment_id: adj.id,
            adjustment_item_id: item.id,
            location_id: lock.location_id,
            location_name: lock.location_name,
            confirmed_qty: lock.confirmed_qty,
            user_ref: userRef,
            created_at: new Date(),
            updated_at: new Date(),
          },
        });
      }

      await tx.adjustment_item.update({
        where: { id: item.id },
        data: {
          qty_pick: sumLockQty,
          user_approve: userApprove,
          updated_at: new Date(),
        },
      });

      await tx.adjustment.update({
        where: { id: adj.id },
        data: {
          status: adj.status === "pending" ? "in-progress" : adj.status,
          updated_at: new Date(),
        },
      });

      return {
        adjustment_id: adj.id,
        adjustment_no: adj.no,
        user_approve: userApprove,
      };
    });

    const detail = await buildAdjustmentDetail(result.adjustment_id, no);

    const payload = {
      ...detail,
      updated_by: userRef,
      user_approve: result.user_approve,
    };

    emitAdjustmentRealtime(
      no,
      "adjustment:minus_lock_pick",
      payload,
      result.adjustment_id,
    );

    return res.json({
      success: true,
      no,
      data: payload,
    });
  },
);

export const confirmAdjustmentCompleteByNo = asyncHandler(
  async (req: Request, res: Response) => {
    const no = decodeNoParam((req.params as any).no);
    if (!no) throw badRequest("Invalid no");

    const userRef = normalizeText(req.body?.user_ref) || null;
    const approvedByUserId = safeInt(req.body?.approved_by_user_id);
    const minusImpactLines = pickMinusImpactLines(req.body);
    const hasMinusImpactLines = minusImpactLines.length > 0;

    const adj = await prisma.adjustment.findFirst({
      where: { no, deleted_at: null },
    });

    if (!adj) throw badRequest("ไม่พบเอกสาร");

    if (adj.status !== "in-progress") {
      throw badRequest("ต้องเป็น in-progress");
    }

    const result = await prisma.$transaction(async (tx) => {
      const confirms = await tx.adjust_location_confirm.findMany({
        where: {
          adjustment_id: adj.id,
          deleted_at: null,
          confirmed_qty: { gt: 0 },
        },
        include: {
          adjustment_item: true,
        },
      });

      if (confirms.length === 0 && !hasMinusImpactLines) {
        throw badRequest("ยังไม่ได้ scan");
      }

      let increase = 0;
      let decrease = 0;

      // ✅ Impact + จาก scan เดิม
      for (const c of confirms) {
        const item = c.adjustment_item;
        if (!item) continue;

        const qty = Math.max(0, Math.floor(Number(c.confirmed_qty ?? 0)));
        if (qty <= 0) continue;

        const fromInv = isInventoryAdjustment(item.location);
        const toInv = isInventoryAdjustment(item.location_dest);

        const locationName = normalizeText(c.location_name);

        const existing = await tx.stock.findFirst({
          where: {
            source: "wms",
            product_id: item.product_id,
            lot_name: item.lot_serial ?? null,
            location_name: locationName,
          } as any,
          orderBy: { id: "desc" },
        });

        if (fromInv && !toInv) {
          if (existing) {
            await tx.stock.update({
              where: { id: existing.id },
              data: {
                quantity: { increment: new Prisma.Decimal(qty) },
                count: { increment: qty },
                updated_at: new Date(),
              } as any,
            });
          } else {
            await tx.stock.create({
              data: {
                bucket_key: buildAdjustmentStockBucketKey({
                  source: "wms",
                  product_id: item.product_id,
                  product_code: item.code ?? null,
                  lot_id: item.lot_id ?? null,
                  location_id: c.location_id ?? null,
                }),
                product_id: item.product_id,
                product_code: item.code ?? null,
                product_name: item.name ?? null,
                unit: item.unit ?? null,
                location_id: c.location_id ?? null,
                location_name: locationName,
                lot_id: item.lot_id ?? null,
                lot_name: item.lot_serial ?? null,
                expiration_date: item.exp ?? null,
                source: "wms",
                quantity: new Prisma.Decimal(qty),
                count: qty,
                updated_at: new Date(),
              } as any,
            });
          }

          increase += qty;
          continue;
        }

        // กัน Impact - ที่ถูก scan มาปน
        if (!fromInv && toInv) {
          continue;
        }

        throw badRequest(
          `ไม่รองรับ adjustment flow location=${item.location ?? "-"} location_dest=${item.location_dest ?? "-"}`,
        );
      }

      // ✅ Impact - จาก Modal Lock No. ไม่ใช้ scan
      for (const line of minusImpactLines) {
        const itemId = Number(line?.adjustment_item_id);
        const totalQty = Math.max(0, Math.floor(Number(line?.qty ?? 0)));
        const locks = Array.isArray(line?.locks) ? line.locks : [];

        if (!Number.isFinite(itemId) || itemId <= 0) {
          throw badRequest("minus_impact_lines.adjustment_item_id ไม่ถูกต้อง");
        }

        if (totalQty <= 0) {
          throw badRequest("minus_impact_lines.qty ต้องมากกว่า 0");
        }

        if (!locks.length) {
          throw badRequest("กรุณาเลือก Lock No. ที่ตัด");
        }

        const item = await tx.adjustment_item.findFirst({
          where: {
            id: itemId,
            adjustment_id: adj.id,
            deleted_at: null,
          },
        });

        if (!item) {
          throw badRequest(`ไม่พบ adjustment_item id=${itemId}`);
        }

        const fromInv = isInventoryAdjustment(item.location);
        const toInv = isInventoryAdjustment(item.location_dest);

        if (fromInv || !toInv) {
          throw badRequest(
            `minus_impact_lines ใช้ได้เฉพาะ Impact - เท่านั้น item=${itemId}`,
          );
        }

        const alreadyConfirmed = await tx.adjust_location_confirm.findFirst({
          where: {
            adjustment_id: adj.id,
            adjustment_item_id: item.id,
            deleted_at: null,
            confirmed_qty: { gt: 0 },
          },
          select: { id: true },
        });

        if (alreadyConfirmed) {
          throw badRequest(`รายการนี้ถูก confirm แล้ว item=${item.id}`);
        }

        const impactQty = Math.abs(Number(item.qty ?? 0));

        const sumLockQty = locks.reduce((sum: number, lock: any) => {
          return sum + Math.max(0, Math.floor(Number(lock?.qty ?? 0)));
        }, 0);

        if (sumLockQty !== totalQty) {
          throw badRequest(`จำนวนรวม Lock No. ไม่ตรงกับ qty item=${itemId}`);
        }

        if (sumLockQty > impactQty) {
          throw badRequest(`จำนวนที่ตัดเกิน Impact item=${itemId}`);
        }

        for (const lock of locks) {
          const qty = Math.max(0, Math.floor(Number(lock?.qty ?? 0)));
          if (qty <= 0) continue;

          const locationName = normalizeText(lock?.location_name);
          const locationId = safeInt(lock?.location_id);

          if (!locationName) {
            throw badRequest("location_name ของ Lock No. ห้ามว่าง");
          }

          const existing = await tx.stock.findFirst({
            where: {
              source: "wms",
              product_id: item.product_id,
              lot_name: item.lot_serial ?? null,
              ...(locationId ? { location_id: locationId } : {}),
              location_name: locationName,
            } as any,
            orderBy: { id: "desc" },
          });

          if (!existing) {
            throw badRequest(
              `stock ไม่มี product=${item.product_id ?? "-"} lot=${item.lot_serial ?? "-"} location=${locationName}`,
            );
          }

          const currentQty = Number(existing.quantity ?? 0);
          const remain = currentQty - qty;

          if (remain < 0) {
            throw badRequest(
              `stock ไม่พอ product=${item.product_id ?? "-"} lot=${item.lot_serial ?? "-"} location=${locationName} need=${qty} have=${currentQty}`,
            );
          }

          await tx.stock.update({
            where: { id: existing.id },
            data: {
              quantity: new Prisma.Decimal(remain),
              count: Math.max(0, Math.floor(remain)),
              updated_at: new Date(),
            } as any,
          });

          await tx.adjust_location_confirm.create({
            data: {
              adjustment_id: adj.id,
              adjustment_item_id: item.id,
              location_id: locationId,
              location_name: locationName,
              confirmed_qty: qty,
              user_ref: userRef,
              created_at: new Date(),
              updated_at: new Date(),
            },
          });

          decrease += qty;
        }

        await tx.adjustment_item.update({
          where: { id: item.id },
          data: {
            qty_pick: sumLockQty,
            updated_at: new Date(),
          },
        });
      }

      await tx.adjustment.update({
        where: { id: adj.id },
        data: {
          status: "completed",
          updated_at: new Date(),
        },
      });

      return {
        increase,
        decrease,
        approved_by_user_id: approvedByUserId,
      };
    });

    const detail = await buildAdjustmentDetail(adj.id, no);

    const payload = {
      ...detail,
      confirmed: result,
    };

    emitAdjustmentRealtime(no, "adjustment:confirm", payload, adj.id);
    emitAdjustmentRealtime(no, "adjustment:confirmed", payload, adj.id);

    return res.json({
      success: true,
      no,
      data: payload,
    });
  },
);

/** =========================================================
 * Helpers: รองรับ payload จาก FE (transfers) + ของเดิม (impact_lines)
 * ========================================================= */

function normalizeLot(v: unknown): string {
  return String(v ?? "")
    .trim()
    .replace(/\s+/g, "");
}

export const deleteAdjustmentItem = asyncHandler(
  async (req: Request, res: Response) => {
    const adjustmentId = Number(req.params.id);
    const itemId = Number(req.params.itemId);

    if (!Number.isFinite(adjustmentId)) {
      throw badRequest("adjustment id ต้องเป็นตัวเลข");
    }

    if (!Number.isFinite(itemId)) {
      throw badRequest("item id ต้องเป็นตัวเลข");
    }

    const result = await prisma.$transaction(async (tx) => {
      const adj = await tx.adjustment.findFirst({
        where: {
          id: adjustmentId,
          deleted_at: null,
        },
        select: {
          id: true,
          no: true,
          status: true,
          is_system_generated: true,
        },
      });

      if (!adj) {
        throw badRequest("Adjustment not found");
      }

      // กันลบเอกสารที่จบแล้ว/ยกเลิกแล้ว
      if (adj.status === "completed" || adj.status === "cancelled") {
        throw badRequest(`ไม่สามารถลบรายการได้เมื่อ status = ${adj.status}`);
      }

      const item = await tx.adjustment_item.findFirst({
        where: {
          id: itemId,
          adjustment_id: adjustmentId,
          deleted_at: null,
        },
        select: {
          id: true,
          adjustment_id: true,
          sequence: true,
          product_id: true,
          code: true,
          name: true,
          lot_serial: true,
          qty: true,
          qty_pick: true,
        },
      });

      if (!item) {
        throw badRequest("Adjustment item not found");
      }

      await tx.adjustment_item.update({
        where: { id: item.id },
        data: {
          deleted_at: new Date(),
          updated_at: new Date(),
        },
      });

      await tx.adjustment.update({
        where: { id: adjustmentId },
        data: {
          updated_at: new Date(),
        },
      });

      const remain = await tx.adjustment_item.count({
        where: {
          adjustment_id: adjustmentId,
          deleted_at: null,
        },
      });

      return {
        adjustment_id: adjustmentId,
        adjustment_no: adj.no,
        deleted_item: item,
        remaining_items: remain,
      };
    });

    return res.json({
      success: true,
      message: "ลบรายการสำเร็จ",
      data: result,
    });
  },
);

import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest } from "../utils/appError";
import { Prisma } from "@prisma/client";
import { formatOdooOutbound } from "../utils/formatters/odoo_outbound.formatter";

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

function normalizeAdjustmentExp(v: unknown): Date | null {
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

  if (oldItems.length === 0 && newItems.length === 0) {
    return;
  }

  if (oldItems.length === 0) {
    throw badRequest("auto adjust นี้ไม่มี old lot สำหรับลบออก");
  }

  if (newItems.length === 0) {
    throw badRequest(
      "auto adjust นี้ไม่มี new lot (#) สำหรับสร้าง placeholder",
    );
  }

  const removedMap = new Map<string, any[]>();

  for (const item of oldItems) {
    const removed = await softDeleteOldStock(
      tx,
      stockTarget,
      item,
      args.no,
      args.department_id,
      args.department,
    );

    const key = buildAutoReplaceOldPairKey(item);
    const arr = removedMap.get(key) ?? [];
    arr.push(removed);
    removedMap.set(key, arr);
  }

  for (const item of newItems) {
    const key = buildAutoReplaceNewPairKey(item);
    const arr = removedMap.get(key) ?? [];

    if (arr.length === 0) {
      throw badRequest(
        `ไม่พบ old lot ที่ match กับ new lot ${item.lot_serial ?? "-"} (product_id=${item.product_id ?? "null"})`,
      );
    }

    const oldRow = arr.shift();
    removedMap.set(key, arr);

    await createNewStockFromOld(tx, stockTarget, oldRow, item, {
      no: args.no,
      department_id: args.department_id,
      department: args.department,
    });
  }
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

          const location_owner = normalizeOwnerOrLocationText(
            item?.location_owner,
          );
          const location_dest = safeString(item?.location_dest);

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
            location:
              normalizeOwnerOrLocationText(item?.location) ??
              normalizeOwnerOrLocationText(item?.location_owner) ??
              safeString(item?.location_dest),

            lot_id,
            lot_serial: safeString(item?.lot_serial),
            tracking: safeString(item?.tracking),

            qty,
            exp,
            barcode_payload: buildBarcodePayload(item?.barcodes),

            location_owner,
            location_owner_display: stringifyIfNeeded(
              item?.location_owner_display,
            ),

            location_dest_id: safeInt(item?.location_dest_id),
            location_dest: safeString(item?.location_dest),
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
            select: { id: true },
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
                status: "completed",
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
                status: "completed",
                is_system_generated: isSystemGenerated,
                date: new Date(),
              },
              select: { id: true },
            });

            adjustmentId = created.id;
          }

          if (mergedItems.length > 0) {
            await tx.adjustment_item.createMany({
              data: mergedItems.map((item) => ({
                adjustment_id: adjustmentId,
                sequence: item.sequence,
                product_id: item.product_id,
                code: item.code,
                name: item.name ?? "",
                unit: item.unit ?? "",
                location_id: null,
                location: item.location_owner ?? item.location_dest ?? null,

                location_owner: item.location_owner ?? null,
                location_owner_display: item.location_owner_display ?? null,

                location_dest_id: item.location_dest_id ?? null,
                location_dest: item.location_dest ?? null,

                location_dest_owner: item.location_dest_owner ?? null,
                location_dest_owner_display:
                  item.location_dest_owner_display ?? null,

                tracking: null,
                lot_id: item.lot_id ?? null,
                lot_serial: item.lot_serial ?? null,
                qty: item.qty,
                exp: item.exp ?? null,
                barcode_payload: item.barcode_payload ?? null,
                qty_pick: 0,
              })),
            });
          }

          if (isSystemGenerated) {
            await applySystemGeneratedLotReplacementBorOnly(tx, {
              no,
              department_id: dep.department_id,
              department: dep.department || "",
              items: mergedItems,
            });
          } else if (adjustmentType === "BOA") {
            await applyBoaAdjustmentToBorStock(tx, {
              no,
              department_id: dep.department_id,
              department: dep.department || "",
              items: mergedItems,
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
          status: saved?.status ?? "completed",
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

/**
 * GET /api/Adjust
 */
export const listCombinedAdjustments = asyncHandler(
  async (req: Request, res: Response) => {
    const page = Math.max(1, Number(req.query.page ?? 1));

    const rawLimit = req.query.limit ?? req.query.pageSize ?? 10;
    const limit = Math.min(300, Math.max(1, Number(rawLimit)));

    const search = String(req.query.search ?? "").trim();

    const statusCsv = String(req.query.status ?? "").trim();
    const statuses = statusCsv
      ? statusCsv
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      : [];

    const allowedStatuses = ["pending", "completed"] as const;

    if (
      statuses.length > 0 &&
      statuses.some(
        (s) => !allowedStatuses.includes(s as (typeof allowedStatuses)[number]),
      )
    ) {
      throw badRequest("status ต้องเป็น pending หรือ completed");
    }

    const mode = String(req.query.level ?? "")
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

    const adjustmentWhere: any = buildAdjustmentSearchWhere(
      search,
      selectedAdjustmentColumns,
    );

    const outboundWhere = buildSpecialOutboundSearchWhere(
      search,
      selectedOutboundColumns,
    );

    const [adjustmentRows, outboundRows] = await Promise.all([
      prisma.adjustment.findMany({
        where: adjustmentWhere,
        orderBy: [{ date: "desc" }, { id: "desc" }],
        include: {
          items: {
            where: { deleted_at: null },
            select: { location: true },
            take: 200,
          },
        },
      }),

      prisma.outbound.findMany({
        where: outboundWhere,
        include: {
          goods_outs: {
            where: { deleted_at: null },
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
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
      }),
    ]);

    const deptShortMapAdjust = await buildDepartmentShortNameMapFromAdjustments(
      adjustmentRows as any,
    );

    const formattedAdjustments = adjustmentRows
      .filter((r: any) => !hasSVInNo(r.no))
      .map((r: any) => {
        const location = computeLocationDisplay(
          (r.items ?? []).map((it: any) => it.location),
        );

        const { items, ...rest } = r;

        let department = r.department;

        const deptId = Number(r.department_id);
        if (Number.isFinite(deptId)) {
          const short = deptShortMapAdjust.get(deptId);
          if (short) department = short;
        }

        const isSystemGenerated = Boolean(r.is_system_generated);
        const adjustmentMode = isSystemGenerated ? "auto" : "manual";

        return {
          ...rest,
          department,
          location,
          source: "adjust",

          // ใช้ตัวนี้แยก manual / auto
          mode: adjustmentMode,

          // ส่ง level เดิมไว้ด้วย เผื่อ FE ยังใช้แสดง post-process / in-process
          adjustment_level: r.level ?? null,

          is_system_generated: isSystemGenerated,
          status: String(r.status ?? "").toLowerCase(),
          type: r.type ?? null,
          out_type: null,
          date: r.date,
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

          // outbound ถือเป็น auto และ completed เสมอใน report นี้
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

    const getCombinedStatus = (row: any): "pending" | "completed" | "" => {
      if (row.source === "adjust") {
        const st = String(row.status ?? "").toLowerCase();
        if (st === "completed") return "completed";
        return "pending";
      }

      if (row.source === "outbound") {
        return "completed";
      }

      return "";
    };

    let mergedAll = [...formattedAdjustments, ...formattedOutbounds];

    if (mode) {
      mergedAll = mergedAll.filter(
        (row: any) => getCombinedMode(row) === mode,
      );
    }

    const statusCounts = {
      manual: {
        pending: 0,
        completed: 0,
      },
      auto: {
        pending: 0,
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
      const da = new Date(a?.date ?? 0).getTime();
      const db = new Date(b?.date ?? 0).getTime();

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
    const id = Number(req.params.id);
    if (!id) throw badRequest("Invalid id");

    const data = await prisma.adjustment.findFirst({
      where: { id, deleted_at: null },
      include: {
        items: {
          where: { deleted_at: null },
          orderBy: [{ sequence: "asc" }, { id: "asc" }],
        },
      },
    });

    if (!data) throw badRequest("Adjustment not found");

    // ✅ ใช้ product_id เป็น key หลักในการหา barcode
    const productIds = Array.from(
      new Set(
        (data.items ?? []).map((it: any) => it.product_id).filter(Boolean),
      ),
    ) as number[];

    const barcodes =
      productIds.length > 0
        ? await prisma.barcode.findMany({
            where: {
              deleted_at: null,
              product_id: { in: productIds },
            },
            select: {
              id: true,
              product_id: true,
              barcode: true,

              // optional ที่มีจริง
              product_code: true,
              product_name: true,
              tracking: true,
              barcode_length: true,
              lot_start: true,
              lot_stop: true,
              exp_start: true,
              exp_stop: true,
              active: true,
              internal_use: true,
              barcode_last_modified_date: true,
            },
            orderBy: [{ id: "desc" }], // เอาตัวล่าสุดก่อน
          })
        : [];

    // product_id -> barcode row (เอาตัวแรกที่เจอหลัง order desc = ล่าสุด)
    const barcodeRowByProductId = new Map<number, any>();
    for (const b of barcodes as any[]) {
      const pid = b?.product_id;
      if (pid == null) continue;
      if (!barcodeRowByProductId.has(Number(pid))) {
        barcodeRowByProductId.set(Number(pid), b);
      }
    }

    // ✅ ดึง exp จาก wms_mdt_goods โดยเช็ค product_id + lot_id
    const goodsKeys = Array.from(
      new Set(
        (data.items ?? [])
          .filter((it: any) => it.product_id != null && it.lot_id != null)
          .map((it: any) => `${Number(it.product_id)}__${Number(it.lot_id)}`),
      ),
    );

    const goodsRows =
      goodsKeys.length > 0
        ? await prisma.wms_mdt_goods.findMany({
            where: {
              OR: (data.items ?? [])
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

    // product_id + lot_id -> goods row
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

    // ✅ เพิ่มข้อมูล barcode + exp จาก wms_mdt_goods ให้ FE
    const items = (data.items ?? []).map((it: any) => {
      const ref =
        it.product_id != null
          ? barcodeRowByProductId.get(Number(it.product_id))
          : null;

      const goodsRef =
        it.product_id != null && it.lot_id != null
          ? goodsRowByProductLot.get(
              `${Number(it.product_id)}__${Number(it.lot_id)}`,
            )
          : null;

      return {
        ...it,

        // คง logic เดิม
        barcode_text: ref?.barcode ? String(ref.barcode).trim() : null,

        // เพิ่ม barcode ref
        barcode_ref: ref
          ? {
              barcode_id: ref.id,
              barcode: ref.barcode ?? null,
              lot_start: ref.lot_start ?? null,
              lot_stop: ref.lot_stop ?? null,
              exp_start: ref.exp_start ?? null,
              exp_stop: ref.exp_stop ?? null,
            }
          : null,

        // ✅ เพิ่ม exp จาก wms_mdt_goods
        exp: goodsRef?.expiration_date ?? null,
      };
    });

    return res.json({ data: { ...data, items } });
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

export const scanAdjustmentLocation = asyncHandler(
  async (req: Request, res: Response) => {
    const no = decodeNoParam((req.params as any).no);

    // ✅ location_full_name จาก body
    const location_full_name = normalizeText(req.body?.location_full_name);

    if (!no) throw badRequest("Invalid no");
    if (!location_full_name) throw badRequest("กรุณาส่ง location_full_name");

    // ✅ ตรวจเอกสาร
    const adj = await prisma.adjustment.findFirst({
      where: { no, deleted_at: null },
      select: { id: true, no: true, status: true },
    });
    if (!adj) throw badRequest(`Adjustment not found: ${no}`);

    // ✅ (optional) จำกัดสถานะ: ให้ scan ได้เฉพาะ in-progress
    if (adj.status !== "in-progress") {
      throw badRequest(
        `Scan allowed only when status is in-progress (current: ${adj.status})`,
      );
    }

    // ✅ ดึง items ที่ location ตรง
    const items = await prisma.adjustment_item.findMany({
      where: {
        adjustment_id: adj.id,
        deleted_at: null,
        location: location_full_name,
      },
      orderBy: [{ sequence: "asc" }, { id: "asc" }],
    });

    // ✅ ถ้าไม่เจอให้แจ้งชัด ๆ (FE จะได้ toast)
    if (items.length === 0) {
      throw badRequest(
        `ไม่พบรายการในเอกสาร ${no} ที่ location = ${location_full_name}`,
      );
    }

    // ✅ map เป็น impact สำหรับ FE
    const impact = items.map((it) => ({
      key: String(it.id), // ✅ ใช้ id ของ adjustment_item
      code: it.code ?? "",
      name: it.name ?? "",
      // ให้ editable default เป็น location_dest ถ้ามี ไม่งั้นใช้ location ที่ scan
      location_full_name: it.location_dest ?? it.location ?? location_full_name,
      lot_serial: it.lot_serial ?? "",
      qty: it.qty ?? 0,
      qty_pick: it.qty_pick ?? 0,
      unit: it.unit ?? null,
    }));

    return res.json({
      no,
      location_full_name,
      impact,
      total: impact.length,
    });
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
    const no = decodeURIComponent((req.params as any).no);
    const barcode_payload = normalizeLot(
      req.body?.barcode_payload ?? req.body?.barcode,
    );

    if (!no) throw badRequest("Invalid no");
    if (!barcode_payload) throw badRequest("กรุณาส่ง barcode_payload");

    const adj = await prisma.adjustment.findFirst({
      where: { no, deleted_at: null },
      select: { id: true, status: true },
    });
    if (!adj) throw badRequest(`Adjustment not found: ${no}`);

    if (adj.status !== "in-progress") {
      throw badRequest(
        `Scan allowed only when status is in-progress (current: ${adj.status})`,
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1) หา candidates ทั้งหมดที่ payload ตรง
      const candidates = await tx.adjustment_item.findMany({
        where: {
          adjustment_id: adj.id,
          deleted_at: null,
          barcode_payload: barcode_payload,
        },
        orderBy: [{ sequence: "asc" }, { id: "asc" }],
      });

      if (candidates.length === 0) {
        throw badRequest(
          `ไม่พบ item ที่ตรงกับ barcode_payload นี้ในเอกสาร ${no}`,
        );
      }

      // 2) กันซ้ำ: เลือกตัวที่ยัง pick ไม่ครบก่อน
      const pickable =
        candidates.find((it) => (it.qty_pick ?? 0) < (it.qty ?? 0)) ??
        candidates[0];

      // 3) ถ้า pick ครบแล้วทั้งคู่ ก็ไม่ควรให้สแกนเพิ่ม
      const maxQty = pickable.qty ?? 0;
      const currentPick = pickable.qty_pick ?? 0;
      if (maxQty > 0 && currentPick >= maxQty) {
        throw badRequest("รายการนี้สแกนครบจำนวนแล้ว");
      }

      // 4) increment qty_pick แบบ atomic
      const updated = await tx.adjustment_item.update({
        where: { id: pickable.id },
        data: { qty_pick: { increment: 1 }, updated_at: new Date() },
      });

      return updated;
    });

    return res.json({
      success: true,
      no,
      barcode_payload,
      matched: {
        key: String(result.id),
        code: result.code ?? "",
        name: result.name ?? "",
        lot_serial: result.lot_serial ?? "",
        exp: (result as any).exp ?? null,
        location_dest: result.location_dest ?? "",
        qty: result.qty ?? 0,
        qty_pick: result.qty_pick ?? 0,
        unit: result.unit ?? null,
      },
      message: "scan ok (+1 qty_pick)",
    });
  },
);

function parseIntSafe(v: unknown, def = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.floor(n);
}

export const confirmAdjustmentCompleteByNo = asyncHandler(
  async (req: Request, res: Response) => {
    const no = decodeNoParam((req.params as any).no);
    if (!no) throw badRequest("Invalid no");

    // ✅ payload FE: { transfers: [...] } (ตามรูป)
    const lines = normalizeTransfersPayload(req.body);

    if (!Array.isArray(lines) || lines.length === 0) {
      throw badRequest("transfers.items ต้องมีอย่างน้อย 1 รายการ");
    }

    const adj = await prisma.adjustment.findFirst({
      where: { no, deleted_at: null },
      select: {
        id: true,
        no: true,
        status: true,
        department: true,
        department_id: true,
        reference: true,
        origin: true,
        date: true,
      },
    });
    if (!adj) throw badRequest(`Adjustment not found: ${no}`);

    if (adj.status !== "pending" && adj.status !== "in-progress") {
      throw badRequest(`Transition not allowed: ${adj.status} -> completed`);
    }

    const inboundNo = no;

    const result = await prisma.$transaction(async (tx) => {
      // preload items เพื่อ resolve id กรณี FE ไม่ส่ง adjustment_item.id
      const adjItems = await tx.adjustment_item.findMany({
        where: { adjustment_id: adj.id, deleted_at: null },
        select: {
          id: true,
          product_id: true,
          lot_serial: true,
          sequence: true,
          qty: true,
          qty_pick: true,
          name: true,
          unit: true,
          code: true,
          lot_id: true,
          tracking: true,
        } as any,
        orderBy: [{ sequence: "asc" }, { id: "asc" }],
      });

      // 1) update adjustment_item ตาม lines
      const updatedItemIds: number[] = [];

      for (const line of lines) {
        const qtyPick = Math.max(0, parseIntSafe(line.qty_pick, 0));
        if (qtyPick <= 0) throw badRequest("qty_pick ต้องมากกว่า 0");

        const location_dest = normalizeText(line.location_dest);
        if (!location_dest) throw badRequest("location_dest ห้ามว่าง");

        // lot_serial: optional ถ้าไม่ส่งมา ใช้ของเดิมได้
        const lotIncoming = normalizeLotOptional(line.lot_serial);

        // ✅ resolve adjustment_item.id
        const itemId = resolveAdjustmentItemId({
          line,
          adjItems,
        });
        if (!itemId)
          throw badRequest(
            "หา adjustment_item ไม่เจอ (product/lot/sequence ไม่ตรง)",
          );

        const updated = await tx.adjustment_item.updateMany({
          where: { id: itemId, adjustment_id: adj.id, deleted_at: null },
          data: {
            location_dest,

            ...(lotIncoming !== undefined ? { lot_serial: lotIncoming } : {}),

            // ✅ requirement: บวกทั้ง qty และ qty_pick,
            qty_pick: { increment: qtyPick },

            updated_at: new Date(),
          } as any,
        });

        if (updated.count === 0) {
          throw badRequest(`ไม่พบ item id=${itemId} ใน adjustment ${no}`);
        }

        updatedItemIds.push(itemId);
      }

      // 2) upsert inbound (no unique)
      const inbound =
        (await tx.inbound.findFirst({
          where: { no: inboundNo, deleted_at: null },
          select: { id: true, no: true },
        })) ??
        (await tx.inbound.create({
          data: {
            no: inboundNo,
            date: adj.date ?? new Date(),
            in_type: "ADJ",
            department: adj.department ?? "",
            department_id: adj.department_id ?? null,
            reference: adj.reference ?? null,
            origin: adj.origin ?? null,
          } as any,
          select: { id: true, no: true },
        }));

      // 3) โหลด item ล่าสุด
      const items = await tx.adjustment_item.findMany({
        where: {
          adjustment_id: adj.id,
          deleted_at: null,
          id: { in: updatedItemIds },
        },
        orderBy: [{ sequence: "asc" }, { id: "asc" }],
      });

      const totalPick = items.reduce(
        (sum: number, it: any) => sum + Number(it.qty_pick ?? 0),
        0,
      );
      if (totalPick <= 0) {
        throw badRequest(
          "ยังไม่มีการสแกนสินค้า (qty_pick = 0) ไม่สามารถ Complete ได้",
        );
      }

      // 4) preload barcode by product_id จาก DB (เอาตัวล่าสุด)
      const productIds = Array.from(
        new Set(items.map((it: any) => it.product_id).filter(Boolean)),
      ) as number[];

      const barcodeRows =
        productIds.length > 0
          ? await tx.barcode.findMany({
              where: { deleted_at: null, product_id: { in: productIds } },
              select: { id: true, product_id: true, barcode: true } as any,
              orderBy: [{ id: "desc" }],
            })
          : [];

      const barcodeByProductId = new Map<number, any>();
      for (const b of barcodeRows as any[]) {
        const pid = Number(b.product_id);
        if (!barcodeByProductId.has(pid)) barcodeByProductId.set(pid, b);
      }

      // map exp/location_dest/barcode ที่มาจาก FE ต่อ itemId
      const extraByItemId = new Map<
        number,
        {
          exp: Date | null;
          location_dest: string | null;
          barcode_id: number | null;
          barcode_text: string | null;
        }
      >();

      for (const line of lines) {
        const itemId = resolveAdjustmentItemId({ line, adjItems });
        if (!itemId) continue;

        const expDate = parseExpireDateOptional(line.expire_date);
        const locDest = normalizeText(line.location_dest) || null;

        const feBarcode0 = Array.isArray(line?.barcodes)
          ? line.barcodes[0]
          : null;
        const feBarcodeId =
          feBarcode0?.barcode_id != null ? Number(feBarcode0.barcode_id) : null;
        const feBarcodeText =
          feBarcode0?.barcode != null
            ? String(feBarcode0.barcode).trim()
            : null;

        extraByItemId.set(itemId, {
          exp: expDate,
          location_dest: locDest,
          barcode_id: feBarcodeId,
          barcode_text: feBarcodeText,
        });
      }

      let created = 0;
      let skippedExists = 0;

      for (const it of items as any[]) {
        const qtyPick = Math.max(0, parseIntSafe(it.qty_pick, 0));
        if (qtyPick <= 0) continue;

        const odoo_line_key = `ADJ:${no}:${it.id}`;

        const exists = await tx.goods_in.findFirst({
          where: { odoo_line_key, deleted_at: null },
          select: { id: true },
        });
        if (exists) {
          skippedExists++;
          continue;
        }

        const pid = it.product_id != null ? Number(it.product_id) : null;

        const extra = extraByItemId.get(Number(it.id)) ?? {
          exp: null,
          location_dest: null,
          barcode_id: null,
          barcode_text: null,
        };

        // ✅ barcode ใช้ DB เป็นหลัก แต่ fallback ใช้ FE ถ้า DB ไม่มี
        const dbRow = pid != null ? barcodeByProductId.get(pid) : null;
        const dbBarcodeText = String(dbRow?.barcode ?? "").trim() || null;

        const finalBarcodeText = dbBarcodeText ?? extra.barcode_text ?? null;
        const finalBarcodeId = dbRow?.id ?? extra.barcode_id ?? null;

        const barcode_payload =
          finalBarcodeText != null
            ? buildAdjustmentBarcodePayload({
                barcode: finalBarcodeText,
                lot_serial: it.lot_serial ?? null,
                exp: extra.exp,
              })
            : null;

        await tx.goods_in.create({
          data: {
            inbound_id: inbound.id,

            sequence: it.sequence ?? null,
            product_id: pid,
            code: it.code ?? null,
            name: String(it.name ?? "").trim() || "-",
            unit: String(it.unit ?? "").trim() || "-",

            quantity_receive: qtyPick,
            quantity_count: 0,
            qty: qtyPick,

            lot_serial: it.lot_serial ?? null,
            lot: it.lot_serial ?? it.lot ?? null,
            lot_id: it.lot_id ?? null,
            tracking: it.tracking ?? null,

            exp: extra.exp,

            barcode_id: finalBarcodeId,
            barcode_text: finalBarcodeText,
            barcode_payload,

            // ✅ ตาม schema ที่คุณเพิ่ม
            location_dest: extra.location_dest ?? it.location_dest ?? null,

            in_process: false,

            odoo_line_key,
            odoo_sequence: it.sequence ?? null,
          } as any,
        });

        created++;
      }

      await tx.adjustment.update({
        where: { id: adj.id },
        data: { status: "completed", updated_at: new Date() },
      });

      return { inbound_no: inbound.no, created, skippedExists };
    });

    return res.json({
      success: true,
      no,
      inbound_no: result.inbound_no,
      goods_in_created: result.created,
      goods_in_skipped_exists: result.skippedExists,
    });
  },
);

/** =========================================================
 * Helpers: รองรับ payload จาก FE (transfers) + ของเดิม (impact_lines)
 * ========================================================= */

function normalizeTransfersPayload(body: any) {
  const transfers = Array.isArray(body?.transfers) ? body.transfers : [];
  if (transfers.length === 0) return [];

  // ส่วนใหญ่ FE ส่ง 1 transfer ต่อ 1 complete
  const t0 = transfers[0] ?? {};
  const items = Array.isArray(t0?.items) ? t0.items : [];

  return items
    .map((it: any) => ({
      // FE payload ตามรูป
      product_id: it?.product_id ?? null,
      sequence: it?.sequence ?? null,

      lot_serial: it?.lot_serial ?? null,
      expire_date: it?.expire_date ?? null,

      qty_pick: it?.qty_pick ?? it?.qty ?? 0,

      // location_dest ต้องมาจาก item เป็นหลัก (ถ้ามี) ไม่งั้น fallback จาก transfer
      location_dest: it?.location_dest ?? t0?.location_dest ?? null,

      // barcode list ตามรูป: [{ barcode_id, barcode }]
      barcodes: Array.isArray(it?.barcodes) ? it.barcodes : [],
    }))
    .filter((x: any) => Number(parseIntSafe(x.qty_pick, 0)) > 0);
}

function resolveAdjustmentItemId(input: {
  line: any;
  adjItems: any[];
}): number | null {
  // ✅ FE ไม่ส่ง key/id ของ adjustment_item → resolve ด้วย product_id + lot_serial + sequence
  const pid =
    input.line?.product_id != null ? Number(input.line.product_id) : null;
  if (!pid) return null;

  const lot = normalizeLotOptional(input.line?.lot_serial);
  const seq = input.line?.sequence != null ? Number(input.line.sequence) : null;

  const candidates = input.adjItems.filter((x: any) => {
    if (Number(x.product_id ?? 0) !== pid) return false;

    if (lot !== undefined) {
      const xl = normalizeLotOptional(x.lot_serial);
      if (xl !== lot) return false;
    }

    if (seq != null && Number(x.sequence ?? 0) !== seq) return false;

    return true;
  });

  if (candidates.length === 1) return Number(candidates[0].id);

  // ถ้าหลายตัว: เลือกตัวที่ qty_pick ยังน้อยที่สุดก่อน
  if (candidates.length > 1) {
    const sorted = [...candidates].sort((a: any, b: any) => {
      const ap = Number(a.qty_pick ?? 0);
      const bp = Number(b.qty_pick ?? 0);
      if (ap !== bp) return ap - bp;
      return Number(a.id) - Number(b.id);
    });
    return Number(sorted[0].id);
  }

  return null;
}

function normalizeLotOptional(v: unknown): string | undefined {
  const s = String(v ?? "")
    .trim()
    .replace(/\s+/g, "");
  return s ? s : undefined;
}

function parseExpireDateOptional(v: unknown): Date | null {
  const s = String(v ?? "").trim();
  if (!s) return null;

  // FE ส่ง "YYYY-MM-DD"
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

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

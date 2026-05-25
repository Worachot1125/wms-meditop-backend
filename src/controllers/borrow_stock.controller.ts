import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
import { formatBorrowStock } from "../utils/formatters/borrow_stocks.formatter";
import { AuthRequest, buildDepartmentAccessWhere } from "../middleware/auth";

import {
  normalizeScanText,
  normalizeLot,
  normalizeExpInput,
  toDateOnlyKey,
  resolveBarcodeScan,
  LOT_NULL_PLACEHOLDER,
} from "../utils/helper_scan/barcode";
import { resolveLocationByFullNameBasic } from "../utils/helper_scan/location";
import { io } from "../index";
import { borrowStockDailyService } from "../services/borrow_stockdaily.service";

const emitBorrowStockRealtime = (
  borrowStock: { id: number },
  event: string,
  payload: any,
) => {
  try {
    const id = Number(borrowStock.id);
    if (!id) return;

    io.to(`borrow_stock:${id}`).emit(event, payload);
    io.emit(event, payload);
  } catch {}
};

function getIO(req: Request) {
  return (req.app as any).get("io");
}

function emitBorrowStockRoom(
  req: Request,
  borrowStockId: number,
  event: string,
  payload: any,
) {
  const io = getIO(req);
  if (!io) return;

  io.to(`borrow_stock:${borrowStockId}`).emit(event, payload);
}

function emitBorrowStockList(req: Request, event: string, payload: any) {
  const io = getIO(req);
  if (!io) return;

  io.to("borrow_stock:list").emit(event, payload);
}

// ใช้ตัวเดิมของคุณได้เลย (ที่มีอยู่แล้ว)
async function resolveLocationByFullName(full_name: string) {
  const loc = await prisma.location.findFirst({
    where: { full_name, deleted_at: null },
    select: { id: true, full_name: true },
  });
  if (!loc) throw badRequest(`ไม่พบ location full_name: ${full_name}`);
  return loc;
}

function toIntSystemQty(decimalLike: any): number {
  const n = Number(decimalLike ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.floor(n);
}

function pickIntIdParam(req: Request, key: string) {
  const raw = (req.params as any)?.[key];
  const v = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw badRequest(`${key} ไม่ถูกต้อง`);
  return n;
}

function dateKeyUTC(d: Date | null | undefined) {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

function parseYYMMDDToDateUTC(yymmdd: string): Date | null {
  const s = String(yymmdd ?? "").trim();
  if (!/^\d{6}$/.test(s)) return null;
  if (s === "999999") return null;

  const yy = Number(s.slice(0, 2));
  const mm = Number(s.slice(2, 4));
  const dd = Number(s.slice(4, 6));
  if (mm < 1 || mm > 12) return null;
  if (dd < 1 || dd > 31) return null;

  const yyyy = 2000 + yy;
  const dt = new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0));
  return Number.isFinite(dt.getTime()) ? dt : null;
}

/**
 * payload = <barcode_text><lot_serial(variable)><exp YYMMDD 6 ตัวท้าย>
 * - exp 999999 => null
 * - lot_serial ว่างได้ => null
 * - barcode_text ต้องเป็น prefix ที่ match barcode master
 */
async function resolveBarcodeTextLotExpFromPayload(payload: string) {
  const text = normalizeScanText(payload);
  if (!text) throw badRequest("กรุณาส่ง barcode");
  if (text.length < 7) throw badRequest(`barcode payload สั้นเกินไป: ${text}`);

  const expPart = text.slice(-6);
  if (!/^\d{6}$/.test(expPart)) {
    throw badRequest(`exp ต้องเป็นเลข 6 หลักท้าย payload (YYMMDD): ${text}`);
  }
  const expDate = parseYYMMDDToDateUTC(expPart);

  const front = text.slice(0, -6);
  if (!front)
    throw badRequest(`payload ไม่ถูกต้อง (ไม่มี barcode ก่อน exp): ${text}`);

  // ใช้ master barcode หา prefix ที่ยาวที่สุด
  const masters = await prisma.barcode.findMany({
    where: { deleted_at: null },
    select: { barcode: true },
  });

  let matchedBarcodeText: string | null = null;
  for (const m of masters) {
    const b = normalizeScanText(m.barcode);
    if (!b) continue;
    if (front.startsWith(b)) {
      if (!matchedBarcodeText || b.length > matchedBarcodeText.length) {
        matchedBarcodeText = b;
      }
    }
  }

  if (!matchedBarcodeText) {
    throw badRequest(`ไม่พบ barcode master ที่ match payload: ${text}`);
  }

  const lotRaw = front.slice(matchedBarcodeText.length);
  const lotSerial = !lotRaw || lotRaw === "XXXXXX" ? null : lotRaw;

  return {
    payload: text,
    barcode_text: matchedBarcodeText,
    lot_serial: lotSerial,
    exp: expDate, // Date | null
  };
}

function parseDepartmentIds(input: unknown): number[] {
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

function parseBooleanTrue(input: unknown): boolean {
  return (
    String(input ?? "")
      .trim()
      .toLowerCase() === "true"
  );
}

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
/**
 * =========================
 * Search helpers
 * =========================
 */
function parseSearchColumns(raw: unknown) {
  if (typeof raw !== "string") return [];

  const allowed = new Set([
    "date",
    "location_name",
    "department",
    "status",
    "user_ref",
  ]);

  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => allowed.has(s));
}

function buildBorrowStockSearchWhere(
  search: string,
  columns: string[],
): Prisma.borrow_stockWhereInput {
  const baseWhere: Prisma.borrow_stockWhereInput = { deleted_at: null };

  if (!search) return baseWhere;

  const orConditions: Prisma.borrow_stockWhereInput[] = [];

  if (columns.includes("date")) {
    const maybeDate = new Date(search);
    if (!Number.isNaN(maybeDate.getTime())) {
      const yyyy = maybeDate.getUTCFullYear();
      const mm = String(maybeDate.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(maybeDate.getUTCDate()).padStart(2, "0");

      orConditions.push({
        created_at: {
          gte: new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`),
          lt: new Date(`${yyyy}-${mm}-${dd}T23:59:59.999Z`),
        },
      });
    }
  }

  if (columns.includes("location_name")) {
    orConditions.push({
      location_name: { contains: search, mode: "insensitive" },
    });
  }

  if (columns.includes("department")) {
    orConditions.push({
      department: {
        is: {
          OR: [
            { full_name: { contains: search, mode: "insensitive" } },
            { short_name: { contains: search, mode: "insensitive" } },
          ],
        },
      },
    });
  }

  if (columns.includes("status")) {
    orConditions.push({
      status: { contains: search, mode: "insensitive" },
    });
  }

  if (columns.includes("user_ref")) {
    orConditions.push({
      user_ref: { contains: search, mode: "insensitive" },
    });
  }

  // มี search แต่ไม่มี column ที่เลือก หรือ search date แต่ parse ไม่ได้
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
 * =========================
 * Build detail (include)
 * =========================
 */
async function buildBorrowStockDetail(id: number) {
  const doc = await prisma.borrow_stock.findUnique({
    where: { id },
    include: {
      department: true,
      borrowStockItems: {
        where: { deleted_at: null },
        orderBy: { id: "asc" },
      },
    },
  });

  if (!doc || doc.deleted_at) throw notFound(`ไม่พบ borrow_stock: ${id}`);
  return formatBorrowStock(doc as any);
}

function buildUserRefFromAuth(req: Request) {
  const u = (req as any).user as
    | { first_name?: string | null; last_name?: string | null }
    | undefined;

  if (!u) throw badRequest("Unauthorized");

  const first = String(u.first_name ?? "").trim();
  const last = String(u.last_name ?? "").trim();

  const ref = [first, last].filter(Boolean).join(" ").trim();

  if (!ref) {
    throw badRequest(
      "user_ref ว่าง (กรุณาตั้ง first_name/last_name ให้ผู้ใช้งาน)",
    );
  }

  return ref;
}

async function resolveBorrowStockAllowedLocation(location_full_name: string) {
  const loc = await prisma.location.findFirst({
    where: {
      full_name: location_full_name,
      deleted_at: null,
    },
    select: {
      id: true,
      full_name: true,
      lock_no: true,
      building: {
        select: {
          id: true,
          short_name: true,
        },
      },
      zone: {
        select: {
          id: true,
          short_name: true,
        },
      },
    },
  });

  if (!loc) {
    throw badRequest(`ไม่พบ location full_name: ${location_full_name}`);
  }

  const buildingName = String(loc.building?.short_name ?? "")
    .trim()
    .toUpperCase();
  const zoneName = String(loc.zone?.short_name ?? "")
    .trim()
    .toUpperCase();
  const lockNo = String(loc.lock_no ?? "")
    .trim()
    .toUpperCase();

  const allowedBuilding = buildingName === "BOR/BOS";
  const allowedZone = zoneName === "F01";
  const allowedLock = lockNo === "BOR" || lockNo === "BOS";

  if (!allowedBuilding || !allowedZone || !allowedLock) {
    throw badRequest(
      `location นี้ไม่อนุญาตให้ใช้กับ Borrow Stock (ต้องเป็น building=BOR/BOS, zone=F01, lock_no=BOR หรือ BOS เท่านั้น)`,
    );
  }

  return {
    id: loc.id,
    full_name: loc.full_name,
    lock_no: loc.lock_no,
    building_name: loc.building?.short_name ?? null,
    zone_name: loc.zone?.short_name ?? null,
  };
}

export const scanBorrowStockLocation = asyncHandler(
  async (
    req: Request<{ no: string }, {}, { location_full_name: string }>,
    res: Response,
  ) => {
    const no = decodeURIComponent(String(req.params.no ?? "")).trim();
    if (!no) throw badRequest("ไม่พบเลข Borrow Stock");

    const location_full_name = String(req.body.location_full_name ?? "").trim();
    if (!location_full_name) throw badRequest("กรุณาส่ง location_full_name");

    const borrowStock = await prisma.borrow_stock.findFirst({
      where: {
        deleted_at: null,
      },
      select: {
        id: true,
      },
    });

    if (!borrowStock) throw badRequest("ไม่พบ Borrow Stock");

    const loc = await resolveBorrowStockAllowedLocation(location_full_name);

    const payload = {
      location: {
        location_id: loc.id,
        location_name: loc.full_name,
      },
    };

    emitBorrowStockRealtime(
      {
        id: borrowStock.id,
      },
      "borrow_stock:scan_location",
      {
        id: borrowStock.id,
        message: "Borrow Stock location scanned",
      },
    );

    return res.json(payload);
  },
);

export const scanBorrowStockBarcodePreview = asyncHandler(
  async (
    req: Request<{}, {}, { barcode: string; location_full_name: string }>,
    res: Response,
  ) => {
    const location_full_name = String(req.body.location_full_name ?? "").trim();
    if (!location_full_name) throw badRequest("กรุณาส่ง location_full_name");

    const loc = await resolveBorrowStockAllowedLocation(location_full_name);
    const parsed = await resolveBarcodeScan(req.body.barcode);

    const parsedLockNo = String(loc.lock_no ?? "")
      .trim()
      .toUpperCase();

    if (!["BOR", "BOS", "SER"].includes(parsedLockNo)) {
      throw badRequest(
        `location นี้ไม่รองรับ borrow/ser stock (lock_no=${loc.lock_no ?? "-"})`,
      );
    }

    const parsedLot = normalizeLot(parsed.lot_serial);

    const giCandidates = await prisma.goods_in.findMany({
      where: {
        deleted_at: null,
        barcode_text: parsed.barcode_text,
        ...(parsedLot
          ? { lot_serial: parsedLot }
          : {
              OR: [
                { lot_serial: null },
                { lot_serial: "" },
                { lot_serial: LOT_NULL_PLACEHOLDER },
              ],
            }),
      },
      select: {
        id: true,
        code: true,
        name: true,
        unit: true,
        lot_serial: true,
        exp: true,
        product_id: true,
        barcode_text: true,
      },
      take: 50,
    });

    const needExpKey = toDateOnlyKey(parsed.exp);

    const gi =
      (needExpKey
        ? giCandidates.find((x) => toDateOnlyKey(x.exp) === needExpKey)
        : giCandidates.find((x) => !x.exp)) ??
      giCandidates[0] ??
      null;

    if (!gi) {
      throw badRequest(
        `ไม่พบ goods_in ที่ตรงกับ barcode_text=${parsed.barcode_text}, lot=${parsedLot ?? "null"}, exp=${needExpKey ?? "null"}`,
      );
    }

    if (!gi.code) {
      throw badRequest(
        "goods_in.code เป็น null (ไม่สามารถสร้าง borrow item ได้)",
      );
    }

    const giLot = normalizeLot(gi.lot_serial);

    let stock = null as null | {
      quantity: any;
      unit: string | null;
      expiration_date: Date | null;
      location_id: number | null;
      location_name: string | null;
      source_table: "bor_stock" | "ser_stock";
    };

    if (gi.product_id != null) {
      const giExpKey = toDateOnlyKey(gi.exp);

      if (parsedLockNo === "SER") {
        const stockCandidates = await prisma.ser_stock.findMany({
          where: {
            product_id: gi.product_id,
            ...(giLot
              ? { lot_name: giLot }
              : {
                  OR: [
                    { lot_name: null },
                    { lot_name: "" },
                    { lot_name: LOT_NULL_PLACEHOLDER },
                  ],
                }),
            ...(loc.id
              ? { location_id: loc.id }
              : { location_name: loc.full_name }),
          },
          select: {
            quantity: true,
            unit: true,
            expiration_date: true,
            location_id: true,
            location_name: true,
          },
          take: 50,
          orderBy: { id: "desc" },
        });

        const picked =
          (giExpKey
            ? stockCandidates.find(
                (s) => toDateOnlyKey(s.expiration_date) === giExpKey,
              )
            : stockCandidates.find((s) => !s.expiration_date)) ??
          stockCandidates[0] ??
          null;

        if (picked) {
          stock = {
            quantity: picked.quantity,
            unit: picked.unit ?? null,
            expiration_date: picked.expiration_date ?? null,
            location_id: picked.location_id ?? null,
            location_name: picked.location_name ?? null,
            source_table: "ser_stock",
          };
        }
      } else {
        const stockCandidates = await prisma.bor_stock.findMany({
          where: {
            product_id: gi.product_id,
            ...(giLot
              ? { lot_name: giLot }
              : {
                  OR: [
                    { lot_name: null },
                    { lot_name: "" },
                    { lot_name: LOT_NULL_PLACEHOLDER },
                  ],
                }),
            ...(loc.id
              ? { location_id: loc.id }
              : { location_name: loc.full_name }),
          },
          select: {
            quantity: true,
            unit: true,
            expiration_date: true,
            location_id: true,
            location_name: true,
          },
          take: 50,
          orderBy: { id: "desc" },
        });

        const picked =
          (giExpKey
            ? stockCandidates.find(
                (s) => toDateOnlyKey(s.expiration_date) === giExpKey,
              )
            : stockCandidates.find((s) => !s.expiration_date)) ??
          stockCandidates[0] ??
          null;

        if (picked) {
          stock = {
            quantity: picked.quantity,
            unit: picked.unit ?? null,
            expiration_date: picked.expiration_date ?? null,
            location_id: picked.location_id ?? null,
            location_name: picked.location_name ?? null,
            source_table: "bor_stock",
          };
        }
      }
    }

    const system_qty = stock ? toIntSystemQty(stock.quantity) : 0;

    const payload = {
      location: {
        location_id: loc.id,
        location_name: loc.full_name,
        lock_no: loc.lock_no ?? null,
      },
      scanned: {
        barcode: parsed.raw_input,
        normalized_input: parsed.normalized_input,
        barcode_text: parsed.barcode_text,
        lot_serial: parsedLot,
        exp: parsed.exp ? parsed.exp.toISOString() : null,
        matched_by: parsed.matched_by,
      },
      goods_in: {
        id: gi.id,
        code: gi.code,
        name: gi.name,
        unit: gi.unit,
        lot_serial: giLot,
        exp: gi.exp ? gi.exp.toISOString() : null,
        product_id: gi.product_id,
        barcode_text: gi.barcode_text,
      },
      item: {
        code: gi.code,
        name: gi.name ?? null,
        lot_serial: giLot,
        expiration_date: gi.exp ? gi.exp.toISOString() : null,
        system_qty,
        executed_qty: 0,
        unit: stock?.unit ?? gi.unit ?? null,
      },
      stock_source: stock
        ? {
            table: stock.source_table,
            location_id: stock.location_id,
            location_name: stock.location_name,
            expiration_date: stock.expiration_date
              ? stock.expiration_date.toISOString()
              : null,
          }
        : null,
    };

    emitBorrowStockRealtime({ id: 0 }, "borrow_stock:scan_barcode_preview", {
      message: "Borrow Stock barcode preview scanned",
    });

    return res.json(payload);
  },
);

/**
 * =========================
 * 1) Start (create draft)
 * POST /api/borrow-stocks/start
 * =========================
 */
export const startBorrowStock = asyncHandler(
  async (
    req: Request<
      {},
      {},
      {
        location_full_name: string;
        department_ids?: number[] | string;
        all_departments?: boolean | string;
        remark?: string | null;
        items: Array<{
          code: string;
          name?: string | null;
          lot_serial: string;
          expiration_date?: string | null;
          system_qty: number;
          executed_qty?: number | null;
          is_outside_location?: boolean | string;
        }>;
      }
    >,
    res: Response,
  ) => {
    const location_full_name = String(req.body.location_full_name ?? "").trim();
    if (!location_full_name) throw badRequest("กรุณาส่ง location_full_name");

    const all_departments =
      typeof req.body.all_departments === "boolean"
        ? req.body.all_departments
        : String(req.body.all_departments ?? "")
            .trim()
            .toLowerCase() === "true";

    const department_ids = parseDepartmentIds(req.body.department_ids);

    if (!all_departments && department_ids.length === 0) {
      throw badRequest("กรุณาเลือก department อย่างน้อย 1 รายการ");
    }

    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (items.length === 0) {
      throw badRequest("กรุณาสแกนรายการอย่างน้อย 1 รายการ");
    }

    const remark = req.body.remark ?? null;
    const user_ref = buildUserRefFromAuth(req);
    const loc = await resolveLocationByFullNameBasic(location_full_name);

    const selectedDepartments = all_departments
      ? []
      : await prisma.department.findMany({
          where: {
            id: { in: department_ids },
          },
          select: {
            id: true,
            short_name: true,
            full_name: true,
            odoo_id: true,
          },
        });

    const borDepartmentIds = selectedDepartments
      .map((d) => String(d.odoo_id ?? "").trim())
      .filter(Boolean);

    if (!all_departments && borDepartmentIds.length === 0) {
      throw badRequest(
        "department ที่เลือกยังไม่มี external/odoo id สำหรับใช้ตรวจสอบ bor_stock",
      );
    }

    for (const [index, it] of items.entries()) {
      const code = String(it.code ?? "").trim();
      const lotSerial = normalizeLot(it.lot_serial);
      const expirationDate = normalizeExpInput(it.expiration_date);
      const systemQty = Math.floor(Number(it.system_qty ?? 0));
      const executedQty =
        it.executed_qty == null ? 0 : Math.floor(Number(it.executed_qty));
      const isOutsideLocation =
        it.is_outside_location === true ||
        String(it.is_outside_location ?? "")
          .trim()
          .toLowerCase() === "true";

      if (!code) throw badRequest(`items[${index}].code ห้ามว่าง`);

      if (!Number.isFinite(systemQty) || systemQty < 0) {
        throw badRequest(`items[${index}] system_qty ไม่ถูกต้อง (SKU ${code})`);
      }

      if (!Number.isFinite(executedQty) || executedQty < 0) {
        throw badRequest(
          `items[${index}] executed_qty ไม่ถูกต้อง (SKU ${code})`,
        );
      }

      if (!isOutsideLocation && executedQty > systemQty) {
        throw badRequest(
          `items[${index}] executed_qty เกิน system_qty (SKU ${code}, lot ${lotSerial ?? "null"})`,
        );
      }

      if (isOutsideLocation) {
        const existsInWms = await prisma.goods_in.findFirst({
          where: {
            deleted_at: null,
            code,
            ...(lotSerial
              ? { lot_serial: lotSerial }
              : {
                  OR: [
                    { lot_serial: null },
                    { lot_serial: "" },
                    { lot_serial: LOT_NULL_PLACEHOLDER },
                  ],
                }),
          },
          select: { id: true },
        });

        if (!existsInWms) {
          throw badRequest(
            `items[${index}] SKU ${code} / lot ${lotSerial ?? "null"} ไม่พบใน WMS`,
          );
        }

        continue;
      }

      const borStockRow = await prisma.bor_stock.findFirst({
        where: {
          location_name: loc.full_name,
          product_code: code,
          ...(lotSerial
            ? { lot_name: lotSerial }
            : {
                OR: [
                  { lot_name: null },
                  { lot_name: "" },
                  { lot_name: LOT_NULL_PLACEHOLDER },
                ],
              }),
          active: true,
          ...(all_departments
            ? {}
            : borDepartmentIds.length > 0
              ? { department_id: { in: borDepartmentIds } }
              : {}),
        },
        select: {
          id: true,
          product_code: true,
          location_name: true,
          department_id: true,
          department_name: true,
          lot_name: true,
          expiration_date: true,
          quantity: true,
        },
      });

      if (!borStockRow) {
        const debugBorRows = await prisma.bor_stock.findMany({
          where: {
            location_name: loc.full_name,
            product_code: code,
            active: true,
          },
          select: {
            id: true,
            product_code: true,
            location_name: true,
            department_id: true,
            department_name: true,
            lot_name: true,
            expiration_date: true,
            quantity: true,
          },
          take: 20,
        });

        throw badRequest(
          `items[${index}] SKU ${code} / lot ${lotSerial ?? "null"} ไม่อยู่ใน location ${loc.full_name} ตาม department ที่เลือก`,
        );
      }
    }

    const created = await prisma.borrow_stock.create({
      data: {
        location_name: loc.full_name,
        remark,
        user_ref,
        status: "pending",

        borrowStockDepartments: {
          create: all_departments
            ? []
            : department_ids.map((deptId) => ({
                department_id: deptId,
              })),
        },

        borrowStockItems: {
          create: items.map((it) => {
            const lotSerial = normalizeLot(it.lot_serial);
            const expirationDate = normalizeExpInput(it.expiration_date);

            return {
              code: String(it.code ?? "").trim(),
              name: it.name ?? null,
              lot_serial: lotSerial ?? LOT_NULL_PLACEHOLDER,
              expiration_date: expirationDate ? new Date(expirationDate) : null,
              system_qty: Math.floor(Number(it.system_qty ?? 0)),
              executed_qty:
                it.executed_qty == null
                  ? 0
                  : Math.floor(Number(it.executed_qty)),
            };
          }),
        },
      },
      include: {
        borrowStockDepartments: {
          include: {
            department: true,
          },
        },
        borrowStockItems: {
          where: { deleted_at: null },
          orderBy: { id: "asc" },
        },
      },
    });

    emitBorrowStockRealtime(
      {
        id: created.id,
      },
      "borrow_stock:started",
      {
        id: created.id,
        message: "Borrow Stock started",
        data: created,
      },
    );

    return res.json({
      location: {
        location_id: loc.id,
        location_name: loc.full_name,
      },
      all_departments,
      department_ids,
      doc: formatBorrowStock(created as any),
    });
  },
);

/**
 * =========================
 * 2) Scan Barcode/Code/Serial
 * POST /api/borrow-stocks/:id/scan-barcode
 * =========================
 */
export const scanBorrowStockBarcode = asyncHandler(
  async (
    req: Request<
      { id: string },
      {},
      { barcode: string; location_full_name: string }
    >,
    res: Response,
  ) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) throw badRequest("id ไม่ถูกต้อง");

    const location_full_name = String(req.body.location_full_name ?? "").trim();
    if (!location_full_name) throw badRequest("กรุณาส่ง location_full_name");

    const parsed = await resolveBarcodeScan(req.body.barcode);
    const loc = await resolveLocationByFullNameBasic(location_full_name);

    const doc = await prisma.borrow_stock.findUnique({
      where: { id },
      select: { id: true, location_name: true, deleted_at: true },
    });
    if (!doc || doc.deleted_at) throw notFound(`ไม่พบ borrow_stock: ${id}`);

    if (doc.location_name !== loc.full_name) {
      throw badRequest(
        `location ไม่ตรงกับเอกสาร (doc=${doc.location_name}, scan=${loc.full_name})`,
      );
    }

    const parsedLot = normalizeLot(parsed.lot_serial);
    const parsedExpKey = toDateOnlyKey(parsed.exp);

    const giCandidates = await prisma.goods_in.findMany({
      where: {
        deleted_at: null,
        barcode_text: parsed.barcode_text,
        ...(parsedLot
          ? { lot_serial: parsedLot }
          : {
              OR: [
                { lot_serial: null },
                { lot_serial: "" },
                { lot_serial: LOT_NULL_PLACEHOLDER },
              ],
            }),
      },
      select: {
        id: true,
        product_id: true,
        code: true,
        name: true,
        unit: true,
        lot_serial: true,
        exp: true,
        barcode_text: true,
      },
      take: 50,
      orderBy: { id: "desc" },
    });

    const gi =
      (parsedExpKey
        ? giCandidates.find((x) => toDateOnlyKey(x.exp) === parsedExpKey)
        : giCandidates.find((x) => !x.exp)) ??
      giCandidates[0] ??
      null;

    if (!gi) {
      throw badRequest(
        `ไม่พบ goods_in ที่ตรงกับ barcode_text=${parsed.barcode_text}, lot=${parsedLot ?? "null"}, exp=${parsedExpKey ?? "null"}`,
      );
    }

    const giLot = normalizeLot(gi.lot_serial);

    const stockCandidates = await prisma.stock.findMany({
      where: {
        deleted_at: null as any,
        location_name: loc.full_name,
        ...(gi.product_id != null ? { product_id: gi.product_id } : {}),
        ...(gi.code ? { product_code: gi.code } : {}),
        ...(giLot
          ? { lot_name: giLot }
          : {
              OR: [
                { lot_name: null },
                { lot_name: "" },
                { lot_name: LOT_NULL_PLACEHOLDER },
              ],
            }),
      } as any,
      select: {
        product_id: true,
        product_code: true,
        product_name: true,
        lot_name: true,
        expiration_date: true,
        quantity: true,
        unit: true,
      },
      take: 50,
      orderBy: { id: "desc" },
    });

    const stock =
      (parsedExpKey
        ? stockCandidates.find(
            (x) => toDateOnlyKey(x.expiration_date) === parsedExpKey,
          )
        : stockCandidates.find((x) => !x.expiration_date)) ??
      stockCandidates[0] ??
      null;

    if (!stock) {
      throw badRequest(
        `ไม่พบ stock ใน location ${loc.full_name} ที่ตรงกับ barcode_text=${parsed.barcode_text}, lot=${parsedLot ?? "null"}, exp=${parsedExpKey ?? "null"}`,
      );
    }

    const system_qty = toIntSystemQty(stock.quantity);

    const matchCode =
      stock.product_code ?? gi.code ?? parsed.barcode_text ?? "-";
    const matchName = stock.product_name ?? gi.name ?? null;
    const matchLot = stock.lot_name ?? giLot ?? "-";
    const matchExp = stock.expiration_date ?? null;
    const matchUnit = stock.unit ?? gi.unit ?? null;

    const existed = await prisma.borrow_stock_item.findFirst({
      where: {
        borrow_stock_id: id,
        deleted_at: null,
        code: matchCode,
        lot_serial: matchLot,
        expiration_date: matchExp,
      },
      select: {
        id: true,
        code: true,
        executed_qty: true,
        system_qty: true,
      },
    });

    let action: "created_new_item" | "incremented_existing_item";
    let affectedItemId: number | null = null;
    let nextExecutedQty = 1;

    if (!existed) {
      const created = await prisma.borrow_stock_item.create({
        data: {
          borrow_stock_id: id,
          code: matchCode,
          name: matchName,
          lot_serial: matchLot,
          expiration_date: matchExp,
          system_qty,
          executed_qty: 1,
        },
        select: {
          id: true,
          executed_qty: true,
        },
      });

      action = "created_new_item";
      affectedItemId = created.id;
      nextExecutedQty = created.executed_qty ?? 1;
    } else {
      const calculatedQty =
        system_qty > 0
          ? Math.min(Number(existed.executed_qty ?? 0) + 1, system_qty)
          : Number(existed.executed_qty ?? 0) + 1;

      const updated = await prisma.borrow_stock_item.update({
        where: { id: existed.id },
        data: {
          executed_qty: calculatedQty,
          updated_at: new Date(),
        },
        select: {
          id: true,
          executed_qty: true,
        },
      });

      action = "incremented_existing_item";
      affectedItemId = updated.id;
      nextExecutedQty = updated.executed_qty ?? calculatedQty;
    }

    const detail = await buildBorrowStockDetail(id);

    const payload = {
      location: {
        location_id: loc.id,
        location_name: loc.full_name,
      },
      scanned: {
        barcode: parsed.raw_input,
        normalized_input: parsed.normalized_input,
        barcode_text: parsed.barcode_text,
        lot_serial: parsedLot,
        exp: parsed.exp ? parsed.exp.toISOString() : null,
        matched_by: parsed.matched_by,
      },
      matched_stock: {
        product_id: stock.product_id,
        code: matchCode,
        name: matchName,
        lot_serial: matchLot,
        expiration_date: matchExp ? matchExp.toISOString() : null,
        system_qty,
        executed_qty: nextExecutedQty,
        unit: matchUnit,
      },
      action,
      affected_item_id: affectedItemId,
      doc: detail,
    };

    emitBorrowStockRealtime(
      {
        id: payload.doc.id,
      },
      "borrow_stock:scan_barcode",
      {
        id: payload.doc.id,
        message: "Borrow Stock barcode scanned",
        data: payload,
      },
    );

    return res.json(payload);
  },
);

/**
 * =========================
 * 3) Update executed_qty
 * PATCH /api/borrow-stocks/:id/items/:itemId
 * =========================
 */
export const updateBorrowStockItem = asyncHandler(
  async (
    req: Request<{ id: string; itemId: string }, {}, { executed_qty: number }>,
    res: Response,
  ) => {
    const id = Number(req.params.id);
    const itemId = Number(req.params.itemId);

    if (!Number.isFinite(id)) throw badRequest("id ไม่ถูกต้อง");
    if (!Number.isFinite(itemId)) throw badRequest("itemId ไม่ถูกต้อง");

    const executed_qty = Number(req.body.executed_qty);
    if (!Number.isFinite(executed_qty) || executed_qty < 0) {
      throw badRequest("executed_qty ต้องเป็นตัวเลข >= 0");
    }

    const item = await prisma.borrow_stock_item.findFirst({
      where: { id: itemId, borrow_stock_id: id, deleted_at: null },
      select: { id: true, system_qty: true },
    });
    if (!item) throw notFound(`ไม่พบ borrow_stock_item: ${itemId}`);

    await prisma.borrow_stock_item.update({
      where: { id: itemId },
      data: { executed_qty: Math.floor(executed_qty), updated_at: new Date() },
    });

    const detail = await buildBorrowStockDetail(id);
    return res.json({ doc: detail });
  },
);

/**
 * =========================
 * 4) Delete item (soft delete)
 * DELETE /api/borrow-stocks/:id/items/:itemId
 * =========================
 */
export const deleteBorrowStockItem = asyncHandler(
  async (req: Request<{ id: string; itemId: string }>, res: Response) => {
    const id = Number(req.params.id);
    const itemId = Number(req.params.itemId);

    if (!Number.isFinite(id)) throw badRequest("id ไม่ถูกต้อง");
    if (!Number.isFinite(itemId)) throw badRequest("itemId ไม่ถูกต้อง");

    const item = await prisma.borrow_stock_item.findFirst({
      where: { id: itemId, borrow_stock_id: id, deleted_at: null },
      select: { id: true },
    });
    if (!item) throw notFound(`ไม่พบ borrow_stock_item: ${itemId}`);

    await prisma.borrow_stock_item.update({
      where: { id: itemId },
      data: { deleted_at: new Date(), updated_at: new Date() },
    });

    const detail = await buildBorrowStockDetail(id);
    return res.json({ doc: detail });
  },
);

/**
 * =========================
 * 5) Confirm
 * POST /api/borrow-stocks/:id/confirm
 * =========================
 */
export const confirmBorrowStock = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) throw badRequest("id ไม่ถูกต้อง");

    const doc = await prisma.borrow_stock.findUnique({
      where: { id },
      include: {
        borrowStockItems: { where: { deleted_at: null } },
        department: true,
      },
    });
    if (!doc || doc.deleted_at) throw notFound(`ไม่พบ borrow_stock: ${id}`);

    if (doc.borrowStockItems.length === 0) {
      throw badRequest("กรุณาสแกนรายการอย่างน้อย 1 รายการก่อน confirm");
    }

    const updated = await prisma.borrow_stock.update({
      where: { id },
      data: { status: "pending", updated_at: new Date() },
      include: {
        department: true,
        borrowStockItems: {
          where: { deleted_at: null },
          orderBy: { id: "asc" },
        },
      },
    });

    emitBorrowStockRealtime(
      {
        id: updated.id,
      },
      "borrow_stock:confirmed",
      {
        id: updated.id,
        message: "Borrow Stock confirmed",
        data: updated,
      },
    );

    return res.json({ doc: formatBorrowStock(updated as any) });
  },
);

export const getBorrowStocks = asyncHandler(
  async (req: Request, res: Response) => {
    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";
    const selectedColumns = parseSearchColumns(req.query.columns);

    const where = buildBorrowStockSearchWhere(search, selectedColumns);

    const rows = await prisma.borrow_stock.findMany({
      where,
      orderBy: { created_at: "desc" },
      include: {
        department: true,
        borrowStockItems: {
          where: { deleted_at: null },
          orderBy: { id: "asc" },
        },
      },
    });

    return res.json(rows.map((r) => formatBorrowStock(r as any)));
  },
);

const buildBorrowStockSearchWhereByTerms = (
  search: string,
  selectedColumns: string[],
): Prisma.borrow_stockWhereInput => {
  const terms = search
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  const searchTerms = terms.length > 0 ? terms : [search];

  if (searchTerms.length === 0) return {};

  const orConditions: Prisma.borrow_stockWhereInput[] = [];

  for (const term of searchTerms) {
    const condition = buildBorrowStockSearchWhere(term, selectedColumns);

    if (Object.keys(condition).length > 0) {
      orConditions.push(condition);
    }
  }

  if (orConditions.length === 0) return {};

  return {
    OR: orConditions,
  };
};

const parseDepartmentNames = (value: unknown): string[] => {
  if (typeof value !== "string") return [];

  return value
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
};

export const getBorrowStocksPaginated = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;

    if (Number.isNaN(page) || page < 1) {
      throw badRequest("page ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");
    }

    if (Number.isNaN(limit) || limit < 1) {
      throw badRequest("limit ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");
    }

    const skip = (page - 1) * limit;

    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";
    const selectedColumns = parseSearchColumns(req.query.columns);

    const rawStatus = req.query.status;
    const status =
      typeof rawStatus === "string" ? rawStatus.trim().toLowerCase() : "";

    const allowedStatuses = ["pending", "completed"] as const;

    if (
      status &&
      !allowedStatuses.includes(status as (typeof allowedStatuses)[number])
    ) {
      throw badRequest("status ต้องเป็น pending หรือ completed");
    }

    const searchWhere = buildBorrowStockSearchWhereByTerms(
      search,
      selectedColumns,
    );

    const user = req.user;
    if (!user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const requestedLocalDepartmentIds = parseDepartmentIdsAsNumbers(
      req.query.department_ids ?? req.query.department_id,
    );

    const requestedDepartmentNames = parseDepartmentNames(req.query.department);

    let requestedDepartmentIdsByName: number[] = [];

    if (requestedDepartmentNames.length > 0) {
      const departmentRows = await prisma.department.findMany({
        where: {
          OR: [
            {
              short_name: {
                in: requestedDepartmentNames,
                mode: "insensitive",
              },
            },
            {
              full_name: {
                in: requestedDepartmentNames,
                mode: "insensitive",
              },
            },
          ],
        },
        select: {
          id: true,
        },
      });

      requestedDepartmentIdsByName = departmentRows.map((d) => d.id);
    }

    const requestedDepartmentIds = [
      ...new Set([
        ...requestedLocalDepartmentIds,
        ...requestedDepartmentIdsByName,
      ]),
    ];

    let finalDepartmentWhere: Prisma.borrow_stockWhereInput = {};

    const privileged = req.departmentAccess?.isPrivileged === true;

    if (!privileged) {
      const userDeptRows = await prisma.user_department.findMany({
        where: { user_id: user.id },
        select: {
          department_id: true,
        },
      });

      const allowedLocalDepartmentIds = userDeptRows
        .map((r) => r.department_id)
        .filter((v): v is number => v !== null && v !== undefined);

      if (requestedDepartmentIds.length > 0) {
        const selectedLocalIds = requestedDepartmentIds.filter((id) =>
          allowedLocalDepartmentIds.includes(id),
        );

        finalDepartmentWhere =
          selectedLocalIds.length > 0
            ? {
                borrowStockDepartments: {
                  some: {
                    department_id: { in: selectedLocalIds },
                  },
                },
              }
            : {
                id: -1,
              };
      } else {
        finalDepartmentWhere = {
          borrowStockDepartments: {
            some: {
              department_id: { in: allowedLocalDepartmentIds },
            },
          },
        };
      }
    } else {
      if (requestedDepartmentIds.length > 0) {
        finalDepartmentWhere = {
          borrowStockDepartments: {
            some: {
              department_id: { in: requestedDepartmentIds },
            },
          },
        };
      } else {
        finalDepartmentWhere = {};
      }
    }

    const whereForCount: Prisma.borrow_stockWhereInput = {
      AND: [
        searchWhere,
        finalDepartmentWhere,
        {
          deleted_at: null,
        },
      ],
    };

    const where: Prisma.borrow_stockWhereInput = {
      AND: [
        searchWhere,
        finalDepartmentWhere,
        {
          deleted_at: null,
        },
        ...(status ? [{ status }] : []),
      ],
    };

    const [rows, total, pendingCount, completedCount] = await Promise.all([
      prisma.borrow_stock.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: "desc" },
        include: {
          borrowStockDepartments: {
            include: {
              department: {
                select: {
                  id: true,
                  short_name: true,
                  full_name: true,
                },
              },
            },
          },
          borrowStockItems: {
            where: { deleted_at: null },
            orderBy: { id: "asc" },
          },
        },
      }),

      prisma.borrow_stock.count({ where }),

      prisma.borrow_stock.count({
        where: {
          AND: [whereForCount, { status: "pending" }],
        },
      }),

      prisma.borrow_stock.count({
        where: {
          AND: [whereForCount, { status: "completed" }],
        },
      }),
    ]);

    return res.json({
      data: rows.map((r) =>
        formatBorrowStock({
          ...r,
          departments: r.borrowStockDepartments.map((d) => d.department),
        } as any),
      ),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        statusCounts: {
          pending: pendingCount,
          completed: completedCount,
        },
        department:
          requestedDepartmentNames.length > 0
            ? requestedDepartmentNames.join(",")
            : null,
      },
    });
  },
);

export const getBorrowStockById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = pickIntIdParam(req, "id");

    const row = await prisma.borrow_stock.findUnique({
      where: { id },
      include: {
        // ✅ เปลี่ยนตรงนี้
        borrowStockDepartments: {
          include: {
            department: {
              select: {
                id: true,
                short_name: true,
                full_name: true,
              },
            },
          },
        },

        borrowStockItems: {
          where: { deleted_at: null },
          orderBy: { id: "asc" },
        },
      },
    });

    if (!row || row.deleted_at) {
      throw notFound(`ไม่พบ borrow_stock: ${id}`);
    }

    return res.json(formatBorrowStock(row as any));
  },
);

export const updateBorrowStock = asyncHandler(
  async (
    req: Request<
      { id: string },
      {},
      {
        location_full_name?: string;
        department_id?: number | null;
        remark?: string | null;
        status?: string;
      }
    >,
    res: Response,
  ) => {
    const id = pickIntIdParam(req, "id");

    const existing = await prisma.borrow_stock.findUnique({
      where: { id },
      select: { id: true, deleted_at: true },
    });
    if (!existing || existing.deleted_at) {
      throw notFound(`ไม่พบ borrow_stock: ${id}`);
    }

    const data = req.body;

    const updateData: Prisma.borrow_stockUpdateInput = {
      updated_at: new Date(),
    };

    if (data.location_full_name !== undefined) {
      const locName = String(data.location_full_name ?? "").trim();
      if (!locName) throw badRequest("กรุณาส่ง location_full_name");
      const loc = await resolveLocationByFullName(locName);
      updateData.location_name = loc.full_name;
    }

    if (data.department_id !== undefined) {
      const department_id =
        data.department_id == null ? null : Number(data.department_id);

      if (department_id != null && !Number.isFinite(department_id)) {
        throw badRequest("department_id ไม่ถูกต้อง");
      }

      if (department_id == null) {
        updateData.department = { disconnect: true };
      } else {
        const d = await prisma.department.findUnique({
          where: { id: department_id },
          select: { id: true, deleted_at: true },
        });

        if (!d) {
          throw badRequest("ไม่พบ department", {
            field: "department_id",
          } as any);
        }

        if (d.deleted_at) {
          throw badRequest("department ถูกลบไปแล้ว", {
            field: "department_id",
          } as any);
        }

        updateData.department = { connect: { id: department_id } };
      }
    }

    if (data.remark !== undefined) updateData.remark = data.remark ?? null;
    if (data.status !== undefined) {
      updateData.status = String(data.status ?? "").trim() || "pending";
    }

    const updated = await prisma.borrow_stock.update({
      where: { id },
      data: updateData,
      include: {
        department: true,
        borrowStockItems: {
          where: { deleted_at: null },
          orderBy: { id: "asc" },
        },
      },
    });

    return res.json(formatBorrowStock(updated as any));
  },
);

export const deleteBorrowStock = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = pickIntIdParam(req, "id");

    const existing = await prisma.borrow_stock.findUnique({
      where: { id },
      select: { id: true, deleted_at: true },
    });
    if (!existing || existing.deleted_at) {
      throw notFound(`ไม่พบ borrow_stock: ${id}`);
    }

    await prisma.$transaction(async (tx) => {
      await tx.borrow_stock_item.updateMany({
        where: { borrow_stock_id: id, deleted_at: null },
        data: { deleted_at: new Date(), updated_at: new Date() },
      });

      await tx.borrow_stock.update({
        where: { id },
        data: { deleted_at: new Date(), updated_at: new Date() },
      });
    });

    return res.status(200).json({ message: "ลบข้อมูลเรียบร้อยแล้ว" });
  },
);

// ================================
// GET ALL bor_stocks
// ================================
export const getAllBorStocks = asyncHandler(
  async (req: Request, res: Response) => {
    const rows = await prisma.bor_stock.findMany({
      orderBy: { id: "desc" },
    });

    return res.json({
      message: "ดึงข้อมูล bor_stocks สำเร็จ",
      total: rows.length,
      data: rows,
    });
  },
);

// ================================
// GET bor_stocks WITH PAGINATION
// ================================
export const getBorStocksPaginated = asyncHandler(
  async (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;

    if (Number.isNaN(page) || page < 1) {
      throw badRequest("page ต้องเป็นตัวเลขบวก");
    }

    if (Number.isNaN(limit) || limit < 1) {
      throw badRequest("limit ต้องเป็นตัวเลขบวก");
    }

    const skip = (page - 1) * limit;

    const where: Prisma.bor_stockWhereInput = {
      deleted_at: null,
    };

    if (req.query.product_id) {
      where.product_id = Number(req.query.product_id);
    }

    if (req.query.lot_name) {
      where.lot_name = {
        contains: String(req.query.lot_name),
        mode: "insensitive",
      };
    }

    if (req.query.location_name) {
      where.location_name = {
        contains: String(req.query.location_name),
        mode: "insensitive",
      };
    }

    if (req.query.no) {
      where.no = {
        contains: String(req.query.no),
        mode: "insensitive",
      };
    }

    const [rows, total] = await Promise.all([
      prisma.bor_stock.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ snapshot_date: "desc" }, { id: "desc" }],
      }),
      prisma.bor_stock.count({ where }),
    ]);

    return res.json({
      message: "ดึงข้อมูล bor_stocks สำเร็จ",
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      data: rows,
    });
  },
);

export const getBorrowStockDailyPaginated = asyncHandler(
  async (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;

    if (page < 1) throw badRequest("page ต้องมากกว่า 0");
    if (limit < 1) throw badRequest("limit ต้องมากกว่า 0");

    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";

    const department_id =
      req.query.department_id != null && req.query.department_id !== ""
        ? Number(req.query.department_id)
        : null;

    const status =
      typeof req.query.status === "string" ? req.query.status.trim() : "";

    const date =
      typeof req.query.date === "string" ? req.query.date.trim() : "";

    const from =
      typeof req.query.from === "string" ? req.query.from.trim() : "";

    const to = typeof req.query.to === "string" ? req.query.to.trim() : "";

    const andWhere: Prisma.borrow_stock_dailyWhereInput[] = [];

    if (search) {
      andWhere.push({
        OR: [
          { product_code: { contains: search, mode: "insensitive" } },
          { product_name: { contains: search, mode: "insensitive" } },
          { lot_serial: { contains: search, mode: "insensitive" } },
          { location_name: { contains: search, mode: "insensitive" } },
          { department_name: { contains: search, mode: "insensitive" } },
          { user_ref: { contains: search, mode: "insensitive" } },
        ],
      });
    }

    if (department_id) {
      andWhere.push({ department_id });
    }

    if (status) {
      andWhere.push({ status });
    }

    if (date) {
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);

      const end = new Date(start);
      end.setDate(end.getDate() + 1);

      andWhere.push({
        snapshot_date: {
          gte: start,
          lt: end,
        },
      });
    } else if (from || to) {
      const dateWhere: any = {};

      if (from) {
        const start = new Date(from);
        start.setHours(0, 0, 0, 0);
        dateWhere.gte = start;
      }

      if (to) {
        const end = new Date(to);
        end.setHours(0, 0, 0, 0);
        end.setDate(end.getDate() + 1);
        dateWhere.lt = end;
      }

      andWhere.push({ snapshot_date: dateWhere });
    }

    const where: Prisma.borrow_stock_dailyWhereInput =
      andWhere.length > 0 ? { AND: andWhere } : {};

    const [total, rows] = await Promise.all([
      prisma.borrow_stock_daily.count({ where }),
      prisma.borrow_stock_daily.findMany({
        where,
        orderBy: [{ snapshot_date: "desc" }, { id: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return res.json({
      data: rows,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  },
);

// ================================
// GET bor_stock BY ID
// ================================
export const getBorStockById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);

    if (Number.isNaN(id)) {
      throw badRequest("id ต้องเป็นตัวเลข");
    }

    const row = await prisma.bor_stock.findUnique({
      where: { id },
    });

    if (!row) {
      throw notFound(`ไม่พบ bor_stock id=${id}`);
    }

    return res.json({
      message: "ดึงข้อมูล bor_stock สำเร็จ",
      data: row,
    });
  },
);

export const getBorrowStocksByLocationName = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const locationName = String(req.query.location_name ?? "").trim();

    if (!locationName) {
      throw badRequest("กรุณาส่ง location_name");
    }

    const allDepartments = parseBooleanTrue(req.query.all_departments);

    // ✅ FE ส่ง local department.id มา
    const requestedLocalDepartmentIds = parseDepartmentIdsAsNumbers(
      req.query.department_ids,
    );

    // ✅ สิทธิ์จาก auth เป็น odoo_id string อยู่แล้ว
    const accessWhere = buildDepartmentAccessWhere(req);
    const allowedDepartmentFilter = accessWhere.department_id;

    // ✅ แปลง local department.id -> department.odoo_id(string)
    let requestedOdooDepartmentIds: string[] = [];

    if (!allDepartments) {
      if (requestedLocalDepartmentIds.length === 0) {
        throw badRequest("กรุณาส่ง department_ids เมื่อ all_departments=false");
      }

      const deptRows = await prisma.department.findMany({
        where: {
          id: { in: requestedLocalDepartmentIds },
        },
        select: {
          id: true,
          odoo_id: true,
          deleted_at: true,
        },
      });

      if (deptRows.length !== requestedLocalDepartmentIds.length) {
        throw badRequest("มี department_ids บางตัวไม่ถูกต้อง");
      }

      if (deptRows.some((d) => d.deleted_at)) {
        throw badRequest("มี department ที่ถูกลบอยู่ในรายการ");
      }

      requestedOdooDepartmentIds = deptRows
        .map((d) => d.odoo_id)
        .filter((v): v is number => v !== null && v !== undefined)
        .map((v) => String(v));
    }

    let finalDepartmentWhere:
      | {}
      | { department_id: string }
      | { department_id: { in: string[] } } = {};

    if (allDepartments) {
      if (typeof allowedDepartmentFilter === "string") {
        finalDepartmentWhere = { department_id: allowedDepartmentFilter };
      } else if (
        allowedDepartmentFilter &&
        typeof allowedDepartmentFilter === "object" &&
        "in" in allowedDepartmentFilter
      ) {
        finalDepartmentWhere = {
          department_id: {
            in: (allowedDepartmentFilter.in as (string | number)[]).map((v) =>
              String(v),
            ),
          },
        };
      } else {
        // privileged user
        finalDepartmentWhere = {};
      }
    } else {
      if (typeof allowedDepartmentFilter === "string") {
        finalDepartmentWhere = requestedOdooDepartmentIds.includes(
          String(allowedDepartmentFilter),
        )
          ? { department_id: String(allowedDepartmentFilter) }
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

        finalDepartmentWhere = {
          department_id: { in: selected },
        };
      } else {
        // privileged user เช่น Admin / Supervisor / UAT / CNE
        finalDepartmentWhere = {
          department_id: { in: requestedOdooDepartmentIds },
        };
      }
    }

    const [borRows, serRows] = await Promise.all([
      prisma.bor_stock.findMany({
        where: {
          deleted_at: null,
          location_name: {
            equals: locationName,
            mode: "insensitive",
          },
          ...finalDepartmentWhere,
        },
        orderBy: [
          { product_code: "asc" },
          { lot_name: "asc" },
          { expiration_date: "asc" },
          { id: "asc" },
        ],
      }),
      prisma.ser_stock.findMany({
        where: {
          deleted_at: null,
          location_name: {
            equals: locationName,
            mode: "insensitive",
          },
          ...finalDepartmentWhere,
        },
        orderBy: [
          { product_code: "asc" },
          { lot_name: "asc" },
          { expiration_date: "asc" },
          { id: "asc" },
        ],
      }),
    ]);

    const data = [
      ...borRows.map((row) => ({
        id: row.id,
        stock_type: "BOR",
        no: row.no,
        product_id: row.product_id,
        code: row.product_code,
        name: row.product_name,
        unit: row.unit,
        lot_id: row.lot_id,
        lot_serial: row.lot_name,
        expiration_date: row.expiration_date,
        system_qty: Number(row.quantity ?? 0),
        executed_qty: 0,
        location_id: row.location_id,
        location_name: row.location_name,
        department_id: row.department_id,
        department_name: row.department_name,
        source: row.source,
        snapshot_date: row.snapshot_date,
        user_pick: row.user_pick,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
      ...serRows.map((row) => ({
        id: row.id,
        stock_type: "SER",
        no: row.no,
        product_id: row.product_id,
        code: row.product_code,
        name: row.product_name,
        unit: row.unit,
        lot_id: row.lot_id,
        lot_serial: row.lot_name,
        expiration_date: row.expiration_date,
        system_qty: Number(row.quantity ?? 0),
        executed_qty: 0,
        location_id: row.location_id,
        location_name: row.location_name,
        department_id: row.department_id,
        department_name: row.department_name,
        source: row.source,
        snapshot_date: row.snapshot_date,
        user_pick: row.user_pick,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
    ];

    return res.json({
      location_name: locationName,
      all_departments: allDepartments,
      requested_department_ids: requestedLocalDepartmentIds, // local id จาก FE
      requested_odoo_department_ids: requestedOdooDepartmentIds, // ใช้ filter จริง
      total: data.length,
      data,
    });
  },
);

type ConfirmBorrowStocksBulkBody = {
  ids: number[];
};

export const confirmBorrowStocksBulk = asyncHandler(
  async (req: Request<{}, {}, ConfirmBorrowStocksBulkBody>, res: Response) => {
    const idsRaw = Array.isArray(req.body?.ids) ? req.body.ids : [];

    const ids: number[] = Array.from(
      new Set(
        idsRaw
          .map((x: number) => Number(x))
          .filter((x: number) => Number.isFinite(x) && x > 0),
      ),
    );

    if (ids.length === 0) {
      throw badRequest("กรุณาส่ง ids อย่างน้อย 1 รายการ");
    }

    const docs = await prisma.borrow_stock.findMany({
      where: {
        id: { in: ids },
        deleted_at: null,
      },
      include: {
        borrowStockItems: {
          where: { deleted_at: null },
        },
        department: true,
      },
      orderBy: { id: "asc" },
    });

    if (docs.length !== ids.length) {
      const foundIds = new Set<number>(docs.map((x) => x.id));
      const missingIds = ids.filter((id) => !foundIds.has(id));
      throw notFound(`ไม่พบ borrow_stock บางรายการ: ${missingIds.join(", ")}`);
    }

    const emptyDoc = docs.find((doc) => doc.borrowStockItems.length === 0);
    if (emptyDoc) {
      throw badRequest(
        `borrow_stock id=${emptyDoc.id} ยังไม่มีรายการสแกน จึง confirm ไม่ได้`,
      );
    }

    const now = new Date();

    await prisma.borrow_stock.updateMany({
      where: {
        id: { in: ids },
        deleted_at: null,
      },
      data: {
        status: "pending",
        updated_at: now,
      },
    });

    const updatedDocs = await prisma.borrow_stock.findMany({
      where: {
        id: { in: ids },
        deleted_at: null,
      },
      include: {
        department: true,
        borrowStockItems: {
          where: { deleted_at: null },
          orderBy: { id: "asc" },
        },
      },
      orderBy: { id: "asc" },
    });

    return res.json({
      message: `confirm borrow_stock สำเร็จ ${updatedDocs.length} รายการ`,
      total: updatedDocs.length,
      data: updatedDocs.map((doc) => formatBorrowStock(doc as any)),
    });
  },
);


export const runBorrowStockDailySnapshot = asyncHandler(
  async (req: Request, res: Response) => {
    const date =
      typeof req.query.date === "string"
        ? req.query.date.trim()
        : undefined;

    const result =
      await borrowStockDailyService.createDailySnapshot(
        "manual-api",
        date,
      );

    return res.json(result);
  },
);
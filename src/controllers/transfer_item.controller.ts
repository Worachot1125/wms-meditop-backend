import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
import { parseDateInput } from "../utils/parseDate";
import {
  CreateTransferDocItemBody,
  UpdateTransferDocItemBody,
} from "../types/transfer_doc_item";
import { formatTransferDocItem } from "../utils/formatters/transfer_item.formatter";
import { toExp6 } from "../utils/barcode";

function getExpDate(exp: string | null | undefined, no_expiry?: boolean) {
  if (no_expiry) return null;
  if (!exp) return null;
  return parseDateInput(exp, "exp");
}

/**
 * =========================
 * helpers
 * =========================
 */
function decodeNoParam(v: unknown): string {
  const s = Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
  if (!s) return "";
  // Express decode รอบแรกแล้ว → เหลือ %2F → decode อีกรอบให้เป็น /
  return decodeURIComponent(s);
}

/**
 * =========================
 * Create transfer_doc_item
 * =========================
 */
export const createTransferDocItem = asyncHandler(
  async (req: Request<{}, {}, CreateTransferDocItemBody>, res: Response) => {
    const data = req.body;

    if (
      !data.transfer_doc_id ||
      !data.name ||
      data.quantity_receive === undefined ||
      data.quantity_count === undefined ||
      !data.unit
    ) {
      throw badRequest("ข้อมูลไม่ครบถ้วน");
    }

    // transfer_doc ต้องมีจริง
    const doc = await prisma.transfer_doc.findUnique({
      where: { id: data.transfer_doc_id },
    });
    if (!doc) throw badRequest("ไม่พบ transfer_doc (transfer_doc_id ไม่ถูกต้อง)");
    if (doc.deleted_at) throw badRequest("transfer_doc ถูกลบไปแล้ว");

    // exp
    const expDate = data.no_expiry
      ? null
      : data.exp
        ? parseDateInput(data.exp, "exp")
        : null;

    // lot: optional
    const lot = data.lot ?? null;

    // qr_payload: code + lot + exp (6 digits YYMMDD)
    let qr_payload: string | null = null;
    if (data.code && lot && expDate) {
      const exp6 = toExp6(expDate);
      qr_payload = `${data.code}${lot}${exp6}`;
    }

    const item = await prisma.transfer_doc_item.create({
      data: {
        transfer_doc_id: data.transfer_doc_id,
        name: data.name,
        quantity_receive: Number(data.quantity_receive),
        quantity_count: Number(data.quantity_count),
        unit: data.unit,
        zone_type: data.zone_type ?? null,
        lot,
        exp: expDate,
        qr_payload,
        code: data.code ?? null,
        lot_id: data.lot_id ?? null,
        lot_serial: data.lot_serial ?? null,
        product_id: data.product_id ?? null,
        qty: data.qty ?? null,
        sequence: data.sequence ?? null,
        tracking: data.tracking ?? null,
        barcode_id: data.barcode_id ?? null,

        // ✅ NEW (optional)
        odoo_line_key: data.odoo_line_key ?? null,
        odoo_sequence: data.odoo_sequence ?? null,
      },
      include: { transfer_doc: true },
    });

    return res.status(201).json(formatTransferDocItem(item));
  },
);

/**
 * =========================
 * GET transfer_doc_items (ALL)
 * =========================
 */
export const getTransferDocItems = asyncHandler(
  async (req: Request, res: Response) => {
    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    const baseWhere: Prisma.transfer_doc_itemWhereInput = {
      deleted_at: null,
    };

    let where: Prisma.transfer_doc_itemWhereInput = baseWhere;

    if (search) {
      const searchCondition: Prisma.transfer_doc_itemWhereInput = {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { unit: { contains: search, mode: "insensitive" } },
          { lot: { contains: search, mode: "insensitive" } },
          { zone_type: { contains: search, mode: "insensitive" } },
          { code: { contains: search, mode: "insensitive" } },
          { lot_serial: { contains: search, mode: "insensitive" } },

          // 🔎 search ใน transfer_doc ด้วย
          { transfer_doc: { no: { contains: search, mode: "insensitive" } } },
          { transfer_doc: { lot: { contains: search, mode: "insensitive" } } },
          {
            transfer_doc: {
              department: { contains: search, mode: "insensitive" },
            },
          },
        ],
      };

      where = { AND: [baseWhere, searchCondition] };
    }

    const rows = await prisma.transfer_doc_item.findMany({
      where,
      orderBy: { created_at: "desc" },
      include: { transfer_doc: true },
    });

    return res.json(rows.map(formatTransferDocItem));
  },
);

/**
 * =========================
 * GET transfer_doc_items (PAGINATED)
 * =========================
 */
export const getTransferDocItemsPaginated = asyncHandler(
  async (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;

    if (isNaN(page) || page < 1) {
      throw badRequest("page ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");
    }

    const skip = (page - 1) * limit;

    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    const baseWhere: Prisma.transfer_doc_itemWhereInput = {
      deleted_at: null,
    };

    let where: Prisma.transfer_doc_itemWhereInput = baseWhere;

    if (search) {
      const searchCondition: Prisma.transfer_doc_itemWhereInput = {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { unit: { contains: search, mode: "insensitive" } },
          { lot: { contains: search, mode: "insensitive" } },
          { zone_type: { contains: search, mode: "insensitive" } },
          { code: { contains: search, mode: "insensitive" } },
          { lot_serial: { contains: search, mode: "insensitive" } },
          { transfer_doc: { no: { contains: search, mode: "insensitive" } } },
          { transfer_doc: { lot: { contains: search, mode: "insensitive" } } },
          {
            transfer_doc: {
              department: { contains: search, mode: "insensitive" },
            },
          },
        ],
      };
      where = { AND: [baseWhere, searchCondition] };
    }

    const [rows, total] = await Promise.all([
      prisma.transfer_doc_item.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: "desc" },
        include: { transfer_doc: true },
      }),
      prisma.transfer_doc_item.count({ where }),
    ]);

    return res.json({
      data: rows.map(formatTransferDocItem),
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
 * =========================
 * GET transfer_doc_item (BY ID)
 * =========================
 */
export const getTransferDocItemById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = decodeNoParam((req.params as any).id);

    const row = await prisma.transfer_doc_item.findUnique({
      where: { id },
      include: { transfer_doc: true }, // ✅ include transfer_doc
    });

    if (!row) throw notFound("ไม่พบ transfer_doc_item");
    if (row.deleted_at) throw badRequest("transfer_doc_item ถูกลบไปแล้ว");

    // ✅ lookup department_code จาก transfer_doc.department_id (เก็บเป็น string)
    let department_code: string | null = null;

    const deptIdRaw = row.transfer_doc?.department_id ?? null;
    if (deptIdRaw) {
      const deptId = parseInt(String(deptIdRaw), 10);
      if (!isNaN(deptId)) {
        const dept = await prisma.department.findFirst({
          where: { odoo_id: deptId },
          select: { department_code: true },
        });
        department_code = dept?.department_code ?? null;
      }
    }

    const formatted = formatTransferDocItem(row);

    return res.json({
      ...formatted,
      department_code,
      transfer_doc: formatted.transfer_doc
        ? { ...(formatted.transfer_doc as any), department_code }
        : null,
    });
  },
);

/**
 * =========================
 * UPDATE transfer_doc_item
 * =========================
 */
export const updateTransferDocItem = asyncHandler(
  async (
    req: Request<{ id: string }, {}, UpdateTransferDocItemBody>,
    res: Response,
  ) => {
    const id = decodeNoParam((req.params as any).id);

    const existing = await prisma.transfer_doc_item.findUnique({
      where: { id },
      include: { transfer_doc: true },
    });
    if (!existing) throw notFound("ไม่พบ transfer_doc_item");
    if (existing.deleted_at) throw badRequest("transfer_doc_item ถูกลบไปแล้ว");

    const data = req.body;

    // ถ้าเปลี่ยน transfer_doc_id ต้องตรวจ doc ใหม่
    if (data.transfer_doc_id) {
      const doc = await prisma.transfer_doc.findUnique({
        where: { id: data.transfer_doc_id },
      });
      if (!doc) throw badRequest("ไม่พบ transfer_doc (transfer_doc_id ไม่ถูกต้อง)");
      if (doc.deleted_at) throw badRequest("transfer_doc ถูกลบไปแล้ว");
    }

    // next lot
    const nextLot =
      data.lot !== undefined ? (data.lot ?? null) : (existing.lot ?? null);

    // ✅ NEW: ถ้าส่ง lot มา แต่ไม่ส่ง lot_serial -> ให้ lot_serial ตาม lot
    const nextLotSerial =
      data.lot_serial !== undefined
        ? data.lot_serial ?? null
        : data.lot !== undefined
          ? data.lot ?? null
          : existing.lot_serial ?? null;

    // next exp
    const nextExp =
      data.exp !== undefined || data.no_expiry !== undefined
        ? data.no_expiry
          ? null
          : data.exp
            ? parseDateInput(data.exp, "exp")
            : null
        : existing.exp;

    // next code
    const nextCode = data.code !== undefined ? data.code : existing.code;

    // qr_payload: code + lot + exp (6 digits YYMMDD)
    let nextPayload: string | null = null;
    if (nextCode && nextLot && nextExp) {
      const exp6 = toExp6(nextExp);
      nextPayload = `${nextCode}${nextLot}${exp6}`;
    }

    const row = await prisma.transfer_doc_item.update({
      where: { id },
      data: {
        transfer_doc_id: data.transfer_doc_id,
        name: data.name,
        quantity_receive:
          data.quantity_receive !== undefined
            ? Number(data.quantity_receive)
            : undefined,
        quantity_count:
          data.quantity_count !== undefined
            ? Number(data.quantity_count)
            : undefined,
        unit: data.unit,
        zone_type: data.zone_type ?? undefined,

        lot: data.lot ?? undefined,

        lot_serial:
          data.lot !== undefined || data.lot_serial !== undefined
            ? nextLotSerial
            : undefined,

        exp: nextExp,
        qr_payload: nextPayload,
        code: data.code ?? undefined,
        lot_id: data.lot_id ?? undefined,
        product_id: data.product_id ?? undefined,
        qty: data.qty ?? undefined,
        sequence: data.sequence ?? undefined,
        tracking: data.tracking ?? undefined,
        barcode_id: data.barcode_id ?? undefined,

        // ✅ optional metadata
        odoo_line_key: data.odoo_line_key ?? undefined,
        odoo_sequence: data.odoo_sequence ?? undefined,

        updated_at: new Date(),
      },
      include: { transfer_doc: true },
    });

    return res.json(formatTransferDocItem(row));
  },
);

/**
 * =========================
 * DELETE transfer_doc_item (soft)
 * =========================
 */
export const deleteTransferDocItem = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = decodeNoParam((req.params as any).id);

    const old = await prisma.transfer_doc_item.findUnique({ where: { id } });
    if (!old) throw notFound("ไม่พบ transfer_doc_item");
    if (old.deleted_at) throw badRequest("transfer_doc_item ถูกลบไปแล้ว");

    await prisma.transfer_doc_item.update({
      where: { id },
      data: { deleted_at: new Date(), updated_at: new Date() },
    });

    return res.json({ message: "ลบ transfer_doc_item เรียบร้อยแล้ว" });
  },
);
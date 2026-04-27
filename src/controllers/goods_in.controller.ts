import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
import { parseDateInput } from "../utils/parseDate";
import { CreateGoodsInBody, UpdateGoodsInBody } from "../types/goods_in";
import { formatGoodsIn } from "../utils/formatters/goods_in.formatter";
import {
  buildQrNumericPayload,
  genEan13Prefix01,
  toExp6,
} from "../utils/barcode";

function getExpDate(exp: string | null | undefined, no_expiry?: boolean) {
  if (no_expiry) return null;
  if (!exp) return null;
  return parseDateInput(exp, "exp");
}

// Create Goods In
export const createGoodsIn = asyncHandler(
  async (req: Request<{}, {}, CreateGoodsInBody>, res: Response) => {
    const data = req.body;

    if (
      !data.inbound_id ||
      !data.name ||
      data.quantity_receive === undefined ||
      data.quantity_count === undefined ||
      !data.unit
    ) {
      throw badRequest("ข้อมูลไม่ครบถ้วน");
    }

    // inbound ต้องมีจริง
    const inbound = await prisma.inbound.findUnique({
      where: { id: data.inbound_id },
    });
    if (!inbound) throw badRequest("ไม่พบ inbound (inbound_id ไม่ถูกต้อง)");
    if (inbound.deleted_at) throw badRequest("inbound ถูกลบไปแล้ว");

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

    const goodsIn = await prisma.goods_in.create({
      data: {
        // ❌ ไม่ต้องส่ง id: data.id
        // (ถ้าพี่อยาก backward compatible: สามารถใส่ id: data.id ?? undefined ได้ แต่ไม่แนะนำ)
        inbound_id: data.inbound_id,
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
      include: { inbound: true },
    });

    return res.status(201).json(formatGoodsIn(goodsIn));
  },
);

// GET goods_in (ALL)
export const getGoodsIns = asyncHandler(async (req: Request, res: Response) => {
  const rawSearch = req.query.search;
  const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

  const baseWhere: Prisma.goods_inWhereInput = {
    deleted_at: null,
  };

  let where: Prisma.goods_inWhereInput = baseWhere;

  if (search) {
    const searchCondition: Prisma.goods_inWhereInput = {
      OR: [
        { name: { contains: search, mode: "insensitive" } },
        { unit: { contains: search, mode: "insensitive" } },
        { lot: { contains: search, mode: "insensitive" } },
        { zone_type: { contains: search, mode: "insensitive" } },
        { code: { contains: search, mode: "insensitive" } },
        { lot_serial: { contains: search, mode: "insensitive" } },
        // 🔎 search ใน inbound ด้วย
        { inbound: { no: { contains: search, mode: "insensitive" } } },
        { inbound: { lot: { contains: search, mode: "insensitive" } } },
        { inbound: { department: { contains: search, mode: "insensitive" } } },
      ],
    };

    where = { AND: [baseWhere, searchCondition] };
  }

  const rows = await prisma.goods_in.findMany({
    where,
    orderBy: { created_at: "desc" },
    include: { inbound: true },
  });

  return res.json(rows.map(formatGoodsIn));
});

// GET goods_in (PAGINATED)
export const getGoodsInsPaginated = asyncHandler(
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

    const baseWhere: Prisma.goods_inWhereInput = {
      deleted_at: null,
    };

    let where: Prisma.goods_inWhereInput = baseWhere;

    if (search) {
      const searchCondition: Prisma.goods_inWhereInput = {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { unit: { contains: search, mode: "insensitive" } },
          { lot: { contains: search, mode: "insensitive" } },
          { zone_type: { contains: search, mode: "insensitive" } },
          { code: { contains: search, mode: "insensitive" } },
          { lot_serial: { contains: search, mode: "insensitive" } },
          { inbound: { no: { contains: search, mode: "insensitive" } } },
          { inbound: { lot: { contains: search, mode: "insensitive" } } },
          {
            inbound: { department: { contains: search, mode: "insensitive" } },
          },
        ],
      };
      where = { AND: [baseWhere, searchCondition] };
    }

    const [rows, total] = await Promise.all([
      prisma.goods_in.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: "desc" },
        include: { inbound: true },
      }),
      prisma.goods_in.count({ where }),
    ]);

    return res.json({
      data: rows.map(formatGoodsIn),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  },
);
function decodeNoParam(v: unknown): string {
  const s = Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
  if (!s) return "";
  // Express decode รอบแรกแล้ว → เหลือ %2F → decode อีกรอบให้เป็น /
  return decodeURIComponent(s);
}

// GET goods_in (BY ID)
export const getGoodsInById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = decodeNoParam((req.params as any).id);

    const row = await prisma.goods_in.findUnique({
      where: { id },
      include: { inbound: true }, // ✅ NEW: ต้อง include inbound
    });

    if (!row) throw notFound("ไม่พบ goods_in");
    if (row.deleted_at) throw badRequest("goods_in ถูกลบไปแล้ว");

    // ✅ lookup department_code จาก inbound.department_id (ซึ่งเก็บเป็น string ใน inbound)
    let department_code: string | null = null;

    const deptIdRaw = row.inbound?.department_id ?? null;
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

    const formatted = formatGoodsIn(row);

    // ✅ ใส่ department_code ในระดับ item เลย (ตามที่ต้องการ)
    return res.json({
      ...formatted,
      department_code,
      // ถ้าอยากให้ inbound ใน goods_in เปลี่ยนเป็น department_code ด้วย (optional)
      inbound: formatted.inbound
        ? { ...formatted.inbound, department_code }
        : null,
    });
  },
);

// UPDATE goods_in
export const updateGoodsIn = asyncHandler(
  async (
    req: Request<{ id: string }, {}, UpdateGoodsInBody>,
    res: Response,
  ) => {
    const id = decodeNoParam((req.params as any).id);

    const existing = await prisma.goods_in.findUnique({
      where: { id },
      include: { inbound: true },
    });
    if (!existing) throw notFound("ไม่พบ goods_in");
    if (existing.deleted_at) throw badRequest("goods_in ถูกลบไปแล้ว");

    const data = req.body;

    // ถ้าเปลี่ยน inbound_id ต้องตรวจ inbound ใหม่
    if (data.inbound_id) {
      const inbound = await prisma.inbound.findUnique({
        where: { id: data.inbound_id },
      });
      if (!inbound) throw badRequest("ไม่พบ inbound (inbound_id ไม่ถูกต้อง)");
      if (inbound.deleted_at) throw badRequest("inbound ถูกลบไปแล้ว");
    }

    // next lot
    const nextLot =
      data.lot !== undefined ? (data.lot ?? null) : (existing.lot ?? null);

    // ✅ NEW: ถ้าส่ง lot มา แต่ไม่ส่ง lot_serial -> ให้ lot_serial ตาม lot
    const nextLotSerial =
      data.lot_serial !== undefined
        ? (data.lot_serial ?? null)
        : data.lot !== undefined
          ? (data.lot ?? null)
          : (existing.lot_serial ?? null);

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

    const row = await prisma.goods_in.update({
      where: { id },
      data: {
        inbound_id: data.inbound_id,
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

        // ✅ ของเดิม: lot ยังอัปเดตเหมือนเดิม
        lot: data.lot ?? undefined,

        // ✅ เปลี่ยนเฉพาะบรรทัดนี้: ให้ lot_serial ตาม lot เมื่อส่ง lot มา
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
        print_check:
          data.print_check !== undefined
            ? Boolean(data.print_check)
            : undefined,
        barcode_id: data.barcode_id ?? undefined,
        updated_at: new Date(),
      },
      include: { inbound: true },
    });

    return res.json(formatGoodsIn(row));
  },
);

// DELETE goods_in (soft)
export const deleteGoodsIn = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = decodeNoParam((req.params as any).id);

    const old = await prisma.goods_in.findUnique({ where: { id } });
    if (!old) throw notFound("ไม่พบ goods_in");
    if (old.deleted_at) throw badRequest("goods_in ถูกลบไปแล้ว");

    await prisma.goods_in.update({
      where: { id },
      data: { deleted_at: new Date(), updated_at: new Date() },
    });

    return res.json({ message: "ลบ goods_in เรียบร้อยแล้ว" });
  },
);

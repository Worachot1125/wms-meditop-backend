import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
import { parseDateInput } from "../utils/parseDate";
import { AuthRequest, buildDepartmentAccessWhere } from "../middleware/auth";
import {
  CreateInboundBody,
  UpdateInboundBody,
  OdooInboundRequest,
} from "../types/inbound";

/**
 * =========================
 * Item matching helpers
 * ✅ เปลี่ยนให้เช็ค items ด้วย:
 *    - product_id
 *    - lot_serial (lot_name)
 * ❌ ไม่ใช้ lot_id ในการเช็ค/เทียบ items แล้ว
 * =========================
 */

// normalize lot_serial/lot_name ให้เทียบกันได้เสถียร (กัน space/เคส)
function normalizeLotSerial(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * key สำหรับการเช็ค/เทียบ item (ตัวเดียวกันหรือไม่)
 * - ต้องมี product_id
 * - lot_serial อาจว่างได้ แต่ยังถือว่าเป็นส่วนหนึ่งของ key
 */
function itemKey(productId: unknown, lotSerial: unknown): string {
  const pid = Number(productId);
  // ถ้า product_id ไม่ใช่ตัวเลขจริง ให้ทำ key ที่เด่นชัดไว้กันชน
  const pidPart = Number.isFinite(pid) ? String(pid) : "NaN";
  const lotPart = normalizeLotSerial(lotSerial);
  return `${pidPart}|${lotPart}`;
}

/**
 * เทียบว่า item สองตัวเป็น "ตัวเดียวกัน" ไหม ตามกติกาใหม่
 */
function isSameItem(
  a: { product_id: unknown; lot_serial?: unknown; lot?: unknown },
  b: { product_id: unknown; lot_serial?: unknown; lot?: unknown },
): boolean {
  // lot_serial(lot_name) บางระบบเก็บไว้ที่ lot หรือ lot_serial
  const aLot = a.lot_serial ?? a.lot;
  const bLot = b.lot_serial ?? b.lot;
  return itemKey(a.product_id, aLot) === itemKey(b.product_id, bLot);
}

// CREATE Inbound
export const createInbound = asyncHandler(
  async (req: Request<{}, {}, CreateInboundBody>, res: Response) => {
    const data = req.body;

    if (
      !data.no ||
      !data.lot ||
      !data.date ||
      data.quantity === undefined ||
      !data.in_type ||
      !data.department
    ) {
      throw badRequest("ข้อมูลไม่ครบถ้วน");
    }

    // กัน quantity ติดลบ
    if (Number.isNaN(Number(data.quantity)) || Number(data.quantity) < 0) {
      throw badRequest("quantity ต้องเป็นตัวเลขและต้องไม่ติดลบ");
    }

    // เช็คซ้ำ no (เพราะเป็น @unique)
    const exists = await prisma.inbound.findUnique({ where: { no: data.no } });
    if (exists) throw badRequest("มี no นี้อยู่แล้ว");

    const inbound = await prisma.inbound.create({
      data: {
        no: data.no,
        lot: data.lot,
        date: parseDateInput(data.date, "date"),
        quantity: Number(data.quantity),
        in_type: data.in_type,
        department: data.department,
        // updated_at ปล่อยให้ null ได้

        invoice:
          data.invoice !== undefined
            ? data.invoice === null
              ? null
              : String(data.invoice).trim() || null
            : null,
      },
    });

    return res.status(201).json(inbound);
  },
);

// GET ALL Inbound
export const getInbounds = asyncHandler(async (req: AuthRequest, res: Response) => {
  const rawSearch = req.query.search;
  const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

  const departmentWhere = buildDepartmentAccessWhere(req);

  const baseWhere: Prisma.inboundWhereInput = {
    deleted_at: null,
    ...departmentWhere,
  };

  let where: Prisma.inboundWhereInput = baseWhere;

  if (search) {
    const searchCondition: Prisma.inboundWhereInput = {
      OR: [
        { no: { contains: search, mode: "insensitive" } },
        { lot: { contains: search, mode: "insensitive" } },
        { in_type: { contains: search, mode: "insensitive" } },
        { department: { contains: search, mode: "insensitive" } },
        {
          quantity: {
            equals: isNaN(Number(search)) ? undefined : Number(search),
          },
        },
      ],
    };
    where = { AND: [baseWhere, searchCondition] };
  }

  const inbounds = await prisma.inbound.findMany({
    where,
    orderBy: { created_at: "desc" },
    include: {
      goods_ins: true,
    },
  });

  const departmentIds = [
    ...new Set(
      inbounds
        .map((ib) => ib.department_id)
        .filter((id): id is string => id != null)
        .map((id) => parseInt(id, 10))
        .filter((id) => !isNaN(id)),
    ),
  ];

  const deptMap = new Map<number, string>();
  if (departmentIds.length > 0) {
    const departments = await prisma.department.findMany({
      where: { odoo_id: { in: departmentIds } },
      select: { odoo_id: true, short_name: true },
    });
    departments.forEach((dept) => {
      if (dept.odoo_id) deptMap.set(dept.odoo_id, dept.short_name);
    });
  }

  const formattedInbounds = inbounds.map((inbound) => {
    const deptId = inbound.department_id
      ? parseInt(inbound.department_id, 10)
      : NaN;
    const shortName = !isNaN(deptId) ? deptMap.get(deptId) : undefined;

    return {
      id: inbound.id,
      picking_id: inbound.picking_id,
      no: inbound.no,
      lot: inbound.lot,
      location_id: inbound.location_id,
      location: inbound.location,
      location_dest_id: inbound.location_dest_id,
      location_dest: inbound.location_dest,
      department_id: inbound.department_id,
      department: shortName ?? inbound.department,
      reference: inbound.reference,
      quantity: inbound.quantity,
      origin: inbound.origin,
      date: inbound.date,
      in_type: inbound.in_type,
      created_at: inbound.created_at,
      updated_at: inbound.updated_at,
      items: inbound.goods_ins
        .filter((gi) => !gi.deleted_at)
        .map((gi) => ({
          id: gi.id,
          sequence: gi.sequence,
          product_id: gi.product_id,
          code: gi.code,
          name: gi.name,
          unit: gi.unit,
          tracking: gi.tracking,
          lot_id: gi.lot_id,
          lot: gi.lot,
          lot_serial: gi.lot_serial,
          exp: gi.exp,
          qty: gi.qty,
          quantity_receive: (gi as any).quantity_receive ?? null,
          quantity_count: (gi as any).quantity_count ?? null,
          barcode_id: gi.barcode_id,
        })),
    };
  });

  return res.json(formattedInbounds);
});

// GET Inbound (WITH PAGINATION)
export const getInboundsPaginated = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;

    if (isNaN(page) || page < 1) {
      throw badRequest("page ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");
    }

    const skip = (page - 1) * limit;

    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

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

    const departmentWhere = buildDepartmentAccessWhere(req);

    // 🔹 baseWhere (มี status filter ถ้ามี)
    const baseWhere: Prisma.inboundWhereInput = {
      deleted_at: null,
      ...departmentWhere,
      ...(status ? { status } : {}),
    };

    let where: Prisma.inboundWhereInput = baseWhere;

    if (search) {
      const searchCondition: Prisma.inboundWhereInput = {
        OR: [
          { no: { contains: search, mode: "insensitive" } },
          { lot: { contains: search, mode: "insensitive" } },
          { in_type: { contains: search, mode: "insensitive" } },
          { department: { contains: search, mode: "insensitive" } },
          { reference: { contains: search, mode: "insensitive" } },
          { origin: { contains: search, mode: "insensitive" } },
          {
            quantity: {
              equals: isNaN(Number(search)) ? undefined : Number(search),
            },
          },
          {
            goods_ins: {
              some: {
                deleted_at: null,
                OR: [{ code: { contains: search, mode: "insensitive" } }],
              },
            },
          },
        ],
      };

      where = { AND: [baseWhere, searchCondition] };
    }

    // 🔹 where สำหรับนับ statusCounts (ต้อง "ไม่ติด status filter")
    const baseWhereForCount: Prisma.inboundWhereInput = {
      deleted_at: null,
      ...departmentWhere,
    };

    let whereForCount: Prisma.inboundWhereInput = baseWhereForCount;

    if (search) {
      const searchCondition: Prisma.inboundWhereInput = {
        OR: [
          { no: { contains: search, mode: "insensitive" } },
          { lot: { contains: search, mode: "insensitive" } },
          { in_type: { contains: search, mode: "insensitive" } },
          { department: { contains: search, mode: "insensitive" } },
          { reference: { contains: search, mode: "insensitive" } },
          { origin: { contains: search, mode: "insensitive" } },
          {
            quantity: {
              equals: isNaN(Number(search)) ? undefined : Number(search),
            },
          },
          {
            goods_ins: {
              some: {
                deleted_at: null,
                OR: [{ code: { contains: search, mode: "insensitive" } }],
              },
            },
          },
        ],
      };

      whereForCount = { AND: [baseWhereForCount, searchCondition] };
    }

    const [inbounds, total, pendingCount, completedCount] =
      await Promise.all([
        prisma.inbound.findMany({
          where,
          skip,
          take: limit,
          orderBy: { created_at: "desc" },
          include: {
            goods_ins: true,
          },
        }),
        prisma.inbound.count({ where }),

        // 🔥 statusCounts (ใช้ whereForCount)
        prisma.inbound.count({
          where: {
            AND: [whereForCount, { status: "pending" }],
          },
        }),
        prisma.inbound.count({
          where: {
            AND: [whereForCount, { status: "completed" }],
          },
        }),
      ]);

    const departmentIds = [
      ...new Set(
        inbounds
          .map((ib) => ib.department_id)
          .filter((id): id is string => id != null)
          .map((id) => parseInt(id, 10))
          .filter((id) => !isNaN(id)),
      ),
    ];

    const deptMap = new Map<number, string>();
    if (departmentIds.length > 0) {
      const departments = await prisma.department.findMany({
        where: { odoo_id: { in: departmentIds } },
        select: { odoo_id: true, short_name: true },
      });
      departments.forEach((dept) => {
        if (dept.odoo_id) deptMap.set(dept.odoo_id, dept.short_name);
      });
    }

    const formattedInbounds = inbounds.map((inbound) => {
      const deptId = inbound.department_id
        ? parseInt(inbound.department_id, 10)
        : NaN;
      const shortName = !isNaN(deptId) ? deptMap.get(deptId) : undefined;

      return {
        id: inbound.id,
        picking_id: inbound.picking_id,
        no: inbound.no,
        lot: inbound.lot,
        quantity: inbound.quantity,
        location_id: inbound.location_id,
        location: inbound.location,
        location_dest_id: inbound.location_dest_id,
        location_dest: inbound.location_dest,
        department_id: inbound.department_id,
        department: shortName ?? inbound.department,
        reference: inbound.reference,
        origin: inbound.origin,
        date: inbound.date,
        in_type: inbound.in_type,
        status: inbound.status,
        created_at: inbound.created_at,
        updated_at: inbound.updated_at,
        items: inbound.goods_ins
          .filter((gi) => !gi.deleted_at)
          .map((gi) => ({
            id: gi.id,
            sequence: gi.sequence,
            product_id: gi.product_id,
            code: gi.code,
            name: gi.name,
            unit: gi.unit,
            tracking: gi.tracking,
            lot_id: gi.lot_id,
            lot: gi.lot,
            lot_serial: gi.lot_serial,
            exp: gi.exp,
            qty: gi.qty,
            quantity_receive: (gi as any).quantity_receive ?? null,
            quantity_count: (gi as any).quantity_count ?? null,
            barcode_id: gi.barcode_id,
          })),
      };
    });

    return res.json({
      data: formattedInbounds,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),

        // ✅ กลับมาแล้ว
        statusCounts: {
          pending: pendingCount,
          completed: completedCount,
        },
      },
    });
  },
);

// GET Inbound BY no (unique)
export const getInboundByGr = asyncHandler(
  async (req: Request<{ gr: string }>, res: Response) => {
    const raw = req.params.gr;
    const no = (Array.isArray(raw) ? raw[0] : raw)?.trim();

    if (!no) throw badRequest("กรุณาระบุ no ใน path เช่น /inbounds/:no");

    const inbound = await prisma.inbound.findUnique({
      where: { no },
      include: {
        goods_ins: {
          where: { deleted_at: null },
          orderBy: { created_at: "desc" },
        },
      },
    });

    if (!inbound) throw notFound("ไม่พบ inbound");

    // Lookup department short_name
    let departmentShortName: string | undefined;
    if (inbound.department_id) {
      const deptId = parseInt(inbound.department_id, 10);
      if (!isNaN(deptId)) {
        const dept = await prisma.department.findFirst({
          where: { odoo_id: deptId },
          select: { short_name: true },
        });
        departmentShortName = dept?.short_name;
      }
    }

    const formattedInbound = {
      id: inbound.id,
      picking_id: inbound.picking_id,
      no: inbound.no,
      location_id: inbound.location_id,
      lot: inbound.lot,
      quantity: inbound.quantity,
      location: inbound.location,
      location_dest_id: inbound.location_dest_id,
      location_dest: inbound.location_dest,
      department_id: inbound.department_id,
      department: departmentShortName ?? inbound.department,
      reference: inbound.reference,
      origin: inbound.origin,
      date: inbound.date,
      in_type: inbound.in_type,
      created_at: inbound.created_at,
      updated_at: inbound.updated_at,
      items: inbound.goods_ins.map((gi) => ({
        id: gi.id,
        sequence: gi.sequence,
        product_id: gi.product_id,
        code: gi.code,
        name: gi.name,
        unit: gi.unit,
        tracking: gi.tracking,
        lot_id: gi.lot_id, // ✅ ยังส่งกลับเหมือนเดิม
        lot: gi.lot,
        lot_serial: gi.lot_serial,
        exp: gi.exp,
        qty: gi.qty,
        barcode_id: gi.barcode_id,
      })),
    };

    return res.json(formattedInbound);
  },
);

// UPDATE Inbound
export const updateInbound = asyncHandler(
  async (
    req: Request<{ gr: string }, {}, UpdateInboundBody>,
    res: Response,
  ) => {
    const no = Array.isArray(req.params.gr) ? req.params.gr[0] : req.params.gr;

    const existing = await prisma.inbound.findUnique({ where: { no } });
    if (!existing) throw notFound("ไม่พบ inbound");
    if (existing.deleted_at) throw badRequest("inbound ถูกลบไปแล้ว");

    const data = req.body;

    // validate quantity ถ้ามีส่งมา
    if (data.quantity !== undefined) {
      if (Number.isNaN(Number(data.quantity)) || Number(data.quantity) < 0) {
        throw badRequest("quantity ต้องเป็นตัวเลขและต้องไม่ติดลบ");
      }
    }

    const inbound = await prisma.inbound.update({
      where: { no },
      data: {
        no: data.no,
        lot: data.lot,
        date: data.date ? parseDateInput(data.date, "date") : undefined,
        quantity:
          data.quantity !== undefined ? Number(data.quantity) : undefined,
        in_type: data.in_type,
        department: data.department,
        updated_at: new Date(),
      },
    });

    return res.json(inbound);
  },
);

/// DELETE Inbound
export const deleteInbound = asyncHandler(
  async (req: Request<{ gr: string }>, res: Response) => {
    const no = Array.isArray(req.params.gr) ? req.params.gr[0] : req.params.gr;

    const old = await prisma.inbound.findUnique({ where: { no } });
    if (!old) throw notFound("ไม่พบ inbound");
    if (old.deleted_at) throw badRequest("inbound ถูกลบไปแล้ว");

    await prisma.inbound.update({
      where: { no },
      data: { deleted_at: new Date(), updated_at: new Date() },
    });

    return res.json({ message: "ลบ inbound เรียบร้อยแล้ว" });
  },
);
